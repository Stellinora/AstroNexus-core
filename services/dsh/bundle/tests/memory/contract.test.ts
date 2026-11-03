import assert from "node:assert/strict";
import { test } from "node:test";

import type { MemoryStore } from "../../src/domain/memory/contracts.ts";
import { FakeMemoryStore } from "../../src/domain/memory/fake-store.ts";
import { SqliteMemoryStore } from "../../src/domain/memory/sqlite-store.ts";

interface StoreCase {
  readonly name: string;
  readonly create: () => Promise<MemoryStore>;
}

const TEST_NOW = 1_700_000_000_000;

function cases(): StoreCase[] {
  let tick = TEST_NOW;
  const now = () => {
    tick += 1;
    return tick;
  };
  return [
    { name: "fake", create: async () => new FakeMemoryStore({ now }) },
    { name: "sqlite", create: async () => new SqliteMemoryStore(":memory:", { now }) },
  ];
}

for (const storeCase of cases()) {
  test(`${storeCase.name}: ingest is idempotent by externalId`, async () => {
    const store = await storeCase.create();
    try {
      const first = await store.ingest({
        kind: "fact",
        payload: { text: "AstroNexus uses SQLite" },
        searchText: "AstroNexus uses SQLite",
        externalId: "session-1:1",
      });
      const second = await store.ingest({
        kind: "fact",
        payload: { text: "duplicate" },
        searchText: "duplicate",
        externalId: "session-1:1",
      });
      assert.equal(first.created, true);
      assert.equal(second.created, false);
      assert.equal(second.event.eventId, first.event.eventId);
    } finally {
      await store.close();
    }
  });

  test(`${storeCase.name}: retrieve matches text and filters kind`, async () => {
    const store = await storeCase.create();
    try {
      await store.ingest({
        kind: "fact",
        payload: { text: "Vesperine is the sibling project" },
        searchText: "Vesperine is the sibling project",
      });
      await store.ingest({
        kind: "preference",
        payload: { text: "Vesperine prefers dark mode" },
        searchText: "Vesperine prefers dark mode",
      });

      const all = await store.retrieve({ text: "Vesperine" });
      assert.equal(all.length, 2);

      const facts = await store.retrieve({ text: "Vesperine", kind: "fact" });
      assert.equal(facts.length, 1);
      assert.equal(facts[0]?.event.kind, "fact");
    } finally {
      await store.close();
    }
  });

  test(`${storeCase.name}: correct supersedes the previous head`, async () => {
    const store = await storeCase.create();
    try {
      const created = await store.ingest({
        kind: "fact",
        payload: { text: "port is 3080" },
        searchText: "port is 3080",
      });
      const corrected = await store.correct({
        memoryId: created.event.memoryId,
        payload: { text: "port is 8080" },
        searchText: "port is 8080",
      });
      assert.equal(corrected.previousEventId, created.event.eventId);

      const oldHits = await store.retrieve({ text: "3080" });
      assert.equal(oldHits.length, 0);

      const newHits = await store.retrieve({ text: "8080" });
      assert.equal(newHits.length, 1);
      assert.equal(newHits[0]?.event.memoryId, created.event.memoryId);
    } finally {
      await store.close();
    }
  });

  test(`${storeCase.name}: lifecycle transition removes memory from retrieval`, async () => {
    const store = await storeCase.create();
    try {
      const created = await store.ingest({
        kind: "workflow",
        payload: { text: "run tests before push" },
        searchText: "run tests before push",
      });
      await store.transition(created.event.memoryId, "archived");

      const hits = await store.retrieve({ text: "tests" });
      assert.equal(hits.length, 0);
      assert.equal(store.boot().items.length, 0);
    } finally {
      await store.close();
    }
  });

  test(`${storeCase.name}: boot packs by kind priority and budget`, async () => {
    const store = await storeCase.create();
    try {
      for (const [kind, text] of [
        ["reflection", "reflection text"],
        ["fact", "fact text"],
        ["preference", "preference text"],
      ] as const) {
        await store.ingest({ kind, payload: { text }, searchText: text });
      }
      const snapshot = store.boot({ maxItems: 2, tokenBudget: 100 });
      assert.deepEqual(
        snapshot.items.map((item) => item.kind),
        ["preference", "fact"],
      );
      assert.match(snapshot.text, /Known long-term memory:/);
    } finally {
      await store.close();
    }
  });

  test(`${storeCase.name}: exportJsonl keeps every version`, async () => {
    const store = await storeCase.create();
    try {
      const created = await store.ingest({
        kind: "decision",
        payload: { text: "use SQLite" },
        searchText: "use SQLite",
      });
      await store.correct({
        memoryId: created.event.memoryId,
        payload: { text: "use Postgres later" },
        searchText: "use Postgres later",
      });
      const lines: string[] = [];
      for await (const line of store.exportJsonl()) lines.push(line);
      assert.equal(lines.length, 2);
      assert.match(lines[0] ?? "", /use SQLite/);
      assert.match(lines[1] ?? "", /use Postgres later/);
    } finally {
      await store.close();
    }
  });

  test(`${storeCase.name}: list returns active heads and filters`, async () => {
    const store = await storeCase.create();
    try {
      const fact = await store.ingest({
        kind: "fact",
        payload: { text: "fact one" },
        searchText: "fact one",
      });
      await store.ingest({
        kind: "preference",
        payload: { text: "pref one" },
        searchText: "pref one",
      });

      assert.equal((await store.list()).length, 2);
      assert.equal((await store.list({ kind: "fact" })).length, 1);

      await store.transition(fact.event.memoryId, "archived");
      assert.equal((await store.list()).length, 1);
      assert.equal((await store.list({ lifecycles: ["archived"] })).length, 1);
    } finally {
      await store.close();
    }
  });

  test(`${storeCase.name}: boot ranks frequently accessed memories first within a kind`, async () => {
    const store = await storeCase.create();
    try {
      const alpha = await store.ingest({
        kind: "fact",
        payload: { text: "alpha fact" },
        searchText: "alpha fact",
      });
      await store.ingest({
        kind: "fact",
        payload: { text: "beta fact" },
        searchText: "beta fact",
      });

      await store.retrieve({ text: "alpha" });
      const snapshot = store.boot({ maxItems: 2 });
      assert.equal(snapshot.items[0]?.memoryId, alpha.event.memoryId);
    } finally {
      await store.close();
    }
  });

  test(`${storeCase.name}: stats reports heads and lifecycle counts`, async () => {
    const store = await storeCase.create();
    try {
      const created = await store.ingest({
        kind: "fact",
        payload: { text: "counted fact" },
        searchText: "counted fact",
      });
      await store.transition(created.event.memoryId, "archived");

      const stats = await store.stats();
      assert.equal(stats.totalEvents, 2);
      assert.equal(stats.active, 0);
      assert.equal(stats.byKind.fact, 1);
      assert.equal(stats.byLifecycle.archived, 1);
    } finally {
      await store.close();
    }
  });

  test(`${storeCase.name}: project and visibility filtering`, async () => {
    const store = await storeCase.create();
    try {
      await store.ingest({
        kind: "fact",
        payload: { text: "global thing" },
        searchText: "global thing",
        visibility: "global",
      });
      await store.ingest({
        kind: "fact",
        payload: { text: "project thing" },
        searchText: "project thing",
        projectId: "p1",
        visibility: "private",
      });
      await store.ingest({
        kind: "fact",
        payload: { text: "unscoped thing" },
        searchText: "unscoped thing",
      });

      assert.equal((await store.retrieve({ text: "thing", projectId: "p1" })).length, 3);
      assert.equal((await store.retrieve({ text: "thing" })).length, 2);
      assert.equal((await store.retrieve({ text: "thing", projectId: "p2" })).length, 2);
      assert.equal((await store.retrieve({ text: "project thing" })).length, 0);

      assert.equal((await store.list({ projectId: "p1" })).length, 3);
      assert.equal((await store.list()).length, 2);
      assert.equal(store.boot({ projectId: "p1" }).items.length, 3);
      assert.equal(store.boot().items.length, 2);
    } finally {
      await store.close();
    }
  });

  test(`${storeCase.name}: maintenance archives duplicate active heads`, async () => {
    const store = await storeCase.create();
    try {
      await store.ingest({
        kind: "fact",
        payload: { text: "same fact" },
        searchText: "same fact",
      });
      await store.ingest({
        kind: "fact",
        payload: { text: "  Same   fact " },
        searchText: "  Same   fact ",
      });
      const result = await store.maintenance({ now: TEST_NOW + 10 });
      assert.equal(result.archivedDuplicates, 1);
      const hits = await store.retrieve({ text: "same fact" });
      assert.equal(hits.length, 1);
    } finally {
      await store.close();
    }
  });

  test(`${storeCase.name}: maintenance decays stale active memories`, async () => {
    const store = await storeCase.create();
    try {
      const created = await store.ingest({
        kind: "fact",
        payload: { text: "old fact" },
        searchText: "old fact",
        eventTime: 1_000,
      });
      const result = await store.maintenance({
        now: 1_000 + 91 * 24 * 60 * 60 * 1000,
      });
      assert.equal(result.decayed, 1);
      assert.equal(store.boot().items.length, 0);
      assert.equal((await store.retrieve({ text: "old fact" })).length, 0);
      assert.equal(created.created, true);
    } finally {
      await store.close();
    }
  });

  test(`${storeCase.name}: maintenance archives old decayed heads`, async () => {
    const store = await storeCase.create();
    try {
      const created = await store.ingest({
        kind: "workflow",
        payload: { text: "old workflow" },
        searchText: "old workflow",
      });
      const decayed = await store.transition(created.event.memoryId, "decayed");
      const result = await store.maintenance({
        now: decayed.eventTime + 181 * 24 * 60 * 60 * 1000,
      });
      assert.equal(result.archived, 1);
    } finally {
      await store.close();
    }
  });
}

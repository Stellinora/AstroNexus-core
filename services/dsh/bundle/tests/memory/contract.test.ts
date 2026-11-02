import assert from "node:assert/strict";
import { test } from "node:test";

import type { MemoryStore } from "../../src/domain/memory/contracts.ts";
import { FakeMemoryStore } from "../../src/domain/memory/fake-store.ts";
import { SqliteMemoryStore } from "../../src/domain/memory/sqlite-store.ts";

interface StoreCase {
  readonly name: string;
  readonly create: () => Promise<MemoryStore>;
}

function cases(): StoreCase[] {
  let tick = 1_700_000_000_000;
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
}

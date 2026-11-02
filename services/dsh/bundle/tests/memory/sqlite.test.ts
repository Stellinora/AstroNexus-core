import assert from "node:assert/strict";
import { test } from "node:test";

import { SqliteMemoryStore } from "../../src/domain/memory/sqlite-store.ts";

test("sqlite: trigram retrieval works for Chinese text", async () => {
  const store = new SqliteMemoryStore(":memory:");
  try {
    await store.ingest({
      kind: "fact",
      payload: { text: "云端记忆工厂使用 SQLite 存储" },
      searchText: "云端记忆工厂使用 SQLite 存储",
    });
    const hits = await store.retrieve({ text: "记忆工厂" });
    assert.equal(hits.length, 1);
    assert.match(hits[0]?.event.searchText ?? "", /记忆工厂/);
  } finally {
    await store.close();
  }
});

test("sqlite: two-character query falls back to LIKE", async () => {
  const store = new SqliteMemoryStore(":memory:");
  try {
    await store.ingest({
      kind: "fact",
      payload: { text: "记忆很重要" },
      searchText: "记忆很重要",
    });
    const hits = await store.retrieve({ text: "记忆" });
    assert.equal(hits.length, 1);
  } finally {
    await store.close();
  }
});

test("sqlite: sourceRef prefix filters retrieval", async () => {
  const store = new SqliteMemoryStore(":memory:");
  try {
    await store.ingest({
      kind: "fact",
      payload: { text: "alpha memory" },
      searchText: "alpha memory",
      sourceRef: "session-a:1",
    });
    await store.ingest({
      kind: "fact",
      payload: { text: "alpha memory" },
      searchText: "alpha memory",
      sourceRef: "session-b:1",
    });
    const hits = await store.retrieve({ text: "alpha", sourceRefPrefix: "session-a:" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.event.sourceRef, "session-a:1");
  } finally {
    await store.close();
  }
});

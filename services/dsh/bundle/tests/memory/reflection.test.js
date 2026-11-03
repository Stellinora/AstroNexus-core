import assert from "node:assert/strict";
import { test } from "node:test";

import { SqliteMemoryStore } from "../../src/domain/memory/sqlite-store.ts";
import { parseReflectionItems, reflectOnce } from "../../src/reflect/index.js";

function fakeContext(chunks) {
  return {
    agentDefaultModel: {
      currentSelection: () => ({ provider: "mock", model: "mock-model" }),
    },
    llm: {
      stream(options) {
        assert.equal(options.provider, "mock");
        assert.equal(options.model, "mock-model");
        return (async function* () {
          for (const chunk of chunks) yield chunk;
        })();
      },
    },
  };
}

test("reflectOnce distills items and advances the cursor", async () => {
  const store = new SqliteMemoryStore(":memory:");
  try {
    await store.ingest({
      kind: "fact",
      payload: { text: "用户说端口是 3080" },
      searchText: "用户说端口是 3080",
      sourceRef: "session-a:1",
    });
    await store.ingest({
      kind: "reflection",
      payload: { text: "我们讨论了部署方式" },
      searchText: "我们讨论了部署方式",
      sourceRef: "session-a:2",
    });

    const ctx = fakeContext([
      { type: "text-delta", index: 0, text: '[{"kind":"preference","text":"用户偏好深色模式"}' },
      { type: "text-delta", index: 0, text: ",{\"kind\":\"decision\",\"text\":\"用 SQLite 做主存储\"}]" },
      { type: "finish", reason: "stop" },
    ]);

    const first = await reflectOnce(ctx, store);
    assert.equal(first.scanned, 2);
    assert.equal(first.extracted, 2);

    const preference = await store.retrieve({ text: "深色模式" });
    assert.equal(preference.length, 1);
    assert.equal(preference[0]?.event.kind, "preference");

    const second = await reflectOnce(ctx, store);
    assert.equal(second.scanned, 0);
    assert.equal(second.extracted, 0);
  } finally {
    await store.close();
  }
});

test("reflectOnce leaves the cursor when the model call fails", async () => {
  const store = new SqliteMemoryStore(":memory:");
  try {
    await store.ingest({
      kind: "fact",
      payload: { text: "需要重试的事实" },
      searchText: "需要重试的事实",
      sourceRef: "session-b:1",
    });
    const ctx = {
      agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "m" }) },
      llm: {
        stream() {
          throw new Error("provider down");
        },
      },
    };

    const result = await reflectOnce(ctx, store);
    assert.equal(result.skipped, "llm-error");
    assert.equal((await store.recentUnreflected()).length, 1);
  } finally {
    await store.close();
  }
});

test("reflectOnce skips items that already exist as active memories", async () => {
  const store = new SqliteMemoryStore(":memory:");
  try {
    await store.ingest({
      kind: "preference",
      payload: { text: "用户偏好深色模式" },
      searchText: "用户偏好深色模式",
      sourceRef: "session-c:1",
    });
    await store.ingest({
      kind: "fact",
      payload: { text: "部署环境是云端" },
      searchText: "部署环境是云端",
      sourceRef: "session-c:2",
    });

    const ctx = fakeContext([
      {
        type: "text-delta",
        index: 0,
        text: '[{"kind":"preference","text":"用户偏好深色模式"},{"kind":"fact","text":"部署端口是 3080"}]',
      },
      { type: "finish", reason: "stop" },
    ]);

    const result = await reflectOnce(ctx, store);
    assert.equal(result.extracted, 1);
    assert.equal((await store.retrieve({ text: "深色模式" })).length, 1);
    assert.equal((await store.retrieve({ text: "3080" })).length, 1);
  } finally {
    await store.close();
  }
});

test("recentUnreflected ignores earlier reflection outputs", async () => {
  const store = new SqliteMemoryStore(":memory:");
  try {
    await store.ingest({
      kind: "fact",
      payload: { text: "真实来源" },
      searchText: "真实来源",
      sourceRef: "session-d:1",
    });
    await store.ingest({
      kind: "preference",
      payload: { text: "反思产物" },
      searchText: "反思产物",
      sourceRef: "reflection:1",
    });

    const events = await store.recentUnreflected();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.sourceRef, "session-d:1");
  } finally {
    await store.close();
  }
});

test("parseReflectionItems tolerates fences and invalid entries", () => {
  const items = parseReflectionItems(
    '```json\n[{"kind":"fact","text":" a "},{"kind":"nope","text":"x"},{"kind":"fact","text":""}]\n```',
  );
  assert.deepEqual(items, [{ kind: "fact", text: "a" }]);
});

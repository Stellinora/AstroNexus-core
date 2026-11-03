import assert from "node:assert/strict";
import { test } from "node:test";

import { SqliteEpisodeStore } from "../../src/domain/episode/sqlite-store.ts";
import { SqliteExperienceStore } from "../../src/domain/experience/sqlite-store.ts";
import { SqliteMemoryStore } from "../../src/domain/memory/sqlite-store.ts";
import { parseReflectionOutput, reflectOnce } from "../../src/reflect/index.js";

const OUTPUT = JSON.stringify({
  knowledge: [{ kind: "fact", text: "部署端口是 3080" }],
  experience: [
    {
      situation: "部署后端口冲突",
      action: "先查占用端口的进程",
      outcome: "发现旧实例未退出",
      lesson: "部署前先确认旧实例已停止",
      conditions: ["部署"],
      tags: ["ops", "port"],
    },
  ],
});

function fakeContext(chunks) {
  return {
    agentDefaultModel: {
      currentSelection: () => ({ provider: "mock", model: "mock-model" }),
    },
    llm: {
      stream(options) {
        assert.equal(options.provider, "mock");
        assert.equal(options.model, "mock-model");
        assert.match(String(options.system), /memory distiller/);
        return (async function* () {
          for (const chunk of chunks) yield chunk;
        })();
      },
    },
  };
}

function chunked(text) {
  const pieces = [];
  for (let index = 0; index < text.length; index += 40) {
    pieces.push({ type: "text-delta", index: 0, text: text.slice(index, index + 40) });
  }
  pieces.push({ type: "finish", reason: "stop" });
  return pieces;
}

async function createStores() {
  const memory = new SqliteMemoryStore(":memory:");
  const experience = new SqliteExperienceStore(":memory:");
  const episodes = new SqliteEpisodeStore(":memory:");
  return { memory, experience, episodes };
}

test("reflectOnce distills knowledge and experience from episodes", async () => {
  const stores = await createStores();
  try {
    const episode = await stores.episodes.record({
      sessionId: "session-a",
      turn: 1,
      startedAt: 1,
      endedAt: 2,
      transcript: [
        { role: "user", text: "部署后端口冲突了", seq: 1 },
        { role: "assistant", text: "先查占用端口的进程", seq: 2 },
      ],
    });

    const result = await reflectOnce(fakeContext(chunked(OUTPUT)), stores);
    assert.equal(result.episodes, 1);
    assert.equal(result.knowledge, 1);
    assert.equal(result.experience, 1);

    const knowledge = await stores.memory.retrieve({ text: "3080" });
    assert.equal(knowledge.length, 1);
    const experience = await stores.experience.search({ situation: "端口冲突" });
    assert.equal(experience.length, 1);
    assert.equal(experience[0]?.experience.tags.includes("ops"), true);

    assert.equal((await stores.episodes.recentUnreflected()).length, 0);
    assert.equal(episode.episodeId > 0, true);

    const second = await reflectOnce(fakeContext(chunked(OUTPUT)), stores);
    assert.equal(second.episodes, 0);
  } finally {
    await stores.memory.close();
    await stores.experience.close();
    await stores.episodes.close();
  }
});

test("reflectOnce leaves episodes unreflected when the model call fails", async () => {
  const stores = await createStores();
  try {
    await stores.episodes.record({
      sessionId: "session-b",
      turn: 1,
      startedAt: 1,
      endedAt: 2,
      transcript: [{ role: "user", text: "需要重试", seq: 1 }],
    });
    const ctx = {
      agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "m" }) },
      llm: {
        stream() {
          throw new Error("provider down");
        },
      },
    };
    const result = await reflectOnce(ctx, stores);
    assert.equal(result.skipped, "llm-error");
    assert.equal((await stores.episodes.recentUnreflected()).length, 1);
  } finally {
    await stores.memory.close();
    await stores.experience.close();
    await stores.episodes.close();
  }
});

test("reflectOnce dedupes existing knowledge and experience", async () => {
  const stores = await createStores();
  try {
    await stores.memory.ingest({
      kind: "fact",
      payload: { text: "部署端口是 3080" },
      searchText: "部署端口是 3080",
      sourceRef: "session-c:1",
    });
    await stores.experience.remember({
      situation: "部署后端口冲突",
      lesson: "部署前先确认旧实例已停止",
    });
    await stores.episodes.record({
      sessionId: "session-c",
      turn: 1,
      startedAt: 1,
      endedAt: 2,
      transcript: [{ role: "user", text: "端口冲突", seq: 1 }],
    });

    const result = await reflectOnce(fakeContext(chunked(OUTPUT)), stores);
    assert.equal(result.knowledge, 0);
    assert.equal(result.experience, 0);
  } finally {
    await stores.memory.close();
    await stores.experience.close();
    await stores.episodes.close();
  }
});

test("parseReflectionOutput handles fences, legacy arrays, and invalid entries", () => {
  const fenced = parseReflectionOutput(
    '```json\n{"knowledge":[{"kind":"fact","text":"a"},{"kind":"nope","text":"x"}],"experience":[{"situation":"s","lesson":"l"}]}\n```',
  );
  assert.deepEqual(fenced.knowledge, [{ kind: "fact", text: "a" }]);
  assert.deepEqual(fenced.experience, [
    {
      situation: "s",
      action: "",
      outcome: "",
      lesson: "l",
      conditions: [],
      tags: [],
    },
  ]);

  const legacy = parseReflectionOutput('[{"kind":"preference","text":"dark mode"}]');
  assert.deepEqual(legacy.knowledge, [{ kind: "preference", text: "dark mode" }]);
  assert.deepEqual(legacy.experience, []);

  assert.deepEqual(parseReflectionOutput("not json"), { knowledge: [], experience: [] });
});

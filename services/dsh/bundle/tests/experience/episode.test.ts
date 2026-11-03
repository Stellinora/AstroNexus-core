import assert from "node:assert/strict";
import { test } from "node:test";

import { SqliteEpisodeStore } from "../../src/domain/episode/sqlite-store.ts";

test("episode store records turns and advances the reflection cursor", async () => {
  const store = new SqliteEpisodeStore(":memory:");
  try {
    const first = await store.record({
      sessionId: "session-a",
      turn: 1,
      startedAt: 1,
      endedAt: 2,
      transcript: [
        { role: "user", text: "部署端口是多少", seq: 1 },
        { role: "assistant", text: "是 3080", seq: 2 },
      ],
    });
    assert.equal(first.turn, 1);
    assert.equal(first.reflectedAt, null);
    assert.equal((await store.recentUnreflected()).length, 1);

    const duplicate = await store.record({
      sessionId: "session-a",
      turn: 1,
      startedAt: 1,
      endedAt: 2,
      transcript: [],
    });
    assert.equal(duplicate.episodeId, first.episodeId);
    assert.equal((await store.recentUnreflected()).length, 1);

    await store.markReflected([first.episodeId]);
    assert.equal((await store.recentUnreflected()).length, 0);
  } finally {
    await store.close();
  }
});

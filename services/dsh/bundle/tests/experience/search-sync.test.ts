import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeExperienceStore } from "../../src/domain/experience/fake-store.ts";
import { SqliteExperienceStore } from "../../src/domain/experience/sqlite-store.ts";

test("searchSync matches async search in both stores", async () => {
  const fake = new FakeExperienceStore();
  const sqlite = new SqliteExperienceStore(":memory:");
  try {
    for (const store of [fake, sqlite]) {
      await store.remember({ situation: "部署后端口冲突", lesson: "先看占用端口的进程" });
      const sync = store.searchSync({ situation: "端口冲突" });
      const asyncHits = await store.search({ situation: "端口冲突" });
      assert.equal(sync.length, 1);
      assert.equal(sync.length, asyncHits.length);
      assert.equal(sync[0]?.experience.experienceId, asyncHits[0]?.experience.experienceId);
    }
  } finally {
    await fake.close();
    await sqlite.close();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExperienceStore } from "../../src/domain/experience/contracts.ts";
import { FakeExperienceStore } from "../../src/domain/experience/fake-store.ts";
import { SqliteExperienceStore } from "../../src/domain/experience/sqlite-store.ts";

interface Case {
  readonly name: string;
  readonly create: () => Promise<ExperienceStore>;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function cases(): Case[] {
  let tick = NOW;
  const now = () => {
    tick += 1;
    return tick;
  };
  return [
    { name: "fake", create: async () => new FakeExperienceStore({ now }) },
    { name: "sqlite", create: async () => new SqliteExperienceStore(":memory:", { now }) },
  ];
}

for (const storeCase of cases()) {
  test(`${storeCase.name}: remember and search by situation`, async () => {
    const store = await storeCase.create();
    try {
      const { experience, created } = await store.remember({
        situation: "服务响应时间飙升到 2000ms",
        action: "先看连接池和慢查询",
        outcome: "连接池耗尽",
        lesson: "高峰期先查连接池",
        tags: ["ops", "postgres"],
        conditions: ["流量高峰"],
        baseConfidence: 0.7,
      });
      assert.equal(created, true);
      assert.equal(experience.lifecycle, "active");

      const hits = await store.search({ situation: "响应时间" });
      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.experience.experienceId, experience.experienceId);

      const tagged = await store.search({ situation: "响应时间", tags: ["ops"] });
      assert.equal(tagged.length, 1);
      const wrongTag = await store.search({ situation: "响应时间", tags: ["frontend"] });
      assert.equal(wrongTag.length, 0);
    } finally {
      await store.close();
    }
  });

  test(`${storeCase.name}: revising keeps a version chain`, async () => {
    const store = await storeCase.create();
    try {
      const first = await store.remember({
        situation: "部署失败",
        lesson: "先看端口 3080",
      });
      await store.remember({
        experienceId: first.experience.experienceId,
        situation: "部署失败",
        lesson: "先看端口 8080",
      });

      const oldHits = await store.search({ situation: "3080" });
      const newHits = await store.search({ situation: "8080" });
      assert.equal(oldHits.length, 0);
      assert.equal(newHits.length, 1);
      assert.equal(newHits[0]?.experience.experienceId, first.experience.experienceId);
    } finally {
      await store.close();
    }
  });

  test(`${storeCase.name}: externalId is idempotent`, async () => {
    const store = await storeCase.create();
    try {
      const first = await store.remember({
        situation: "重复情境",
        lesson: "只写一次",
        externalId: "episode:1",
      });
      const second = await store.remember({
        situation: "重复情境",
        lesson: "只写一次",
        externalId: "episode:1",
      });
      assert.equal(first.created, true);
      assert.equal(second.created, false);
      assert.equal(second.experience.experienceId, first.experience.experienceId);
    } finally {
      await store.close();
    }
  });

  test(`${storeCase.name}: feedback moves confidence`, async () => {
    const store = await storeCase.create();
    try {
      const { experience } = await store.remember({
        situation: "反馈测试",
        lesson: "看效果",
        baseConfidence: 0.6,
      });
      const start = experience.confidence;
      const success = await store.feedback({
        experienceId: experience.experienceId,
        success: true,
      });
      assert.ok(success.confidence > start);
      const failure = await store.feedback({
        experienceId: experience.experienceId,
        success: false,
      });
      assert.ok(failure.confidence < success.confidence);
      assert.equal(failure.successCount, 1);
      assert.equal(failure.failureCount, 1);
    } finally {
      await store.close();
    }
  });

  test(`${storeCase.name}: maintenance deprecates low-confidence experience`, async () => {
    const store = await storeCase.create();
    try {
      const { experience } = await store.remember({
        situation: "总是失败的做法",
        lesson: "不要这样",
        baseConfidence: 0.4,
      });
      for (let index = 0; index < 5; index += 1) {
        await store.feedback({ experienceId: experience.experienceId, success: false });
      }
      const result = await store.maintenance({ now: NOW + 1000 });
      assert.equal(result.deprecated, 1);
      const listed = await store.list({ lifecycle: ["active"] });
      assert.equal(listed.length, 0);
      const deprecated = await store.list({ lifecycle: ["deprecated"] });
      assert.equal(deprecated.length, 1);

      const archived = await store.maintenance({ now: NOW + 200 * DAY, archiveAfterMs: 180 * DAY });
      assert.equal(archived.archived, 1);
    } finally {
      await store.close();
    }
  });
}

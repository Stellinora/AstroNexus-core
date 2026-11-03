import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExperienceEvent, ExperienceHit } from "../../src/domain/experience/contracts.ts";
import { selectExperienceForInjection } from "../../src/domain/experience/inject.ts";

function event(overrides: Partial<ExperienceEvent> = {}): ExperienceEvent {
  return {
    eventId: 1,
    experienceId: "e1",
    supersedesId: null,
    situation: "部署后端口冲突",
    action: "查占用进程",
    outcome: "旧实例未退出",
    lesson: "部署前先确认旧实例已停止",
    conditions: [],
    tags: ["ops"],
    baseConfidence: 0.7,
    confidence: 0.7,
    successCount: 1,
    failureCount: 0,
    lifecycle: "active",
    projectId: null,
    visibility: "private",
    sourceRefs: [],
    eventTime: 1,
    ingestedAt: 1,
    externalId: null,
    ...overrides,
  };
}

function hit(overrides: Partial<ExperienceEvent> = {}, score = 1): ExperienceHit {
  return { experience: event(overrides), score };
}

test("returns empty injection when there are no usable hits", () => {
  assert.deepEqual(selectExperienceForInjection([]), { items: [], text: "" });
  assert.equal(selectExperienceForInjection([hit({ confidence: 0.1 })]).text, "");
  assert.equal(selectExperienceForInjection([hit({ lifecycle: "archived" })]).text, "");
  assert.equal(selectExperienceForInjection([hit()], { excludeIds: new Set(["e1"]) }).text, "");
});

test("caps items and characters", () => {
  const hits = [
    hit({ experienceId: "e1", situation: "a", lesson: "b" }, 3),
    hit({ experienceId: "e2", situation: "c", lesson: "d" }, 2),
    hit({ experienceId: "e3", situation: "e", lesson: "f" }, 1),
  ];
  const two = selectExperienceForInjection(hits);
  assert.equal(two.items.length, 2);
  assert.match(two.text, /Known experience/);

  const tiny = selectExperienceForInjection(hits, { maxChars: 60 });
  assert.ok(tiny.items.length <= 2);
  assert.ok(tiny.text.length <= 60);
});

test("formats situation, lesson, action, and confidence", () => {
  const selection = selectExperienceForInjection([
    hit({ situation: "部署失败", lesson: "先看日志", action: "查 stderr", confidence: 0.66 }),
  ]);
  assert.equal(
    selection.text,
    "Known experience (use only if relevant):\n- When 部署失败 → 先看日志; action: 查 stderr (confidence 0.66)",
  );
});

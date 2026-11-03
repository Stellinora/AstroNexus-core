import assert from "node:assert/strict";
import { test } from "node:test";

import { effectiveAccessScore, estimateTokens, renderBootText } from "../../src/domain/memory/boot.ts";

test("estimateTokens counts wide characters as one token", () => {
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens("记忆系统"), 4);
  assert.equal(estimateTokens("记忆 abcdefgh"), 5);
});

test("renderBootText returns empty text for an empty list", () => {
  assert.equal(renderBootText([]), "");
});

test("effectiveAccessScore decays old access below recent access", () => {
  const now = 1_700_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const oldHigh = effectiveAccessScore(10, now - 360 * day, now);
  const recentLow = effectiveAccessScore(2, now - day, now);
  assert.ok(oldHigh < recentLow);
  assert.equal(effectiveAccessScore(0, now, now), 0);
  assert.ok(Math.abs(effectiveAccessScore(4, now - 90 * day, now) - 2) < 0.01);
});

test("renderBootText renders one line per item", () => {
  const text = renderBootText([
    { memoryId: "m1", kind: "fact", text: "a", sourceRef: null },
    { memoryId: "m2", kind: "preference", text: "b", sourceRef: "s:1" },
  ]);
  assert.equal(text, "Known long-term memory:\n- [fact] a\n- [preference] b");
});

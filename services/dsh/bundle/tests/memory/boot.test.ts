import assert from "node:assert/strict";
import { test } from "node:test";

import { estimateTokens, renderBootText } from "../../src/domain/memory/boot.ts";

test("estimateTokens counts wide characters as one token", () => {
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens("记忆系统"), 4);
  assert.equal(estimateTokens("记忆 abcdefgh"), 5);
});

test("renderBootText returns empty text for an empty list", () => {
  assert.equal(renderBootText([]), "");
});

test("renderBootText renders one line per item", () => {
  const text = renderBootText([
    { memoryId: "m1", kind: "fact", text: "a", sourceRef: null },
    { memoryId: "m2", kind: "preference", text: "b", sourceRef: "s:1" },
  ]);
  assert.equal(text, "Known long-term memory:\n- [fact] a\n- [preference] b");
});

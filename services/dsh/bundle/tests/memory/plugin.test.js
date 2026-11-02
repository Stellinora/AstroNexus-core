import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { apply } from "../../src/memory/index.js";

function createContext() {
  const listeners = new Map();
  const disposers = [];
  const ctx = {
    listeners,
    systemPrompt: {
      spec: null,
      context(spec) {
        this.spec = spec;
        return () => {};
      },
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === "function") disposers.push(disposer);
    },
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    dispose() {
      for (const disposer of disposers.reverse()) disposer();
    },
  };
  return ctx;
}

function message(content) {
  return { message: { content } };
}

test("memory plugin ingests text messages and refreshes boot context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astronexus-memory-plugin-"));
  const ctx = createContext();
  try {
    apply(ctx, { dbPath: join(dir, "memory.db"), bootTokenBudget: 200 });
    const listener = ctx.listeners.get("session/event");
    assert.equal(typeof listener, "function");

    listener(
      { id: "session-a", seq: 1 },
      { type: "user/message", seq: 1, data: message([{ type: "text", text: "记住：端口是 3080" }]) },
    );
    await waitFor(() => ctx.systemPrompt.spec.text().includes("3080"));

    listener(
      { id: "session-a", seq: 1 },
      { type: "user/message", seq: 1, data: message([{ type: "text", text: "记住：端口是 3080" }]) },
    );
    listener(
      { id: "session-a", seq: 2 },
      { type: "assistant/message", seq: 2, data: message([{ type: "text", text: "已记录" }]) },
    );
    await waitFor(() => ctx.systemPrompt.spec.text().includes("已记录"));

    const text = ctx.systemPrompt.spec.text();
    assert.equal(text.split("3080").length - 1, 1);
    assert.match(text, /- \[reflection\] 已记录/);
  } finally {
    ctx.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for memory ingest");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

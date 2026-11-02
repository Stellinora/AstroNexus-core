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
    tools: {
      defs: new Map(),
      register(definition) {
        this.defs.set(definition.name, definition);
        return () => this.defs.delete(definition.name);
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
      {
        type: "assistant/message",
        seq: 2,
        data: message([{ type: "text", text: "已记录这条信息，稍后确认" }]),
      },
    );
    await waitFor(() => ctx.systemPrompt.spec.text().includes("已记录这条信息"));

    const text = ctx.systemPrompt.spec.text();
    assert.equal(text.split("3080").length - 1, 1);
    assert.match(text, /- \[reflection\] 已记录这条信息/);
  } finally {
    ctx.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory plugin registers search, remember, and correct tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astronexus-memory-tools-"));
  const ctx = createContext();
  try {
    apply(ctx, { dbPath: join(dir, "memory.db"), bootTokenBudget: 200 });
    const exec = { signal: new AbortController().signal };

    const remember = ctx.tools.defs.get("memory_remember");
    const search = ctx.tools.defs.get("memory_search");
    const correct = ctx.tools.defs.get("memory_correct");
    const list = ctx.tools.defs.get("memory_list");
    const forget = ctx.tools.defs.get("memory_forget");
    const exportTool = ctx.tools.defs.get("memory_export");
    for (const tool of [remember, search, correct, list, forget, exportTool]) {
      assert.equal(typeof tool?.execute, "function");
    }

    const stored = await remember.execute({ text: "端口是 3080", kind: "fact" }, exec);
    assert.equal(typeof stored.memoryId, "string");
    assert.equal(typeof stored.eventId, "number");

    const found = await search.execute({ query: "3080" }, exec);
    assert.equal(found.hits.length, 1);
    assert.equal(found.hits[0].memoryId, stored.memoryId);

    const fixed = await correct.execute(
      { memoryId: stored.memoryId, text: "端口是 8080" },
      exec,
    );
    assert.equal(fixed.previousEventId, stored.eventId);

    const oldHits = await search.execute({ query: "3080" }, exec);
    const newHits = await search.execute({ query: "8080" }, exec);
    assert.equal(oldHits.hits.length, 0);
    assert.equal(newHits.hits.length, 1);
    assert.match(ctx.systemPrompt.spec.text(), /8080/);
    assert.doesNotMatch(ctx.systemPrompt.spec.text(), /3080/);

    const listed = await list.execute({}, exec);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].text, "端口是 8080");

    const forgotten = await forget.execute({ memoryId: stored.memoryId }, exec);
    assert.equal(forgotten.lifecycle, "soft_deleted");
    const afterForget = await list.execute({}, exec);
    assert.equal(afterForget.items.length, 0);
    assert.equal((await search.execute({ query: "8080" }, exec)).hits.length, 0);

    const exported = await exportTool.execute({}, exec);
    assert.equal(exported.lines, 3);
    assert.match(exported.jsonl, /端口是 8080/);
  } finally {
    ctx.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory plugin skips short and slash-command messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astronexus-memory-filter-"));
  const ctx = createContext();
  try {
    apply(ctx, { dbPath: join(dir, "memory.db"), bootTokenBudget: 200 });
    const listener = ctx.listeners.get("session/event");

    listener(
      { id: "session-b", seq: 1 },
      { type: "user/message", seq: 1, data: message([{ type: "text", text: "hi" }]) },
    );
    listener(
      { id: "session-b", seq: 2 },
      { type: "user/message", seq: 2, data: message([{ type: "text", text: "/help me please" }]) },
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(ctx.systemPrompt.spec.text(), "");
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

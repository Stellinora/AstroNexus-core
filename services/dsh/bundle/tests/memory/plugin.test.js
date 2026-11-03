import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SqliteEpisodeStore } from "../../src/domain/episode/sqlite-store.ts";
import { apply } from "../../src/memory/index.js";

function createContext() {
  const listeners = new Map();
  const disposers = [];
  const ctx = {
    listeners,
    systemPrompt: {
      specs: [],
      context(spec) {
        this.specs.push(spec);
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

function assistantMessage(content) {
  return { message: { content } };
}

function userMessage(content) {
  return { role: "user", content };
}

function bootSpec(ctx) {
  return ctx.systemPrompt.specs.find((spec) => spec.name === "astronexus-memory");
}

function experienceSpec(ctx) {
  return ctx.systemPrompt.specs.find((spec) => spec.name === "astronexus-experience");
}

test("memory plugin ingests user messages and records turn episodes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astronexus-memory-plugin-"));
  const dbPath = join(dir, "memory.db");
  const ctx = createContext();
  try {
    apply(ctx, { dbPath, bootTokenBudget: 200 });
    const listener = ctx.listeners.get("session/event");
    assert.equal(typeof listener, "function");
    const session = { id: "session-a" };

    listener(session, { type: "turn/start", seq: 1, time: 10, data: { turn: 1 } });
    listener(session, {
      type: "user/message",
      seq: 2,
      time: 11,
      data: userMessage([{ type: "text", text: "记住：端口是 3080" }]),
    });
    await waitFor(() => bootSpec(ctx).text().includes("3080"));

    listener(session, {
      type: "assistant/message",
      seq: 3,
      time: 12,
      data: assistantMessage([{ type: "text", text: "已记录这条信息，稍后确认" }]),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.doesNotMatch(bootSpec(ctx).text(), /已记录这条信息/);

    listener(session, { type: "turn/end", seq: 4, time: 13, data: { turn: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 150));

    ctx.dispose();

    const episodes = new SqliteEpisodeStore(dbPath);
    try {
      const pending = await episodes.recentUnreflected();
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.turn, 1);
      assert.deepEqual(
        pending[0]?.transcript.map((message) => message.role),
        ["user", "assistant"],
      );
    } finally {
      await episodes.close();
    }
  } finally {
    ctx.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory plugin registers knowledge and experience tools", async () => {
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
    const statsTool = ctx.tools.defs.get("memory_stats");
    const expRemember = ctx.tools.defs.get("experience_remember");
    const expSearch = ctx.tools.defs.get("experience_search");
    const expFeedback = ctx.tools.defs.get("experience_feedback");
    const expList = ctx.tools.defs.get("experience_list");
    const expExport = ctx.tools.defs.get("experience_export");
    for (const tool of [
      remember,
      search,
      correct,
      list,
      forget,
      exportTool,
      statsTool,
      expRemember,
      expSearch,
      expFeedback,
      expList,
      expExport,
    ]) {
      assert.equal(typeof tool?.execute, "function");
    }

    const stored = await remember.execute({ text: "端口是 3080", kind: "fact" }, exec);
    const found = await search.execute({ query: "3080" }, exec);
    assert.equal(found.hits.length, 1);
    assert.equal(found.hits[0].memoryId, stored.memoryId);

    const fixed = await correct.execute(
      { memoryId: stored.memoryId, text: "端口是 8080" },
      exec,
    );
    assert.equal(fixed.previousEventId, stored.eventId);
    assert.equal((await search.execute({ query: "3080" }, exec)).hits.length, 0);
    assert.equal((await search.execute({ query: "8080" }, exec)).hits.length, 1);

    const listed = await list.execute({}, exec);
    assert.equal(listed.items.length, 1);
    const forgotten = await forget.execute({ memoryId: stored.memoryId }, exec);
    assert.equal(forgotten.lifecycle, "soft_deleted");
    const stats = await statsTool.execute({}, exec);
    assert.equal(stats.totalEvents, 3);
    assert.equal(stats.active, 0);

    const experience = await expRemember.execute(
      {
        situation: "部署后端口冲突",
        action: "查占用端口的进程",
        outcome: "旧实例未退出",
        lesson: "部署前先停旧实例",
        tags: ["ops"],
      },
      exec,
    );
    assert.equal(experience.created, true);
    assert.equal(typeof experience.experienceId, "string");

    const expFound = await expSearch.execute({ situation: "端口冲突" }, exec);
    assert.equal(expFound.items.length, 1);
    assert.equal(expFound.items[0].tags.includes("ops"), true);

    const feedback = await expFeedback.execute(
      { experienceId: experience.experienceId, success: true },
      exec,
    );
    assert.equal(feedback.successCount, 1);
    assert.ok(feedback.confidence > 0.6);

    const expListed = await expList.execute({}, exec);
    assert.equal(expListed.items.length, 1);

    const expExported = await expExport.execute({}, exec);
    assert.equal(expExported.lines, 1);
    assert.match(expExported.jsonl, /部署后端口冲突/);
  } finally {
    ctx.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory plugin injects matching experience for the current turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astronexus-memory-inject-"));
  const ctx = createContext();
  try {
    apply(ctx, { dbPath: join(dir, "memory.db"), bootTokenBudget: 200 });
    const exec = { signal: new AbortController().signal };

    const remember = ctx.tools.defs.get("experience_remember");
    await remember.execute(
      {
        situation: "部署后端口冲突",
        action: "查占用端口的进程",
        outcome: "旧实例未退出",
        lesson: "部署前先确认旧实例已停止",
        tags: ["ops"],
        baseConfidence: 0.8,
      },
      exec,
    );

    const preStep = ctx.listeners.get("agent/pre-step");
    const agent = { id: "agent-1" };
    const messages = [userMessage([{ type: "text", text: "部署后端口冲突了，怎么处理？" }])];
    await preStep(
      { agent, messages, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages }),
    );

    const provider = experienceSpec(ctx);
    const first = provider.text({ agent });
    assert.match(first, /Known experience/);
    assert.match(first, /部署前先确认旧实例已停止/);
    assert.equal(provider.text({ agent }), first);
    assert.doesNotMatch(bootSpec(ctx).text(), /旧实例/);

    await preStep(
      { agent, messages, turn: 2, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages }),
    );
    assert.equal(provider.text({ agent }), "");

    const unrelated = [userMessage([{ type: "text", text: "今天天气怎么样" }])];
    await preStep(
      { agent, messages: unrelated, turn: 3, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: unrelated }),
    );
    assert.equal(provider.text({ agent }), "");
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
    const session = { id: "session-b" };

    listener(session, {
      type: "user/message",
      seq: 1,
      data: userMessage([{ type: "text", text: "hi" }]),
    });
    listener(session, {
      type: "user/message",
      seq: 2,
      data: userMessage([{ type: "text", text: "/help me please" }]),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(bootSpec(ctx).text(), "");
  } finally {
    ctx.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory plugin can re-inject experience after configured turns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "astronexus-memory-reinject-"));
  const ctx = createContext();
  try {
    apply(ctx, {
      dbPath: join(dir, "memory.db"),
      bootTokenBudget: 200,
      experienceReinjectAfterTurns: 2,
    });
    const exec = { signal: new AbortController().signal };
    await ctx.tools.defs.get("experience_remember").execute(
      {
        situation: "部署后端口冲突",
        lesson: "部署前先确认旧实例已停止",
        baseConfidence: 0.8,
      },
      exec,
    );

    const preStep = ctx.listeners.get("agent/pre-step");
    const agent = { id: "agent-r" };
    const messages = [userMessage([{ type: "text", text: "部署后端口冲突了" }])];
    const provider = experienceSpec(ctx);

    await preStep(
      { agent, messages, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages }),
    );
    assert.match(provider.text({ agent }), /Known experience/);

    await preStep(
      { agent, messages, turn: 2, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages }),
    );
    assert.equal(provider.text({ agent }), "");

    await preStep(
      { agent, messages, turn: 4, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages }),
    );
    assert.match(provider.text({ agent }), /Known experience/);
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

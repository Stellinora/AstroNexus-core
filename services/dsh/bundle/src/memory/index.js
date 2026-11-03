import { homedir } from "node:os";
import { join } from "node:path";

import { SqliteEpisodeStore } from "../domain/episode/sqlite-store.ts";
import { selectExperienceForInjection } from "../domain/experience/inject.ts";
import { SqliteExperienceStore } from "../domain/experience/sqlite-store.ts";
import { SqliteMemoryStore } from "../domain/memory/sqlite-store.ts";

export const name = "astronexus-memory";
export const inject = ["systemPrompt", "tools"];

const TEXT_BLOCK = "text";
const KINDS = ["fact", "preference", "decision", "workflow", "blocker", "reflection"];
const EXPERIENCE_LIFECYCLES = ["active", "deprecated", "archived"];

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const dbPath = config.dbPath || join(home, "memory", "memory.db");
  const tokenBudget = config.bootTokenBudget ?? 800;
  const maxMessageChars = config.maxMessageChars ?? 4000;
  const minMessageChars = config.minMessageChars ?? 8;
  const autoInjectExperience = config.autoInjectExperience !== false;
  const experienceMaxItems = config.experienceMaxItems ?? 2;
  const experienceMaxChars = config.experienceMaxChars ?? 400;
  const experienceMinConfidence = config.experienceMinConfidence ?? 0.3;
  const projectId = config.projectId ?? null;
  const defaultVisibility = config.visibility ?? (projectId ? "project" : "private");
  const experienceReinjectAfterTurns = Math.max(
    0,
    Number(config.experienceReinjectAfterTurns ?? 0),
  );

  const store = new SqliteMemoryStore(dbPath);
  const experience = new SqliteExperienceStore(dbPath);
  const episodes = new SqliteEpisodeStore(dbPath);
  let snapshot = store.boot({ tokenBudget, projectId });
  const refresh = () => {
    snapshot = store.boot({ tokenBudget, projectId });
  };

  const buffers = new Map();
  const situations = new Map();
  const injectedExperience = new Map();

  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: "astronexus-memory",
      order: 1200,
      text: () => snapshot.text,
      required: true,
    }),
  );

  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: "astronexus-experience",
      order: 1210,
      text: (assembly) => {
        if (!autoInjectExperience) return "";
        const agentId = assembly && assembly.agent && assembly.agent.id;
        if (!agentId) return "";
        const situation = situations.get(agentId);
        if (!situation) return "";
        const state = injectedExperience.get(agentId);
        if (state && state.turn === situation.turn) return state.text;

        const exclude = new Set();
        if (state) {
          for (const [experienceId, lastTurn] of state.lastTurns) {
            if (
              experienceReinjectAfterTurns <= 0 ||
              situation.turn - lastTurn < experienceReinjectAfterTurns
            ) {
              exclude.add(experienceId);
            }
          }
        }

        const hits = experience.searchSync({
          situation: situation.text,
          limit: 10,
          ...(projectId ? { projectId } : {}),
        });
        const selected = selectExperienceForInjection(hits, {
          maxItems: experienceMaxItems,
          maxChars: experienceMaxChars,
          minConfidence: experienceMinConfidence,
          excludeIds: exclude,
        });
        const lastTurns = new Map(state ? state.lastTurns : []);
        for (const item of selected.items) lastTurns.set(item.experienceId, situation.turn);
        injectedExperience.set(agentId, {
          turn: situation.turn,
          text: selected.text,
          lastTurns,
        });
        return selected.text;
      },
      required: true,
    }),
  );

  ctx.effect(() =>
    ctx.on("agent/pre-step", async (payload, next) => {
      const decision = await next();
      if (decision && decision.kind === "enter") {
        const text = lastUserText(decision.messages);
        if (text !== "") {
          situations.set(payload.agent.id, { text, turn: payload.turn });
        }
      }
      return decision;
    }),
  );

  ctx.effect(() =>
    ctx.on("agent/disposed", ({ agent }) => {
      situations.delete(agent.id);
      injectedExperience.delete(agent.id);
    }),
  );

  ctx.effect(() =>
    ctx.on("session/event", (session, event) => {
      try {
        handleEvent(session, event);
      } catch {
        // A malformed event must never break the session feed.
      }
    }),
  );

  ctx.effect(() => ctx.tools.register(memorySearchTool(store, projectId)));
  ctx.effect(() =>
    ctx.tools.register(
      memoryRememberTool(store, refresh, { projectId, visibility: defaultVisibility }),
    ),
  );
  ctx.effect(() => ctx.tools.register(memoryCorrectTool(store, refresh, projectId)));
  ctx.effect(() => ctx.tools.register(memoryListTool(store, projectId)));
  ctx.effect(() => ctx.tools.register(memoryForgetTool(store, refresh)));
  ctx.effect(() => ctx.tools.register(memoryExportTool(store)));
  ctx.effect(() => ctx.tools.register(memoryStatsTool(store)));
  ctx.effect(() => ctx.tools.register(experienceSearchTool(experience, projectId)));
  ctx.effect(() =>
    ctx.tools.register(
      experienceRememberTool(experience, {
        projectId,
        visibility: defaultVisibility,
      }),
    ),
  );
  ctx.effect(() => ctx.tools.register(experienceFeedbackTool(experience)));
  ctx.effect(() => ctx.tools.register(experienceListTool(experience, projectId)));
  ctx.effect(() => ctx.tools.register(experienceExportTool(experience)));

  ctx.effect(() => () => {
    store.close().catch(() => {});
    experience.close().catch(() => {});
    episodes.close().catch(() => {});
  });

  function handleEvent(session, event) {
    if (event.type === "turn/start") {
      const turn = Number(event.data && event.data.turn);
      if (!Number.isFinite(turn)) return;
      buffers.set(session.id, {
        turn,
        startedAt: Number(event.time ?? Date.now()),
        messages: [],
      });
      return;
    }

    if (event.type === "turn/end") {
      const buffer = buffers.get(session.id);
      if (!buffer) return;
      buffers.delete(session.id);
      if (buffer.messages.length === 0) return;
      episodes
        .record({
          sessionId: session.id,
          turn: buffer.turn,
          transcript: buffer.messages,
          startedAt: buffer.startedAt,
          endedAt: Number(event.time ?? Date.now()),
        })
        .catch(() => {});
      return;
    }

    if (event.type !== "user/message" && event.type !== "assistant/message") return;
    const message =
      event.type === "user/message" ? event.data : event.data && event.data.message;
    if (message && message.source && message.source.kind === "runtime-context") return;
    const text = extractText(message)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxMessageChars);
    if (text.length < minMessageChars) return;
    if (text.startsWith("/")) return;

    const buffer = buffers.get(session.id);
    if (buffer) {
      buffer.messages.push({
        role: event.type === "user/message" ? "user" : "assistant",
        text,
        seq: Number(event.seq),
      });
    }

    if (event.type !== "user/message") return;
    store
      .ingest({
        kind: "fact",
        payload: { text },
        searchText: text,
        sourceRef: `${session.id}:${event.seq}`,
        externalId: `dsh:${session.id}:${event.seq}`,
        projectId,
        visibility: defaultVisibility,
      })
      .then((result) => {
        if (result.created) refresh();
      })
      .catch(() => {});
  }
}

function memorySearchTool(store, defaultProjectId = null) {
  return {
    name: "memory_search",
    description: "Search knowledge (facts, preferences, decisions) in long-term memory.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text." },
        kind: { type: "string", enum: KINDS, description: "Restrict to one kind." },
        projectId: { type: "string", description: "Project scope; defaults to the deployment project." },
        limit: { type: "number", description: "Maximum hits, default 10." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      schema: hitsSchema(
        ["memoryId", "kind", "text", "sourceRef", "score"],
        ["memoryId", "kind", "text", "sourceRef", "score"],
      ),
      render: (_args, value) => renderText(value),
    },
    execute: async (args) => {
      const projectId = args.projectId ? String(args.projectId) : defaultProjectId;
      const hits = await store.retrieve({
        text: String(args.query ?? ""),
        ...(args.kind ? { kind: args.kind } : {}),
        ...(projectId ? { projectId } : {}),
        ...(args.limit ? { limit: Number(args.limit) } : {}),
      });
      return {
        hits: hits.map((hit) => ({
          memoryId: hit.event.memoryId,
          kind: hit.event.kind,
          text: hit.event.searchText,
          sourceRef: hit.event.sourceRef ?? "",
          score: hit.score,
        })),
      };
    },
  };
}

function memoryRememberTool(store, refresh, defaults = {}) {
  return {
    name: "memory_remember",
    description: "Store an explicit knowledge item (fact, preference, decision, workflow, blocker).",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        kind: { type: "string", enum: KINDS },
        sourceRef: { type: "string" },
        projectId: { type: "string", description: "Project scope; defaults to the deployment project." },
        visibility: { type: "string", enum: ["private", "project", "global"] },
      },
      required: ["text"],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema(
        { memoryId: { type: "string" }, eventId: { type: "number" } },
        ["memoryId", "eventId"],
      ),
      render: (_args, value) => renderText(value),
    },
    execute: async (args) => {
      const text = String(args.text ?? "").trim();
      if (text === "") throw new Error("memory_remember requires non-empty text");
      const projectId = args.projectId ? String(args.projectId) : (defaults.projectId ?? null);
      const visibility = args.visibility ?? defaults.visibility ?? "private";
      const result = await store.ingest({
        kind: args.kind ?? "fact",
        payload: { text },
        searchText: text,
        ...(args.sourceRef ? { sourceRef: String(args.sourceRef) } : {}),
        projectId,
        visibility,
      });
      if (result.created) refresh();
      return { memoryId: result.event.memoryId, eventId: result.event.eventId };
    },
  };
}

function memoryCorrectTool(store, refresh, defaultProjectId = null) {
  return {
    name: "memory_correct",
    description: "Replace a knowledge item with a corrected version; history is retained.",
    parameters: {
      type: "object",
      properties: {
        memoryId: { type: "string" },
        text: { type: "string" },
        kind: { type: "string", enum: KINDS },
        projectId: { type: "string" },
        visibility: { type: "string", enum: ["private", "project", "global"] },
      },
      required: ["memoryId", "text"],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema(
        {
          memoryId: { type: "string" },
          eventId: { type: "number" },
          previousEventId: { type: "number" },
        },
        ["memoryId", "eventId", "previousEventId"],
      ),
      render: (_args, value) => renderText(value),
    },
    execute: async (args) => {
      const text = String(args.text ?? "").trim();
      if (text === "") throw new Error("memory_correct requires non-empty text");
      const projectId = args.projectId ? String(args.projectId) : defaultProjectId;
      const result = await store.correct({
        memoryId: String(args.memoryId),
        payload: { text },
        searchText: text,
        ...(args.kind ? { kind: args.kind } : {}),
        ...(projectId ? { projectId } : {}),
        ...(args.visibility ? { visibility: args.visibility } : {}),
      });
      refresh();
      return {
        memoryId: result.event.memoryId,
        eventId: result.event.eventId,
        previousEventId: result.previousEventId ?? 0,
      };
    },
  };
}

function memoryListTool(store, defaultProjectId = null) {
  return {
    name: "memory_list",
    description: "List knowledge entries, newest first.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: KINDS },
        includeInactive: { type: "boolean" },
        projectId: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    output: {
      schema: itemsSchema(
        {
          memoryId: { type: "string" },
          kind: { type: "string" },
          text: { type: "string" },
          lifecycle: { type: "string" },
          sourceRef: { type: "string" },
          eventTime: { type: "number" },
        },
        ["memoryId", "kind", "text", "lifecycle", "sourceRef", "eventTime"],
      ),
      render: (_args, value) => renderText(value),
    },
    execute: async (args) => {
      const projectId = args.projectId ? String(args.projectId) : defaultProjectId;
      const events = await store.list({
        ...(args.kind ? { kind: args.kind } : {}),
        ...(args.includeInactive
          ? { lifecycles: ["active", "decayed", "archived", "soft_deleted"] }
          : {}),
        ...(projectId ? { projectId } : {}),
        ...(args.limit ? { limit: Number(args.limit) } : {}),
      });
      return {
        items: events.map((event) => ({
          memoryId: event.memoryId,
          kind: event.kind,
          text: event.searchText,
          lifecycle: event.lifecycle,
          sourceRef: event.sourceRef ?? "",
          eventTime: event.eventTime,
        })),
      };
    },
  };
}

function memoryForgetTool(store, refresh) {
  return {
    name: "memory_forget",
    description: "Soft-delete a knowledge item. History is retained.",
    parameters: {
      type: "object",
      properties: { memoryId: { type: "string" } },
      required: ["memoryId"],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema(
        {
          memoryId: { type: "string" },
          eventId: { type: "number" },
          lifecycle: { type: "string" },
        },
        ["memoryId", "eventId", "lifecycle"],
      ),
      render: (_args, value) => renderText(value),
    },
    execute: async (args) => {
      const event = await store.transition(String(args.memoryId), "soft_deleted");
      refresh();
      return {
        memoryId: event.memoryId,
        eventId: event.eventId,
        lifecycle: event.lifecycle,
      };
    },
  };
}

function memoryExportTool(store) {
  return {
    name: "memory_export",
    description: "Export the complete memory history as JSONL.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number" } },
      additionalProperties: false,
    },
    output: {
      schema: objectSchema(
        { lines: { type: "number" }, jsonl: { type: "string" } },
        ["lines", "jsonl"],
      ),
      render: (_args, value) => renderText(value),
    },
    execute: async (args) => {
      const limit = Math.min(Math.max(Number(args.limit ?? 200), 1), 1000);
      const lines = [];
      for await (const line of store.exportJsonl()) {
        lines.push(line.trim());
        if (lines.length >= limit) break;
      }
      return { lines: lines.length, jsonl: lines.join("\n") };
    },
  };
}

function memoryStatsTool(store) {
  return {
    name: "memory_stats",
    description: "Show knowledge counts by kind and lifecycle.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: objectSchema(
        {
          totalEvents: { type: "number" },
          active: { type: "number" },
          byKind: countObject(KINDS),
          byLifecycle: countObject(["active", "decayed", "archived", "soft_deleted"]),
        },
        ["totalEvents", "active", "byKind", "byLifecycle"],
      ),
      render: (_args, value) => renderText(value),
    },
    execute: async () => store.stats(),
  };
}

function experienceSearchTool(store, defaultProjectId = null) {
  return {
    name: "experience_search",
    description:
      "Search the experience layer for past situations, actions, outcomes, and lessons.",
    parameters: {
      type: "object",
      properties: {
        situation: { type: "string", description: "Current situation or problem." },
        tags: { type: "array", items: { type: "string" } },
        projectId: { type: "string", description: "Project scope; defaults to the deployment project." },
        includeDeprecated: { type: "boolean" },
        limit: { type: "number" },
      },
      required: ["situation"],
      additionalProperties: false,
    },
    output: {
      schema: itemsSchema(experienceFields(), experienceRequired()),
      render: (_args, value) => renderText(value),
    },
    execute: async (args) => {
      const projectId = args.projectId ? String(args.projectId) : defaultProjectId;
      const hits = await store.search({
        situation: String(args.situation ?? ""),
        ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
        ...(projectId ? { projectId } : {}),
        ...(args.includeDeprecated ? { includeDeprecated: true } : {}),
        ...(args.limit ? { limit: Number(args.limit) } : {}),
      });
      return { items: hits.map((hit) => experienceView(hit.experience, hit.score)) };
    },
  };
}

function experienceRememberTool(store, defaults = {}) {
  return {
    name: "experience_remember",
    description:
      "Store or revise an experience: the situation, what was done, the outcome, and the lesson.",
    parameters: {
      type: "object",
      properties: {
        experienceId: { type: "string", description: "Revise this experience instead of creating one." },
        situation: { type: "string" },
        action: { type: "string" },
        outcome: { type: "string" },
        lesson: { type: "string" },
        conditions: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
        baseConfidence: { type: "number" },
        projectId: { type: "string", description: "Project scope; defaults to the deployment project." },
        visibility: { type: "string", enum: ["private", "project", "global"] },
      },
      required: ["situation", "lesson"],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema(
        { experienceId: { type: "string" }, eventId: { type: "number" }, created: { type: "boolean" } },
        ["experienceId", "eventId", "created"],
      ),
      render: (_args, value) => renderText(value),
    },
    execute: async (args) => {
      const projectId = args.projectId ? String(args.projectId) : (defaults.projectId ?? null);
      const visibility = args.visibility ?? defaults.visibility ?? "private";
      const result = await store.remember({
        situation: String(args.situation ?? ""),
        lesson: String(args.lesson ?? ""),
        ...(args.experienceId ? { experienceId: String(args.experienceId) } : {}),
        ...(args.action ? { action: String(args.action) } : {}),
        ...(args.outcome ? { outcome: String(args.outcome) } : {}),
        ...(Array.isArray(args.conditions) ? { conditions: args.conditions.map(String) } : {}),
        ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
        ...(typeof args.baseConfidence === "number" ? { baseConfidence: args.baseConfidence } : {}),
        projectId,
        visibility,
      });
      return {
        experienceId: result.experience.experienceId,
        eventId: result.experience.eventId,
        created: result.created,
      };
    },
  };
}

function experienceFeedbackTool(store) {
  return {
    name: "experience_feedback",
    description: "Record whether an applied experience worked; confidence moves with the result.",
    parameters: {
      type: "object",
      properties: {
        experienceId: { type: "string" },
        success: { type: "boolean" },
        sourceRef: { type: "string" },
      },
      required: ["experienceId", "success"],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema(
        {
          experienceId: { type: "string" },
          successCount: { type: "number" },
          failureCount: { type: "number" },
          confidence: { type: "number" },
          lifecycle: { type: "string" },
        },
        ["experienceId", "successCount", "failureCount", "confidence", "lifecycle"],
      ),
      render: (_args, value) => renderText(value),
    },
    execute: async (args) =>
      store.feedback({
        experienceId: String(args.experienceId),
        success: args.success === true,
        ...(args.sourceRef ? { sourceRef: String(args.sourceRef) } : {}),
      }),
  };
}

function experienceListTool(store, defaultProjectId = null) {
  return {
    name: "experience_list",
    description: "List experience entries, optionally by lifecycle and tags.",
    parameters: {
      type: "object",
      properties: {
        lifecycle: { type: "array", items: { type: "string", enum: EXPERIENCE_LIFECYCLES } },
        tags: { type: "array", items: { type: "string" } },
        projectId: { type: "string", description: "Project scope; defaults to the deployment project." },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    output: {
      schema: itemsSchema(experienceFields(), experienceRequired()),
      render: (_args, value) => renderText(value),
    },
    execute: async (args) => {
      const projectId = args.projectId ? String(args.projectId) : defaultProjectId;
      const events = await store.list({
        ...(Array.isArray(args.lifecycle) ? { lifecycle: args.lifecycle.map(String) } : {}),
        ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
        ...(projectId ? { projectId } : {}),
        ...(args.limit ? { limit: Number(args.limit) } : {}),
      });
      return { items: events.map((event) => experienceView(event, 0)) };
    },
  };
}

function experienceExportTool(store) {
  return {
    name: "experience_export",
    description: "Export the complete experience history as JSONL.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number" } },
      additionalProperties: false,
    },
    output: {
      schema: objectSchema(
        { lines: { type: "number" }, jsonl: { type: "string" } },
        ["lines", "jsonl"],
      ),
      render: (_args, value) => renderText(value),
    },
    execute: async (args) => {
      const limit = Math.min(Math.max(Number(args.limit ?? 200), 1), 1000);
      const lines = [];
      for await (const line of store.exportJsonl()) {
        lines.push(line.trim());
        if (lines.length >= limit) break;
      }
      return { lines: lines.length, jsonl: lines.join("\n") };
    },
  };
}

function experienceFields() {
  return {
    experienceId: { type: "string" },
    situation: { type: "string" },
    action: { type: "string" },
    outcome: { type: "string" },
    lesson: { type: "string" },
    conditions: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    successCount: { type: "number" },
    failureCount: { type: "number" },
    lifecycle: { type: "string" },
    score: { type: "number" },
  };
}

function experienceRequired() {
  return [
    "experienceId",
    "situation",
    "action",
    "outcome",
    "lesson",
    "conditions",
    "tags",
    "confidence",
    "successCount",
    "failureCount",
    "lifecycle",
    "score",
  ];
}

function experienceView(event, score) {
  return {
    experienceId: event.experienceId,
    situation: event.situation,
    action: event.action,
    outcome: event.outcome,
    lesson: event.lesson,
    conditions: [...event.conditions],
    tags: [...event.tags],
    confidence: event.confidence,
    successCount: event.successCount,
    failureCount: event.failureCount,
    lifecycle: event.lifecycle,
    score,
  };
}

function renderText(value) {
  return [{ type: TEXT_BLOCK, text: JSON.stringify(value, null, 2) }];
}

function extractText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  const parts = [];
  for (const block of message.content) {
    if (block && block.type === TEXT_BLOCK && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    if (message.source && message.source.kind === "runtime-context") continue;
    const text = extractText(message)
      .replace(/\s+/g, " ")
      .trim();
    if (text !== "") return text;
  }
  return "";
}

function objectSchema(properties, required) {
  return { type: "object", properties, required, additionalProperties: false };
}

function itemsSchema(itemProperties, itemRequired) {
  return objectSchema(
    {
      items: {
        type: "array",
        items: objectSchema(itemProperties, itemRequired),
      },
    },
    ["items"],
  );
}

function hitsSchema(fields, required) {
  return objectSchema(
    {
      hits: {
        type: "array",
        items: objectSchema(
          Object.fromEntries(fields.map((field) => [field, { type: field === "score" ? "number" : "string" }])),
          required,
        ),
      },
    },
    ["hits"],
  );
}

function countObject(keys) {
  return {
    type: "object",
    properties: Object.fromEntries(keys.map((key) => [key, { type: "number" }])),
    required: [...keys],
    additionalProperties: false,
  };
}

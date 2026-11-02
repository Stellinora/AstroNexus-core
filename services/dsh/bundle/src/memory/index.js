import { homedir } from "node:os";
import { join } from "node:path";

import { SqliteMemoryStore } from "../domain/memory/sqlite-store.ts";

export const name = "astronexus-memory";
export const inject = ["systemPrompt", "tools"];

const TEXT_BLOCK = "text";
const KINDS = ["fact", "preference", "decision", "workflow", "blocker", "reflection"];

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const dbPath = config.dbPath || join(home, "memory", "memory.db");
  const tokenBudget = config.bootTokenBudget ?? 800;
  const maxMessageChars = config.maxMessageChars ?? 4000;
  const minMessageChars = config.minMessageChars ?? 8;

  const store = new SqliteMemoryStore(dbPath);
  let snapshot = store.boot({ tokenBudget });
  const refresh = () => {
    snapshot = store.boot({ tokenBudget });
  };

  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: "astronexus-memory",
      order: 1200,
      text: () => snapshot.text,
      required: true,
    }),
  );

  ctx.effect(() =>
    ctx.on("session/event", (session, event) => {
      try {
        if (event.type !== "user/message" && event.type !== "assistant/message") return;
        const text = extractText(event.data && event.data.message)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, maxMessageChars);
        if (text.length < minMessageChars) return;
        if (text.startsWith("/")) return;
        const kind = event.type === "user/message" ? "fact" : "reflection";
        store
          .ingest({
            kind,
            payload: { text },
            searchText: text,
            sourceRef: `${session.id}:${event.seq}`,
            externalId: `dsh:${session.id}:${event.seq}`,
          })
          .then((result) => {
            if (result.created) refresh();
          })
          .catch(() => {});
      } catch {
        // A malformed event must never break the session feed.
      }
    }),
  );

  ctx.effect(() => ctx.tools.register(memorySearchTool(store)));
  ctx.effect(() => ctx.tools.register(memoryRememberTool(store, refresh)));
  ctx.effect(() => ctx.tools.register(memoryCorrectTool(store, refresh)));
  ctx.effect(() => ctx.tools.register(memoryListTool(store)));
  ctx.effect(() => ctx.tools.register(memoryForgetTool(store, refresh)));
  ctx.effect(() => ctx.tools.register(memoryExportTool(store)));

  ctx.effect(() => () => {
    store.close().catch(() => {});
  });
}

function memorySearchTool(store) {
  return {
    name: "memory_search",
    description:
      "Search long-term memory for relevant facts, preferences, decisions, workflows, blockers, or reflections.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text." },
        kind: { type: "string", enum: KINDS, description: "Restrict to one memory kind." },
        limit: { type: "number", description: "Maximum hits, default 10." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          hits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                memoryId: { type: "string" },
                kind: { type: "string" },
                text: { type: "string" },
                sourceRef: { type: "string" },
                score: { type: "number" },
              },
              required: ["memoryId", "kind", "text", "sourceRef", "score"],
              additionalProperties: false,
            },
          },
        },
        required: ["hits"],
        additionalProperties: false,
      },
      render: (_args, value) => renderText(value),
    },
    execute: async (args) => {
      const hits = await store.retrieve({
        text: String(args.query ?? ""),
        ...(args.kind ? { kind: args.kind } : {}),
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

function memoryRememberTool(store, refresh) {
  return {
    name: "memory_remember",
    description: "Store an explicit user-provided fact, preference, decision, workflow, blocker, or reflection.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Memory text to store." },
        kind: { type: "string", enum: KINDS, description: "Memory kind, default fact." },
        sourceRef: { type: "string", description: "Optional source reference." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          memoryId: { type: "string" },
          eventId: { type: "number" },
        },
        required: ["memoryId", "eventId"],
        additionalProperties: false,
      },
      render: (_args, value) => renderText(value),
    },
    execute: async (args) => {
      const text = String(args.text ?? "").trim();
      if (text === "") throw new Error("memory_remember requires non-empty text");
      const result = await store.ingest({
        kind: args.kind ?? "fact",
        payload: { text },
        searchText: text,
        ...(args.sourceRef ? { sourceRef: String(args.sourceRef) } : {}),
      });
      if (result.created) refresh();
      return { memoryId: result.event.memoryId, eventId: result.event.eventId };
    },
  };
}

function memoryCorrectTool(store, refresh) {
  return {
    name: "memory_correct",
    description: "Replace a memory's current content with a corrected version; the previous version stays in history.",
    parameters: {
      type: "object",
      properties: {
        memoryId: { type: "string" },
        text: { type: "string" },
        kind: { type: "string", enum: KINDS },
      },
      required: ["memoryId", "text"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          memoryId: { type: "string" },
          eventId: { type: "number" },
          previousEventId: { type: "number" },
        },
        required: ["memoryId", "eventId", "previousEventId"],
        additionalProperties: false,
      },
      render: (_args, value) => renderText(value),
    },
    execute: async (args) => {
      const text = String(args.text ?? "").trim();
      if (text === "") throw new Error("memory_correct requires non-empty text");
      const result = await store.correct({
        memoryId: String(args.memoryId),
        payload: { text },
        searchText: text,
        ...(args.kind ? { kind: args.kind } : {}),
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

function memoryListTool(store) {
  return {
    name: "memory_list",
    description: "List current memory entries, newest first.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: KINDS },
        includeInactive: { type: "boolean", description: "Include decayed, archived, and soft-deleted entries." },
        limit: { type: "number", description: "Maximum entries, default 50." },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                memoryId: { type: "string" },
                kind: { type: "string" },
                text: { type: "string" },
                lifecycle: { type: "string" },
                sourceRef: { type: "string" },
                eventTime: { type: "number" },
              },
              required: ["memoryId", "kind", "text", "lifecycle", "sourceRef", "eventTime"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
      render: (_args, value) => renderText(value),
    },
    execute: async (args) => {
      const events = await store.list({
        ...(args.kind ? { kind: args.kind } : {}),
        ...(args.includeInactive
          ? { lifecycles: ["active", "decayed", "archived", "soft_deleted"] }
          : {}),
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
    description: "Soft-delete a memory. The version chain stays in history and can still be exported.",
    parameters: {
      type: "object",
      properties: {
        memoryId: { type: "string" },
      },
      required: ["memoryId"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          memoryId: { type: "string" },
          eventId: { type: "number" },
          lifecycle: { type: "string" },
        },
        required: ["memoryId", "eventId", "lifecycle"],
        additionalProperties: false,
      },
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
    description: "Export the complete memory event history as JSONL, including superseded versions.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum events, default 200, max 1000." },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          lines: { type: "number" },
          jsonl: { type: "string" },
        },
        required: ["lines", "jsonl"],
        additionalProperties: false,
      },
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

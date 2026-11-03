import { homedir } from "node:os";
import { join } from "node:path";

import { SqliteMemoryStore } from "../domain/memory/sqlite-store.ts";

export const name = "astronexus-reflect";
export const inject = ["agentDefaultModel"];

const HOUR_MS = 60 * 60 * 1000;
const KINDS = new Set(["fact", "preference", "decision", "workflow", "blocker"]);

const REFLECTION_PROMPT = `You are a memory distiller for a long-lived assistant.
From the transcript, extract durable memories worth keeping: stable facts, user preferences, decisions, workflows, and blockers.
Ignore greetings, transient task details, code dumps, and speculation.
Return ONLY a JSON array, no prose and no code fences:
[{"kind":"fact|preference|decision|workflow|blocker","text":"..."}]
Use the user's language. Keep each text under 200 characters. At most 20 items.`;

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const dbPath = config.dbPath || join(home, "memory", "memory.db");
  const intervalMs = config.intervalMs ?? HOUR_MS;
  const maintenance = {
    ...(config.decayAfterMs ? { decayAfterMs: config.decayAfterMs } : {}),
    ...(config.archiveAfterMs ? { archiveAfterMs: config.archiveAfterMs } : {}),
  };
  const reflection = {
    ...(config.provider ? { provider: config.provider } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.batchSize ? { batchSize: config.batchSize } : {}),
    ...(config.maxInputChars ? { maxInputChars: config.maxInputChars } : {}),
    ...(config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {}),
  };

  const store = new SqliteMemoryStore(dbPath);
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await store.maintenance(maintenance);
      if (config.reflection !== false) {
        await reflectOnce(ctx, store, reflection);
      }
    } catch {
      // A maintenance or reflection failure must not break the host.
    } finally {
      busy = false;
    }
  };

  const prime = setTimeout(() => {
    void tick();
  }, config.primeDelayMs ?? 5000);
  if (typeof prime.unref === "function") prime.unref();

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  ctx.effect(() => () => {
    clearTimeout(prime);
    clearInterval(timer);
  });
  ctx.effect(() => () => {
    store.close().catch(() => {});
  });
}

export async function reflectOnce(ctx, store, options = {}) {
  const batchSize = options.batchSize ?? 30;
  const events = await store.recentUnreflected(batchSize);
  if (events.length === 0) return { scanned: 0, extracted: 0 };

  const selection =
    options.provider && options.model
      ? { provider: options.provider, model: options.model }
      : ctx.agentDefaultModel && typeof ctx.agentDefaultModel.currentSelection === "function"
        ? ctx.agentDefaultModel.currentSelection()
        : undefined;
  if (!selection || !selection.provider || !selection.model) {
    return { scanned: events.length, extracted: 0, skipped: "no-model" };
  }

  const transcript = events
    .map((event) => `[${event.kind}] ${event.searchText}`)
    .join("\n")
    .slice(0, options.maxInputChars ?? 8000);

  let output = "";
  try {
    const stream = ctx.llm.stream({
      provider: selection.provider,
      model: selection.model,
      system: REFLECTION_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: transcript }] }],
      temperature: 0.2,
      maxTokens: options.maxOutputTokens ?? 800,
    });
    for await (const chunk of stream) {
      if (chunk && chunk.type === "text-delta" && typeof chunk.text === "string") {
        output += chunk.text;
      }
    }
  } catch {
    return { scanned: events.length, extracted: 0, skipped: "llm-error" };
  }

  const items = parseReflectionItems(output);
  const sourceIds = events.map((event) => event.eventId);
  for (const item of items) {
    await store.ingest({
      kind: item.kind,
      payload: { text: item.text },
      searchText: item.text,
      sourceRef: `reflection:${sourceIds.join(",")}`,
    });
  }
  await store.markReflected(sourceIds);
  return { scanned: events.length, extracted: items.length };
}

export function parseReflectionItems(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const items = [];
  const seen = new Set();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const kind = String(entry.kind ?? "");
    const value = String(entry.text ?? "").trim();
    if (!KINDS.has(kind) || value === "") continue;
    const key = `${kind}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind, text: value.slice(0, 200) });
    if (items.length >= 20) break;
  }
  return items;
}

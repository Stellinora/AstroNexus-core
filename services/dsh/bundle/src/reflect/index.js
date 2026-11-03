import { homedir } from "node:os";
import { join } from "node:path";

import { SqliteEpisodeStore } from "../domain/episode/sqlite-store.ts";
import { SqliteExperienceStore } from "../domain/experience/sqlite-store.ts";
import { normalizeMemoryText } from "../domain/memory/maintenance.ts";
import { SqliteMemoryStore } from "../domain/memory/sqlite-store.ts";

export const name = "astronexus-reflect";
export const inject = ["agentDefaultModel", "llm"];

const HOUR_MS = 60 * 60 * 1000;
const KNOWLEDGE_KINDS = new Set([
  "fact",
  "preference",
  "decision",
  "workflow",
  "blocker",
]);

const REFLECTION_PROMPT = `You are a memory distiller for a long-lived assistant.
You receive turn-level transcripts. Extract two things:

1. Durable knowledge: stable facts, user preferences, decisions.
2. Experience: reusable lessons from how a situation was handled.

Return ONLY JSON, no prose and no code fences:
{"knowledge":[{"kind":"fact|preference|decision","text":"..."}],
 "experience":[{"situation":"...","action":"...","outcome":"...","lesson":"...","conditions":["..."],"tags":["..."]}]}

Rules:
- Ignore greetings, transient task details, code dumps, and speculation.
- "situation" is the trigger or problem pattern; "lesson" is the reusable takeaway.
- Use the user's language. Keep each text under 200 characters.
- At most 20 items total. Empty arrays are allowed.`;

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const dbPath = config.dbPath || join(home, "memory", "memory.db");
  const intervalMs = config.intervalMs ?? HOUR_MS;
  const debug = config.debug === true;
  const log = (...args) => {
    if (debug) console.error("[astronexus-reflect]", ...args);
  };

  const memory = new SqliteMemoryStore(dbPath);
  const experience = new SqliteExperienceStore(dbPath);
  const episodes = new SqliteEpisodeStore(dbPath);

  const memoryMaintenance = {
    ...(config.decayAfterMs ? { decayAfterMs: config.decayAfterMs } : {}),
    ...(config.archiveAfterMs ? { archiveAfterMs: config.archiveAfterMs } : {}),
  };
  const experienceMaintenance = {
    ...(config.minFeedback ? { minFeedback: config.minFeedback } : {}),
    ...(config.minConfidence ? { minConfidence: config.minConfidence } : {}),
    ...(config.experienceArchiveAfterMs
      ? { archiveAfterMs: config.experienceArchiveAfterMs }
      : {}),
  };
  const reflection = {
    ...(config.provider ? { provider: config.provider } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.batchSize ? { batchSize: config.batchSize } : {}),
    ...(config.maxInputChars ? { maxInputChars: config.maxInputChars } : {}),
    ...(config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {}),
    ...(config.projectId ? { projectId: config.projectId } : {}),
    ...(config.visibility ? { visibility: config.visibility } : {}),
    ...(debug ? { debug } : {}),
  };

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    log("tick start");
    try {
      await memory.maintenance(memoryMaintenance);
      await experience.maintenance(experienceMaintenance);
      log("maintenance done");
      if (config.reflection !== false) {
        const result = await reflectOnce(ctx, { memory, experience, episodes }, reflection);
        log("reflection", result);
      }
    } catch (error) {
      log("tick error", error && error.message ? error.message : error);
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
    memory.close().catch(() => {});
    experience.close().catch(() => {});
    episodes.close().catch(() => {});
  });
}

export async function reflectOnce(ctx, stores, options = {}) {
  const batchSize = options.batchSize ?? 5;
  const batch = await stores.episodes.recentUnreflected(batchSize);
  if (batch.length === 0) return { episodes: 0, knowledge: 0, experience: 0 };

  const selection =
    options.provider && options.model
      ? { provider: options.provider, model: options.model }
      : ctx.agentDefaultModel && typeof ctx.agentDefaultModel.currentSelection === "function"
        ? ctx.agentDefaultModel.currentSelection()
        : undefined;
  if (!selection || !selection.provider || !selection.model) {
    return { episodes: batch.length, knowledge: 0, experience: 0, skipped: "no-model" };
  }

  const transcript = batch
    .map((episode) => {
      const lines = episode.transcript.map((message) => `${message.role}: ${message.text}`);
      return `--- episode ${episode.episodeId} (turn ${episode.turn})\n${lines.join("\n")}`;
    })
    .join("\n\n")
    .slice(0, options.maxInputChars ?? 8000);

  let output = "";
  try {
    const stream = ctx.llm.stream({
      provider: selection.provider,
      model: selection.model,
      system: REFLECTION_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: transcript }] }],
      temperature: 0.2,
      maxTokens: options.maxOutputTokens ?? 1000,
    });
    for await (const chunk of stream) {
      if (chunk && chunk.type === "text-delta" && typeof chunk.text === "string") {
        output += chunk.text;
      }
    }
  } catch (error) {
    if (options.debug) {
      console.error("[astronexus-reflect] llm error", error && error.message ? error.message : error);
    }
    return { episodes: batch.length, knowledge: 0, experience: 0, skipped: "llm-error" };
  }

  const parsed = parseReflectionOutput(output);
  const episodeIds = batch.map((episode) => episode.episodeId);
  const projectId = options.projectId ?? null;
  const visibility = options.visibility ?? (projectId ? "project" : "private");

  const existingKnowledge = await stores.memory.list({
    limit: 500,
    ...(projectId ? { projectId } : {}),
  });
  const knowledgeSeen = new Set(
    existingKnowledge.map((item) => `${item.kind}:${normalizeMemoryText(item.searchText)}`),
  );
  let knowledgeWritten = 0;
  for (const item of parsed.knowledge) {
    const key = `${item.kind}:${normalizeMemoryText(item.text)}`;
    if (knowledgeSeen.has(key)) continue;
    knowledgeSeen.add(key);
    await stores.memory.ingest({
      kind: item.kind,
      payload: { text: item.text },
      searchText: item.text,
      sourceRef: `episode:${episodeIds.join(",")}`,
      projectId,
      visibility,
    });
    knowledgeWritten += 1;
  }

  const existingExperience = await stores.experience.list({
    limit: 500,
    ...(projectId ? { projectId } : {}),
  });
  const experienceSeen = new Set(
    existingExperience.map(
      (item) =>
        `${normalizeMemoryText(item.situation)}::${normalizeMemoryText(item.lesson)}`,
    ),
  );
  let experienceWritten = 0;
  for (const item of parsed.experience) {
    const key = `${normalizeMemoryText(item.situation)}::${normalizeMemoryText(item.lesson)}`;
    if (experienceSeen.has(key)) continue;
    experienceSeen.add(key);
    await stores.experience.remember({
      situation: item.situation,
      action: item.action,
      outcome: item.outcome,
      lesson: item.lesson,
      conditions: item.conditions,
      tags: item.tags,
      projectId: options.projectId ?? null,
      visibility: options.visibility ?? (options.projectId ? "project" : "private"),
      sourceRefs: episodeIds.map((id) => `episode:${id}`),
    });
    experienceWritten += 1;
  }

  await stores.episodes.markReflected(episodeIds);
  return {
    episodes: batch.length,
    knowledge: knowledgeWritten,
    experience: experienceWritten,
  };
}

export function parseReflectionOutput(text) {
  const empty = { knowledge: [], experience: [] };
  if (typeof text !== "string") return empty;

  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (
    objectStart !== -1 &&
    (arrayStart === -1 || objectStart < arrayStart) &&
    objectEnd > objectStart
  ) {
    try {
      const value = JSON.parse(text.slice(objectStart, objectEnd + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return {
          knowledge: normalizeKnowledge(value.knowledge),
          experience: normalizeExperience(value.experience),
        };
      }
    } catch {
      // Fall through to the legacy array form.
    }
  }

  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try {
      const value = JSON.parse(text.slice(arrayStart, arrayEnd + 1));
      if (Array.isArray(value)) return { knowledge: normalizeKnowledge(value), experience: [] };
    } catch {
      return empty;
    }
  }
  return empty;
}

function normalizeKnowledge(value) {
  if (!Array.isArray(value)) return [];
  const items = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const kind = String(entry.kind ?? "");
    const text = String(entry.text ?? "").trim();
    if (!KNOWLEDGE_KINDS.has(kind) || text === "") continue;
    const key = `${kind}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind, text: text.slice(0, 200) });
    if (items.length >= 20) break;
  }
  return items;
}

function normalizeExperience(value) {
  if (!Array.isArray(value)) return [];
  const items = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const situation = String(entry.situation ?? "").trim();
    const lesson = String(entry.lesson ?? "").trim();
    if (situation === "" || lesson === "") continue;
    const key = `${situation}::${lesson}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      situation: situation.slice(0, 200),
      action: String(entry.action ?? "").trim().slice(0, 200),
      outcome: String(entry.outcome ?? "").trim().slice(0, 200),
      lesson: lesson.slice(0, 200),
      conditions: normalizeStringList(entry.conditions),
      tags: normalizeStringList(entry.tags),
    });
    if (items.length >= 20) break;
  }
  return items;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .slice(0, 10);
}

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { computeConfidence } from "./confidence.ts";
import type {
  ExperienceDraft,
  ExperienceEvent,
  ExperienceFeedbackInput,
  ExperienceFeedbackResult,
  ExperienceHit,
  ExperienceLifecycle,
  ExperienceListQuery,
  ExperienceMaintenanceOptions,
  ExperienceMaintenanceResult,
  ExperienceSearchQuery,
  ExperienceStore,
  ExperienceVisibility,
} from "./contracts.ts";
import { EXPERIENCE_SCHEMA_SQL, experienceHeadClause } from "./schema.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

interface ExperienceRow {
  id: number;
  experience_id: string;
  supersedes_id: number | null;
  situation: string;
  action: string;
  outcome: string;
  lesson: string;
  conditions_json: string;
  tags_json: string;
  search_text: string;
  base_confidence: number;
  lifecycle: string;
  project_id: string | null;
  visibility: string;
  source_refs_json: string;
  event_time: number;
  ingested_at: number;
  external_id: string | null;
  success_count: number;
  failure_count: number;
  fts_score?: number;
}

export interface SqliteExperienceStoreOptions {
  readonly now?: () => number;
}

export class SqliteExperienceStore implements ExperienceStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(path: string, options: SqliteExperienceStoreOptions = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(EXPERIENCE_SCHEMA_SQL);
    this.#now = options.now ?? (() => Date.now());
  }

  async remember(
    draft: ExperienceDraft,
  ): Promise<{ experience: ExperienceEvent; created: boolean }> {
    if (draft.externalId) {
      const existing = this.#byExternalId(draft.externalId);
      if (existing) return { experience: this.#view(existing), created: false };
    }
    const experienceId = draft.experienceId ?? randomUUID();
    let supersedesId: number | null = null;
    if (draft.experienceId) {
      const head = this.#head(draft.experienceId);
      if (!head) throw new Error(`experience not found: ${draft.experienceId}`);
      supersedesId = head.id;
    }
    const row = this.#insert({
      experienceId,
      supersedesId,
      situation: draft.situation.trim(),
      action: (draft.action ?? "").trim(),
      outcome: (draft.outcome ?? "").trim(),
      lesson: draft.lesson.trim(),
      conditions: normalizeList(draft.conditions),
      tags: normalizeList(draft.tags),
      baseConfidence: clamp(draft.baseConfidence ?? 0.6),
      lifecycle: "active",
      projectId: draft.projectId ?? null,
      visibility: draft.visibility ?? "private",
      sourceRefs: [...(draft.sourceRefs ?? [])],
      eventTime: draft.eventTime ?? this.#now(),
      externalId: draft.externalId ?? null,
    });
    return { experience: this.#view(row), created: true };
  }

  async search(query: ExperienceSearchQuery): Promise<readonly ExperienceHit[]> {
    return this.#search(query);
  }

  searchSync(query: ExperienceSearchQuery): readonly ExperienceHit[] {
    return this.#search(query);
  }

  #search(query: ExperienceSearchQuery): readonly ExperienceHit[] {
    const needle = query.situation.trim();
    const tags = normalizeList(query.tags);
    const limit = query.limit ?? 10;
    const lifecycles = query.includeDeprecated ? ["active", "deprecated"] : ["active"];
    const placeholders = lifecycles.map(() => "?").join(", ");
    const params: (string | number)[] = [...lifecycles];
    const normalized = normalizeSearchText(needle);
    const useFts = normalized.length > 6;
    let sql: string;

    if (useFts) {
      sql = `SELECT e.*, ${COUNT_COLUMNS}, -bm25(experience_fts) AS fts_score
             FROM experience_event e
             JOIN experience_fts ON experience_fts.rowid = e.id
             WHERE experience_fts MATCH ?
               AND e.lifecycle IN (${placeholders})
               AND ${experienceHeadClause("e")}`;
      params.unshift(buildFtsQuery(normalized));
    } else {
      sql = `SELECT e.*, ${COUNT_COLUMNS}
             FROM experience_event e
             WHERE e.search_text LIKE ?
               AND e.lifecycle IN (${placeholders})
               AND ${experienceHeadClause("e")}`;
      params.unshift(`%${needle}%`);
    }

    const rows = this.#db.prepare(`${sql} LIMIT 200`).all(...params) as unknown as ExperienceRow[];
    const hits: ExperienceHit[] = [];
    for (const row of rows) {
      const event = this.#view(row);
      if (query.projectId && event.projectId !== query.projectId) continue;
      if (!tags.every((tag) => event.tags.includes(tag))) continue;
      const tagScore = tags.length === 0 ? 0 : tags.length / Math.max(1, event.tags.length);
      hits.push({
        experience: event,
        score: Number(row.fts_score ?? 1) + tagScore + event.confidence,
      });
    }
    hits.sort((left, right) => right.score - left.score);
    return hits.slice(0, limit);
  }

  async list(query: ExperienceListQuery = {}): Promise<readonly ExperienceEvent[]> {
    const lifecycles = query.lifecycle ?? ["active"];
    const tags = normalizeList(query.tags);
    const limit = query.limit ?? 50;
    const placeholders = lifecycles.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(
        `SELECT e.*, ${COUNT_COLUMNS}
         FROM experience_event e
         WHERE e.lifecycle IN (${placeholders})
           AND ${experienceHeadClause("e")}
         ORDER BY e.event_time DESC
         LIMIT 200`,
      )
      .all(...lifecycles) as unknown as ExperienceRow[];
    return rows
      .map((row) => this.#view(row))
      .filter((event) => (query.projectId ? event.projectId === query.projectId : true))
      .filter((event) => tags.every((tag) => event.tags.includes(tag)))
      .slice(0, limit);
  }

  async feedback(input: ExperienceFeedbackInput): Promise<ExperienceFeedbackResult> {
    const head = this.#head(input.experienceId);
    if (!head) throw new Error(`experience not found: ${input.experienceId}`);
    this.#db
      .prepare(
        "INSERT INTO experience_feedback(experience_id, success, source_ref, at) VALUES (?, ?, ?, ?)",
      )
      .run(input.experienceId, input.success ? 1 : 0, input.sourceRef ?? null, this.#now());
    const counts = this.#counts(input.experienceId);
    return {
      experienceId: input.experienceId,
      successCount: counts.success,
      failureCount: counts.failure,
      confidence: computeConfidence(
        Number(head.base_confidence),
        counts.success,
        counts.failure,
      ),
      lifecycle: head.lifecycle as ExperienceLifecycle,
    };
  }

  async transition(experienceId: string, to: ExperienceLifecycle): Promise<ExperienceEvent> {
    const head = this.#head(experienceId);
    if (!head) throw new Error(`experience not found: ${experienceId}`);
    if (head.lifecycle === to) return this.#view(head);
    const row = this.#insert({
      experienceId,
      supersedesId: head.id,
      situation: head.situation,
      action: head.action,
      outcome: head.outcome,
      lesson: head.lesson,
      conditions: parseList(head.conditions_json),
      tags: parseList(head.tags_json),
      baseConfidence: Number(head.base_confidence),
      lifecycle: to,
      projectId: head.project_id,
      visibility: head.visibility as ExperienceVisibility,
      sourceRefs: parseList(head.source_refs_json),
      eventTime: this.#now(),
      externalId: null,
    });
    return this.#view(row);
  }

  async maintenance(
    options: ExperienceMaintenanceOptions = {},
  ): Promise<ExperienceMaintenanceResult> {
    const now = options.now ?? this.#now();
    const minFeedback = options.minFeedback ?? 5;
    const minConfidence = options.minConfidence ?? 0.3;
    const archiveAfterMs = options.archiveAfterMs ?? 180 * DAY_MS;
    const heads = this.#db
      .prepare(
        `SELECT e.*, ${COUNT_COLUMNS}
         FROM experience_event e
         WHERE ${experienceHeadClause("e")}
         ORDER BY e.id ASC`,
      )
      .all() as unknown as ExperienceRow[];

    let deprecated = 0;
    let archived = 0;
    for (const row of heads) {
      const total = Number(row.success_count) + Number(row.failure_count);
      const confidence = computeConfidence(
        Number(row.base_confidence),
        Number(row.success_count),
        Number(row.failure_count),
      );
      if (row.lifecycle === "active" && total >= minFeedback && confidence < minConfidence) {
        await this.transition(row.experience_id, "deprecated");
        deprecated += 1;
        continue;
      }
      if (row.lifecycle === "deprecated" && now - Number(row.event_time) > archiveAfterMs) {
        await this.transition(row.experience_id, "archived");
        archived += 1;
      }
    }
    return { deprecated, archived };
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  #view(row: ExperienceRow): ExperienceEvent {
    const successCount = Number(row.success_count ?? 0);
    const failureCount = Number(row.failure_count ?? 0);
    const baseConfidence = Number(row.base_confidence);
    return {
      eventId: Number(row.id),
      experienceId: row.experience_id,
      supersedesId: row.supersedes_id === null ? null : Number(row.supersedes_id),
      situation: row.situation,
      action: row.action,
      outcome: row.outcome,
      lesson: row.lesson,
      conditions: parseList(row.conditions_json),
      tags: parseList(row.tags_json),
      baseConfidence,
      confidence: computeConfidence(baseConfidence, successCount, failureCount),
      successCount,
      failureCount,
      lifecycle: row.lifecycle as ExperienceLifecycle,
      projectId: row.project_id,
      visibility: row.visibility as ExperienceVisibility,
      sourceRefs: parseList(row.source_refs_json),
      eventTime: Number(row.event_time),
      ingestedAt: Number(row.ingested_at),
      externalId: row.external_id,
    };
  }

  #insert(input: {
    experienceId: string;
    supersedesId: number | null;
    situation: string;
    action: string;
    outcome: string;
    lesson: string;
    conditions: string[];
    tags: string[];
    baseConfidence: number;
    lifecycle: ExperienceLifecycle;
    projectId: string | null;
    visibility: ExperienceVisibility;
    sourceRefs: string[];
    eventTime: number;
    externalId: string | null;
  }): ExperienceRow {
    const searchText = `${input.situation}\n${input.lesson}\n${input.tags.join(" ")}`;
    const ingestedAt = this.#now();
    this.#db.exec("BEGIN");
    try {
      const result = this.#db
        .prepare(
          `INSERT INTO experience_event
             (experience_id, supersedes_id, situation, action, outcome, lesson,
              conditions_json, tags_json, search_text, base_confidence, lifecycle,
              project_id, visibility, source_refs_json, event_time, ingested_at, external_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.experienceId,
          input.supersedesId,
          input.situation,
          input.action,
          input.outcome,
          input.lesson,
          JSON.stringify(input.conditions),
          JSON.stringify(input.tags),
          searchText,
          input.baseConfidence,
          input.lifecycle,
          input.projectId,
          input.visibility,
          JSON.stringify(input.sourceRefs),
          input.eventTime,
          ingestedAt,
          input.externalId,
        );
      const eventId = Number(result.lastInsertRowid);
      this.#db
        .prepare("INSERT INTO experience_fts(rowid, search_text) VALUES (?, ?)")
        .run(eventId, searchText);
      this.#db.exec("COMMIT");
      return {
        id: eventId,
        experience_id: input.experienceId,
        supersedes_id: input.supersedesId,
        situation: input.situation,
        action: input.action,
        outcome: input.outcome,
        lesson: input.lesson,
        conditions_json: JSON.stringify(input.conditions),
        tags_json: JSON.stringify(input.tags),
        search_text: searchText,
        base_confidence: input.baseConfidence,
        lifecycle: input.lifecycle,
        project_id: input.projectId,
        visibility: input.visibility,
        source_refs_json: JSON.stringify(input.sourceRefs),
        event_time: input.eventTime,
        ingested_at: ingestedAt,
        external_id: input.externalId,
        success_count: 0,
        failure_count: 0,
      };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #byExternalId(externalId: string): ExperienceRow | undefined {
    return this.#db
      .prepare(
        `SELECT e.*, ${COUNT_COLUMNS}
         FROM experience_event e
         WHERE e.external_id = ?
         LIMIT 1`,
      )
      .get(externalId) as unknown as ExperienceRow | undefined;
  }

  #head(experienceId: string): ExperienceRow | undefined {
    return this.#db
      .prepare(
        `SELECT e.*, ${COUNT_COLUMNS}
         FROM experience_event e
         WHERE e.experience_id = ? AND ${experienceHeadClause("e")}
         ORDER BY e.id DESC LIMIT 1`,
      )
      .get(experienceId) as unknown as ExperienceRow | undefined;
  }

  #counts(experienceId: string): { success: number; failure: number } {
    const row = this.#db
      .prepare(
        `SELECT
           SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success,
           SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failure
         FROM experience_feedback WHERE experience_id = ?`,
      )
      .get(experienceId) as unknown as { success: number | null; failure: number | null };
    return { success: Number(row?.success ?? 0), failure: Number(row?.failure ?? 0) };
  }
}

const COUNT_COLUMNS = `
  (SELECT COUNT(*) FROM experience_feedback f WHERE f.experience_id = e.experience_id AND f.success = 1) AS success_count,
  (SELECT COUNT(*) FROM experience_feedback f WHERE f.experience_id = e.experience_id AND f.success = 0) AS failure_count
`;

function normalizeList(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function parseList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function quoteFts(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

function normalizeSearchText(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, "");
}

function buildFtsQuery(normalized: string): string {
  if (normalized.length <= 3) return quoteFts(normalized);
  const tokens: string[] = [];
  for (let index = 0; index + 3 <= normalized.length && tokens.length < 24; index += 1) {
    tokens.push(quoteFts(normalized.slice(index, index + 3)));
  }
  return tokens.join(" OR ");
}

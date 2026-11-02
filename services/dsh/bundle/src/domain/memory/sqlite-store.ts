import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildBootSnapshot } from "./boot.ts";
import type {
  BootRequest,
  BootSnapshot,
  CorrectInput,
  CorrectResult,
  IngestInput,
  IngestResult,
  MemoryEvent,
  MemoryKind,
  MemoryLifecycle,
  MemoryStore,
  MaintenanceOptions,
  MaintenanceResult,
  RetrieveQuery,
  RetrievalHit,
} from "./contracts.ts";
import { planMaintenance } from "./maintenance.ts";
import { headClause, MEMORY_SCHEMA_SQL } from "./schema.ts";

interface EventRow {
  id: number;
  memory_id: string;
  supersedes_id: number | null;
  kind: string;
  payload_json: string;
  search_text: string;
  event_time: number;
  ingested_at: number;
  lifecycle: string;
  source_ref: string | null;
  external_id: string | null;
}

export interface SqliteStoreOptions {
  readonly now?: () => number;
}

export class SqliteMemoryStore implements MemoryStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(path: string, options: SqliteStoreOptions = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("PRAGMA foreign_keys = ON;");
    this.#applySchema();
    this.#now = options.now ?? (() => Date.now());
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    if (input.externalId) {
      const existing = this.#byExternalId(input.externalId);
      if (existing) return { event: existing, created: false };
    }
    const row = this.#insert({
      memoryId: input.memoryId ?? randomUUID(),
      supersedesId: null,
      kind: input.kind,
      payload: input.payload,
      searchText: input.searchText ?? JSON.stringify(input.payload),
      eventTime: input.eventTime ?? this.#now(),
      lifecycle: "active",
      sourceRef: input.sourceRef ?? null,
      externalId: input.externalId ?? null,
    });
    return { event: row, created: true };
  }

  async correct(input: CorrectInput): Promise<CorrectResult> {
    const current = this.#head(input.memoryId);
    if (!current) throw new Error(`memory not found: ${input.memoryId}`);
    const event = this.#insert({
      memoryId: input.memoryId,
      supersedesId: current.eventId,
      kind: input.kind ?? current.kind,
      payload: input.payload ?? current.payload,
      searchText: input.searchText ?? current.searchText,
      eventTime: this.#now(),
      lifecycle: "active",
      sourceRef: input.sourceRef ?? current.sourceRef,
      externalId: input.externalId ?? null,
    });
    return { event, previousEventId: current.eventId };
  }

  async transition(memoryId: string, to: MemoryLifecycle): Promise<MemoryEvent> {
    const current = this.#head(memoryId);
    if (!current) throw new Error(`memory not found: ${memoryId}`);
    if (current.lifecycle === to) return current;
    return this.#insert({
      memoryId,
      supersedesId: current.eventId,
      kind: current.kind,
      payload: current.payload,
      searchText: current.searchText,
      eventTime: this.#now(),
      lifecycle: to,
      sourceRef: current.sourceRef,
      externalId: null,
    });
  }

  async retrieve(query: RetrieveQuery): Promise<readonly RetrievalHit[]> {
    const text = query.text.trim();
    const limit = query.limit ?? 10;
    const conditions: string[] = [
      "e.lifecycle = 'active'",
      headClause("e"),
    ];
    const params: (string | number)[] = [];

    if (query.kind) {
      conditions.push("e.kind = ?");
      params.push(query.kind);
    }
    if (query.sourceRefPrefix) {
      conditions.push("e.source_ref LIKE ?");
      params.push(`${query.sourceRefPrefix}%`);
    }

    if (text.length >= 3) {
      conditions.push("memory_fts MATCH ?");
      params.push(quoteFts(text));
      const rows = this.#db
        .prepare(
          `SELECT e.*, -bm25(memory_fts) AS score
           FROM memory_event e
           JOIN memory_fts ON memory_fts.rowid = e.id
           WHERE ${conditions.join(" AND ")}
           ORDER BY score DESC, e.event_time DESC
           LIMIT ?`,
        )
        .all(...params, limit) as unknown as (EventRow & { score: number })[];
      return rows.map((row) => ({ event: toEvent(row), score: Number(row.score) }));
    }

    conditions.push("e.search_text LIKE ?");
    params.push(`%${text}%`);
    const rows = this.#db
      .prepare(
        `SELECT e.*
         FROM memory_event e
         WHERE ${conditions.join(" AND ")}
         ORDER BY e.event_time DESC
         LIMIT ?`,
      )
      .all(...params, limit) as unknown as EventRow[];
    return rows.map((row) => ({ event: toEvent(row), score: 1 }));
  }

  boot(request: BootRequest = {}): BootSnapshot {
    const rows = this.#db
      .prepare(
        `SELECT e.* FROM memory_event e
         WHERE e.lifecycle = 'active' AND ${headClause("e")}
         ORDER BY e.event_time DESC
         LIMIT 200`,
      )
      .all() as unknown as EventRow[];
    return buildBootSnapshot(rows.map(toEvent), request);
  }

  async maintenance(options: MaintenanceOptions = {}): Promise<MaintenanceResult> {
    const heads = this.#db
      .prepare(
        `SELECT e.* FROM memory_event e
         WHERE ${headClause("e")}
         ORDER BY e.id ASC`,
      )
      .all() as unknown as EventRow[];
    const plan = planMaintenance(heads.map(toEvent), options);
    for (const action of plan.actions) {
      await this.transition(action.memoryId, action.to);
    }
    return plan.result;
  }

  async *exportJsonl(): AsyncIterable<string> {
    const rows = this.#db
      .prepare("SELECT * FROM memory_event ORDER BY id ASC")
      .all() as unknown as EventRow[];
    for (const row of rows) yield `${JSON.stringify(toEvent(row))}\n`;
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  #applySchema(): void {
    try {
      this.#db.exec(MEMORY_SCHEMA_SQL);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("trigram")) throw error;
      this.#db.exec(MEMORY_SCHEMA_SQL.replace(", tokenize='trigram'", ""));
    }
  }

  #insert(input: {
    memoryId: string;
    supersedesId: number | null;
    kind: MemoryKind;
    payload: Readonly<Record<string, unknown>>;
    searchText: string;
    eventTime: number;
    lifecycle: MemoryLifecycle;
    sourceRef: string | null;
    externalId: string | null;
  }): MemoryEvent {
    this.#db.exec("BEGIN");
    try {
      const result = this.#db
        .prepare(
          `INSERT INTO memory_event
             (memory_id, supersedes_id, kind, payload_json, search_text,
              event_time, ingested_at, lifecycle, source_ref, external_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.memoryId,
          input.supersedesId,
          input.kind,
          JSON.stringify(input.payload),
          input.searchText,
          input.eventTime,
          this.#now(),
          input.lifecycle,
          input.sourceRef,
          input.externalId,
        );
      const eventId = Number(result.lastInsertRowid);
      this.#db
        .prepare("INSERT INTO memory_fts(rowid, search_text) VALUES (?, ?)")
        .run(eventId, input.searchText);
      this.#db.exec("COMMIT");
      return {
        eventId,
        memoryId: input.memoryId,
        supersedesId: input.supersedesId,
        kind: input.kind,
        payload: input.payload,
        searchText: input.searchText,
        eventTime: input.eventTime,
        ingestedAt: this.#now(),
        lifecycle: input.lifecycle,
        sourceRef: input.sourceRef,
        externalId: input.externalId,
      };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #byExternalId(externalId: string): MemoryEvent | undefined {
    const row = this.#db
      .prepare("SELECT * FROM memory_event WHERE external_id = ? LIMIT 1")
      .get(externalId) as unknown as EventRow | undefined;
    return row ? toEvent(row) : undefined;
  }

  #head(memoryId: string): MemoryEvent | undefined {
    const row = this.#db
      .prepare(
        `SELECT e.* FROM memory_event e
         WHERE e.memory_id = ? AND ${headClause("e")}
         ORDER BY e.id DESC LIMIT 1`,
      )
      .get(memoryId) as unknown as EventRow | undefined;
    return row ? toEvent(row) : undefined;
  }
}

function toEvent(row: EventRow): MemoryEvent {
  return {
    eventId: Number(row.id),
    memoryId: row.memory_id,
    supersedesId: row.supersedes_id === null ? null : Number(row.supersedes_id),
    kind: row.kind as MemoryKind,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    searchText: row.search_text,
    eventTime: Number(row.event_time),
    ingestedAt: Number(row.ingested_at),
    lifecycle: row.lifecycle as MemoryLifecycle,
    sourceRef: row.source_ref,
    externalId: row.external_id,
  };
}

function quoteFts(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

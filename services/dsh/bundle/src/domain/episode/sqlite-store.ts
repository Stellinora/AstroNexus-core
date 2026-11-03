import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  Episode,
  EpisodeInput,
  EpisodeMessage,
  EpisodeStore,
} from "./contracts.ts";

const EPISODE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS episode (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  transcript_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  reflected_at INTEGER,
  external_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS episode_external
  ON episode(external_id) WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS episode_unreflected
  ON episode(reflected_at, id);
`;

interface EpisodeRow {
  id: number;
  session_id: string;
  turn: number;
  transcript_json: string;
  started_at: number;
  ended_at: number;
  reflected_at: number | null;
}

export interface SqliteEpisodeStoreOptions {
  readonly now?: () => number;
}

export class SqliteEpisodeStore implements EpisodeStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(path: string, options: SqliteEpisodeStoreOptions = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(EPISODE_SCHEMA_SQL);
    this.#now = options.now ?? (() => Date.now());
  }

  async record(input: EpisodeInput): Promise<Episode> {
    const externalId = `${input.sessionId}:${input.turn}`;
    const existing = this.#db
      .prepare("SELECT * FROM episode WHERE external_id = ? LIMIT 1")
      .get(externalId) as unknown as EpisodeRow | undefined;
    if (existing) return toEpisode(existing);

    const result = this.#db
      .prepare(
        `INSERT INTO episode
           (session_id, turn, transcript_json, started_at, ended_at, reflected_at, external_id)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        input.sessionId,
        input.turn,
        JSON.stringify(input.transcript),
        input.startedAt,
        input.endedAt,
        externalId,
      );
    const row = this.#db
      .prepare("SELECT * FROM episode WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as unknown as EpisodeRow;
    return toEpisode(row);
  }

  async recentUnreflected(limit = 20): Promise<readonly Episode[]> {
    const rows = this.#db
      .prepare(
        `SELECT * FROM episode
         WHERE reflected_at IS NULL
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(limit) as unknown as EpisodeRow[];
    return rows.map(toEpisode);
  }

  async markReflected(episodeIds: readonly number[]): Promise<void> {
    const statement = this.#db.prepare("UPDATE episode SET reflected_at = ? WHERE id = ?");
    const at = this.#now();
    for (const episodeId of episodeIds) statement.run(at, episodeId);
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}

function toEpisode(row: EpisodeRow): Episode {
  return {
    episodeId: Number(row.id),
    sessionId: row.session_id,
    turn: Number(row.turn),
    transcript: parseTranscript(row.transcript_json),
    startedAt: Number(row.started_at),
    endedAt: Number(row.ended_at),
    reflectedAt: row.reflected_at === null ? null : Number(row.reflected_at),
  };
}

function parseTranscript(json: string): EpisodeMessage[] {
  try {
    const value = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item) =>
          item &&
          typeof item === "object" &&
          (item.role === "user" || item.role === "assistant") &&
          typeof item.text === "string" &&
          typeof item.seq === "number",
      )
      .map((item) => ({ role: item.role, text: item.text, seq: item.seq }));
  } catch {
    return [];
  }
}

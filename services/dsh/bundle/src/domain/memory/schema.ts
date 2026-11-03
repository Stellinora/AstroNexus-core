export const MEMORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  supersedes_id INTEGER,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  search_text TEXT NOT NULL,
  event_time INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  lifecycle TEXT NOT NULL,
  source_ref TEXT,
  external_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_event_external
  ON memory_event(external_id) WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS memory_event_memory
  ON memory_event(memory_id, id);

CREATE INDEX IF NOT EXISTS memory_event_supersedes
  ON memory_event(supersedes_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
  USING fts5(search_text, tokenize='trigram');

CREATE TABLE IF NOT EXISTS memory_access (
  memory_id TEXT PRIMARY KEY,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_reflection (
  event_id INTEGER PRIMARY KEY,
  reflected_at INTEGER NOT NULL
);
`;

export function headClause(alias = "e"): string {
  return `NOT EXISTS (SELECT 1 FROM memory_event s WHERE s.supersedes_id = ${alias}.id)`;
}

-- Turn-level episode buffer consumed by the reflection worker.
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

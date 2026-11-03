-- Experience layer (separate from memory_event).
CREATE TABLE IF NOT EXISTS experience_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experience_id TEXT NOT NULL,
  supersedes_id INTEGER,
  situation TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  lesson TEXT NOT NULL,
  conditions_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  search_text TEXT NOT NULL,
  base_confidence REAL NOT NULL DEFAULT 0.6,
  lifecycle TEXT NOT NULL,
  project_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  event_time INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  external_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS experience_event_external
  ON experience_event(external_id) WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS experience_event_experience
  ON experience_event(experience_id, id);

CREATE INDEX IF NOT EXISTS experience_event_supersedes
  ON experience_event(supersedes_id);

CREATE VIRTUAL TABLE IF NOT EXISTS experience_fts
  USING fts5(search_text, tokenize='trigram');

CREATE TABLE IF NOT EXISTS experience_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experience_id TEXT NOT NULL,
  success INTEGER NOT NULL,
  source_ref TEXT,
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS experience_feedback_experience
  ON experience_feedback(experience_id, id);

-- Access counters for boot ranking (derived operational data, not memory history).
CREATE TABLE IF NOT EXISTS memory_access (
  memory_id TEXT PRIMARY KEY,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER NOT NULL
);

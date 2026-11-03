-- Cursor for the LLM reflection worker: which source events were already distilled.
CREATE TABLE IF NOT EXISTS memory_reflection (
  event_id INTEGER PRIMARY KEY,
  reflected_at INTEGER NOT NULL
);

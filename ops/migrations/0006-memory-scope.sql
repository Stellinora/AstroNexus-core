-- Memory layer scope fields (project isolation and visibility).
ALTER TABLE memory_event ADD COLUMN project_id TEXT;
ALTER TABLE memory_event ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';

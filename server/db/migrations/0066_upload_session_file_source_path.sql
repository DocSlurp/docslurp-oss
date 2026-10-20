ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS source_path text NOT NULL DEFAULT '';

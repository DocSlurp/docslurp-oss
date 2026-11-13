ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS api_key_id text;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS allowed_workspace_ids text[];
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS result jsonb;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS reconcile_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS next_reconcile_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours';
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS unknown_size boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS upload_sessions_reconcile_idx ON upload_sessions (next_reconcile_at) WHERE status IN ('pending', 'uploading', 'ingesting');

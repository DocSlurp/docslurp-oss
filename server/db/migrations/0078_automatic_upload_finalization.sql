ALTER TABLE upload_sessions ADD COLUMN api_key_id text;
ALTER TABLE upload_sessions ADD COLUMN allowed_workspace_ids text[];
ALTER TABLE upload_sessions ADD COLUMN result jsonb;
ALTER TABLE upload_sessions ADD COLUMN last_error text;
ALTER TABLE upload_sessions ADD COLUMN reconcile_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE upload_sessions ADD COLUMN next_reconcile_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE upload_sessions ADD COLUMN expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours';
ALTER TABLE upload_session_files ADD COLUMN unknown_size boolean NOT NULL DEFAULT false;
CREATE INDEX upload_sessions_reconcile_idx ON upload_sessions (next_reconcile_at) WHERE status IN ('pending', 'uploading', 'ingesting');

-- Direct uploads finalize per file and start ingestion in waves while the upload is still in progress.
--
-- Per file: a short finalize lease (token plus expiry) so a storage webhook, a client files/complete call and the
-- fallback reconciler never finalize the same file at once and no session-wide lock is needed; the run (wave) that took
-- the file; when it was finalized (the wave timer starts from the first waiting file); the fallback reconciler's own
-- schedule; and a definite rejection found in the background, shown to the client.
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS run_id text;
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS finalized_at timestamptz;
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS finalize_lease_until timestamptz;
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS finalize_lease_token text;
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS next_check_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS check_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS finalize_error jsonb;

-- Finalized files not yet in a run (the next wave), open files (is the session finished?), and the fallback's due list.
CREATE INDEX IF NOT EXISTS upload_session_files_waiting_idx ON upload_session_files (session_id, finalized_at)
  WHERE status = 'completed' AND run_id IS NULL;
CREATE INDEX IF NOT EXISTS upload_session_files_open_idx ON upload_session_files (session_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS upload_session_files_check_idx ON upload_session_files (next_check_at) WHERE status = 'pending';

-- A wave refused by billing or admission is retried no sooner than this (a confirm still tries at once).
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS wave_blocked_until timestamptz;

-- One row per run an upload session started. Wave 1's run id is the session id (the session's `result`).
CREATE TABLE IF NOT EXISTS upload_session_runs (
  session_id text NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  wave integer NOT NULL,
  run_id text NOT NULL,
  status text NOT NULL DEFAULT 'creating',
  file_count integer NOT NULL DEFAULT 0,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  PRIMARY KEY (session_id, wave)
);
CREATE UNIQUE INDEX IF NOT EXISTS upload_session_runs_run_id_idx ON upload_session_runs (run_id);

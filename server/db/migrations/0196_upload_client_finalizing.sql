-- A client that completes its own files (POST .../files/complete) holds the background reconciler off its upload
-- session until client_finalizing_until, so the two never contend for the session lock. Null: no client is finalizing.
-- client_finalizing_since is when the current run of holds began; total hold time is capped from it.
-- ADD COLUMN takes a brief ACCESS EXCLUSIVE lock: give up rather than queue (and block every upload query) behind a
-- long reconciler transaction; the migration is safe to rerun.
SET LOCAL lock_timeout = '5s';
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS client_finalizing_until timestamptz;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS client_finalizing_since timestamptz;
-- Aborted and failed sessions' open multipart uploads are aborted outside any session lock; this marks each one done.
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS multipart_aborted_at timestamptz;
CREATE INDEX IF NOT EXISTS upload_session_files_pending_multipart_abort_idx ON upload_session_files (session_id)
  WHERE upload_id IS NOT NULL AND multipart_aborted_at IS NULL;

-- Direct uploads finalize per file and start ingestion in waves while the upload is still in progress.
--
-- Per file: a short finalize lease (token plus expiry) so a storage webhook, a client files/complete call and the
-- fallback reconciler never finalize the same file at once and no session-wide lock is needed; the run (wave) that took
-- the file; when it was finalized (the wave timer starts from the first waiting file); the fallback reconciler's own
-- schedule; and a definite rejection found in the background, shown to the client.
-- ADD COLUMN takes a brief ACCESS EXCLUSIVE lock: give up rather than queue (and block every upload query) behind a
-- long transaction; the migration is safe to rerun.
SET LOCAL lock_timeout = '5s';
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS run_id text;
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS finalized_at timestamptz;
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS finalize_lease_until timestamptz;
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS finalize_lease_token text;
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS next_check_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS check_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS finalize_error jsonb;

-- Finalized files not yet in a run (the next wave), open files (is the session finished?), and the fallback's due list.
-- A file of a 'waves' session is 'finalized' when its bytes are sealed ('completed' in a 'single' session). Servers
-- from before waves confirm a session only when every file is 'completed', so they never confirm a waves session.
CREATE INDEX IF NOT EXISTS upload_session_files_waiting_idx ON upload_session_files (session_id, finalized_at)
  WHERE status IN ('completed', 'finalized') AND run_id IS NULL;
CREATE INDEX IF NOT EXISTS upload_session_files_open_idx ON upload_session_files (session_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS upload_session_files_check_idx ON upload_session_files (next_check_at) WHERE status = 'pending';

-- A wave refused by billing or admission is retried no sooner than this (a confirm still tries at once).
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS wave_blocked_until timestamptz;
-- How the session ingests, fixed when it is created (DOCSLURP_UPLOAD_WAVES): 'single' (one run, after every file) or
-- 'waves' (runs while the upload is in progress). Everything after creation reads this, never the live setting.
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS finalize_protocol text NOT NULL DEFAULT 'single';
DO $idem$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upload_sessions_finalize_protocol_check' AND conrelid = 'upload_sessions'::regclass) THEN
    ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_finalize_protocol_check CHECK (finalize_protocol IN ('single', 'waves'));
  END IF;
END $idem$;

-- One row per run an upload session tried to start (a wave). The first attempt's run id is the session id.
-- A wave is 'pending' while its run is created, then 'committed' (its run exists) or 'failed' (its run never will).
CREATE TABLE IF NOT EXISTS upload_session_runs (
  session_id text NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  wave integer NOT NULL,
  run_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed', 'failed')),
  file_count integer NOT NULL DEFAULT 0,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  PRIMARY KEY (session_id, wave)
);
CREATE UNIQUE INDEX IF NOT EXISTS upload_session_runs_run_id_idx ON upload_session_runs (run_id);

-- Exactly once, enforced by the database:
-- 1. A wave moves only pending -> committed or pending -> failed; a failed row is kept as a tombstone of its run id.
CREATE OR REPLACE FUNCTION docslurp_upload_wave_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.session_id IS DISTINCT FROM OLD.session_id THEN
    RAISE EXCEPTION 'upload wave % cannot change its run or session', OLD.run_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('committed', 'failed')) THEN
    RAISE EXCEPTION 'upload wave % cannot move from % to %', OLD.run_id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS upload_session_runs_transition ON upload_session_runs;
CREATE TRIGGER upload_session_runs_transition BEFORE UPDATE ON upload_session_runs
  FOR EACH ROW EXECUTE FUNCTION docslurp_upload_wave_transition();

-- 2. A file joins only a pending wave of its own session, and leaves a wave only once that wave failed: a file in a
--    pending or committed wave can never be handed to another run.
CREATE OR REPLACE FUNCTION docslurp_upload_file_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.run_id IS NOT DISTINCT FROM OLD.run_id THEN RETURN NEW; END IF;
  IF OLD.run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM upload_session_runs w WHERE w.run_id = OLD.run_id AND w.status = 'failed'
  ) THEN
    RAISE EXCEPTION 'upload file % is in run %', OLD.id, OLD.run_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM upload_session_runs w WHERE w.run_id = NEW.run_id AND w.session_id = NEW.session_id AND w.status = 'pending'
  ) THEN
    RAISE EXCEPTION 'upload file % can join only a pending wave of its session', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS upload_session_files_membership ON upload_session_files;
CREATE TRIGGER upload_session_files_membership BEFORE UPDATE OF run_id ON upload_session_files
  FOR EACH ROW EXECUTE FUNCTION docslurp_upload_file_membership();

-- 3. A wave's run commits in the same transaction as its wave: publishing the run (creation_ready_at) moves a pending
--    wave to committed, and a run whose wave already failed (fenced by another holder) can never be published.
CREATE OR REPLACE FUNCTION docslurp_upload_wave_commit_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE upload_session_runs SET status = 'committed', started_at = coalesce(started_at, now())
    WHERE run_id = NEW.id AND status = 'pending';
  IF NOT FOUND AND EXISTS (SELECT 1 FROM upload_session_runs WHERE run_id = NEW.id AND status = 'failed') THEN
    RAISE EXCEPTION 'run % belongs to an upload wave that was fenced off', NEW.id USING ERRCODE = 'DSW01';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS project_runs_upload_wave_commit ON project_runs;
CREATE TRIGGER project_runs_upload_wave_commit BEFORE UPDATE OF creation_ready_at ON project_runs
  FOR EACH ROW WHEN (OLD.creation_ready_at IS NULL AND NEW.creation_ready_at IS NOT NULL)
  EXECUTE FUNCTION docslurp_upload_wave_commit_fence();

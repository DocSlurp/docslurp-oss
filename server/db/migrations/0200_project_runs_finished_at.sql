-- Activity feeds (REST/SSE listRuns, the realtime activity projection, the org activity summary) read active runs
-- plus recently finished ones. Active runs have their partial indexes (0153, 0195); "recently finished" used
-- updated_at, which heartbeats rewrite every few seconds, so it could not be indexed cheaply and every read scanned or
-- sorted a project's or organization's whole run history. finished_at is written only when a run reaches a terminal
-- status (and cleared if it is resumed), so its indexes change once per run, not per heartbeat.
--
-- Locking: the migrator applies pending migrations in one transaction, so the ACCESS EXCLUSIVE lock ADD COLUMN takes
-- is held until commit, through the small backfill and the index builds: every read and write of project_runs waits
-- for this migration (about as long as the index builds, a few seconds on today's table; schedule the release off
-- peak once it grows). Each statement waits at most 5 s to acquire its lock and fails the release rather than queueing
-- behind a long-open transaction. Idempotent.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS finished_at timestamptz;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION project_runs_stamp_finished_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status NOT IN ('completed', 'failed') THEN
    NEW.finished_at := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.finished_at := coalesce(NEW.finished_at, now());
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.finished_at := now();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER project_runs_finished_at BEFORE INSERT OR UPDATE OF status ON project_runs
FOR EACH ROW EXECUTE FUNCTION project_runs_stamp_finished_at();
--> statement-breakpoint
-- idempotent-migration: fills only rows still null (a second run finds none), so it writes the same values.
-- Runs that finished in the last day keep appearing as recent; older history needs no stamp.
UPDATE project_runs SET finished_at = updated_at
WHERE finished_at IS NULL AND status IN ('completed', 'failed') AND updated_at > now() - interval '1 day';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_runs_project_finished_idx ON project_runs (project_id, finished_at DESC)
  WHERE finished_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_runs_org_finished_idx ON project_runs (org_id, finished_at DESC)
  WHERE finished_at IS NOT NULL;
--> statement-breakpoint
-- Blocked runs (saved, not admitted for spend) appear in the feeds beside active ones. They take no heartbeats, so
-- updated_at here changes rarely, and the set is small.
CREATE INDEX IF NOT EXISTS project_runs_org_blocked_idx ON project_runs (org_id, updated_at DESC)
  WHERE status = 'blocked';

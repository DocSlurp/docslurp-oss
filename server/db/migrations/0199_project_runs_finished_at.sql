-- Activity feeds (REST/SSE listRuns, the realtime activity projection, the org activity summary) read active runs
-- plus recently finished ones. Active runs have their partial indexes (0153, 0195); "recently finished" used
-- updated_at, which heartbeats rewrite every few seconds, so it could not be indexed cheaply and every read scanned or
-- sorted a project's or organization's whole run history. finished_at is written only when a run reaches a terminal
-- status (and cleared if it is resumed), so its indexes change once per run, not per heartbeat.
--
-- Locking: ADD COLUMN takes a brief ACCESS EXCLUSIVE lock and each index build holds SHARE for one pass (as 0195 and
-- 0198); each waits at most 5 s for its lock and fails the release rather than queueing writers. Idempotent.
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

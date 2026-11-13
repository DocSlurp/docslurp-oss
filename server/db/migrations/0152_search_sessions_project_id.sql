-- Search sessions get a real project_id column. 0087 indexed (metadata ->> 'workspaceId', created_at); 0132 moved the
-- key to projectId but only renamed that index, so every project read (project list, GET /v1/projects/:id, telemetry,
-- suggestions) filtered metadata ->> 'projectId' without an index and scanned the whole table.
-- ON DELETE CASCADE: deleting a project deletes everything in it (data-deletion.ts), and its search history (queries,
-- ranked chunk ids) is project data; result rows and zero-result diagnostics already cascade from the session.
--
-- Schema only: no row is updated here. Every search inserts a session, and all pending migrations commit in one
-- transaction, so the ACCESS EXCLUSIVE lock ADD COLUMN takes is held until the last of them commits; a backfill
-- inside it (one UPDATE per old row, each firing the realtime trigger and the foreign-key check) blocked search and
-- chat for over a minute per 600k rows. Old rows are filled out of band, in short batches, by the API's maintenance
-- sweep (server/src/services/search-session-project-backfill.ts); until it finishes, project reads undercount old
-- sessions. Sessions whose project no longer exists keep project_id null; no project reader can reach them.
--
-- What remains under the lock is one index build over the table (~2 s per 600k rows, as 0087; CONCURRENTLY cannot run
-- in a transaction). Fail fast instead of queueing every search insert behind a long-open writer; a retried deploy
-- finishes the work.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- A foreign key declared with a new, all-null column is created valid without scanning the table.
ALTER TABLE "search_sessions" ADD COLUMN IF NOT EXISTS "project_id" text
  CONSTRAINT "search_sessions_project_id_fkey" REFERENCES "projects"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- Only for a database whose column exists without the constraint: NOT VALID still checks every new write and still
-- cascades, and skips the scan of existing rows.
DO $idem$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'search_sessions_project_id_fkey' AND conrelid = 'search_sessions'::regclass
  ) THEN
    ALTER TABLE "search_sessions" ADD CONSTRAINT "search_sessions_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE NOT VALID;
  END IF;
END $idem$;
--> statement-breakpoint
-- Writers that do not set the column (API instances and chat executors still running the previous release during a
-- rolling deploy) get it from the metadata they already write. Only an existing project's id is accepted, so
-- malformed or stale metadata leaves the column null instead of failing the insert: ->> yields text or null for any
-- JSON value, and the lookup returns no row for anything that is not a project.
CREATE OR REPLACE FUNCTION search_sessions_set_project_id() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.project_id IS NULL AND jsonb_typeof(NEW.metadata) = 'object' THEN
    NEW.project_id := (SELECT p.id FROM public.projects p WHERE p.id = NEW.metadata ->> 'projectId');
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER search_sessions_set_project_id
BEFORE INSERT OR UPDATE OF metadata ON "search_sessions"
FOR EACH ROW EXECUTE FUNCTION search_sessions_set_project_id();
--> statement-breakpoint
DROP INDEX IF EXISTS "search_sessions_project_created_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "search_sessions_workspace_created_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_sessions_project_id_created_at_idx"
  ON "search_sessions" USING btree ("project_id", "created_at", "id");
--> statement-breakpoint
-- Column statistics now, so the backfill's pages (project_id IS NULL, in created_at order) are planned as short
-- index range scans from the first batch instead of waiting for autoanalyze. A sample, not a table scan.
ANALYZE "search_sessions" ("project_id");

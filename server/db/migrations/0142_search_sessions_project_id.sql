-- Search sessions get a real project_id column. 0087 indexed (metadata ->> 'workspaceId', created_at); 0132 moved the
-- key to projectId but only renamed that index, so every project read (project list, GET /v1/projects/:id, telemetry,
-- suggestions) filtered metadata ->> 'projectId' without an index and scanned the whole table.
-- ON DELETE CASCADE: deleting a project deletes everything in it (data-deletion.ts), and its search history (queries,
-- ranked chunk ids) is project data; result rows and zero-result diagnostics already cascade from the session.
-- Sessions whose project no longer exists keep project_id null; no project reader can reach them.
-- Built without CONCURRENTLY (migrations run in a transaction): the backfill and index build hold locks for about one
-- table scan each (~2 s per 600k rows, as 0087). Fail fast instead of queueing every search insert behind a
-- long-open writer; a retried deploy finishes the work.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "search_sessions" ADD COLUMN IF NOT EXISTS "project_id" text;
--> statement-breakpoint
DO $idem$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'search_sessions_project_id_fkey' AND conrelid = 'search_sessions'::regclass
  ) THEN
    ALTER TABLE "search_sessions" ADD CONSTRAINT "search_sessions_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE NOT VALID;
  END IF;
END $idem$;
--> statement-breakpoint
UPDATE "search_sessions" s SET "project_id" = p.id
FROM "projects" p
WHERE s."project_id" IS NULL AND p.id = s.metadata ->> 'projectId';
--> statement-breakpoint
ALTER TABLE "search_sessions" VALIDATE CONSTRAINT "search_sessions_project_id_fkey";
--> statement-breakpoint
DROP INDEX IF EXISTS "search_sessions_project_created_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "search_sessions_workspace_created_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_sessions_project_id_created_at_idx"
  ON "search_sessions" USING btree ("project_id", "created_at");

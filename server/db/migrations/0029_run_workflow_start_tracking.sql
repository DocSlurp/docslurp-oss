-- Durable workflow-start tracking for queued runs (run-start recovery).
-- A queued run whose Temporal workflow start was never confirmed (deferred
-- because Temporal was unreachable, or the intake request died between
-- creating the run and starting it) has workflow_started_at NULL. The API's
-- run-start recovery loop retries those within seconds, with per-run backoff
-- in workflow_start_next_at, instead of waiting for the 10-minute stale-queued
-- sweep. Runs that are queued because they are waiting for worker slots have a
-- confirmed start and are left alone.
ALTER TABLE "workspace_runs" ADD COLUMN IF NOT EXISTS "workflow_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workspace_runs" ADD COLUMN IF NOT EXISTS "workflow_start_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace_runs" ADD COLUMN IF NOT EXISTS "workflow_start_next_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_runs_workflow_start_pending_idx"
  ON "workspace_runs" USING btree ("created_at")
  WHERE "status" = 'queued' AND "workflow_started_at" IS NULL;

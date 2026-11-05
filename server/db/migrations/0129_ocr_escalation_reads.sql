-- OCR escalation reads, persisted as soon as the hosted call returns (worker/src/ocr/hosted-reader.ts). A retried activity
-- reuses a page's completed read instead of calling the provider again, and every real call (completed or failed) keeps
-- its usage events here under their deterministic ids, so its provider cost is recorded once even when the activity that
-- made it failed before its checkpoint. Run-scoped: rows go with their run (ON DELETE CASCADE), so deleting a run deletes the OCR text it holds.
--
-- Locks: the release's lock prelude (the same in every lock-taking migration of it; see 0122), then workspace_runs, which the
-- foreign key below locks (SHARE ROW EXCLUSIVE), so the migrator takes it in the release's order and not first.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE documents IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE upload_session_files IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE organizations, org_memberships IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
LOCK TABLE api_keys IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE webhooks IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE workspace_runs IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ocr_escalation_reads (
  run_id text NOT NULL REFERENCES workspace_runs(id) ON DELETE CASCADE,
  document_id text NOT NULL,
  page_number integer NOT NULL CHECK (page_number > 0),
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  text text,
  model text NOT NULL,
  usage_events jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, document_id, page_number, attempt),
  CHECK (status = 'failed' OR text IS NOT NULL)
);

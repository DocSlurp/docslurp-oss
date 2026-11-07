-- Let the vision attempt ledger count OCR reads. The guard admits the OCR escalation read and the hosted OCR read with
-- purpose `ocr` (worker/src/lib/vision-attempt-guard.ts), and the per-document escalation budget is counted from these
-- rows, but 0105's CHECK only allows page, region, map-ocr and critique: every such admission failed the insert.
--
-- Swapping the CHECK takes ACCESS EXCLUSIVE on vision_run_attempts. The new CHECK is added NOT VALID, so nothing scans the
-- table under the lock: it binds every insert and update from now on, and every existing row satisfies it by construction
-- (the old CHECK allowed a subset). `ALTER TABLE vision_run_attempts VALIDATE CONSTRAINT ...` can mark it validated later.
--
-- The lock prelude is the same in every lock-taking migration of this release (0122, 0123, 0125, 0126, 0127, 0128; see
-- 0122). vision_run_attempts comes last: the worker's vision admission transaction takes only this table and the vision
-- org tables, never one of the prelude's.
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
LOCK TABLE vision_run_attempts IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE vision_run_attempts DROP CONSTRAINT IF EXISTS vision_run_attempts_purpose_check;
--> statement-breakpoint
ALTER TABLE vision_run_attempts ADD CONSTRAINT vision_run_attempts_purpose_check
  CHECK (purpose IN ('page', 'region', 'map-ocr', 'critique', 'ocr')) NOT VALID;

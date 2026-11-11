-- Let the vision attempt ledger count table-rescue reads. A page that classify-route authorizes for a model read by table-leak
-- signals alone is admitted with purpose `table-rescue` and a per-document page budget (tableLeakPageCap), counted from these
-- rows so activity retries and worker restarts cannot widen it (worker/src/lib/vision-attempt-guard.ts).
--
-- The new CHECK is added NOT VALID: nothing scans the table under the lock, and every existing row satisfies it by
-- construction (the old CHECK allowed a subset). Only vision_run_attempts is locked; the worker's vision admission
-- transaction takes this table and the vision org tables, never another table first.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE vision_run_attempts IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE vision_run_attempts DROP CONSTRAINT IF EXISTS vision_run_attempts_purpose_check;
--> statement-breakpoint
ALTER TABLE vision_run_attempts ADD CONSTRAINT vision_run_attempts_purpose_check
  CHECK (purpose IN ('page', 'region', 'map-ocr', 'critique', 'ocr', 'table-rescue')) NOT VALID;

-- Summary tree backfill jobs: a parking reason for an unpriced deployment, and what fair claiming needs
-- (worker/src/summary-tree/backfill-job.ts).
--
-- 1. blocked_reason 'unpriced': the deployment charges for work but its pricing provider has no price for the summary
--    tree unit. Such a job makes no model call. The CHECK is replaced only while it does not allow the value yet, so
--    a second run after a later migration widened the list does not narrow it back.
-- 2. last_attempt_at: when a worker last looked at the job (claimed it, parked it or put it back in the queue). Jobs
--    are claimed least recently attempted first, organizations least recently served first, so one organization's
--    parked jobs cannot keep another organization's job waiting.
-- 3. park_count, parked_since: parks in a row since the job last made progress, and when that row of parks began.
--    A parked job waits longer after every park, up to a bound, and one that has been parked too long ends `failed`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'summary_tree_jobs_blocked_reason_check' AND conrelid = 'summary_tree_jobs'::regclass
      AND pg_get_constraintdef(oid) LIKE '%''unpriced''%'
  ) THEN
    ALTER TABLE summary_tree_jobs DROP CONSTRAINT IF EXISTS summary_tree_jobs_blocked_reason_check;
    ALTER TABLE summary_tree_jobs ADD CONSTRAINT summary_tree_jobs_blocked_reason_check
      CHECK (blocked_reason IS NULL OR blocked_reason IN ('build-off', 'balance', 'credits', 'policy', 'unpriced'));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE summary_tree_jobs ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
--> statement-breakpoint
ALTER TABLE summary_tree_jobs ADD COLUMN IF NOT EXISTS park_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE summary_tree_jobs ADD COLUMN IF NOT EXISTS parked_since timestamptz;
--> statement-breakpoint
-- Jobs that are not finished, for the claim and for the per-organization "last served" lookup.
CREATE INDEX IF NOT EXISTS summary_tree_jobs_open_idx ON summary_tree_jobs (org_id, last_attempt_at) WHERE status IN ('queued', 'running', 'blocked');
--> statement-breakpoint
-- The worker claims and runs the jobs. server/db/roles.mjs reconciles the same grant after every migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    REVOKE ALL ON public.summary_tree_jobs FROM docslurp_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.summary_tree_jobs TO docslurp_worker;
  END IF;
END $$;

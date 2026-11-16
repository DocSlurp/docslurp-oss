-- A call is reserved before provider submission and cleared in the same transaction
-- as its usage/debit receipt. An expired job with unresolved calls cannot be resumed:
-- operators must reconcile provider receipts rather than erase unknown exposure.
ALTER TABLE summary_tree_jobs ADD COLUMN IF NOT EXISTS outstanding_calls integer NOT NULL DEFAULT 0;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'summary_tree_jobs_outstanding_calls_nonnegative'
    AND conrelid = 'summary_tree_jobs'::regclass) THEN
    ALTER TABLE summary_tree_jobs ADD CONSTRAINT summary_tree_jobs_outstanding_calls_nonnegative CHECK (outstanding_calls >= 0);
  END IF;
END $$;

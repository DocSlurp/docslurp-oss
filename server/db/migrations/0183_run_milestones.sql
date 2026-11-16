-- Run milestones (worker/src/pipeline/run-milestones.ts): the first time a worker picks the run up, the first page
-- with extracted content, and the first page that finished every page-level stage of the run's plan. Each is stamped
-- once by a conditional update and measured from created_at, so start latency and time-to-first-page are exact across
-- workers, retries and resumes. Additive and nullable: runs created before this migration leave them null.
-- outcome_recorded_at guards the terminal outcome metric the same way: a retried or late terminal activity records nothing.
-- One statement: one brief lock on project_runs.
ALTER TABLE project_runs
  ADD COLUMN IF NOT EXISTS worker_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_page_extracted_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_page_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome_recorded_at timestamptz;

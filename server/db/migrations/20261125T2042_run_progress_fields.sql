-- Honest ingest progress on the run record (worker/src/db/run-ledger.ts; packages/shared/src/run.ts).
--
-- pages_searchable: pages of the run's documents that finished indexing and are served by search. pages_processed counts
--   page checkpoints of the extraction stages and reaches pages_total before routing, vision and indexing have run, so it
--   cannot say how much of a run can be searched yet. NULL means "not reported": the run was written only by a release
--   that predates this column, so readers fall back to what they showed before instead of presenting 0.
-- pages_counted_at: when pages_total stopped being provisional (every stage that measures page counts has finished, or
--   the run completed). NULL while documents are still being counted, and for runs that predate this column.
--
-- Expand only: both columns are nullable with no default, so the ALTER is a catalog change (no table rewrite, no
-- backfill) under a brief ACCESS EXCLUSIVE lock, bounded by the runner's lock timeout and retried. The previous release
-- never names either column in an INSERT or UPDATE, so its workers and API keep working against the new schema; the
-- worker writes them only once it has seen that they exist. One statement: one lock on project_runs. Idempotent.
ALTER TABLE project_runs
  ADD COLUMN IF NOT EXISTS pages_searchable bigint,
  ADD COLUMN IF NOT EXISTS pages_counted_at timestamptz;

-- Active runs (queued or processing) by organization, covering what the
-- autoscaler snapshot (packages/shared/src/worker-autoscale.ts) and an org's
-- activity summary read. Both used to aggregate over all of project_runs,
-- finished history included, every scaler poll; restricted to active runs they
-- read only this small partial index (index-only where the visibility map allows).
-- org_id leads so "active runs for this org" is a range read of one org.
--
-- Built without CONCURRENTLY (migrations run in a transaction, as 0087 and
-- 0167). The partial predicate keeps it small, but the build still scans the
-- table under a SHARE lock that blocks run inserts and updates; lock_timeout
-- fails fast rather than queueing writers behind a long-open transaction, and a
-- retried deploy finishes the build.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_runs_org_active_idx ON project_runs (org_id)
  INCLUDE (id, project_id, status, control_state, lease_expires_at, shard_demand,
    total_documents, processed_documents, pages_total, pages_processed,
    created_at, worker_started_at, updated_at)
  WHERE status IN ('queued', 'processing');

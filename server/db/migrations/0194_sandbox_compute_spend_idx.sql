-- A provider's platform spend cap reads recorded sandbox_compute usage of one provider and model across every
-- organization in a short window (ExtractorPluginHost.computeSpendCents, worker/src/db/compute-fleet-store.ts, through
-- usage_attribution). No existing index serves a window that is not scoped to an organization, project or key, so that
-- read would scan usage_events. This partial index holds only sandbox_compute rows (a small share of usage events).
--
-- Locking: the build holds SHARE on usage_events (one pass over the table, as 0042 and 0187; CONCURRENTLY cannot run in a
-- transaction). It waits at most 5 s for its lock and fails the release instead of queueing usage writes behind a
-- long-open transaction; a retried deploy finishes the work. Idempotent.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_events_sandbox_compute_created_idx
  ON usage_events (provider, model, created_at)
  WHERE metric = 'sandbox_compute';

-- Worker capability registry (packages/shared/src/worker-capabilities.ts,
-- docs/releases.md#app-and-worker-skew).
--
-- Every worker process upserts one row per host (instance_id: the Fly machine
-- id, or hostname-pid locally) at startup, before it polls Temporal, and on a
-- heartbeat. `capabilities` lists the gated features its build supports. The
-- app enables a gated flag (WORKER_INDEX_BEFORE_ENRICH, ...) only when every
-- live poller on the run's task queue has a fresh row carrying the matching
-- capability, so flag and deploy order no longer matter.
--
-- Additive only. Rows hold no tenant data; stale rows are pruned by the
-- workers themselves.
CREATE TABLE IF NOT EXISTS worker_capabilities (
  instance_id text PRIMARY KEY,
  identity text NOT NULL,
  task_queue text NOT NULL,
  build_id text,
  protocol integer DEFAULT 1 NOT NULL,
  capabilities text[] DEFAULT '{}'::text[] NOT NULL,
  -- created_at of the newest applied migration this worker saw (drizzle journal `when`).
  schema_applied_when bigint,
  started_at timestamptz DEFAULT now() NOT NULL,
  last_seen_at timestamptz DEFAULT now() NOT NULL,
  stopped_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS worker_capabilities_queue_seen_idx
  ON worker_capabilities (task_queue, last_seen_at DESC);

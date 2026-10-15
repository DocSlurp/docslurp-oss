-- Ownership outlives a worker process and tenant/run deletion. Never cascade leases.
CREATE TABLE remote_capacity_leases (
  id text PRIMARY KEY, provider text NOT NULL, name text NOT NULL UNIQUE,
  scope jsonb NOT NULL, before_ids jsonb NOT NULL,
  resource_id text, status text NOT NULL CHECK(status IN ('creating','active','deleting','deleted')),
  hourly_usd numeric(24,12) NOT NULL CHECK(hourly_usd > 0),
  reserved_usd numeric(24,12) NOT NULL CHECK(reserved_usd > 0),
  cost_usd numeric(24,12), created_at timestamptz NOT NULL DEFAULT now(),
  deadline timestamptz NOT NULL, verified_deleted_at timestamptz,
  CHECK(deadline > created_at)
);
--> statement-breakpoint
CREATE INDEX remote_capacity_outstanding_idx ON remote_capacity_leases(status, deadline);
--> statement-breakpoint
CREATE TABLE remote_capacity_watchdog (
  id text PRIMARY KEY CHECK(id = 'media'), providers jsonb NOT NULL, heartbeat_at timestamptz NOT NULL
);

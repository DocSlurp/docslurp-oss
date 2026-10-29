-- Vision spend ledger for the worker's vision guard (worker/src/lib/vision-spend-guard.ts,
-- worker/src/db/vision-spend-store.ts). Every vision provider call reserves its worst-case cost
-- here before it runs and settles to its actual cost when it finishes, so every worker of a run
-- (and every run of an org) admits calls against the same ledger under advisory locks.
--
-- These are guard counters, not spend: billing, budgets and reports still read usage_events
-- through usage_attribution. Unbilled spend (rejected and failed attempts) is also kept per org
-- in hourly buckets for the org's rolling unbilled limit.
CREATE TABLE IF NOT EXISTS vision_spend_reservations (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES workspace_runs(id) ON DELETE CASCADE,
  org_id text,
  cents double precision NOT NULL CHECK (cents >= 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vision_spend_reservations_run_idx ON vision_spend_reservations (run_id);
CREATE INDEX IF NOT EXISTS vision_spend_reservations_org_idx ON vision_spend_reservations (org_id) WHERE org_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS vision_run_spend (
  run_id text PRIMARY KEY REFERENCES workspace_runs(id) ON DELETE CASCADE,
  provider_cost_cents double precision NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vision_run_pages (
  run_id text NOT NULL REFERENCES workspace_runs(id) ON DELETE CASCADE,
  document_id text NOT NULL,
  page_number integer NOT NULL,
  rejected boolean NOT NULL DEFAULT false,
  PRIMARY KEY (run_id, document_id, page_number)
);

CREATE TABLE IF NOT EXISTS vision_org_unbilled_spend (
  org_id text NOT NULL,
  hour timestamptz NOT NULL,
  cents double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, hour)
);

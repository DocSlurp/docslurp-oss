-- Vision attempt ledger for the worker's vision guard (worker/src/lib/vision-attempt-guard.ts,
-- worker/src/db/vision-attempt-store.ts). Every HTTP request the worker sends to a vision provider is
-- admitted here first, under the run's then the org's advisory lock, so every worker of a run and every
-- run of an org count against the same rows. The guard counts requests; it reads no cost.
--
-- These are guard counters, not spend: billing, budgets and reports still read usage_events through
-- usage_attribution.

-- Requests per run, page and purpose (page, region, map-ocr, critique) and how many failed or were
-- rejected (the run's rejection breaker). Only meaningful while the run exists.
CREATE TABLE IF NOT EXISTS vision_run_attempts (
  run_id text NOT NULL REFERENCES workspace_runs(id) ON DELETE CASCADE,
  document_id text NOT NULL,
  page_number integer NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('page', 'region', 'map-ocr', 'critique')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  PRIMARY KEY (run_id, document_id, page_number, purpose)
);

-- Pages of a run whose vision read created the customer's Rich page charge (one per run and page), so
-- only one request per page and run ever leaves the org's uncharged count.
CREATE TABLE IF NOT EXISTS vision_run_charged_pages (
  run_id text NOT NULL REFERENCES workspace_runs(id) ON DELETE CASCADE,
  document_id text NOT NULL,
  page_number integer NOT NULL,
  PRIMARY KEY (run_id, document_id, page_number)
);

-- One row per admitted request not (yet) confirmed to have created a new customer charge: the org's
-- rolling 24 hour uncharged count. Keyed by org only, with no foreign key to runs or workspaces, so
-- deleting either can never reset it. `settled` is false while the request is in flight.
CREATE TABLE IF NOT EXISTS vision_org_attempts (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  settled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vision_org_attempts_org_idx ON vision_org_attempts (org_id, created_at);

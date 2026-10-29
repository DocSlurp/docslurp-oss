-- Vision attempt ledger for the worker's vision guard (worker/src/lib/vision-attempt-guard.ts,
-- worker/src/db/vision-attempt-store.ts). Every HTTP request the worker's vision runtime sends to a
-- vision provider is admitted here first, under the run's then the org's advisory lock, so every
-- worker of a run and every run of an org count against the same rows. The guard counts requests,
-- weighted by their route's worst-case list price; it reads no reported cost.
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

-- One row per admitted request not (yet) known to have created a persisted customer charge: the org's
-- rolling 24 hour uncharged count, weighted by the worst case the request's route can cost us
-- (weight_cents). Keyed by org only, with no foreign key to runs or workspaces, so deleting either can
-- never reset it. A row leaves only in the checkpoint transaction that inserts the Rich page charge its
-- read created (usage_events id rich:<run>:<document>:<page>, first insert wins), or when the provider
-- refused the request before accepting it (429, overload, streaming unsupported). `settled` is false
-- while the request is in flight or its charge awaits that checkpoint.
CREATE TABLE IF NOT EXISTS vision_org_attempts (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  weight_cents numeric(12, 4) NOT NULL CHECK (weight_cents > 0),
  settled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vision_org_attempts_org_idx ON vision_org_attempts (org_id, created_at);

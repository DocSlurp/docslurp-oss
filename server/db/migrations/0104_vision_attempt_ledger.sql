-- Vision attempt ledger for the worker's vision guard (worker/src/lib/vision-attempt-guard.ts,
-- worker/src/db/vision-attempt-store.ts). Every HTTP request the worker's vision runtime sends to a
-- vision provider is admitted here first, under the run's then the org's advisory lock, so every
-- worker of a run and every run of an org count against the same rows. The guard counts requests,
-- weighted by their route's worst-case list price; admission reads no reported cost, and a response billed
-- above its weight only ever adds to the count (vision_route_overruns below).
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

-- One row per admitted request, kept for the 24 hour window whatever happens to the run, its workspace or its
-- vision_org_attempts row (a Rich charge checkpoint removes that one): the durable owner of the request. A billed
-- overrun is reconciled against this ticket, never against the run row, so deleting the run cannot lose it.
-- weight_cents is what the request was admitted at (the route's catalog bound times the route's weight
-- correction); bound_cents is the catalog bound alone. provider and model are null on unbilled routes.
CREATE TABLE IF NOT EXISTS vision_admission_tickets (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  provider text,
  model text,
  weight_cents numeric(12, 4) NOT NULL CHECK (weight_cents > 0),
  bound_cents numeric(12, 4) NOT NULL CHECK (bound_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vision_admission_tickets_created_idx ON vision_admission_tickets (created_at);

-- One row per admission ticket whose response a provider billed above the route's catalog bound (a provider
-- counting more image tokens than the catalog's processor bound). The ticket id is the key, so reconciling the
-- same response twice (a retried write whose first commit was not acknowledged) changes nothing. The worker
-- tops the ticket's org up by billed minus admitted weight in vision_org_attempts (row id overrun:<ticket>),
-- refuses the route for that org once the org has VISION_ROUTE_OVERRUN_LIMIT rows on it in 24 hours, and
-- multiplies every org's later admission weight on the route by its highest billed/bound ratio in 24 hours
-- (capped at VISION_ROUTE_WEIGHT_CORRECTION_MAX). org_id comes from the ticket; run_id is diagnostics only.
-- Reset runbook: docs/page-router.md.
CREATE TABLE IF NOT EXISTS vision_route_overruns (
  ticket_id text PRIMARY KEY,
  provider text NOT NULL,
  model text NOT NULL,
  org_id text NOT NULL,
  run_id text,
  billed_cents numeric(12, 4) NOT NULL,
  bound_cents numeric(12, 4) NOT NULL CHECK (bound_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vision_route_overruns_org_route_idx ON vision_route_overruns (org_id, provider, model, created_at);
CREATE INDEX IF NOT EXISTS vision_route_overruns_route_idx ON vision_route_overruns (provider, model, created_at);

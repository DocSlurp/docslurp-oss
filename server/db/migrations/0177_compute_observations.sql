-- Operational compute prices and calibration receipts. No customer content or tenant identifiers.
-- Price writes are operator-owned; runtime roles may read prices and append measurements only.
CREATE TABLE IF NOT EXISTS compute_price_observations (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  offer_id text NOT NULL CHECK (length(offer_id) BETWEEN 1 AND 200),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 100),
  sku text NOT NULL CHECK (length(sku) BETWEEN 1 AND 200),
  region text NOT NULL CHECK (length(region) BETWEEN 1 AND 100),
  market text NOT NULL CHECK (length(market) BETWEEN 1 AND 100),
  observed_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL CHECK (valid_until > observed_at AND valid_until <= observed_at + interval '24 hours'),
  source_url text NOT NULL CHECK (source_url ~ '^https://' AND length(source_url) <= 2000),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  native_currency text NOT NULL CHECK (native_currency ~ '^[A-Z]{3}$'),
  native_per_hour numeric NOT NULL CHECK (native_per_hour > 0 AND native_per_hour < 1000000),
  usd_per_native numeric NOT NULL CHECK (usd_per_native > 0 AND usd_per_native < 1000000),
  fx_observed_at timestamptz NOT NULL,
  fx_source_url text NOT NULL CHECK (fx_source_url ~ '^https://' AND length(fx_source_url) <= 2000),
  usd_per_hour numeric NOT NULL CHECK (usd_per_hour > 0 AND usd_per_hour < 1000000),
  egress_usd_per_gib numeric NOT NULL CHECK (egress_usd_per_gib >= 0 AND egress_usd_per_gib < 1000000),
  billing_minimum_seconds integer NOT NULL CHECK (billing_minimum_seconds >= 0),
  billing_quantum_seconds integer NOT NULL CHECK (billing_quantum_seconds > 0),
  UNIQUE (id, offer_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS compute_price_lookup_idx ON compute_price_observations
  (provider, sku, region, market, observed_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS compute_calibration_observations (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  profile_id text NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 200),
  price_id text NOT NULL,
  offer_id text NOT NULL CHECK (length(offer_id) BETWEEN 1 AND 200),
  image_hash text NOT NULL CHECK (length(image_hash) BETWEEN 1 AND 200),
  isolation_policy text NOT NULL CHECK (length(isolation_policy) BETWEEN 1 AND 200),
  engine text NOT NULL CHECK (length(engine) BETWEEN 1 AND 200),
  workload text NOT NULL CHECK (length(workload) BETWEEN 1 AND 100),
  observed_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL CHECK (valid_until > observed_at),
  attempted integer NOT NULL CHECK (attempted > 0),
  succeeded integer NOT NULL CHECK (succeeded >= 0),
  failed integer NOT NULL CHECK (failed >= 0),
  slots integer NOT NULL CHECK (slots > 0 AND slots <= 1024),
  startup_p95_ms integer NOT NULL CHECK (startup_p95_ms >= 0),
  service_p95_ms_per_page integer NOT NULL CHECK (service_p95_ms_per_page > 0),
  transfer_ms_per_mib numeric NOT NULL CHECK (transfer_ms_per_mib >= 0 AND transfer_ms_per_mib < 1000000000),
  idle_tail_ms integer NOT NULL CHECK (idle_tail_ms >= 0),
  allocated_ms bigint NOT NULL CHECK (allocated_ms > 0),
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  CHECK (succeeded + failed = attempted),
  FOREIGN KEY (price_id, offer_id) REFERENCES compute_price_observations(id, offer_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS compute_calibration_lookup_idx ON compute_calibration_observations
  (profile_id, observed_at DESC);
--> statement-breakpoint
REVOKE ALL ON compute_price_observations, compute_calibration_observations FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['docslurp_app', 'docslurp_worker'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = runtime_role) THEN CONTINUE; END IF;
    EXECUTE format('REVOKE ALL ON public.compute_price_observations, public.compute_calibration_observations FROM %I', runtime_role);
    EXECUTE format('GRANT SELECT ON public.compute_price_observations, public.compute_calibration_observations TO %I', runtime_role);
    EXECUTE format('GRANT INSERT ON public.compute_calibration_observations TO %I', runtime_role);
  END LOOP;
END $$;

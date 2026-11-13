-- Live provider observations for route tiers (packages/shared/src/provider-tiers.ts): what each model x endpoint
-- (an OpenRouter endpoint tag) cost and how it served, over time. Global operations data, not tenant data: no
-- organization, project, user, prompt or document is stored here.
--
-- Rows only rank and filter hosts inside reviewed tier options; a host absent from an option's pool is never sent a
-- request whatever this table says, so writing a row cannot widen where customer data goes.
--
-- Sources:
--   openrouter-endpoints  the public /models/{id}/endpoints listing (prices, status, uptime), polled by the API's
--                         maintenance sweep;
--   traffic               our own served requests (time to first token, served host), recorded by the caller.
--
-- A new table and a view: no lock on any existing table.
CREATE TABLE IF NOT EXISTS provider_endpoint_observations (
  id bigserial PRIMARY KEY,
  observed_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('openrouter-endpoints', 'traffic')),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  endpoint text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 200),
  input_usd_per_mtok numeric CHECK (input_usd_per_mtok >= 0),
  output_usd_per_mtok numeric CHECK (output_usd_per_mtok >= 0),
  cache_read_usd_per_mtok numeric CHECK (cache_read_usd_per_mtok >= 0),
  -- OpenRouter time-of-day or prompt-size price overrides, as listed.
  price_overrides jsonb,
  quantization text,
  status integer,
  uptime_30m numeric CHECK (uptime_30m BETWEEN 0 AND 100),
  latency_ms integer CHECK (latency_ms >= 0),
  generation_ms integer CHECK (generation_ms >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS provider_endpoint_observations_lookup_idx
  ON provider_endpoint_observations (model, endpoint, source, observed_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS provider_endpoint_observations_age_idx ON provider_endpoint_observations (observed_at);
--> statement-breakpoint
-- The current state per model x endpoint: the latest listed price, status and uptime, and the median time to first
-- token over the last 2 hours of our own traffic (null when there was none).
CREATE OR REPLACE VIEW provider_endpoint_current AS
WITH listed AS (
  SELECT DISTINCT ON (model, endpoint) model, endpoint, observed_at, input_usd_per_mtok, output_usd_per_mtok, status, uptime_30m
  FROM provider_endpoint_observations
  WHERE source = 'openrouter-endpoints'
  ORDER BY model, endpoint, observed_at DESC
), served AS (
  SELECT model, endpoint, percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS latency_p50_ms, count(*) AS samples
  FROM provider_endpoint_observations
  WHERE source = 'traffic' AND latency_ms IS NOT NULL AND observed_at > now() - interval '2 hours'
  GROUP BY model, endpoint
)
SELECT listed.model, listed.endpoint, listed.observed_at, listed.input_usd_per_mtok, listed.output_usd_per_mtok,
  listed.status, listed.uptime_30m, served.latency_p50_ms, coalesce(served.samples, 0) AS latency_samples
FROM listed LEFT JOIN served USING (model, endpoint);
--> statement-breakpoint
-- The app role (API: poller, pruning) gets DML through default privileges. The worker reads current observations and
-- records served latency: SELECT and INSERT on the table, its sequence, SELECT on the view; never UPDATE or DELETE.
-- server/db/roles.mjs reconciles the same grants after every migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    REVOKE ALL ON public.provider_endpoint_observations FROM docslurp_worker;
    GRANT SELECT, INSERT ON public.provider_endpoint_observations TO docslurp_worker;
    GRANT USAGE, SELECT ON SEQUENCE public.provider_endpoint_observations_id_seq TO docslurp_worker;
    REVOKE ALL ON public.provider_endpoint_current FROM docslurp_worker;
    GRANT SELECT ON public.provider_endpoint_current TO docslurp_worker;
  END IF;
END $$;

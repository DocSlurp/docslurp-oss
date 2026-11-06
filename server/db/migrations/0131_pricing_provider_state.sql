-- Durable, fleet-shared state for the deployment's pricing provider (DOCSLURP_PRICING_PLUGIN): named, monotone counters.
-- A provider keeps here what must survive restarts and be shared by every API, worker and chat-executor machine, such as
-- the highest version of something it has accepted, so it can refuse an older one replayed after a restart. Neutral: a key
-- and a bigint; no prices, rates or provider details are stored or described here.
--
-- The value only ever rises: runtime roles read the table and raise a key through pricing_state_raise(key, candidate), a
-- SECURITY DEFINER function that inserts the key or keeps the larger of the stored and candidate values in one statement
-- (concurrent raises serialize on the row) and returns the stored value. No runtime role may INSERT, UPDATE, DELETE or
-- TRUNCATE the table itself, so none can lower or reset a value; the grants below hold at commit for the roles that exist,
-- and server/db/roles.mjs reconciles them after every migration.
--
-- A new table and a function: no lock on any existing table, so no lock prelude (0122's rule; pinned by
-- rollout-0121-0127-locks.test.ts, which covers this release).
CREATE TABLE IF NOT EXISTS pricing_provider_state (
  key text PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  value bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pricing_state_raise(p_key text, p_candidate bigint) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO public.pricing_provider_state AS s (key, value) VALUES (p_key, p_candidate)
  ON CONFLICT (key) DO UPDATE
    SET value = greatest(s.value, excluded.value),
        updated_at = CASE WHEN excluded.value > s.value THEN now() ELSE s.updated_at END
  RETURNING value
$$;
--> statement-breakpoint
REVOKE ALL ON public.pricing_provider_state FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.pricing_state_raise(text, bigint) FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE runtime_role text;
BEGIN
  -- The app role (API and chat executor) gets table DML and function EXECUTE through default privileges; the worker none.
  -- Both end with SELECT and EXECUTE only.
  FOREACH runtime_role IN ARRAY ARRAY['docslurp_app','docslurp_worker'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = runtime_role) THEN CONTINUE; END IF;
    EXECUTE format('REVOKE ALL ON public.pricing_provider_state FROM %I', runtime_role);
    EXECUTE format('GRANT SELECT ON public.pricing_provider_state TO %I', runtime_role);
    EXECUTE format('REVOKE ALL ON FUNCTION public.pricing_state_raise(text, bigint) FROM %I', runtime_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pricing_state_raise(text, bigint) TO %I', runtime_role);
  END LOOP;
END $$;

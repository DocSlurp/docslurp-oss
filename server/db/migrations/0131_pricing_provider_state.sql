-- Durable, fleet-shared state for the deployment's pricing provider (DOCSLURP_PRICING_PLUGIN): named, monotone counters.
-- A provider keeps here what must survive restarts and be shared by every API, worker and chat-executor machine, such as
-- the highest version of something an operator has activated, so every process can refuse an older one replayed after a
-- restart. Neutral: a key and a bigint; no prices, rates or provider details are stored or described here.
--
-- Runtime roles only read it. A value rises only through pricing_state_raise(key, candidate), run by the table owner (the
-- operator's credential, never a runtime role): it inserts the key or keeps the larger of the stored and candidate values
-- (concurrent raises serialize on the row) and returns the stored value. Candidates are at least 1 and values never
-- negative. A missing key is seeded at any candidate (after a database reset the operator restores the current value);
-- an existing key rises by at most 1000 per raise, a guard against an operator's typo. The function is SECURITY INVOKER and no
-- runtime role may EXECUTE it, INSERT, UPDATE, DELETE or TRUNCATE the table, so no runtime role can raise, lower or reset a
-- value: a per-call cap alone could not stop a caller allowed unlimited calls (council J). The grants below hold at commit
-- for the roles that exist, and server/db/roles.mjs reconciles them after every migration. Pre-release: this migration was
-- edited in place before its first deploy (council G L1 and J, 2026-11-06).
--
-- A new table and a function: no lock on any existing table, so no lock prelude (0122's rule; pinned by
-- rollout-0121-0127-locks.test.ts, which covers this release).
CREATE TABLE IF NOT EXISTS pricing_provider_state (
  key text PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  value bigint NOT NULL CHECK (value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pricing_state_raise(p_key text, p_candidate bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE stored bigint;
BEGIN
  IF p_candidate IS NULL OR p_candidate < 1 THEN
    RAISE EXCEPTION 'pricing_state_raise: candidate must be at least 1' USING ERRCODE = '22003';
  END IF;
  SELECT s.value INTO stored FROM public.pricing_provider_state s WHERE s.key = p_key FOR UPDATE;
  -- An existing counter rises by at most 1000 per raise (an operator's typo); a missing key is seeded at the candidate.
  IF stored IS NOT NULL AND p_candidate::numeric > stored::numeric + 1000 THEN
    RAISE EXCEPTION 'pricing_state_raise: candidate exceeds the stored value by more than 1000' USING ERRCODE = '22003';
  END IF;
  INSERT INTO public.pricing_provider_state AS s (key, value) VALUES (p_key, p_candidate)
  ON CONFLICT (key) DO UPDATE
    SET value = greatest(s.value, excluded.value),
        updated_at = CASE WHEN excluded.value > s.value THEN now() ELSE s.updated_at END
  RETURNING s.value INTO stored;
  RETURN stored;
END
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
  -- Both end with SELECT on the table only.
  FOREACH runtime_role IN ARRAY ARRAY['docslurp_app','docslurp_worker'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = runtime_role) THEN CONTINUE; END IF;
    EXECUTE format('REVOKE ALL ON public.pricing_provider_state FROM %I', runtime_role);
    EXECUTE format('GRANT SELECT ON public.pricing_provider_state TO %I', runtime_role);
    EXECUTE format('REVOKE ALL ON FUNCTION public.pricing_state_raise(text, bigint) FROM %I', runtime_role);
  END LOOP;
END $$;

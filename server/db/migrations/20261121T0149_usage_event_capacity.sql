-- destructive-migration: Widens existing fields without changing values; the attribution view retains its OID, output types and grants.
-- The view references all three columns. Temporarily detach its expressions
-- inside this transaction, then restore its exact definition after the rewrite.
DO $$
DECLARE
  definition text;
  detached text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.usage_events'::regclass
      AND ((attname IN ('input_tokens', 'output_tokens') AND atttypid <> 'bigint'::regtype)
        OR (attname = 'amount' AND atttypmod <> -1))
  ) THEN RETURN; END IF;

  -- Take locks in the same order as a read of the view.
  definition := pg_get_viewdef('public.usage_attribution'::regclass);
  detached := replace(definition, '(ue.amount * scope.share) AS amount', 'NULL::numeric AS amount');
  detached := replace(detached, '((ue.input_tokens)::numeric * scope.share) AS input_tokens', 'NULL::numeric AS input_tokens');
  detached := replace(detached, '((ue.output_tokens)::numeric * scope.share) AS output_tokens', 'NULL::numeric AS output_tokens');
  EXECUTE 'CREATE OR REPLACE VIEW public.usage_attribution AS ' || detached;

  ALTER TABLE public.usage_events
    ALTER COLUMN amount TYPE numeric,
    ALTER COLUMN input_tokens TYPE bigint,
    ALTER COLUMN output_tokens TYPE bigint,
    -- The former numeric typmod rejected infinities. Keep that behavior.
    ADD CONSTRAINT usage_events_amount_finite_range
      CHECK (amount NOT IN ('Infinity'::numeric, '-Infinity'::numeric));

  EXECUTE 'CREATE OR REPLACE VIEW public.usage_attribution AS ' || definition;
END $$;

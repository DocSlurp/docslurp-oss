-- destructive-migration: Widens accumulated token counters and preserves additional precision on future cost increments.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = 'public.graph_jobs'::regclass
      AND ((attname IN ('input_tokens', 'output_tokens') AND atttypid <> 'bigint'::regtype)
        OR (attname = 'cost_cents' AND format_type(atttypid, atttypmod) <> 'numeric(24,12)'))
  ) THEN
    ALTER TABLE public.graph_jobs
      ALTER COLUMN input_tokens TYPE bigint,
      ALTER COLUMN output_tokens TYPE bigint,
      ALTER COLUMN cost_cents TYPE numeric(24,12);
  END IF;
END $$;

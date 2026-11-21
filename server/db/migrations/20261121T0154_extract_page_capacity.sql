-- destructive-migration: Widens the aggregate page count of an extract's run without changing stored values.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = 'public.extracts'::regclass
      AND attname = 'pages' AND atttypid <> 'bigint'::regtype
  ) THEN
    ALTER TABLE public.extracts ALTER COLUMN pages TYPE bigint;
  END IF;
END $$;

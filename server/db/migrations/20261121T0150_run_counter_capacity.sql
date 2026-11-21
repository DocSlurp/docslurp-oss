-- destructive-migration: Widens run counters in place and restores the dependent materialized view and counter trigger in the same transaction.
-- The materialized view has no in-tree readers. Rebuild it with the same
-- columns and types for operators and self-hosted consumers.
DO $$
DECLARE
  counter_trigger text;
  trigger_mode "char";
  stats_populated boolean;
  stats_grants aclitem[];
  entry record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.project_runs'::regclass
      AND attname IN ('total_documents', 'processed_documents', 'pages_total', 'pages_processed', 'spend_unchecked_pages')
      AND atttypid <> 'bigint'::regtype
  ) THEN RETURN; END IF;

  -- Custom objects must be dealt with explicitly. DROP without CASCADE also
  -- refuses downstream dependencies.
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.admin_stats'::regclass
      AND (pg_get_userbyid(relowner) <> current_user OR relhasindex OR reloptions IS NOT NULL
        OR reltablespace <> 0 OR obj_description(oid, 'pg_class') IS NOT NULL)
  ) OR EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = 'public.admin_stats'::regclass AND attnum > 0
      AND (attacl IS NOT NULL OR col_description(attrelid, attnum) IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'admin_stats has custom metadata; preserve it before applying the run counter migration';
  END IF;

  SELECT relispopulated, relacl INTO STRICT stats_populated, stats_grants
  FROM pg_class WHERE oid = 'public.admin_stats'::regclass;
  SELECT pg_get_triggerdef(oid), tgenabled INTO STRICT counter_trigger, trigger_mode
  FROM pg_trigger WHERE tgrelid = 'public.project_runs'::regclass
    AND tgname = 'project_runs_corpus_stats_update';

  DROP MATERIALIZED VIEW public.admin_stats;
  DROP TRIGGER project_runs_corpus_stats_update ON public.project_runs;

  ALTER TABLE public.project_runs
    ALTER COLUMN total_documents TYPE bigint,
    ALTER COLUMN processed_documents TYPE bigint,
    ALTER COLUMN pages_total TYPE bigint,
    ALTER COLUMN pages_processed TYPE bigint,
    ALTER COLUMN spend_unchecked_pages TYPE bigint;

  EXECUTE counter_trigger;
  IF trigger_mode = 'D' THEN
    ALTER TABLE public.project_runs DISABLE TRIGGER project_runs_corpus_stats_update;
  ELSIF trigger_mode = 'R' THEN
    ALTER TABLE public.project_runs ENABLE REPLICA TRIGGER project_runs_corpus_stats_update;
  ELSIF trigger_mode = 'A' THEN
    ALTER TABLE public.project_runs ENABLE ALWAYS TRIGGER project_runs_corpus_stats_update;
  END IF;

  CREATE MATERIALIZED VIEW public.admin_stats AS
    SELECT date_trunc('hour', created_at) AS hour, count(*) AS runs_count,
      sum(pages_total)::bigint AS pages_total, avg(output_cost_cents + input_cost_cents) AS avg_cost_cents
    FROM public.project_runs
    GROUP BY date_trunc('hour', created_at)
    WITH NO DATA;
  IF stats_populated THEN REFRESH MATERIALIZED VIEW public.admin_stats; END IF;

  -- Strip new default grants before restoring the previous effective grants.
  FOR entry IN
    SELECT DISTINCT grantee
    FROM pg_class, LATERAL aclexplode(relacl)
    WHERE oid = 'public.admin_stats'::regclass
      AND grantee <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
  LOOP
    EXECUTE format('REVOKE ALL ON public.admin_stats FROM %s',
      CASE WHEN entry.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(entry.grantee)) END);
  END LOOP;

  FOR entry IN
    SELECT grantee, privilege_type, is_grantable
    FROM aclexplode(CASE WHEN cardinality(stats_grants) > 0 THEN stats_grants END)
    WHERE grantee <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
  LOOP
    EXECUTE format('GRANT %s ON public.admin_stats TO %s%s', entry.privilege_type,
      CASE WHEN entry.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(entry.grantee)) END,
      CASE WHEN entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;

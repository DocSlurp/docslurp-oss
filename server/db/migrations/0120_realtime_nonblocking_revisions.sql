-- destructive-migration: realtime_revisions is introduced by 0115 in this same unreleased PR278; absent from N-1 main e6d2e6bdfdd3b8a9c2aeaff4ed7be03ea222168e. The view preserves its reader contract and this migration replaces all trigger writers.
-- Do not serialize independent ingestion transactions on one organization row.
-- Each transaction writes its own counter; committed counters are folded without
-- touching any other live writer. The aggregate view preserves the read contract.
ALTER TABLE realtime_revisions RENAME TO realtime_revision_counters;
ALTER TABLE realtime_revision_counters DROP CONSTRAINT realtime_revisions_pkey;
UPDATE realtime_revision_counters SET transaction_id=0;
ALTER TABLE realtime_revision_counters ADD PRIMARY KEY (org_id,transaction_id);
-- Maintenance must not scan every settled organization to find a pending row.
CREATE INDEX realtime_revision_pending ON realtime_revision_counters(org_id,transaction_id)
WHERE transaction_id<>0;
--> statement-breakpoint
CREATE VIEW realtime_revisions AS
SELECT org_id,sum(revision)::bigint AS revision,max(transaction_id) AS transaction_id
FROM realtime_revision_counters GROUP BY org_id;
--> statement-breakpoint
-- This role is intentionally not a runtime login or a member of another role.
-- A restricted migrator must be provisioned with membership by a cluster admin.
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='docslurp_realtime_publisher') THEN
    CREATE ROLE docslurp_realtime_publisher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
    EXECUTE format('GRANT docslurp_realtime_publisher TO %I',current_user);
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='docslurp_realtime_publisher'
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member='docslurp_realtime_publisher'::regrole) THEN
    RAISE EXCEPTION 'realtime publisher must be an isolated non-login role';
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE,CREATE ON SCHEMA public TO docslurp_realtime_publisher;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.realtime_revision_counters TO docslurp_realtime_publisher;
GRANT SELECT(id,org_id) ON public.workspaces,public.workspace_runs,public.documents TO docslurp_realtime_publisher;
--> statement-breakpoint
CREATE FUNCTION realtime_fold_committed(organization_id text) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE folded bigint; removed_count integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(319120,hashtext(organization_id)) THEN RETURN 0; END IF;
  INSERT INTO public.realtime_revision_counters(org_id,revision,transaction_id)
  VALUES(organization_id,0,0) ON CONFLICT(org_id,transaction_id) DO NOTHING;
  WITH removed AS (
    DELETE FROM public.realtime_revision_counters WHERE org_id=organization_id
      AND transaction_id IN (SELECT transaction_id FROM public.realtime_revision_counters
        WHERE org_id=organization_id AND transaction_id NOT IN (0,txid_current())
        ORDER BY transaction_id LIMIT 256 FOR UPDATE SKIP LOCKED)
    RETURNING revision
  ) SELECT coalesce(sum(revision),0)::bigint,count(*)::integer INTO folded,removed_count FROM removed;
  IF folded>0 THEN
    UPDATE public.realtime_revision_counters SET revision=revision+folded
      WHERE org_id=organization_id AND transaction_id=0;
  END IF;
  RETURN removed_count;
END $$;
--> statement-breakpoint
CREATE FUNCTION realtime_record_change(organization_id text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE inserted integer;
BEGIN
  INSERT INTO public.realtime_revision_counters(org_id,revision,transaction_id)
  VALUES(organization_id,1,txid_current()) ON CONFLICT(org_id,transaction_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted=0 THEN RETURN; END IF;
  PERFORM pg_notify('realtime_changed','');
  PERFORM public.realtime_fold_committed(organization_id);
END $$;
--> statement-breakpoint
-- Bounded independent maintenance: keyset through 16 orgs, <=256 counters/org.
-- No supplied revision or arbitrary mutation; it only folds already committed sums.
CREATE FUNCTION realtime_compact_revisions(after_org text DEFAULT '')
RETURNS TABLE(next_org text,folded_rows integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE candidate text; cursor_value text:=after_org; total integer:=0;
BEGIN
  FOR i IN 1..16 LOOP
    SELECT org_id INTO candidate FROM public.realtime_revision_counters
      WHERE org_id>cursor_value AND transaction_id<>0 ORDER BY org_id,transaction_id LIMIT 1;
    IF candidate IS NULL THEN
      RETURN QUERY SELECT ''::text,total; RETURN;
    END IF;
    total:=total+public.realtime_fold_committed(candidate);
    cursor_value:=candidate;
  END LOOP;
  RETURN QUERY SELECT cursor_value,total;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION realtime_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  old_id text;
  new_id text;
  source_kind text;
  source_id text;
  organization_id text;
BEGIN
  IF TG_TABLE_SCHEMA<>'public' OR TG_RELID<>pg_catalog.to_regclass('public.'||pg_catalog.quote_ident(TG_TABLE_NAME))
    OR TG_NAME<>'realtime_changed' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_NARGS<>0 THEN
    RAISE EXCEPTION 'untrusted realtime trigger source' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME='organizations' THEN
    source_kind := 'org';
    IF TG_OP<>'INSERT' THEN old_id := OLD.id; END IF;
    IF TG_OP<>'DELETE' THEN new_id := NEW.id; END IF;
  ELSIF TG_TABLE_NAME IN ('workspace_runs','documents','workspaces','org_memberships',
    'usage_events','credit_ledger','credit_debits_pending','credit_leases','interactive_spend_holds') THEN
    source_kind := 'org';
    IF TG_OP<>'INSERT' THEN old_id := OLD.org_id; END IF;
    IF TG_OP<>'DELETE' THEN new_id := NEW.org_id; END IF;
  ELSIF TG_TABLE_NAME IN ('workspace_members','workspace_search_settings','query_suggestions') THEN
    source_kind := 'workspace';
    IF TG_OP<>'INSERT' THEN old_id := OLD.workspace_id; END IF;
    IF TG_OP<>'DELETE' THEN new_id := NEW.workspace_id; END IF;
  ELSIF TG_TABLE_NAME IN ('workspace_run_events','workspace_run_stage_states','performance_log') THEN
    source_kind := 'run';
    IF TG_OP<>'INSERT' THEN old_id := OLD.run_id; END IF;
    IF TG_OP<>'DELETE' THEN new_id := NEW.run_id; END IF;
  ELSIF TG_TABLE_NAME IN ('document_run_stage_states','page_stage_states','document_tags',
    'document_summaries','document_pages','document_chunks') THEN
    source_kind := 'document';
    IF TG_OP<>'INSERT' THEN old_id := OLD.document_id; END IF;
    IF TG_OP<>'DELETE' THEN new_id := NEW.document_id; END IF;
  ELSE RAISE EXCEPTION 'Unsupported realtime source';
  END IF;
  FOR source_id IN SELECT DISTINCT value FROM unnest(ARRAY[old_id,new_id]) AS value WHERE value IS NOT NULL ORDER BY value LOOP
    organization_id := NULL;
    IF source_kind='org' THEN organization_id := source_id;
    ELSIF source_kind='workspace' THEN SELECT org_id INTO organization_id FROM public.workspaces WHERE id=source_id;
    ELSIF source_kind='run' THEN SELECT org_id INTO organization_id FROM public.workspace_runs WHERE id=source_id;
    ELSE SELECT org_id INTO organization_id FROM public.documents WHERE id=source_id;
    END IF;
    IF organization_id IS NOT NULL THEN
      PERFORM public.realtime_record_change(organization_id);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION realtime_search_session_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  workspace_id_value text;
  old_workspace_id text;
  new_workspace_id text;
  organization_id text;
BEGIN
  IF TG_TABLE_SCHEMA<>'public' OR TG_RELID<>'public.search_sessions'::pg_catalog.regclass
    OR TG_NAME<>'realtime_changed' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_NARGS<>0 THEN
    RAISE EXCEPTION 'untrusted realtime trigger source' USING ERRCODE='42501';
  END IF;
  IF TG_OP<>'INSERT' THEN old_workspace_id := OLD.metadata->>'workspaceId'; END IF;
  IF TG_OP<>'DELETE' THEN new_workspace_id := NEW.metadata->>'workspaceId'; END IF;
  FOR workspace_id_value IN SELECT DISTINCT value FROM unnest(ARRAY[old_workspace_id,new_workspace_id]) AS value WHERE value IS NOT NULL ORDER BY value LOOP
    SELECT org_id INTO organization_id FROM public.workspaces WHERE id=workspace_id_value;
    IF organization_id IS NOT NULL THEN
      PERFORM public.realtime_record_change(organization_id);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION realtime_materialization_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE organization_id text;
BEGIN
  IF TG_TABLE_SCHEMA<>'public' OR TG_RELID<>'public.document_page_states'::pg_catalog.regclass
    OR TG_NAME<>'realtime_changed' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_NARGS<>0 THEN
    RAISE EXCEPTION 'untrusted realtime trigger source' USING ERRCODE='42501';
  END IF;
  SELECT org_id INTO organization_id FROM public.documents WHERE id=coalesce(NEW.document_id,OLD.document_id);
  IF organization_id IS NOT NULL THEN
    PERFORM public.realtime_record_change(organization_id);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Revoke function capabilities before publishing the schema transaction. Trigger
-- execution does not require runtime EXECUTE; attaching a trigger does.
ALTER FUNCTION public.realtime_changed() OWNER TO docslurp_realtime_publisher;
ALTER FUNCTION public.realtime_search_session_changed() OWNER TO docslurp_realtime_publisher;
ALTER FUNCTION public.realtime_materialization_changed() OWNER TO docslurp_realtime_publisher;
ALTER FUNCTION public.realtime_record_change(text) OWNER TO docslurp_realtime_publisher;
ALTER FUNCTION public.realtime_fold_committed(text) OWNER TO docslurp_realtime_publisher;
ALTER FUNCTION public.realtime_compact_revisions(text) OWNER TO docslurp_realtime_publisher;
REVOKE CREATE ON SCHEMA public FROM docslurp_realtime_publisher;
REVOKE ALL ON FUNCTION public.realtime_changed(),public.realtime_search_session_changed(),
  public.realtime_materialization_changed(),public.realtime_record_change(text),
  public.realtime_fold_committed(text),public.realtime_compact_revisions(text) FROM PUBLIC;
REVOKE ALL ON public.realtime_revision_counters,public.realtime_revisions FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['docslurp_app','docslurp_worker'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=runtime_role) THEN CONTINUE; END IF;
    IF pg_catalog.pg_has_role(runtime_role,'docslurp_realtime_publisher','MEMBER') THEN
      RAISE EXCEPTION 'runtime role must not inherit realtime publisher';
    END IF;
    EXECUTE format('REVOKE ALL ON public.realtime_revision_counters,public.realtime_revisions FROM %I',runtime_role);
    EXECUTE format('REVOKE ALL ON FUNCTION public.realtime_changed(),public.realtime_search_session_changed(),public.realtime_materialization_changed(),public.realtime_record_change(text),public.realtime_fold_committed(text),public.realtime_compact_revisions(text) FROM %I',runtime_role);
    IF runtime_role='docslurp_app' THEN
      EXECUTE format('GRANT SELECT ON public.realtime_revisions TO %I',runtime_role);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.realtime_compact_revisions(text) TO %I',runtime_role);
    END IF;
  END LOOP;
END $$;

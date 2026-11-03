-- Do not serialize independent ingestion transactions on one organization row.
-- Each transaction writes its own counter; committed counters are folded without
-- touching any other live writer. The aggregate view preserves the read contract.
ALTER TABLE realtime_revisions RENAME TO realtime_revision_counters;
ALTER TABLE realtime_revision_counters DROP CONSTRAINT realtime_revisions_pkey;
UPDATE realtime_revision_counters SET transaction_id=0;
ALTER TABLE realtime_revision_counters ADD PRIMARY KEY (org_id,transaction_id);
--> statement-breakpoint
CREATE VIEW realtime_revisions AS
SELECT org_id,sum(revision)::bigint AS revision,max(transaction_id) AS transaction_id
FROM realtime_revision_counters GROUP BY org_id;
--> statement-breakpoint
CREATE FUNCTION realtime_record_change(organization_id text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE inserted integer; folded bigint;
BEGIN
  INSERT INTO public.realtime_revision_counters(org_id,revision,transaction_id)
  VALUES(organization_id,1,txid_current()) ON CONFLICT(org_id,transaction_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted=0 THEN RETURN; END IF;
  -- NOTIFY remains commit-only. Missing notifications recover through the view.
  PERFORM pg_notify('realtime_changed','');
  -- Compaction must never wait for another publisher. All non-current visible
  -- transaction rows are immutable: their originating transaction has committed.
  IF NOT pg_try_advisory_xact_lock(319120,hashtext(organization_id)) THEN RETURN; END IF;
  INSERT INTO public.realtime_revision_counters(org_id,revision,transaction_id)
  VALUES(organization_id,0,0) ON CONFLICT(org_id,transaction_id) DO NOTHING;
  WITH removed AS (
    DELETE FROM public.realtime_revision_counters WHERE org_id=organization_id
      AND transaction_id IN (SELECT transaction_id FROM public.realtime_revision_counters
        WHERE org_id=organization_id AND transaction_id NOT IN (0,txid_current())
        ORDER BY transaction_id LIMIT 256 FOR UPDATE SKIP LOCKED)
    RETURNING revision
  ) SELECT coalesce(sum(revision),0)::bigint INTO folded FROM removed;
  IF folded>0 THEN
    UPDATE public.realtime_revision_counters SET revision=revision+folded
      WHERE org_id=organization_id AND transaction_id=0;
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION realtime_changed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  old_id text;
  new_id text;
  source_kind text;
  source_id text;
  organization_id text;
BEGIN
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
    ELSIF source_kind='workspace' THEN SELECT org_id INTO organization_id FROM workspaces WHERE id=source_id;
    ELSIF source_kind='run' THEN SELECT org_id INTO organization_id FROM workspace_runs WHERE id=source_id;
    ELSE SELECT org_id INTO organization_id FROM documents WHERE id=source_id;
    END IF;
    IF organization_id IS NOT NULL THEN
      PERFORM public.realtime_record_change(organization_id);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION realtime_search_session_changed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  workspace_id_value text;
  old_workspace_id text;
  new_workspace_id text;
  organization_id text;
BEGIN
  IF TG_OP<>'INSERT' THEN old_workspace_id := OLD.metadata->>'workspaceId'; END IF;
  IF TG_OP<>'DELETE' THEN new_workspace_id := NEW.metadata->>'workspaceId'; END IF;
  FOR workspace_id_value IN SELECT DISTINCT value FROM unnest(ARRAY[old_workspace_id,new_workspace_id]) AS value WHERE value IS NOT NULL ORDER BY value LOOP
    SELECT org_id INTO organization_id FROM workspaces WHERE id=workspace_id_value;
    IF organization_id IS NOT NULL THEN
      PERFORM public.realtime_record_change(organization_id);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION realtime_materialization_changed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE organization_id text;
BEGIN
  SELECT org_id INTO organization_id FROM documents WHERE id=coalesce(NEW.document_id,OLD.document_id);
  IF organization_id IS NOT NULL THEN
    PERFORM public.realtime_record_change(organization_id);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

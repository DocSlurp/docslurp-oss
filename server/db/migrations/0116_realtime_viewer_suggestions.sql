-- Read only scope columns: never serialize page text, chunk content, event
-- payloads or document metadata merely to publish an invalidation.
CREATE OR REPLACE FUNCTION realtime_changed() RETURNS trigger LANGUAGE plpgsql AS $$
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
      INSERT INTO realtime_revisions(org_id,revision,transaction_id) VALUES(organization_id,1,txid_current())
      ON CONFLICT(org_id) DO UPDATE SET revision=realtime_revisions.revision+1,transaction_id=txid_current()
      WHERE realtime_revisions.transaction_id<>txid_current();
      PERFORM pg_notify('realtime_changed','');
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Processing-only viewer and suggestion observation. These triggers publish
-- only committed revisions; they never generate suggestions or read artifacts.
CREATE TRIGGER realtime_changed AFTER INSERT OR UPDATE OR DELETE ON query_suggestions
FOR EACH ROW EXECUTE FUNCTION realtime_changed();
--> statement-breakpoint
CREATE TRIGGER realtime_changed AFTER INSERT OR UPDATE OR DELETE ON document_pages
FOR EACH ROW EXECUTE FUNCTION realtime_changed();
--> statement-breakpoint
CREATE TRIGGER realtime_changed AFTER INSERT OR UPDATE OR DELETE ON document_chunks
FOR EACH ROW EXECUTE FUNCTION realtime_changed();
--> statement-breakpoint
-- search_sessions carries workspace identity in metadata, rather than a column.
CREATE FUNCTION realtime_search_session_changed() RETURNS trigger LANGUAGE plpgsql AS $$
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
      INSERT INTO realtime_revisions(org_id,revision,transaction_id) VALUES(organization_id,1,txid_current())
      ON CONFLICT(org_id) DO UPDATE SET revision=realtime_revisions.revision+1,transaction_id=txid_current()
      WHERE realtime_revisions.transaction_id<>txid_current();
      PERFORM pg_notify('realtime_changed','');
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER realtime_changed AFTER INSERT OR UPDATE OR DELETE ON search_sessions
FOR EACH ROW EXECUTE FUNCTION realtime_search_session_changed();

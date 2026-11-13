-- Commit-visible dashboard revisions. NOTIFY is delivered by Postgres only on
-- commit; a shared bounded sweep reads these rows to recover lost notifications.
CREATE TABLE IF NOT EXISTS realtime_revisions (
  org_id text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 1,
  transaction_id bigint NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION realtime_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb;
  organization_id text;
  workspace_id_value text;
  run_id_value text;
BEGIN
  -- Visit both scopes when ownership changes, so the old collection removes it.
  FOR row_data IN SELECT value FROM jsonb_array_elements(
    CASE WHEN TG_OP = 'INSERT' THEN jsonb_build_array(to_jsonb(NEW))
         WHEN TG_OP = 'DELETE' THEN jsonb_build_array(to_jsonb(OLD))
         ELSE jsonb_build_array(to_jsonb(OLD), to_jsonb(NEW)) END
  ) LOOP
    organization_id := row_data ->> 'org_id';
    IF TG_TABLE_NAME = 'organizations' THEN organization_id := row_data ->> 'id'; END IF;
    IF organization_id IS NULL THEN
      workspace_id_value := row_data ->> 'workspace_id';
      IF workspace_id_value IS NULL THEN
        run_id_value := row_data ->> 'run_id';
        SELECT workspace_id INTO workspace_id_value FROM workspace_runs WHERE id = run_id_value;
      END IF;
      IF workspace_id_value IS NULL AND row_data ->> 'document_id' IS NOT NULL THEN
        SELECT workspace_id INTO workspace_id_value FROM documents WHERE id = row_data ->> 'document_id';
      END IF;
      SELECT org_id INTO organization_id FROM workspaces WHERE id = workspace_id_value;
    END IF;
    IF organization_id IS NOT NULL THEN
      INSERT INTO realtime_revisions (org_id, revision, transaction_id)
      VALUES (organization_id, 1, txid_current())
      ON CONFLICT (org_id) DO UPDATE
        SET revision = realtime_revisions.revision + 1, transaction_id = txid_current()
        WHERE realtime_revisions.transaction_id <> txid_current();
      PERFORM pg_notify('realtime_changed', '');
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DO $$
DECLARE source text;
BEGIN
  FOREACH source IN ARRAY ARRAY[
    'workspace_runs', 'workspace_run_events', 'workspace_run_stage_states',
    'document_run_stage_states', 'page_stage_states', 'documents', 'workspaces',
    'workspace_search_settings', 'org_memberships', 'workspace_members',
    'document_tags', 'document_summaries', 'performance_log', 'usage_events', 'organizations', 'credit_ledger', 'credit_debits_pending',
    'credit_leases', 'interactive_spend_holds'
  ] LOOP
    EXECUTE format('CREATE OR REPLACE TRIGGER realtime_changed AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION realtime_changed()', source);
  END LOOP;
END $$;

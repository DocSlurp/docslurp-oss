-- Links are observations of independently owned shared materialization work.
CREATE TABLE IF NOT EXISTS chat_run_dependencies (
  id text PRIMARY KEY,
  operation_id text NOT NULL REFERENCES chat_operations(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES workspace_runs(id) ON DELETE CASCADE,
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  pages integer[] NOT NULL CHECK (cardinality(pages) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_id,run_id)
);
CREATE INDEX IF NOT EXISTS chat_run_dependencies_operation ON chat_run_dependencies(operation_id);

--> statement-breakpoint
CREATE OR REPLACE FUNCTION realtime_materialization_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE organization_id text;
BEGIN
  SELECT org_id INTO organization_id FROM documents WHERE id=coalesce(NEW.document_id,OLD.document_id);
  IF organization_id IS NOT NULL THEN
    INSERT INTO realtime_revisions(org_id,revision,transaction_id) VALUES(organization_id,1,txid_current())
    ON CONFLICT(org_id) DO UPDATE SET revision=realtime_revisions.revision+1,transaction_id=txid_current()
    WHERE realtime_revisions.transaction_id<>txid_current();
    PERFORM pg_notify('realtime_changed','');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER realtime_changed AFTER INSERT OR UPDATE OR DELETE ON document_page_states
FOR EACH ROW EXECUTE FUNCTION realtime_materialization_changed();

--> statement-breakpoint
-- Shared jobs still consume active-tree admission until their bounded dependency settles.
CREATE OR REPLACE FUNCTION chat_root_has_active_dependencies(root text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM chat_run_dependencies d JOIN chat_operations c ON c.id=d.operation_id
    JOIN workspace_runs r ON r.id=d.run_id
    WHERE c.root_id=root AND d.created_at+interval '15 minutes'>now()
      AND r.status NOT IN ('failed','cancelled')
      AND (SELECT count(*) FROM document_page_states p WHERE p.document_id=d.document_id
        AND p.page_number=ANY(d.pages) AND p.state IN ('indexed','failed','blocked-pii'))<cardinality(d.pages)
  )
$$;

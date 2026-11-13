-- Revisions are database-owned: timestamps and run IDs are not publication tokens.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS projection_revision bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bump_projection_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.projection_revision := OLD.projection_revision + 1;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER documents_projection_revision BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION bump_projection_revision();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION invalidate_corrected_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE documents SET projection_revision = projection_revision WHERE id = COALESCE(NEW.document_id, OLD.document_id);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER corrections_projection_revision AFTER INSERT OR UPDATE OR DELETE ON document_corrections
FOR EACH ROW EXECUTE FUNCTION invalidate_corrected_projection();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION invalidate_workspace_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pipeline IS DISTINCT FROM OLD.pipeline OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    UPDATE documents SET projection_revision = projection_revision WHERE workspace_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER workspace_projection_revision AFTER UPDATE ON workspaces
FOR EACH ROW EXECUTE FUNCTION invalidate_workspace_projection();
--> statement-breakpoint
DO $idem$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_projection_scope' AND conrelid = 'documents'::regclass) THEN
    ALTER TABLE documents ADD CONSTRAINT documents_projection_scope UNIQUE (id, workspace_id, org_id);
  END IF;
END $idem$;
--> statement-breakpoint
DO $idem$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_projection_scope' AND conrelid = 'workspaces'::regclass) THEN
    ALTER TABLE workspaces ADD CONSTRAINT workspaces_projection_scope UNIQUE (id, org_id);
  END IF;
END $idem$;

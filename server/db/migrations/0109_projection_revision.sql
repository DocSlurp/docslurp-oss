-- Revisions are database-owned: timestamps and run IDs are not publication tokens.
ALTER TABLE documents ADD COLUMN projection_revision bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE FUNCTION bump_projection_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.projection_revision := OLD.projection_revision + 1;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER documents_projection_revision BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION bump_projection_revision();
--> statement-breakpoint
CREATE FUNCTION invalidate_corrected_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE documents SET projection_revision = projection_revision WHERE id = COALESCE(NEW.document_id, OLD.document_id);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER corrections_projection_revision AFTER INSERT OR UPDATE OR DELETE ON document_corrections
FOR EACH ROW EXECUTE FUNCTION invalidate_corrected_projection();
--> statement-breakpoint
CREATE FUNCTION invalidate_workspace_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pipeline IS DISTINCT FROM OLD.pipeline OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    UPDATE documents SET projection_revision = projection_revision WHERE workspace_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER workspace_projection_revision AFTER UPDATE ON workspaces
FOR EACH ROW EXECUTE FUNCTION invalidate_workspace_projection();
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_projection_scope UNIQUE (id, workspace_id, org_id);
--> statement-breakpoint
ALTER TABLE workspaces ADD CONSTRAINT workspaces_projection_scope UNIQUE (id, org_id);

-- A document's canonical ID names the logical source it represents (a URL, a
-- site path such as /products, or any caller-chosen key). When a newer document
-- with the same canonical ID finishes processing in the same workspace, older
-- completed versions are marked superseded and drop out of search while staying
-- available for version history.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS canonical_id text;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS superseded_by_document_id text;
--> statement-breakpoint
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_canonical_id_length_check;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_canonical_id_length_check CHECK (canonical_id IS NULL OR char_length(canonical_id) BETWEEN 1 AND 2048);
--> statement-breakpoint
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS canonical_id text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS documents_workspace_canonical_idx ON documents USING btree (workspace_id, canonical_id, created_at DESC) WHERE canonical_id IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION supersede_canonical_documents() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  newer_id text;
BEGIN
  -- Serialize completions of the same logical source so concurrent versions
  -- always agree on which one is current.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id || ':' || NEW.canonical_id, 0));

  SELECT d.id INTO newer_id
  FROM documents d
  WHERE d.workspace_id = NEW.workspace_id
    AND d.canonical_id = NEW.canonical_id
    AND d.status = 'completed'
    AND d.id <> NEW.id
    AND (d.created_at, d.id) > (NEW.created_at, NEW.id)
  ORDER BY d.created_at DESC, d.id DESC
  LIMIT 1;

  IF newer_id IS NOT NULL THEN
    -- A newer version already finished; this late completion is stale on arrival.
    UPDATE documents
    SET superseded_at = coalesce(superseded_at, now()), superseded_by_document_id = newer_id
    WHERE id = NEW.id;
    RETURN NULL;
  END IF;

  UPDATE documents
  SET superseded_at = now(), superseded_by_document_id = NEW.id, updated_at = now()
  WHERE workspace_id = NEW.workspace_id
    AND canonical_id = NEW.canonical_id
    AND status = 'completed'
    AND superseded_at IS NULL
    AND id <> NEW.id
    AND (created_at, id) < (NEW.created_at, NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS documents_supersede_canonical_on_insert ON documents;
--> statement-breakpoint
CREATE TRIGGER documents_supersede_canonical_on_insert
AFTER INSERT ON documents
FOR EACH ROW
WHEN (NEW.status = 'completed' AND NEW.canonical_id IS NOT NULL)
EXECUTE FUNCTION supersede_canonical_documents();
--> statement-breakpoint
DROP TRIGGER IF EXISTS documents_supersede_canonical_on_complete ON documents;
--> statement-breakpoint
CREATE TRIGGER documents_supersede_canonical_on_complete
AFTER UPDATE OF status ON documents
FOR EACH ROW
WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' AND NEW.canonical_id IS NOT NULL)
EXECUTE FUNCTION supersede_canonical_documents();

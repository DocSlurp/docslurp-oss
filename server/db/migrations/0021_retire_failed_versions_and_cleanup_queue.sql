-- A successful replacement also retires failed and cancelled older versions of
-- the same canonical source, and a version that ends failed/cancelled after a
-- newer one completed is retired on arrival. Retired versions are purged like
-- any superseded version.
CREATE OR REPLACE FUNCTION supersede_canonical_documents() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  newer_id text;
BEGIN
  -- Serialize transitions of the same logical source so concurrent versions
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
    -- A newer version already finished; this late outcome is stale on arrival.
    UPDATE documents
    SET superseded_at = coalesce(superseded_at, now()), superseded_by_document_id = newer_id
    WHERE id = NEW.id;
    RETURN NULL;
  END IF;

  IF NEW.status <> 'completed' THEN
    -- A failed or cancelled version never replaces anything.
    RETURN NULL;
  END IF;

  UPDATE documents
  SET superseded_at = now(), superseded_by_document_id = NEW.id, updated_at = now()
  WHERE workspace_id = NEW.workspace_id
    AND canonical_id = NEW.canonical_id
    AND status IN ('completed', 'failed', 'cancelled')
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
WHEN (NEW.status IN ('completed', 'failed', 'cancelled') AND NEW.canonical_id IS NOT NULL)
EXECUTE FUNCTION supersede_canonical_documents();
--> statement-breakpoint
DROP TRIGGER IF EXISTS documents_supersede_canonical_on_complete ON documents;
--> statement-breakpoint
CREATE TRIGGER documents_supersede_canonical_on_complete
AFTER UPDATE OF status ON documents
FOR EACH ROW
WHEN (NEW.status IN ('completed', 'failed', 'cancelled') AND OLD.status IS DISTINCT FROM NEW.status AND NEW.canonical_id IS NOT NULL)
EXECUTE FUNCTION supersede_canonical_documents();
--> statement-breakpoint
-- External cleanup for documents deleted by hand: the row (and its derived rows)
-- are gone immediately; the worker purge sweep then deletes object-storage
-- artifacts and LanceDB rows recorded here.
CREATE TABLE IF NOT EXISTS document_cleanup_queue (
  document_id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL,
  user_id text NOT NULL,
  workspace_id text NOT NULL,
  run_id text,
  source_key text,
  delete_source boolean DEFAULT false NOT NULL,
  keep_shared_artifacts boolean DEFAULT false NOT NULL,
  vector_targets jsonb DEFAULT '[]'::jsonb NOT NULL,
  artifact_uris text[] DEFAULT '{}'::text[] NOT NULL,
  kg_node_ids text[] DEFAULT '{}'::text[] NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  last_error text,
  created_at timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_cleanup_queue_created_idx ON document_cleanup_queue USING btree (created_at);

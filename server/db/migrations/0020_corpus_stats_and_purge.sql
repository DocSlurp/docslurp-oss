-- Current-corpus counters and superseded-version purge bookkeeping.
--
-- workspace_corpus_stats counts only documents that are completed and not
-- superseded: what search actually serves. A row trigger on documents applies
-- deltas in the same transaction as each status/supersede change, so a
-- replacement swaps old for new atomically (never 1.5x pages) and reads never
-- aggregate the documents table. Ingest throughput stays run-based.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS purged_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS documents_superseded_unpurged_idx ON documents USING btree (superseded_at) WHERE superseded_at IS NOT NULL AND purged_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS documents_workspace_in_flight_idx ON documents USING btree (workspace_id) WHERE status NOT IN ('completed', 'failed', 'cancelled');
--> statement-breakpoint
DELETE FROM vector_indexes a
USING vector_indexes b
WHERE a.document_id = b.document_id
  AND a.backend = b.backend
  AND a.embedding_model = b.embedding_model
  AND a.dimension = b.dimension
  AND a.id > b.id;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS vector_indexes_document_backend_model_idx ON vector_indexes USING btree (document_id, backend, embedding_model, dimension);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS workspace_corpus_stats (
  workspace_id text PRIMARY KEY NOT NULL,
  document_count bigint DEFAULT 0 NOT NULL,
  page_count bigint DEFAULT 0 NOT NULL,
  source_bytes bigint DEFAULT 0 NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT workspace_corpus_stats_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION apply_workspace_corpus_stats() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_live boolean := TG_OP <> 'INSERT' AND OLD.status = 'completed' AND OLD.superseded_at IS NULL;
  new_live boolean := TG_OP <> 'DELETE' AND NEW.status = 'completed' AND NEW.superseded_at IS NULL;
BEGIN
  IF old_live AND new_live
    AND OLD.workspace_id = NEW.workspace_id
    AND OLD.page_count = NEW.page_count
    AND OLD.file_size = NEW.file_size THEN
    RETURN NULL;
  END IF;
  IF old_live THEN
    UPDATE workspace_corpus_stats
    SET document_count = document_count - 1,
        page_count = page_count - OLD.page_count,
        source_bytes = source_bytes - OLD.file_size,
        updated_at = now()
    WHERE workspace_id = OLD.workspace_id;
  END IF;
  IF new_live THEN
    INSERT INTO workspace_corpus_stats AS s (workspace_id, document_count, page_count, source_bytes)
    VALUES (NEW.workspace_id, 1, NEW.page_count, NEW.file_size)
    ON CONFLICT (workspace_id) DO UPDATE
    SET document_count = s.document_count + 1,
        page_count = s.page_count + EXCLUDED.page_count,
        source_bytes = s.source_bytes + EXCLUDED.source_bytes,
        updated_at = now();
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS documents_corpus_stats ON documents;
--> statement-breakpoint
CREATE TRIGGER documents_corpus_stats
AFTER INSERT OR DELETE OR UPDATE OF status, superseded_at, page_count, file_size, workspace_id ON documents
FOR EACH ROW
EXECUTE FUNCTION apply_workspace_corpus_stats();
--> statement-breakpoint
INSERT INTO workspace_corpus_stats (workspace_id, document_count, page_count, source_bytes)
SELECT workspace_id, count(*), coalesce(sum(page_count), 0), coalesce(sum(file_size), 0)
FROM documents
WHERE status = 'completed' AND superseded_at IS NULL
GROUP BY workspace_id
ON CONFLICT (workspace_id) DO UPDATE
SET document_count = EXCLUDED.document_count,
    page_count = EXCLUDED.page_count,
    source_bytes = EXCLUDED.source_bytes,
    updated_at = now();

--> statement-breakpoint
-- Webhook outbox: the worker records events here; the API drains it with the
-- same signed, SSRF-checked dispatcher used everywhere else (NOTIFY for
-- immediacy, the maintenance sweep as a fallback).
CREATE TABLE IF NOT EXISTS webhook_outbox (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb DEFAULT '{}'::jsonb NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  claimed_at timestamptz,
  dispatched_at timestamptz,
  last_error text,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT webhook_outbox_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhook_outbox_pending_idx ON webhook_outbox USING btree (created_at) WHERE dispatched_at IS NULL;

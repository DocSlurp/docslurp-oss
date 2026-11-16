-- Summary-tree retrieval leg (packages/shared/src/summary-tree.ts, server/src/search/summary-tree.ts).
--
-- 1. document_chunks (document_id, chunk_index).
-- `guide` mode fetches the chunks a summary node covers with one query: up to five ranges of
-- `chunk_index BETWEEN chunk_start AND chunk_end`, each inside one document. document_chunks had only
-- document_chunks_document_id_idx, so each range read every chunk of its document and filtered.
-- Measured on Postgres 17 (2026-11-14), 362,000 chunk rows of about 600 bytes: one document of 62,000 chunks
-- (about 20,000 pages) and 10,000 documents of 30 chunks; five ranges of 12 chunks per query:
--   62,000-chunk document: median 215 ms, p95 293 ms before (12,448 buffers per range); 0.13 ms, p95 0.19 ms after.
--   30-chunk documents:    median 0.55 ms before; 0.28 ms after.
--   Index: 0.9 s to build, 10 MB (the single-column index is 3.6 MB). 30,000 chunk inserts took 12.9 s with it and
--   14.5 s without: no measurable write cost beside the full-text index.
-- Built without CONCURRENTLY (migrations run in a transaction, as 0087 and 0152): the build holds a SHARE lock on
-- document_chunks, so chunk inserts wait for it (about 2.4 s per million rows at the measured rate) while reads
-- continue. The older single-column index stays; it is a prefix of this one and can be dropped in a later release.
CREATE INDEX IF NOT EXISTS document_chunks_document_chunk_index_idx ON document_chunks (document_id, chunk_index);
--> statement-breakpoint
-- 2. Tree readiness rides the search eligibility hint.
-- Native search caches, per project, which documents have a ready tree (EligibleDocument.treeReady in
-- server/src/search/eligible-documents.ts), and the search response cache drops a project's entries on the same hint.
-- The database sends the hint itself, whichever code path changed the row, as migration 0153 does for documents:
-- - a tree that stops being servable (leaves `ready`, changes run or embedding space, or is deleted) sends the
--   immediate hint {"projectIds":[p]}: its nodes stop being served as soon as the change commits;
-- - a tree that becomes `ready` sends {"projectIds":[p],"debounce":true}: an arrival, which API processes apply at most
--   once per project per debounce window, so a backfill marking thousands of documents ready does not reload the
--   project's eligible set on every commit. A process that does not know `debounce` applies it immediately.
-- Identical notifications in one transaction are delivered once.
CREATE OR REPLACE FUNCTION summary_tree_readiness_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  was_ready boolean := TG_OP <> 'INSERT' AND OLD.status = 'ready';
  is_ready boolean := TG_OP <> 'DELETE' AND NEW.status = 'ready';
BEGIN
  IF was_ready AND (
    NOT is_ready
    OR OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.embedding_model IS DISTINCT FROM NEW.embedding_model
    OR OLD.dimension IS DISTINCT FROM NEW.dimension
    OR OLD.built_at IS DISTINCT FROM NEW.built_at
  ) THEN
    PERFORM pg_notify('search_eligibility', json_build_object('projectIds', json_build_array(OLD.project_id))::text);
  END IF;
  IF is_ready AND (NOT was_ready OR OLD.project_id IS DISTINCT FROM NEW.project_id) THEN
    PERFORM pg_notify('search_eligibility', json_build_object('projectIds', json_build_array(NEW.project_id), 'debounce', true)::text);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER document_summary_trees_readiness_changed
AFTER INSERT OR DELETE OR UPDATE OF status, run_id, project_id, embedding_model, dimension, built_at ON document_summary_trees
FOR EACH ROW EXECUTE FUNCTION summary_tree_readiness_changed();

-- Summary-tree retrieval leg (packages/shared/src/summary-tree.ts, server/src/search/summary-tree.ts).
--
-- 1. document_chunks (document_id, chunk_index).
-- `guide` mode fetches the chunks a summary node covers with one query: up to five ranges of
-- `chunk_index BETWEEN chunk_start AND chunk_end` inside one document each. document_chunks had only
-- document_chunks_document_id_idx, so each range read every chunk of its document and filtered: on a document of
-- 62,000 chunks (about 20,000 pages) that is the whole document per search. With this index a range is one index
-- range scan of the rows it returns, whatever the document size. Measurements are in the pull request.
-- Built without CONCURRENTLY (migrations run in a transaction, as 0087 and 0152): the build holds a SHARE lock on
-- document_chunks, so chunk inserts wait for it while reads continue. The older single-column index stays; it is a
-- prefix of this one and can be dropped in a later release.
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

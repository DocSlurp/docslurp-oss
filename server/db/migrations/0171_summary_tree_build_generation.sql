-- Summary tree: a build generation on every document's tree state (worker/src/summary-tree/state-store.ts).
--
-- document_summary_trees.build_generation counts the builds that took the document: it goes up every time a build
-- writes the row `building`. A queued removal of the document's summary data (storage_cleanup_queue, kind
-- 'summary_tree_document') carries the generation that was current when it was queued, so the sweep can tell a tree
-- that was rebuilt after the removal was asked for from the tree the removal was asked about, and does not delete
-- the rebuilt one (worker/src/db/superseded-purge.ts). The column is not in the readiness trigger's column list
-- (migration 0165): raising it sends no hint.
ALTER TABLE document_summary_trees ADD COLUMN IF NOT EXISTS build_generation bigint NOT NULL DEFAULT 0;

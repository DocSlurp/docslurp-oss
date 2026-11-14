-- Summary tree: corrected documents and queued removal of one document's summary data.
--
-- 1. skip_reason 'corrected'. A completed correction reindex replaces a document's chunks; the tree's source (the
--    run's embed artifact) still holds the text from before it. Such a document gets no tree: the correction marks
--    its state row `skipped` / `corrected` (creating the row when there is none), and no build replaces that row.
-- 2. storage_cleanup_queue kind 'summary_tree_document': strict removal of one document's summary rows and text
--    artifact (worker/src/db/superseded-purge.ts). Queued by the correction reindex, by a build that finds its
--    document gone, and when a document is withheld for PII after its tree was built.
-- 3. Documents corrected before this migration get the same mark, and removal is queued for those that had a tree.
ALTER TABLE document_summary_trees DROP CONSTRAINT IF EXISTS document_summary_trees_skip_reason_check;
--> statement-breakpoint
ALTER TABLE document_summary_trees ADD CONSTRAINT document_summary_trees_skip_reason_check
  CHECK (skip_reason IS NULL OR skip_reason IN ('format', 'tables', 'short', 'media', 'pii', 'no-leaves', 'corrected'));
--> statement-breakpoint
ALTER TABLE storage_cleanup_queue DROP CONSTRAINT IF EXISTS storage_cleanup_queue_kind_check;
--> statement-breakpoint
ALTER TABLE storage_cleanup_queue ADD CONSTRAINT storage_cleanup_queue_kind_check
  CHECK (kind IN ('storage_prefix', 'vector_table', 'vector_prefix', 'vector_rows', 'upload_original', 'doppler_folder', 'summary_tree_document'));
--> statement-breakpoint
INSERT INTO storage_cleanup_queue (kind, org_id, target, payload, reason)
SELECT 'summary_tree_document', t.org_id, t.org_id || '|' || t.project_id || '|' || t.document_id,
  jsonb_build_object('projectId', t.project_id, 'documentId', t.document_id), 'document_corrected'
FROM document_summary_trees t
JOIN document_corrections dc ON dc.document_id = t.document_id AND dc.reindex_completed_at IS NOT NULL
WHERE t.skip_reason IS DISTINCT FROM 'corrected'
ON CONFLICT (kind, target) DO NOTHING;
--> statement-breakpoint
DELETE FROM document_summary_tree_nodes n
USING document_corrections dc
WHERE dc.document_id = n.document_id AND dc.reindex_completed_at IS NOT NULL;
--> statement-breakpoint
INSERT INTO document_summary_trees (document_id, org_id, project_id, run_id, status, skip_reason, updated_at)
SELECT d.id, d.org_id, d.project_id, d.run_id, 'skipped', 'corrected', now()
FROM documents d
JOIN document_corrections dc ON dc.document_id = d.id AND dc.reindex_completed_at IS NOT NULL
WHERE d.org_id IS NOT NULL AND d.project_id IS NOT NULL
ON CONFLICT (document_id) DO UPDATE SET
  status = 'skipped', skip_reason = 'corrected', build_owner = NULL, built_at = NULL, root_node_id = NULL,
  node_count = 0, level_count = 0, error = NULL, updated_at = now()
WHERE document_summary_trees.skip_reason IS DISTINCT FROM 'corrected';

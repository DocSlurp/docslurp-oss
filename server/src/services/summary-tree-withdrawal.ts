import { SUMMARY_TREE_CLEANUP_KIND, SUMMARY_TREE_CORRECTED_SKIP_REASON } from "@docslurp/shared";

import type { SqlClient } from "../db.js";

/*
 * Withdrawing one document's summary tree (packages/shared/src/summary-tree.ts) from the API side.
 *
 * A tree is built by the worker from a run's extraction. When the API changes what a document says or whether it may
 * be shown (a correction reindex, a PII block), the tree no longer describes the document, and the worker cannot see
 * that on its own. Both calls here run inside the caller's transaction, so the withdrawal commits with the change
 * that caused it:
 *
 * - the document's tree state row leaves `ready` at once (search reads only `ready` rows, re-checked on every
 *   request), and its registry rows go;
 * - strict removal of its summary rows and text artifact is queued for the worker sweep
 *   (`storage_cleanup_queue`, kind `summary_tree_document`; worker/src/db/superseded-purge.ts).
 */

/**
 * Queues strict removal of the document's summary rows and text artifact. A queued entry becomes due again. The entry
 * carries the document's build generation at this moment (0 without a tree state): the sweep does not delete a tree
 * that a later build finished (worker/src/db/superseded-purge.ts).
 */
export async function queueSummaryTreeRemoval(tx: SqlClient, documentId: string, reason: string): Promise<void> {
  await tx`
    insert into storage_cleanup_queue (kind, org_id, target, payload, reason)
    select ${SUMMARY_TREE_CLEANUP_KIND}, d.org_id, d.org_id || '|' || d.project_id || '|' || d.id,
      jsonb_build_object('projectId', d.project_id, 'documentId', d.id, 'generation', coalesce((
        select t.build_generation from document_summary_trees t where t.document_id = d.id
      ), 0)), ${reason}
    from documents d
    where d.id = ${documentId} and d.org_id is not null and d.project_id is not null
    on conflict (kind, target) do update set
      payload = storage_cleanup_queue.payload || jsonb_build_object('generation', excluded.payload -> 'generation'),
      reason = excluded.reason, not_before = now(), attempts = 0, last_error = null
  `;
}

/**
 * A correction reindex replaced the document's chunks. The tree's source still holds the earlier text and its chunk
 * ranges name the earlier chunks, so the document has no tree from now on: its state row becomes `skipped` /
 * `corrected` (created when the document had none, so a build that has not started yet sees it too), which no build
 * replaces. The caller must hold the document's row `for update`: a summary row write in flight finishes before this
 * transaction commits, and the queued removal runs after it.
 */
export async function withdrawSummaryTreeForCorrection(tx: SqlClient, documentId: string): Promise<void> {
  await tx`
    insert into document_summary_trees (document_id, org_id, project_id, run_id, status, skip_reason, updated_at)
    select d.id, d.org_id, d.project_id, d.run_id, 'skipped', ${SUMMARY_TREE_CORRECTED_SKIP_REASON}, now()
    from documents d
    where d.id = ${documentId} and d.org_id is not null and d.project_id is not null
    on conflict (document_id) do update set
      run_id = excluded.run_id, status = 'skipped', skip_reason = ${SUMMARY_TREE_CORRECTED_SKIP_REASON},
      build_owner = null, built_at = null, root_node_id = null, node_count = 0, level_count = 0, error = null, updated_at = now()
  `;
  await tx`delete from document_summary_tree_nodes where document_id = ${documentId}`;
  await queueSummaryTreeRemoval(tx, documentId, "document_corrected");
}

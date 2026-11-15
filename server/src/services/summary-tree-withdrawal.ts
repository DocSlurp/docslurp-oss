import { SUMMARY_TREE_CLEANUP_KIND, SUMMARY_TREE_CORRECTED_SKIP_REASON } from "@docslurp/shared";

import { sql as defaultSql, type SqlClient } from "../db.js";

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

/** Documents reconciled per pass, and how often a process looks once a pass found nothing. */
const RECONCILE_BATCH = 200;
const RECONCILE_IDLE_INTERVAL_MS = 10 * 60_000;
let reconciling = false;
let reconcileIdleUntil = 0;

/**
 * Marks and withdraws corrected documents that lack the mark. Every completed correction reindex leaves the
 * document's tree state `skipped` / `corrected` in its own transaction (`withdrawSummaryTreeForCorrection`), and
 * migration 0167 did the same for corrections completed before it. A correction completed after that migration by a
 * server instance that predates the withdrawal (a rolling deploy) leaves none, and such a document's tree would be
 * built, or kept, from the text the correction replaced. This pass finds those documents and does for each what the
 * reindex would have done: the mark, the registry rows, and the queued strict removal.
 *
 * Idempotent, and safe on every instance at once: a document that carries the mark is not selected, each document is
 * handled in its own transaction under its row lock (`for update skip locked`), and marking twice changes nothing.
 * A pass that finds nothing makes the process look again only every ten minutes. Returns the documents marked.
 */
export async function sweepCorrectedSummaryTrees(
  options: { sql?: typeof defaultSql; limit?: number; force?: boolean; now?: number } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  if (reconciling || (!options.force && now < reconcileIdleUntil)) return 0;
  const sql = options.sql ?? defaultSql;
  reconciling = true;
  let marked = 0;
  try {
    const candidates = await sql<{ id: string }[]>`
      select d.id from documents d
      join document_corrections dc on dc.document_id = d.id and dc.reindex_completed_at is not null
      where d.org_id is not null and d.project_id is not null
        and not exists (
          select 1 from document_summary_trees t
          where t.document_id = d.id and t.skip_reason = ${SUMMARY_TREE_CORRECTED_SKIP_REASON}
        )
      order by d.id
      limit ${options.limit ?? RECONCILE_BATCH}
    `;
    for (const candidate of candidates) {
      marked += await sql.begin(async (tx) => {
        const transaction = tx as unknown as SqlClient;
        // The same lock the reindex holds: a summary row write in flight finishes first. A document another instance
        // is handling right now is left to it.
        const [document] = await transaction<{ id: string }[]>`
          select d.id from documents d
          where d.id = ${candidate.id}
            and exists (select 1 from document_corrections dc where dc.document_id = d.id and dc.reindex_completed_at is not null)
            and not exists (
              select 1 from document_summary_trees t
              where t.document_id = d.id and t.skip_reason = ${SUMMARY_TREE_CORRECTED_SKIP_REASON}
            )
          for update of d skip locked
        `;
        if (!document) return 0;
        await withdrawSummaryTreeForCorrection(transaction, document.id);
        return 1;
      });
    }
    if (marked > 0) console.log(`[summary-tree] reconciled corrected documents marked=${marked}`);
    // Nothing left to do: look again later. A full batch means more may wait: the next sweep continues.
    reconcileIdleUntil = candidates.length === 0 ? now + RECONCILE_IDLE_INTERVAL_MS : 0;
    return marked;
  } finally {
    reconciling = false;
  }
}

/** Tests: forget when the last empty pass ran. */
export function resetCorrectedSummaryTreeReconcileForTests(): void {
  reconcileIdleUntil = 0;
  reconciling = false;
}

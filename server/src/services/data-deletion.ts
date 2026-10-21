import { sql as defaultSql, type SqlClient } from "../db.js";
import { signalPipelineCancel } from "../lib/temporal.js";
import { notifySearchEligibilityChanged } from "../search/eligibility-hint.js";

/**
 * Data deletion: the one place that removes a workspace's rows.
 *
 * Postgres rows go immediately. Everything outside Postgres (LanceDB rows,
 * object-storage artifacts, raw uploads) is recorded by the documents and
 * workspace_runs BEFORE DELETE triggers (migration 0035) in
 * document_cleanup_queue and storage_cleanup_queue, which the worker sweep
 * drains. Callers therefore never enqueue cleanup themselves; they only cancel
 * in-flight work first and delete in bounded batches. See docs/data-deletion.md.
 */

export interface DataDeletionDeps {
  sql: SqlClient;
  /** Cancels a run's Temporal workflow (and its in-flight activities). */
  cancelWorkflow: (runId: string) => Promise<void>;
  /** Documents deleted per transaction, so huge workspaces never hold one giant lock. */
  documentBatchSize?: number;
}

export const defaultDataDeletionDeps: DataDeletionDeps = {
  sql: defaultSql,
  cancelWorkflow: (runId) => signalPipelineCancel(runId),
};

export interface CancelledRunsSummary {
  cancelled: number;
  /** Workflows Temporal could not be reached for; their cleanup waits out the in-flight grace period. */
  unreachable: number;
}

const ACTIVE_RUN_STATUSES = ["queued", "blocked", "processing"] as const;

/**
 * Cancel every in-flight run in the given workspaces: Temporal first (so
 * activities stop writing), then mark the rows cancelled. A missing workflow is
 * fine; an unreachable Temporal does not block deletion, because cleanup of
 * in-flight runs and documents waits out a grace period (`not_before`).
 */
export async function cancelWorkspaceRuns(
  workspaceIds: string[],
  reason: string,
  deps: DataDeletionDeps = defaultDataDeletionDeps,
): Promise<CancelledRunsSummary> {
  if (workspaceIds.length === 0) return { cancelled: 0, unreachable: 0 };
  const runs = await deps.sql<{ id: string }[]>`
    select id from workspace_runs
    where workspace_id = any(${deps.sql.array(workspaceIds)})
      and status = any(${deps.sql.array([...ACTIVE_RUN_STATUSES])})
  `;
  let unreachable = 0;
  const pending = [...runs];
  const workers = Array.from({ length: Math.min(8, pending.length) }, async () => {
    for (let run = pending.shift(); run; run = pending.shift()) {
      try {
        await deps.cancelWorkflow(run.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/not found/i.test(message)) {
          unreachable += 1;
          console.warn(`[data-deletion] could not cancel workflow run=${run.id}: ${message}`);
        }
      }
    }
  });
  await Promise.all(workers);
  if (runs.length > 0) {
    await deps.sql`
      update workspace_runs
      set status = 'failed', control_state = 'cancelled', control_requested_at = now(),
          error = ${reason}, lease_expires_at = now(), updated_at = now()
      where id = any(${deps.sql.array(runs.map((run) => run.id))})
        and status = any(${deps.sql.array([...ACTIVE_RUN_STATUSES])})
    `;
  }
  return { cancelled: runs.length, unreachable };
}

export interface DeletedWorkspaceData {
  documents: number;
  runs: number;
}

/**
 * Delete one workspace and everything in it. Documents go in batches (each
 * batch enqueues its own cleanup through the trigger), then the workspace row,
 * whose FK cascades take the runs (enqueuing their storage prefixes) and the
 * remaining per-workspace rows.
 */
export async function deleteWorkspaceData(
  workspaceId: string,
  deps: DataDeletionDeps = defaultDataDeletionDeps,
): Promise<DeletedWorkspaceData> {
  const batchSize = Math.max(1, deps.documentBatchSize ?? 500);
  let documents = 0;
  for (;;) {
    const deleted = await deps.sql<{ id: string }[]>`
      delete from documents
      where id in (
        select id from documents where workspace_id = ${workspaceId}
        order by id
        limit ${batchSize}
      )
      returning id
    `;
    documents += deleted.length;
    if (deleted.length < batchSize) break;
  }
  const [runs] = await deps.sql<{ count: number }[]>`
    select count(*)::int as count from workspace_runs where workspace_id = ${workspaceId}
  `;
  // Rows a concurrent upload added since the last batch cascade here and are
  // still enqueued by the trigger.
  await deps.sql`delete from workspaces where id = ${workspaceId}`;
  await notifySearchEligibilityChanged(deps.sql, [workspaceId]);
  return { documents, runs: runs?.count ?? 0 };
}

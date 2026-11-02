import { sql as defaultSql, type SqlClient } from "../db.js";
import { admissionBlock, requireRunCreditLease, spendGuardsSkipped } from "./billing/spend-guard.js";
import { creditLeasesEnabled } from "./billing/credit-leases.js";

/**
 * Blocked jobs: config-change re-index runs saved as `status = 'blocked'` because spend admission refused them
 * (no credits, budget). Once the org may spend again they become `queued` (with their first credit lease), and
 * the run-start recovery sweeper starts their workflow like any queued run whose start was never confirmed.
 */
export async function resumeBlockedRuns(
  deps: { sql?: SqlClient; orgId?: string; limit?: number } = {},
): Promise<{ resumed: number; stillBlocked: number }> {
  const sql = deps.sql ?? defaultSql;
  const rows = await sql<{ id: string; org_id: string; workspace_id: string; speed_boost: boolean }[]>`
    select r.id, r.org_id, r.workspace_id, coalesce(r.pipeline->'speedBoost' = 'true'::jsonb, false) as speed_boost from workspace_runs r
    join workspaces w on w.id = r.workspace_id and w.archived_at is null
    where r.status = 'blocked' and r.control_state is null ${deps.orgId ? sql`and r.org_id = ${deps.orgId}` : sql``}
    order by r.created_at, r.id
    limit ${deps.limit ?? 100}
  `;
  let resumed = 0;
  let stillBlocked = 0;
  for (const row of rows) {
    const admitted = await sql.begin(async (tx) => {
      const block = await admissionBlock(tx, row.org_id, row.workspace_id, { speedBoost: row.speed_boost });
      if (block) return false;
      try {
        return await tx.savepoint(async (sp) => {
          const [updated] = await sp<{ id: string }[]>`
            update workspace_runs
            set status = 'queued', blocked_reason = null, workflow_started_at = null, workflow_start_next_at = null,
                updated_at = now()
            where id = ${row.id} and org_id = ${row.org_id} and workspace_id = ${row.workspace_id}
              and status = 'blocked' and control_state is null
            returning id
          `;
          if (!updated) return false;
          if (creditLeasesEnabled() && !spendGuardsSkipped()) {
            await requireRunCreditLease(sp, { runId: row.id, orgId: row.org_id, workspaceId: row.workspace_id });
          }
          return true;
        });
      } catch (error) {
        // Roll back both the queued transition and any partial lease write.
        console.warn(`[blocked-runs] run=${row.id} remains blocked: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    });
    if (admitted) resumed += 1;
    else stillBlocked += 1;
  }
  if (resumed > 0) console.log(`[blocked-runs] resumed=${resumed} still_blocked=${stillBlocked}`);
  return { resumed, stillBlocked };
}

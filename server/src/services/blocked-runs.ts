import { sql as defaultSql, type SqlClient } from "../db.js";
import { admitBlockedRun } from "./run-admission.js";

/**
 * Blocked jobs: config-change re-index runs saved as `status = 'blocked'` because spend admission refused them
 * (no credits, budget). Once the org may spend again they become `queued` (with their first credit lease), and
 * the run-start recovery sweeper starts their workflow like any queued run whose start was never confirmed.
 */
export async function resumeBlockedRuns(
  deps: { sql?: SqlClient; orgId?: string; limit?: number } = {},
): Promise<{ resumed: number; stillBlocked: number }> {
  const sql = deps.sql ?? defaultSql;
  const rows = await sql<{ id: string; org_id: string; project_id: string; speed_boost: boolean }[]>`
    select r.id, r.org_id, r.project_id, coalesce(r.pipeline->'speedBoost' = 'true'::jsonb, false) as speed_boost from project_runs r
    join projects w on w.id = r.project_id and w.archived_at is null
    where r.status = 'blocked' and r.control_state is null ${deps.orgId ? sql`and r.org_id = ${deps.orgId}` : sql``}
    order by r.created_at, r.id
    limit ${deps.limit ?? 100}
  `;
  let resumed = 0;
  let stillBlocked = 0;
  for (const row of rows) {
    const admitted = await admitBlockedRun(sql, { id: row.id, orgId: row.org_id, projectId: row.project_id, speedBoost: row.speed_boost });
    if (admitted) resumed += 1;
    else stillBlocked += 1;
  }
  if (resumed > 0) console.log(`[blocked-runs] resumed=${resumed} still_blocked=${stillBlocked}`);
  return { resumed, stillBlocked };
}

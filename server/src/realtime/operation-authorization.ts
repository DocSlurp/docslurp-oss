import { realtimeCanaryOrgAllowed } from "./rollout-scope.js";
import type postgres from "postgres";
import { sql } from "../db.js";

/** Trusted session identity only. No output/projection reads; abort releases SQL. */
export async function revalidateOperationScopes(userId: string, operationId: string, signal: AbortSignal,
  client: postgres.Sql | postgres.TransactionSql = sql) {
  signal.throwIfAborted();
  const query = client<{ permitted: boolean; org_id: string }[]>`
    with root as (select root_id from chat_operations
      where id=${operationId} and user_id=${userId} and expires_at>clock_timestamp()),
    scopes as materialized (
      select c.project_id,c.org_id from chat_operations c join root on c.root_id=root.root_id
        where c.user_id=${userId} and c.expires_at>clock_timestamp()
      union
      select r.project_id,r.org_id from chat_run_dependencies d
        join chat_operations c on c.id=d.operation_id join root on c.root_id=root.root_id
        join project_runs r on r.id=d.run_id
        where c.user_id=${userId} and c.expires_at>clock_timestamp()
      limit 129)
    select scopes.org_id, exists(select 1 from projects p where p.id=scopes.project_id and p.org_id=scopes.org_id
      and docslurp_project_access(p.id,${userId})) as permitted from scopes`;
  const cancel = () => { void Promise.resolve(query.cancel()).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const scopes = await query;
    signal.throwIfAborted();
    if (!scopes.length || scopes.length > 128 || scopes.some(scope => !scope.permitted || !realtimeCanaryOrgAllowed(scope.org_id))) throw new Error("operation_forbidden");
  } finally { signal.removeEventListener("abort", cancel); }
}

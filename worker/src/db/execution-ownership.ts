import type { TransactionSql } from "postgres";

export interface ExecutionOwner {
  runId: string;
  orgId: string;
  workspaceId: string;
  executionGeneration?: string;
}

export class StaleExecutionError extends Error {
  constructor() {
    super("Run execution ownership does not match");
    this.name = "StaleExecutionError";
  }
}

/** Lock before init/terminal writes, in the SAME transaction as those writes.
 * Never claims ownership: only the server's creation/restart intent may do that.
 * Null matches only null, preserving old histories without granting them owned runs.
 */
export async function assertExecutionOwnership(tx: TransactionSql, owner: ExecutionOwner): Promise<void> {
  const [row] = await tx<{ id: string }[]>`
    select id from workspace_runs
    where id = ${owner.runId} and org_id = ${owner.orgId} and workspace_id = ${owner.workspaceId}
      and execution_generation is not distinct from ${owner.executionGeneration ?? null}
    for update
  `;
  if (!row) throw new StaleExecutionError();
}

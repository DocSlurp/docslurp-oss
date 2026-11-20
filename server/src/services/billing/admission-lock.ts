import type { TransactionSql } from "postgres";

import type { SqlClient } from "../../db.js";

/**
 * The organization's spend-admission lock, held to the end of the caller's transaction. Every path that admits work
 * or changes what admission reads (run admission, interactive spend near zero, settings that queue work, policy
 * transitions) takes it first, before any run, project or document lock: organization, then run. Reentrant within
 * one transaction. This is the only place the lock key is named (run-admission-owners.test.ts).
 */
export async function lockOrgAdmission(client: SqlClient | TransactionSql, orgId: string): Promise<void> {
  await (client as SqlClient)`select pg_advisory_xact_lock(spend_admission_lock_key(${orgId}))`;
}

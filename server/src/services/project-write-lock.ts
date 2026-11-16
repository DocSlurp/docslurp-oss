import type { sql } from "../db.js";

/** Settings may admit work after saving, even when privacy/PII does not change.
 * Acquire spend before any project UPDATE/row lock, matching active intake's
 * monthly-capacity and policy-admission triggers. The config lock serializes
 * preference writers; intake never acquires it. Reentrant within one transaction.
 */
export async function lockProjectConfigurationWrite(client: typeof sql, projectId: string, orgId: string): Promise<void> {
  await client`select pg_advisory_xact_lock(hashtextextended(${`config-change:${projectId}`}, 0))`;
  await client`select pg_advisory_xact_lock(spend_admission_lock_key(${orgId}))`;
}

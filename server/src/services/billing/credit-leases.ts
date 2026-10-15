import type { TransactionSql } from "postgres";

import {
  isBillingExemptOrg,
  resolveChatCreditReserveConfig,
  resolveCreditLeaseConfig,
  type ChatCreditReserveConfig,
  type CreditLeaseConfig,
} from "@docslurp/shared";

import { sql as defaultSql, type SqlClient } from "../../db.js";

/**
 * App side of org-level credit leases (migration 0052; the worker side is
 * worker/src/db/credit-lease.ts). The app grants a run's first lease at
 * admission and on a spend resume, so concurrent admissions and resumes
 * cannot all pass on one positive balance; the worker consumes and renews it.
 * Leases never grant into the chat reserve (migration 0053): free = available
 * - other leases - reserve(plan). Run admission and automation (assertCanSpend
 * kind "job") subtract every live lease and the reserve, so app admission and
 * worker leases agree on what is free; chat and search (kind "interactive")
 * ignore leases.
 */

type Client = SqlClient | TransactionSql;

export function creditLeaseConfig(env: NodeJS.ProcessEnv = process.env): CreditLeaseConfig {
  return resolveCreditLeaseConfig(env);
}

export function creditLeasesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return creditLeaseConfig(env).enabled;
}

export interface RunLeaseGrant {
  remaining: number;
  available: number;
  outstanding: number;
  blockReason: string | null;
}

/** grant_credit_lease() for a run (holder scope checked in SQL against org/workspace). */
export async function grantRunCreditLease(
  client: Client,
  run: { runId: string; orgId: string; workspaceId: string | null },
  config: CreditLeaseConfig = creditLeaseConfig(),
  reserve: ChatCreditReserveConfig = resolveChatCreditReserveConfig(),
): Promise<RunLeaseGrant | null> {
  const db = client as SqlClient;
  const [row] = await db<{
    lease_remaining: string | number;
    available_credits: string | number;
    outstanding_credits: string | number;
    block_reason: string | null;
  }[]>`
    select lease_remaining, available_credits, outstanding_credits, block_reason
    from grant_credit_lease(
      ${run.orgId}::text, ${run.workspaceId}::text, 'run', ${run.runId}::text,
      ${config.minCredits}::numeric, ${config.maxCredits}::numeric, ${config.initialCredits}::numeric,
      ${config.fraction}::numeric, ${config.horizonSeconds}::numeric, ${config.ttlSeconds}::int,
      ${isBillingExemptOrg(run.orgId)}::boolean,
      ${reserve.paidReserveCredits}::numeric, ${reserve.freeReserveCredits}::numeric
    )
  `;
  // grant_credit_lease() always returns one row or raises.
  if (!row) return null;
  return {
    remaining: Number(row.lease_remaining),
    available: Number(row.available_credits),
    outstanding: Number(row.outstanding_credits),
    blockReason: row.block_reason,
  };
}

/**
 * Mark leases past their TTL expired and wake the orgs they return credits
 * to. Expiry is already computed at read time (expires_at > now()), so this
 * sweep is bookkeeping plus the notification; it also drops settled rows of
 * runs finished more than a week ago.
 */
export async function sweepExpiredCreditLeases(
  deps: { sql?: SqlClient } = {},
): Promise<{ orgs: number; deleted: number }> {
  const sql = deps.sql ?? defaultSql;
  const expired = await sql<{ org_id: string }[]>`
    with expired as (
      update credit_leases
      set status = 'expired', updated_at = now()
      where status = 'active' and expires_at < now()
      returning org_id, credit_exempt, greatest(granted - consumed, 0) as unused
    ),
    orgs as (
      select distinct org_id from expired where unused > 0 and not credit_exempt
    )
    select org_id, pg_notify('org_spend_changed', json_build_object('orgId', org_id, 'reason', 'lease_expired')::text)
    from orgs
  `;
  const deleted = await sql`
    delete from credit_leases
    where status <> 'active' and updated_at < now() - interval '7 days'
  `;
  // Interactive chat holds (migration 0053) of orgs that stopped chatting;
  // admit_interactive_spend already drops an active org's expired holds.
  await sql`delete from interactive_spend_holds where expires_at < now() - interval '1 hour'`;
  if (expired.length > 0) console.log(`[credit-leases] expired leases returned credits to orgs=${expired.length}`);
  return { orgs: expired.length, deleted: deleted.count };
}

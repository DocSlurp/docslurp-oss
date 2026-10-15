import type { TransactionSql } from "postgres";

import {
  creditLedgerEntrySchema,
  type CreditLedgerEntry,
  type PlanId,
} from "@docslurp/shared";
import { sql, type SqlClient } from "../../db.js";

type Client = SqlClient | TransactionSql;

export type OrgBillingRow = {
  id: string;
  name: string;
  created_by_user_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan_id: PlanId;
  worker_slots: number;
  /** Prepaid pool (1 credit = 1 cent). */
  credit_balance_cents: number;
  included_credits_remaining: number;
  included_credits_granted: number;
  subscription_status: string;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  scheduled_plan_id: PlanId | null;
  past_due_since: Date | null;
  monthly_budget_cents: number | null;
  auto_recharge_enabled: boolean;
  auto_recharge_threshold_credits: number | null;
  auto_recharge_amount_cents: number | null;
  auto_recharge_monthly_limit_cents: number | null;
  auto_recharge_last_attempt_at: Date | null;
  auto_recharge_consecutive_failures: number;
  auto_recharge_authorized_at: Date | null;
  /** Debits recorded but not yet applied to the pools (migration 0030). */
  pending_debit_credits: number;
};

export async function getOrgBillingRow(orgId: string, client: Client = sql): Promise<OrgBillingRow | null> {
  const [row] = await (client as SqlClient)<OrgBillingRow[]>`
    select
      id, name, created_by_user_id, stripe_customer_id, stripe_subscription_id,
      plan_id, worker_slots, credit_balance_cents, included_credits_remaining,
      included_credits_granted, subscription_status, current_period_start,
      current_period_end, cancel_at_period_end, scheduled_plan_id, past_due_since,
      monthly_budget_cents, auto_recharge_enabled, auto_recharge_threshold_credits,
      auto_recharge_amount_cents, auto_recharge_monthly_limit_cents,
      auto_recharge_last_attempt_at, auto_recharge_consecutive_failures,
      auto_recharge_authorized_at,
      pending_org_debit_credits(id) as pending_debit_credits
    from organizations
    where id = ${orgId}
    limit 1
  `;
  return row ?? null;
}

export type CreditPools = {
  /** Included pool after pending debits (which spend included first). */
  includedRemaining: number;
  /** Prepaid pool after pending debits; may be negative after an overrun. */
  prepaid: number;
  /** Debits recorded by workers but not yet applied (applied within seconds). */
  pending: number;
  /** included + prepaid − pending: what admission and auto-recharge compare against. */
  available: number;
};

/**
 * Pools as they will stand once pending debits are applied: pending spends
 * included first, then prepaid, exactly as apply_pending_org_debits will.
 */
export function toCreditPools(
  row: Pick<OrgBillingRow, "included_credits_remaining" | "credit_balance_cents"> & { pending_debit_credits?: number | string | null },
): CreditPools {
  const included = Number(row.included_credits_remaining ?? 0);
  const prepaidRaw = Number(row.credit_balance_cents ?? 0);
  const pending = Math.max(0, Number(row.pending_debit_credits ?? 0));
  const fromIncluded = Math.min(pending, Math.max(included, 0));
  const includedRemaining = included - fromIncluded;
  const prepaid = prepaidRaw - (pending - fromIncluded);
  return { includedRemaining, prepaid, pending, available: included + prepaidRaw - pending };
}

/** Included + prepaid − pending credits (org_available_credits, migration 0030). */
export async function getAvailableCredits(orgId: string, client: Client = sql): Promise<CreditPools> {
  const [row] = await (client as SqlClient)<{ included: string; prepaid: string; pending: string }[]>`
    select included::text, prepaid::text, pending::text from org_available_credits(${orgId})
  `;
  return row
    ? toCreditPools({ included_credits_remaining: Number(row.included), credit_balance_cents: Number(row.prepaid), pending_debit_credits: Number(row.pending) })
    : { includedRemaining: 0, prepaid: 0, pending: 0, available: 0 };
}

/**
 * Record a debit to apply asynchronously (enqueue_org_credit_debit, migration
 * 0030). Use on high-volume paths: it never locks the org row. Admission and
 * the overview already subtract it; the maintenance flusher applies it.
 */
export async function enqueueOrgCreditDebit(
  client: Client,
  args: {
    orgId: string;
    credits: number;
    userId?: string | null;
    reason?: string;
    runId?: string | null;
    workspaceId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (!(args.credits > 0)) return;
  await (client as SqlClient)`
    select enqueue_org_credit_debit(
      ${args.orgId},
      ${args.credits},
      ${args.userId ?? null},
      ${args.reason ?? "usage"},
      ${args.runId ?? null},
      ${args.workspaceId ?? null},
      ${JSON.stringify(args.metadata ?? {})}::text::jsonb
    )
  `;
}

/**
 * Apply pending debits, one org per transaction (apply_pending_org_debits).
 * Workers' maintenance leader runs the same flush; concurrent flushes are safe.
 */
export async function flushPendingCreditDebits(options: { maxOrgs?: number } = {}): Promise<{ orgs: number; debits: number; credits: number }> {
  const orgs = await sql<{ org_id: string }[]>`select org_id from pending_debit_orgs(${options.maxOrgs ?? 500}::int)`;
  let applied = 0;
  let debits = 0;
  let credits = 0;
  for (const { org_id } of orgs) {
    const [row] = await sql<{ debits: number; credits: string }[]>`select * from apply_pending_org_debits(${org_id}, true)`;
    const count = Number(row?.debits ?? 0);
    if (count > 0) applied += 1;
    debits += count;
    credits += Number(row?.credits ?? 0);
  }
  return { orgs: applied, debits, credits };
}

/**
 * Spend credits now through debit_org_credits (migration 0024): included
 * first, then prepaid, one ledger row per pool. Locks the org row until
 * commit, so keep it to low-volume paths (the daily storage meter); the
 * pending-debit flush calls the same function.
 */
export async function debitOrgCredits(
  client: Client,
  args: {
    orgId: string;
    credits: number;
    userId?: string | null;
    reason?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ fromIncluded: number; fromPrepaid: number }> {
  if (!(args.credits > 0)) {
    return { fromIncluded: 0, fromPrepaid: 0 };
  }
  const [row] = await (client as SqlClient)<{ from_included: number; from_prepaid: number }[]>`
    select * from debit_org_credits(
      ${args.orgId},
      ${args.credits},
      ${args.userId ?? null},
      ${args.reason ?? "usage"},
      ${JSON.stringify(args.metadata ?? {})}::text::jsonb
    )
  `;
  return { fromIncluded: Number(row?.from_included ?? 0), fromPrepaid: Number(row?.from_prepaid ?? 0) };
}

export async function grantOrgCredits(
  client: Client,
  args: {
    orgId: string;
    source: "subscription" | "topup" | "auto_recharge" | "starter" | "promo" | "adjustment";
    externalId: string | null;
    pool: "included" | "prepaid";
    credits: number;
    resetIncluded?: boolean;
    userId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<boolean> {
  const [row] = await (client as SqlClient)<{ granted: boolean }[]>`
    select grant_org_credits(
      ${args.orgId},
      ${args.source},
      ${args.externalId},
      ${args.pool},
      ${Math.max(0, args.credits)},
      ${args.resetIncluded ?? false},
      ${args.userId ?? null},
      ${JSON.stringify(args.metadata ?? {})}::text::jsonb
    ) as granted
  `;
  return Boolean(row?.granted);
}

export async function listCreditLedger(args: {
  orgId: string;
  limit?: number;
  before?: string | null;
}): Promise<CreditLedgerEntry[]> {
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? 50) || 50, 1), 200);
  const before = args.before ? new Date(args.before) : null;
  const beforeValid = before && !Number.isNaN(before.getTime()) ? before : null;
  const rows = await sql<
    { id: string; created_at: Date; delta: number; reason: string; pool: string | null; metadata: Record<string, unknown> | null }[]
  >`
    select id, created_at, delta, reason, pool, metadata
    from credit_ledger
    where org_id = ${args.orgId}
      ${beforeValid ? sql`and created_at < ${beforeValid}` : sql``}
    order by created_at desc, id desc
    limit ${limit}
  `;
  return rows.map((row) =>
    creditLedgerEntrySchema.parse({
      id: row.id,
      createdAt: new Date(row.created_at).toISOString(),
      // credit_ledger.delta is in dollars; 1 credit = 1 cent.
      deltaCredits: Math.round(Number(row.delta) * 100 * 1e6) / 1e6,
      reason: row.reason,
      pool: row.pool === "included" || row.pool === "prepaid" ? row.pool : null,
      metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    }),
  );
}

import type { TransactionSql } from "postgres";

import {
  creditLedgerEntrySchema,
  type CreditLedgerEntry,
} from "@docslurp/shared";
import { sql, type SqlClient } from "../../db.js";

type Client = SqlClient | TransactionSql;

export type OrgBillingRow = {
  id: string;
  name: string;
  created_by_user_id: string | null;
  stripe_customer_id: string | null;
  /** First paid grant; null while the org only has starter credits (migration 0068). */
  funded_at: Date | null;
  worker_slots: number;
  /** Prepaid balance (1 credit = 1 cent); may be negative after an admitted run overdraws. */
  credit_balance_cents: number;
  monthly_budget_cents: number | null;
  auto_recharge_enabled: boolean;
  auto_recharge_threshold_credits: number | null;
  auto_recharge_amount_cents: number | null;
  auto_recharge_monthly_limit_cents: number | null;
  auto_recharge_last_attempt_at: Date | null;
  auto_recharge_consecutive_failures: number;
  auto_recharge_authorized_at: Date | null;
  /** Debits recorded but not yet applied to the balance (migration 0030). */
  pending_debit_credits: number;
};

export async function getOrgBillingRow(orgId: string, client: Client = sql): Promise<OrgBillingRow | null> {
  const [row] = await (client as SqlClient)<OrgBillingRow[]>`
    select
      id, name, created_by_user_id, stripe_customer_id, funded_at, worker_slots, credit_balance_cents,
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

/** Whether the org has ever had a paid grant (funded) rather than only starter credits. */
export function isFundedOrg(row: { funded_at?: Date | string | null } | null | undefined): boolean {
  return Boolean(row?.funded_at);
}

export type CreditBalance = {
  /** Prepaid balance before pending debits; may be negative after an overrun. */
  balance: number;
  /** Debits recorded by workers but not yet applied (applied within seconds). */
  pending: number;
  /** balance − pending: what admission and auto top-up compare against. */
  available: number;
};

export function toCreditBalance(
  row: Pick<OrgBillingRow, "credit_balance_cents"> & { pending_debit_credits?: number | string | null },
): CreditBalance {
  const balance = Number(row.credit_balance_cents ?? 0);
  const pending = Math.max(0, Number(row.pending_debit_credits ?? 0));
  return { balance, pending, available: balance - pending };
}

/** Balance − pending credits (org_available_credits, migration 0068). */
export async function getAvailableCredits(orgId: string, client: Client = sql): Promise<CreditBalance> {
  const [row] = await (client as SqlClient)<{ balance: string; pending: string }[]>`
    select balance::text, pending::text from org_available_credits(${orgId})
  `;
  return row
    ? toCreditBalance({ credit_balance_cents: Number(row.balance), pending_debit_credits: Number(row.pending) })
    : { balance: 0, pending: 0, available: 0 };
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
 * Cancel the not-yet-applied debits of some chat-turn Usage Events, so they
 * are never charged. Takes the org row lock first, the same lock
 * apply_pending_org_debits takes before it deletes pending rows, so a pending
 * debit is either applied by a flush or cancelled here, never both: whatever
 * part of those events' credits is not cancelled here was already applied.
 * Call it inside the caller's transaction and keep the lock until commit.
 */
export async function cancelPendingChatTurnDebits(
  client: Client,
  args: { orgId: string; turnId: string; usageEventIds: readonly string[] },
): Promise<{ credits: number; debits: number }> {
  if (args.usageEventIds.length === 0) return { credits: 0, debits: 0 };
  await (client as SqlClient)`select 1 from organizations where id = ${args.orgId} for no key update`;
  const [row] = await (client as SqlClient)<{ credits: string; debits: number }[]>`
    with cancelled as (
      delete from credit_debits_pending p
      where p.org_id = ${args.orgId}
        and p.metadata ->> 'chatTurnId' = ${args.turnId}
        and p.metadata ->> 'usageEventId' = any(${[...args.usageEventIds]}::text[])
      returning p.credits
    )
    select coalesce(sum(credits), 0)::text as credits, count(*)::int as debits from cancelled
  `;
  return { credits: Number(row?.credits ?? 0), debits: Number(row?.debits ?? 0) };
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
 * Spend credits now through debit_org_credits (migration 0068): one ledger
 * row. Locks the org row until commit, so keep it to low-volume paths (the
 * daily storage meter); the pending-debit flush calls the same function.
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
): Promise<number> {
  if (!(args.credits > 0)) return 0;
  const [row] = await (client as SqlClient)<{ debited: string }[]>`
    select debit_org_credits(
      ${args.orgId},
      ${args.credits},
      ${args.userId ?? null},
      ${args.reason ?? "usage"},
      ${JSON.stringify(args.metadata ?? {})}::text::jsonb
    )::text as debited
  `;
  return Number(row?.debited ?? 0);
}

/** `refund` (undelivered chat turns) returns credits without funding the org. */
export type CreditGrantSource = "topup" | "auto_recharge" | "starter" | "promo" | "adjustment" | "refund";

/** Grant credits once per (source, externalId). A paid source funds the org (migration 0068). */
export async function grantOrgCredits(
  client: Client,
  args: {
    orgId: string;
    source: CreditGrantSource;
    externalId: string | null;
    credits: number;
    userId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<boolean> {
  const [row] = await (client as SqlClient)<{ granted: boolean }[]>`
    select grant_org_credits(
      ${args.orgId},
      ${args.source},
      ${args.externalId},
      ${Math.max(0, args.credits)},
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
    { id: string; created_at: Date; delta: number; reason: string; metadata: Record<string, unknown> | null }[]
  >`
    select id, created_at, delta, reason, metadata
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
      metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    }),
  );
}

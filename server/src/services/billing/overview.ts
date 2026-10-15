import {
  autoRechargeSettingsSchema,
  billingOverviewSchema,
  chatCreditOverdraft,
  chatCreditReserve,
  resolveChatCreditReserveConfig,
  dailyStorageCredits,
  getPlan,
  planIdSchema,
  subscriptionStatusValueSchema,
  type AutoRechargeSettings,
  type BillingOverview,
} from "@docslurp/shared";
import { sql } from "../../db.js";
import { orgSpendByCategory } from "../usage-attribution.js";
import { getOrgBillingRow, toCreditPools, type OrgBillingRow } from "./credits.js";
import { orgHasPaymentMethod } from "./customers.js";
import { isStripeConfigured } from "./stripe-client.js";

/**
 * Storage estimate per indexed page. There is no per-artifact size column, so
 * derived artifacts (Markdown, page images) and index bytes (vectors,
 * full-text, graph) are estimated from page counts using the Standard
 * pipeline profile's planning figures. Source bytes are exact.
 */
export const ESTIMATED_ARTIFACT_BYTES_PER_PAGE = 96 * 1024;
export const ESTIMATED_INDEX_BYTES_PER_PAGE = 28 * 1024;

const DAYS_PER_MONTH = 730 / 24;

export type OrgStorage = { objectBytes: number; indexBytes: number; sourceBytes: number; pages: number };

/** Object + index bytes the org is storing, from workspace_corpus_stats (live documents only). */
export async function getOrgStorage(orgId: string): Promise<OrgStorage> {
  const [row] = await sql<{ source_bytes: string | number; pages: string | number }[]>`
    select
      coalesce(sum(s.source_bytes), 0)::text as source_bytes,
      coalesce(sum(s.page_count), 0)::text as pages
    from workspace_corpus_stats s
    join workspaces w on w.id = s.workspace_id
    where w.org_id = ${orgId}
  `;
  const sourceBytes = Number(row?.source_bytes ?? 0);
  const pages = Number(row?.pages ?? 0);
  return {
    sourceBytes,
    pages,
    objectBytes: sourceBytes + pages * ESTIMATED_ARTIFACT_BYTES_PER_PAGE,
    indexBytes: pages * ESTIMATED_INDEX_BYTES_PER_PAGE,
  };
}

/** Worker slots busy right now: processing runs, or processing page tasks when a run fans out. */
async function getWorkersInUse(orgId: string): Promise<number> {
  const [row] = await sql<{ in_use: number }[]>`
    select greatest(
      (select count(*) from workspace_runs where org_id = ${orgId} and status = 'processing'),
      (select count(*) from page_work_tasks t
        join workspace_runs r on r.id = t.run_id
        where r.org_id = ${orgId} and t.status = 'processing')
    )::int as in_use
  `;
  return Number(row?.in_use ?? 0);
}

export function autoRechargeFromRow(row: OrgBillingRow): AutoRechargeSettings | null {
  if (
    row.auto_recharge_threshold_credits == null ||
    row.auto_recharge_amount_cents == null ||
    row.auto_recharge_monthly_limit_cents == null
  ) {
    return null;
  }
  const parsed = autoRechargeSettingsSchema.safeParse({
    enabled: row.auto_recharge_enabled,
    thresholdCredits: Number(row.auto_recharge_threshold_credits),
    amountCents: Number(row.auto_recharge_amount_cents),
    monthlyLimitCents: Number(row.auto_recharge_monthly_limit_cents),
  });
  return parsed.success ? parsed.data : null;
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function startOfUtcMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Everything the billing page needs in one read. Works without Stripe (`stripeConfigured: false`). */
export async function getBillingOverview(orgId: string): Promise<BillingOverview> {
  const org = await getOrgBillingRow(orgId);
  if (!org) {
    throw new Error("Organization not found");
  }
  const plan = getPlan(org.plan_id);
  const periodStart = org.current_period_start ? new Date(org.current_period_start) : startOfUtcMonth();
  const stripeConfigured = isStripeConfigured();

  const [storage, inUse, spend, hasPaymentMethod, hasCreditGrants] = await Promise.all([
    getOrgStorage(orgId),
    getWorkersInUse(orgId).catch(() => 0),
    orgSpendByCategory(orgId, periodStart),
    stripeConfigured && org.stripe_customer_id
      ? orgHasPaymentMethod(orgId).catch((error: unknown) => {
          console.warn(`[billing] payment method lookup failed orgId=${orgId}: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        })
      : Promise.resolve(false),
    sql<{ granted: boolean }[]>`select org_has_credit_grants(${orgId}) as granted`
      .then(([row]) => row?.granted === true)
      .catch(() => false),
  ]);
  const reserveConfig = resolveChatCreditReserveConfig();

  const pools = toCreditPools(org);
  const dailyStorage = dailyStorageCredits({
    objectBytes: storage.objectBytes,
    indexBytes: storage.indexBytes,
    includedGb: plan.includedStorageGb,
  });
  const status = subscriptionStatusValueSchema.safeParse(org.subscription_status);
  const scheduled = planIdSchema.safeParse(org.scheduled_plan_id);

  return billingOverviewSchema.parse({
    orgId,
    plan: plan.id,
    subscriptionStatus: status.success ? status.data : "none",
    cancelAtPeriodEnd: Boolean(org.cancel_at_period_end),
    currentPeriodStart: iso(org.current_period_start),
    currentPeriodEnd: iso(org.current_period_end),
    scheduledPlan: scheduled.success ? scheduled.data : null,
    credits: {
      includedRemaining: pools.includedRemaining,
      includedGranted: Number(org.included_credits_granted ?? 0),
      prepaid: pools.prepaid,
      pending: pools.pending,
      available: pools.available,
      chatReserve: chatCreditReserve(plan.id, reserveConfig),
      chatOverdraft: chatCreditOverdraft(plan.id, hasCreditGrants, reserveConfig),
    },
    workers: { limit: Number(org.worker_slots), inUse },
    storage: {
      objectBytes: storage.objectBytes,
      indexBytes: storage.indexBytes,
      sourceBytes: storage.sourceBytes,
      estimated: storage.pages > 0,
      includedGb: plan.includedStorageGb,
      projectedMonthlyCredits: dailyStorage.totalCredits * DAYS_PER_MONTH,
    },
    spendThisPeriod: {
      compute: spend.compute,
      ai: spend.ai,
      storage: spend.storage,
      other: spend.other,
      total: spend.total,
    },
    autoRecharge: autoRechargeFromRow(org),
    monthlyBudgetCredits: org.monthly_budget_cents == null ? null : Number(org.monthly_budget_cents),
    stripeConfigured,
    hasPaymentMethod,
  });
}

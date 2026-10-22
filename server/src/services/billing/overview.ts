import {
  autoTopUpSettingsSchema,
  billingOverviewSchema,
  buildBillingForecast,
  chatCreditOverdraft,
  chatCreditReserve,
  resolveChatCreditReserveConfig,
  storageCreditsPerMonth,
  type AutoTopUpSettings,
  type BillingOverview,
} from "@docslurp/shared";
import { sql } from "../../db.js";
import { orgSpendByCategory, orgUnitUsage } from "../usage-attribution.js";
import { getOrgBillingRow, isFundedOrg, toCreditBalance, type OrgBillingRow } from "./credits.js";
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

export type OrgStorage = { objectBytes: number; indexBytes: number; sourceBytes: number; pages: number };

/**
 * Object + index bytes the org is storing: live documents from
 * workspace_corpus_stats, plus archived superseded versions (their pages and
 * source stay stored for browsing). Live and archived rows are disjoint
 * (archived rows are superseded), so nothing is double-counted. Purged rows
 * are excluded.
 */
export async function getOrgStorage(orgId: string, db: typeof sql = sql): Promise<OrgStorage> {
  const [row] = await db<{ source_bytes: string | number; pages: string | number }[]>`
    select
      (coalesce((select sum(s.source_bytes) from workspace_corpus_stats s
        join workspaces w on w.id = s.workspace_id where w.org_id = ${orgId}), 0)
       + coalesce((select sum(d.file_size) from documents d
        where d.org_id = ${orgId} and d.archived_at is not null and d.purged_at is null), 0))::text as source_bytes,
      (coalesce((select sum(s.page_count) from workspace_corpus_stats s
        join workspaces w on w.id = s.workspace_id where w.org_id = ${orgId}), 0)
       + coalesce((select sum(d.page_count) from documents d
        where d.org_id = ${orgId} and d.archived_at is not null and d.purged_at is null), 0))::text as pages
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

export function autoTopUpFromRow(row: OrgBillingRow): AutoTopUpSettings | null {
  if (
    row.auto_recharge_threshold_credits == null ||
    row.auto_recharge_amount_cents == null ||
    row.auto_recharge_monthly_limit_cents == null
  ) {
    return null;
  }
  const parsed = autoTopUpSettingsSchema.safeParse({
    enabled: row.auto_recharge_enabled,
    thresholdCredits: Number(row.auto_recharge_threshold_credits),
    amountCents: Number(row.auto_recharge_amount_cents),
    monthlyLimitCents: Number(row.auto_recharge_monthly_limit_cents),
  });
  return parsed.success ? parsed.data : null;
}

function startOfUtcMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Everything the billing page needs in one read, including the monthly
 * forecast (stored bytes at the storage price, plus the last 30 days of
 * searches and chat answers). Works without Stripe (`stripeConfigured: false`).
 */
export async function getBillingOverview(orgId: string, now = new Date()): Promise<BillingOverview> {
  const org = await getOrgBillingRow(orgId);
  if (!org) {
    throw new Error("Organization not found");
  }
  const funded = isFundedOrg(org);
  const stripeConfigured = isStripeConfigured();

  const [storage, inUse, spend, last30d, hasPaymentMethod, hasCreditGrants] = await Promise.all([
    getOrgStorage(orgId),
    getWorkersInUse(orgId).catch(() => 0),
    orgSpendByCategory(orgId, startOfUtcMonth(now)),
    orgUnitUsage(orgId, new Date(now.getTime() - THIRTY_DAYS_MS)),
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
  const balance = toCreditBalance(org);
  const storageBytes = storage.objectBytes + storage.indexBytes;

  return billingOverviewSchema.parse({
    orgId,
    funded,
    credits: {
      balance: balance.balance,
      pending: balance.pending,
      available: balance.available,
      chatReserve: chatCreditReserve(funded, reserveConfig),
      chatOverdraft: chatCreditOverdraft(funded, hasCreditGrants, reserveConfig),
    },
    workers: { limit: Number(org.worker_slots), inUse },
    storage: {
      bytes: storageBytes,
      objectBytes: storage.objectBytes,
      indexBytes: storage.indexBytes,
      sourceBytes: storage.sourceBytes,
      estimated: storage.pages > 0,
      monthlyCredits: storageCreditsPerMonth(storageBytes),
    },
    forecast: buildBillingForecast({
      balanceCredits: balance.available,
      storageBytes,
      searchesLast30d: last30d.searches,
      searchCreditsLast30d: last30d.searchCredits,
      chatAnswersLast30d: last30d.chatAnswers,
      chatCreditsLast30d: last30d.chatCredits,
      fastPagesLast30d: last30d.fastPages,
      richPagesLast30d: last30d.richPages,
      ingestCreditsLast30d: last30d.ingestCredits,
    }),
    spendThisMonth: spend,
    autoTopUp: autoTopUpFromRow(org),
    monthlyBudgetCredits: org.monthly_budget_cents == null ? null : Number(org.monthly_budget_cents),
    stripeConfigured,
    hasPaymentMethod,
  });
}

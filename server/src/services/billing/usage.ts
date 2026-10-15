import { sql } from "../../db.js";
import { orgDailyUsage, orgIngestUsage, orgUsageTotals, runCostBreakdown } from "../usage-attribution.js";
import type { IngestJobCost, UsageBreakdown } from "@docslurp/shared";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// Usage Diagnostics Service
// ---------------------------------------------------------------------------

export async function getUsageBreakdown(
  orgId: string,
): Promise<UsageBreakdown> {
  const now = new Date();
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [hour, day, month, daily] = await Promise.all([
    orgUsageTotals(orgId, hourAgo),
    orgUsageTotals(orgId, dayAgo),
    orgUsageTotals(orgId, monthStart),
    orgDailyUsage(orgId, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)),
  ]);
  const dailyRows = daily.slice(0, 7);

  return {
    orgId,
    lastHour: hour,
    last24h: day,
    currentMonth: month,
    dailyBreakdown: dailyRows,
  };
}

export async function getIngestJobCosts(args: {
  orgId: string;
  runId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ costs: IngestJobCost[]; total: number }> {
  const { rows, total } = await orgIngestUsage({
    orgId: args.orgId,
    runId: args.runId,
    limit: args.limit ?? 50,
    offset: args.offset ?? 0,
  });

  return {
    costs: rows.map((r) => ({
      runId: r.run_id,
      documentId: r.document_id,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      totalTokens: r.input_tokens + r.output_tokens,
      costCents: r.cost_cents,
      model: r.model,
      provider: r.provider,
      stage: r.stage_name,
      createdAt: r.created_at,
    })),
    total,
  };
}

export async function getRunCostBreakdown(args: { runId: string; orgId: string }): Promise<{
  totalTokens: number;
  totalCostCents: number;
  byStage: { stage: string; tokens: number; costCents: number }[];
  byModel: { model: string; tokens: number; costCents: number }[];
}> {
  return runCostBreakdown(args);
}

// ---------------------------------------------------------------------------
// Budget Alert Service
// ---------------------------------------------------------------------------

export async function checkAndFireBudgetAlerts(orgId: string): Promise<void> {
  const [orgRow] = await sql<
    {
      monthly_budget_cents: number | null;
      budget_alert_threshold_percent: number;
    }[]
  >`
    select monthly_budget_cents, budget_alert_threshold_percent
    from organizations
    where id = ${orgId}
    limit 1
  `;

  if (!orgRow?.monthly_budget_cents) return;

  const spendCents = Math.ceil((await orgUsageTotals(orgId, "month")).costCents);
  const threshold =
    orgRow.monthly_budget_cents * (orgRow.budget_alert_threshold_percent / 100);

  if (spendCents >= threshold) {
    const [existingAlert] = await sql<{ id: string }[]>`
      select id from budget_alerts
      where org_id = ${orgId}
        and alert_type = 'monthly_budget'
        and notified_at >= date_trunc('month', now())
      limit 1
    `;

    if (!existingAlert) {
      await sql`
        insert into budget_alerts (org_id, alert_type, threshold_percent, current_usage_cents, budget_cents)
        values (${orgId}, 'monthly_budget', ${orgRow.budget_alert_threshold_percent}, ${spendCents}, ${orgRow.monthly_budget_cents})
      `;
      console.log(
        `[billing] budget alert orgId=${orgId} spendCents=${spendCents} threshold=${threshold}`,
      );
    }
  }
}

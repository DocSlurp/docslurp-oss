import { BILLABLE_UNIT_METRICS, UNIT_CHARGE_PROVIDER } from "@docslurp/shared";
import { sql, type SqlClient } from "../db.js";
import type { SqlFragment } from "../lib/sql-fragments.js";

/**
 * Usage Event attribution: the single rule for which Workspace and
 * Organization a Usage Event counts against. Budgets, rate limits, billing,
 * and board telemetry all read spend through this module so they cannot drift.
 *
 * The rule lives in the `usage_attribution` SQL view (migration 0043), which
 * the worker's budget alerts read too:
 *  1. Writers stamp the scope at write time into the `org_id`, `workspace_id`
 *     and `api_key_id` columns (migration 0042), so spend survives run and
 *     workspace deletion. An event with `workspace_id` belongs to it.
 *  2. An event without one but with `metadata.workspaceIds[]` (cross-workspace
 *     answers) splits its cost and tokens evenly across those workspaces.
 *  3. Anything else is org-only.
 * The org is `org_id` (else the workspace's org); a split row counts against
 * its split workspace's org, falling back to `org_id` once it is deleted.
 *
 * API key attribution (per-key spend limits) is the `api_key_id` column:
 * the authenticating request's key, else the key that started the run.
 *
 * Nothing outside this module (and the two write-side ledgers) may query
 * `usage_events` directly; `usage-events-owners.test.ts` enforces it.
 */

export type UsageWindow = "month" | Date | null;

export interface AttributedUsageRow {
  id: string;
  created_at: Date;
  user_id: string;
  run_id: string | null;
  /** run_id, or the run recorded in metadata after the run was deleted. */
  source_run_id: string | null;
  document_id: string | null;
  metric: string;
  provider: string;
  model: string;
  unit: string;
  metadata: Record<string, unknown>;
  api_key_id: string | null;
  workspace_id: string | null;
  org_id: string | null;
  source_kind: "ingest" | "search";
  share: number;
  amount: number;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
}

function windowPredicate(client: SqlClient, window: UsageWindow) {
  if (window === null) return client`true`;
  if (window === "month") return client`au.created_at >= date_trunc('month', now())`;
  return client`au.created_at >= ${window}`;
}

/**
 * Subquery fragment over the `usage_attribution` view, yielding one row per
 * (Usage Event, attributed workspace) with columns described by
 * `AttributedUsageRow`. Split events produce one row per workspace with
 * proportional cost and tokens; aggregate distinct events with
 * `count(distinct id)`. Sums over it equal sums over the raw events.
 */
export function attributedUsage(
  window: UsageWindow,
  client: SqlClient = sql,
): SqlFragment {
  return client`(
    select au.* from usage_attribution au
    where ${windowPredicate(client, window)}
  )`;
}

export interface UsageTotals {
  tokens: number;
  costCents: number;
  eventCount: number;
}

function toTotals(row: { tokens: unknown; cost_cents: unknown; event_count: unknown } | undefined): UsageTotals {
  return {
    tokens: Math.round(Number(row?.tokens ?? 0)),
    costCents: Number(row?.cost_cents ?? 0),
    eventCount: Number(row?.event_count ?? 0),
  };
}

export async function workspaceUsageTotals(
  workspaceId: string,
  window: UsageWindow = "month",
  client: SqlClient = sql,
): Promise<UsageTotals> {
  const [row] = await client<{ tokens: string; cost_cents: number; event_count: number }[]>`
    select
      coalesce(sum(au.input_tokens + au.output_tokens), 0) as tokens,
      coalesce(sum(au.cost_cents), 0)::double precision as cost_cents,
      count(distinct au.id)::int as event_count
    from ${attributedUsage(window, client)} au
    where au.workspace_id = ${workspaceId}
  `;
  return toTotals(row);
}

export async function orgUsageTotals(
  orgId: string,
  window: UsageWindow = "month",
  client: SqlClient = sql,
): Promise<UsageTotals> {
  const [row] = await client<{ tokens: string; cost_cents: number; event_count: number }[]>`
    select
      coalesce(sum(au.input_tokens + au.output_tokens), 0) as tokens,
      coalesce(sum(au.cost_cents), 0)::double precision as cost_cents,
      count(distinct au.id)::int as event_count
    from ${attributedUsage(window, client)} au
    where au.org_id = ${orgId}
  `;
  return toTotals(row);
}

/**
 * Cents of usage attributed to one API key since `since`, served by the
 * `usage_events (api_key_id, created_at)` index (migration 0042), so cost
 * stays proportional to that key's own events rather than all recent usage.
 */
export async function apiKeySpendCents(
  apiKeyId: string,
  since: Date,
  client: SqlClient = sql,
): Promise<number> {
  const [row] = await client<{ cost_cents: number }[]>`
    select coalesce(sum(ue.cost_cents), 0)::double precision as cost_cents
    from usage_events ue
    where ue.api_key_id = ${apiKeyId}
      and ue.created_at >= ${since}
  `;
  return Number(row?.cost_cents ?? 0);
}

export async function orgDailyUsage(
  orgId: string,
  since: Date,
  client: SqlClient = sql,
): Promise<Array<UsageTotals & { date: string }>> {
  const rows = await client<{ date: string; tokens: string; cost_cents: number; event_count: number }[]>`
    select
      date_trunc('day', au.created_at)::date as date,
      coalesce(sum(au.input_tokens + au.output_tokens), 0) as tokens,
      coalesce(sum(au.cost_cents), 0)::double precision as cost_cents,
      count(distinct au.id)::int as event_count
    from ${attributedUsage(since, client)} au
    where au.org_id = ${orgId}
    group by date_trunc('day', au.created_at)::date
    order by date desc
  `;
  return rows.map((row) => ({ date: row.date, ...toTotals(row) }));
}

export type SpendCategory = "ingest" | "storage" | "search" | "chat" | "other";

/** Usage Event provider/metric written by the daily storage meter. */
export const STORAGE_USAGE_PROVIDER = UNIT_CHARGE_PROVIDER;
export const STORAGE_USAGE_METRIC = BILLABLE_UNIT_METRICS.storage;

/** Ingest spend: pages, media minutes and the optional per-document features. */
const INGEST_UNIT_METRICS = [
  BILLABLE_UNIT_METRICS.fastPage,
  BILLABLE_UNIT_METRICS.richPage,
  BILLABLE_UNIT_METRICS.mediaMinutes,
  BILLABLE_UNIT_METRICS.documentSummary,
  BILLABLE_UNIT_METRICS.structuredFields,
  BILLABLE_UNIT_METRICS.knowledgeGraph,
  BILLABLE_UNIT_METRICS.propositions,
];

/**
 * Credits charged to an org since `since`, by the price-card category the
 * billing page shows. Only billable unit events carry cost (provider and
 * compute events are recorded at 0), so `other` is normally 0.
 */
export async function orgSpendByCategory(
  orgId: string,
  since: UsageWindow,
  client: SqlClient = sql,
): Promise<Record<SpendCategory, number> & { total: number }> {
  const rows = await client<{ category: SpendCategory; cost_cents: number }[]>`
    select
      case
        when au.metric = any(${INGEST_UNIT_METRICS}::text[]) then 'ingest'
        when au.metric = ${STORAGE_USAGE_METRIC} then 'storage'
        when au.metric = ${BILLABLE_UNIT_METRICS.search} then 'search'
        when au.metric = ${BILLABLE_UNIT_METRICS.chatAnswer} then 'chat'
        else 'other'
      end as category,
      coalesce(sum(au.cost_cents), 0)::double precision as cost_cents
    from ${attributedUsage(since, client)} au
    where au.org_id = ${orgId}
    group by 1
  `;
  const totals: Record<SpendCategory, number> = { ingest: 0, storage: 0, search: 0, chat: 0, other: 0 };
  for (const row of rows) {
    totals[row.category] = Number(row.cost_cents ?? 0);
  }
  return { ...totals, total: totals.ingest + totals.storage + totals.search + totals.chat + totals.other };
}

export interface OrgUnitUsage {
  searches: number;
  searchCredits: number;
  chatAnswers: number;
  chatCredits: number;
  fastPages: number;
  /** Rich pages, including media minutes counted as Rich pages. */
  richPages: number;
  ingestCredits: number;
}

/**
 * Units and credits the price card charged an org since `since` (the billing
 * forecast's last-30-day pace). Unit events record the count in `amount`:
 * searches and chat answers as 1 per call, pages as billed pages.
 */
export async function orgUnitUsage(orgId: string, since: UsageWindow, client: SqlClient = sql): Promise<OrgUnitUsage> {
  const rows = await client<{ metric: string; amount: number; cost_cents: number; events: number }[]>`
    select au.metric,
      coalesce(sum(au.amount), 0)::double precision as amount,
      coalesce(sum(au.cost_cents), 0)::double precision as cost_cents,
      count(distinct au.id)::int as events
    from ${attributedUsage(since, client)} au
    where au.org_id = ${orgId}
      and au.metric = any(${[...INGEST_UNIT_METRICS, BILLABLE_UNIT_METRICS.search, BILLABLE_UNIT_METRICS.chatAnswer]}::text[])
    group by au.metric
  `;
  const by = new Map(rows.map((row) => [row.metric, { amount: Number(row.amount ?? 0), cost: Number(row.cost_cents ?? 0), events: Number(row.events ?? 0) }]));
  const get = (metric: string) => by.get(metric) ?? { amount: 0, cost: 0, events: 0 };
  const ingestCredits = INGEST_UNIT_METRICS.reduce((sum, metric) => sum + get(metric).cost, 0);
  return {
    searches: get(BILLABLE_UNIT_METRICS.search).events,
    searchCredits: get(BILLABLE_UNIT_METRICS.search).cost,
    chatAnswers: get(BILLABLE_UNIT_METRICS.chatAnswer).events,
    chatCredits: get(BILLABLE_UNIT_METRICS.chatAnswer).cost,
    fastPages: get(BILLABLE_UNIT_METRICS.fastPage).amount,
    richPages: get(BILLABLE_UNIT_METRICS.richPage).amount + get(BILLABLE_UNIT_METRICS.mediaMinutes).amount,
    ingestCredits,
  };
}

export interface UsageAggregate {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  events: number;
}

type AggregateRow = { input_tokens: unknown; output_tokens: unknown; cost_cents: unknown; events: unknown };

function toAggregate(row: AggregateRow | undefined): UsageAggregate {
  return {
    inputTokens: Math.round(Number(row?.input_tokens ?? 0)),
    outputTokens: Math.round(Number(row?.output_tokens ?? 0)),
    costCents: Number(row?.cost_cents ?? 0),
    events: Number(row?.events ?? 0),
  };
}

/** All usage of one run (run and document cost panels). */
export async function runUsageTotals(runId: string, client: SqlClient = sql): Promise<UsageAggregate> {
  const [row] = await client<AggregateRow[]>`
    select
      coalesce(sum(au.input_tokens), 0) as input_tokens,
      coalesce(sum(au.output_tokens), 0) as output_tokens,
      coalesce(sum(au.cost_cents), 0)::double precision as cost_cents,
      count(distinct au.id)::int as events
    from ${attributedUsage(null, client)} au
    where au.run_id = ${runId}
  `;
  return toAggregate(row);
}

/** Spend of a set of runs, counted only against one workspace (ingest report). */
/**
 * summarizeRunUsageCost over several runs of one workspace together (ingest
 * report), so its cost agrees with the run records: billed spend plus the
 * flagged compute estimate. Scoped to the workspace, and by source run so
 * spend survives run deletion.
 */
export async function workspaceRunsUsageCost(
  workspaceId: string,
  runIds: readonly string[],
  client: SqlClient = sql,
): Promise<RunUsageCostSummary> {
  if (runIds.length === 0) return summarizeRunUsageCost();
  const [row] = await client<RunUsageCostTotalsRow[]>`
    select ${runUsageCostColumns(client)}
    from ${attributedUsage(null, client)} au
    where au.workspace_id = ${workspaceId} and au.source_run_id = any(${client.array([...runIds])}::text[])
  `;
  return summarizeRunUsageCost(row);
}

/** Usage recorded against one document. */
export async function documentUsageTotals(documentId: string, client: SqlClient = sql): Promise<UsageAggregate> {
  const [row] = await client<AggregateRow[]>`
    select
      coalesce(sum(au.input_tokens), 0) as input_tokens,
      coalesce(sum(au.output_tokens), 0) as output_tokens,
      coalesce(sum(au.cost_cents), 0)::double precision as cost_cents,
      count(distinct au.id)::int as events
    from ${attributedUsage(null, client)} au
    where au.document_id = ${documentId}
  `;
  return toAggregate(row);
}

/** Lifetime spend per provider and model across all orgs (health metrics). */
export async function spendByProviderModel(
  client: SqlClient = sql,
): Promise<Array<{ provider: string; model: string; total_cost_cents: number }>> {
  const rows = await client<{ provider: string; model: string; total_cost_cents: number }[]>`
    select
      au.provider,
      au.model,
      coalesce(sum(au.cost_cents), 0)::double precision as total_cost_cents
    from usage_attribution au
    group by au.provider, au.model
    order by au.provider, au.model
  `;
  return rows.map((row) => ({ ...row, total_cost_cents: Number(row.total_cost_cents ?? 0) }));
}

/**
 * Prompt and completion tokens of a user's Search Session, as a correlated
 * subquery fragment. `sessionId` names the session id column of the outer
 * query.
 */
export function sessionTokenUsage(
  userId: string,
  sessionId: SqlFragment,
  client: SqlClient = sql,
): SqlFragment {
  return client`(
    select
      coalesce(sum(au.input_tokens), 0) as input_tokens,
      coalesce(sum(au.output_tokens), 0) as output_tokens
    from ${attributedUsage(null, client)} au
    where au.user_id = ${userId}
      and au.metadata ->> 'sessionId' = ${sessionId}
  )`;
}

export interface IngestUsageRow {
  run_id: string;
  document_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  model: string;
  provider: string;
  stage_name: string | null;
  created_at: string;
}

/**
 * An org's ingest (run) Usage Events, newest first, optionally for one run.
 * Events of deleted runs keep their run id from metadata.
 */
export async function orgIngestUsage(
  args: { orgId: string; runId?: string; limit: number; offset: number },
  client: SqlClient = sql,
): Promise<{ rows: IngestUsageRow[]; total: number }> {
  const runFilter = args.runId ? client`and au.source_run_id = ${args.runId}` : client``;
  const [countRow] = await client<{ total: number }[]>`
    select count(distinct au.id)::int as total
    from ${attributedUsage(null, client)} au
    where au.org_id = ${args.orgId} and au.source_kind = 'ingest' ${runFilter}
  `;
  const rows = await client<IngestUsageRow[]>`
    select
      au.source_run_id as run_id,
      au.document_id,
      round(au.input_tokens)::int as input_tokens,
      round(au.output_tokens)::int as output_tokens,
      au.cost_cents::double precision as cost_cents,
      au.model,
      au.provider,
      wr.stage as stage_name,
      au.created_at
    from ${attributedUsage(null, client)} au
    left join workspace_runs wr on wr.id = au.run_id
    where au.org_id = ${args.orgId} and au.source_kind = 'ingest' ${runFilter}
    order by au.created_at desc
    limit ${args.limit}
    offset ${args.offset}
  `;
  return { rows, total: Number(countRow?.total ?? 0) };
}

/** One run's spend by stage and by model, scoped to its org. */
export async function runCostBreakdown(
  args: { runId: string; orgId: string },
  client: SqlClient = sql,
): Promise<{
  totalTokens: number;
  totalCostCents: number;
  byStage: { stage: string; tokens: number; costCents: number }[];
  byModel: { model: string; tokens: number; costCents: number }[];
}> {
  const stageRows = await client<{ stage: string | null; tokens: number; cost_cents: number }[]>`
    select
      wr.stage,
      round(coalesce(sum(au.input_tokens + au.output_tokens), 0))::int as tokens,
      coalesce(sum(au.cost_cents), 0)::double precision as cost_cents
    from ${attributedUsage(null, client)} au
    left join workspace_runs wr on wr.id = au.run_id
    where au.source_run_id = ${args.runId} and au.org_id = ${args.orgId}
    group by wr.stage
    order by cost_cents desc
  `;
  const modelRows = await client<{ model: string; tokens: number; cost_cents: number }[]>`
    select
      au.model,
      round(coalesce(sum(au.input_tokens + au.output_tokens), 0))::int as tokens,
      coalesce(sum(au.cost_cents), 0)::double precision as cost_cents
    from ${attributedUsage(null, client)} au
    where au.source_run_id = ${args.runId} and au.org_id = ${args.orgId}
    group by au.model
    order by cost_cents desc
  `;
  const toEntry = (row: { tokens: number; cost_cents: number }) => ({
    tokens: Number(row.tokens ?? 0),
    costCents: Number(row.cost_cents ?? 0),
  });
  const byModel = modelRows.map((row) => ({ model: row.model, ...toEntry(row) }));
  return {
    totalTokens: byModel.reduce((sum, row) => sum + row.tokens, 0),
    totalCostCents: byModel.reduce((sum, row) => sum + row.costCents, 0),
    byStage: stageRows.map((row) => ({ stage: row.stage ?? "deleted", ...toEntry(row) })),
    byModel,
  };
}

export type RunUsageCostTotalsRow = {
  input_tokens: number;
  output_tokens: number;
  recorded_cost_cents: number | string;
  ai_cost_cents: number | string;
  /** Billed cost of calls served by our own models (subset of ai_cost_cents). */
  self_hosted_cost_cents: number | string;
  /** The hosted-equivalent list price of those calls, shown struck through. */
  self_hosted_list_cents: number | string;
  fee_cost_cents: number | string;
  billed_compute_cents: number | string;
  estimated_compute_cents: number | string;
  worker_classes: string[] | null;
  regions: string[] | null;
};

/** Columns of RunUsageCostTotalsRow, aggregated over `au` (usage_attribution). */
function runUsageCostColumns(client: SqlClient) {
  return client`
      round(coalesce(sum(au.input_tokens), 0))::int as input_tokens,
      round(coalesce(sum(au.output_tokens), 0))::int as output_tokens,
      coalesce(sum(au.cost_cents), 0)::double precision as recorded_cost_cents,
      coalesce(sum(au.cost_cents) filter (where au.provider not in ('local-compute', 'docslurp')), 0)::double precision as ai_cost_cents,
      coalesce(sum(au.cost_cents) filter (where au.metadata -> 'selfHosted' is not null), 0)::double precision as self_hosted_cost_cents,
      coalesce(sum((au.metadata #>> '{selfHosted,hostedEquivalentListCents}')::double precision) filter (
        where au.metadata -> 'selfHosted' is not null
      ), 0)::double precision as self_hosted_list_cents,
      coalesce(sum(au.cost_cents) filter (where au.provider = 'docslurp'), 0)::double precision as fee_cost_cents,
      coalesce(sum(au.cost_cents) filter (where au.provider = 'local-compute'), 0)::double precision as billed_compute_cents,
      coalesce(sum((au.metadata ->> 'effectiveCostCents')::double precision) filter (
        where au.provider = 'local-compute'
          and coalesce(au.metadata ->> 'costRollup', 'authoritative') = 'authoritative'
          and coalesce(au.metadata ->> 'billable', 'false') <> 'true'
      ), 0)::double precision as estimated_compute_cents,
      coalesce(array_agg(distinct au.metadata ->> 'workerClass') filter (
        where au.provider = 'local-compute' and au.metadata ->> 'workerClass' is not null
      ), '{}') as worker_classes,
      coalesce(array_agg(distinct au.metadata ->> 'region') filter (
        where au.provider = 'local-compute' and au.metadata ->> 'region' is not null
      ), '{}') as regions`;
}

/**
 * A run's usage split into AI, platform fee and compute spend, plus the worker
 * classes and regions its compute ran on (run progress panel). One statement
 * over the view, so callers keep a single round trip.
 */
export async function runUsageCostTotals(
  runId: string,
  client: SqlClient = sql,
): Promise<RunUsageCostTotalsRow[]> {
  return await client<RunUsageCostTotalsRow[]>`
    select ${runUsageCostColumns(client)}
    from usage_attribution au
    where au.run_id = ${runId}
  `;
}

/**
 * The run cost every surface reports (run records, progress snapshots and
 * SSE, document details, benchmarks): ledger spend (AI/API calls, per-page
 * fees, billed compute) plus the rate-card estimate of unbilled worker
 * compute, which is persisted at 0 cents with its estimate in
 * `effectiveCostCents` (`costSource: "estimate"`) and flagged here.
 *
 * `billedCostCents` is the ledger spend alone: the figure the run cost cap
 * (`pipeline.maxCostCents`) is enforced against, equal to
 * `workspace_runs.spent_cents` (kept by a usage_events trigger, migration
 * 0056). `costCents = billedCostCents + estimatedComputeCents`.
 */
export function summarizeRunUsageCost(row?: RunUsageCostTotalsRow | null) {
  const n = (value: number | string | undefined) => Number(value ?? 0) || 0;
  const estimatedCompute = n(row?.estimated_compute_cents);
  const computeCostCents = n(row?.billed_compute_cents) + estimatedCompute;
  return {
    inputTokens: row?.input_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
    costCents: n(row?.recorded_cost_cents) + estimatedCompute,
    billedCostCents: n(row?.recorded_cost_cents),
    estimatedComputeCents: estimatedCompute,
    aiCostCents: n(row?.ai_cost_cents),
    selfHostedCostCents: n(row?.self_hosted_cost_cents),
    selfHostedListCents: n(row?.self_hosted_list_cents),
    feeCostCents: n(row?.fee_cost_cents),
    computeCostCents,
    computeEstimated: estimatedCompute > 0,
    workerClasses: row?.worker_classes ?? [],
    regions: row?.regions ?? [],
  };
}
export type RunUsageCostSummary = ReturnType<typeof summarizeRunUsageCost>;

/**
 * summarizeRunUsageCost for several runs in one statement (run lists, boards).
 * Runs without usage are absent from the map; summarize `undefined` for 0.
 */
export async function runUsageCostSummaries(
  runIds: readonly string[],
  client: SqlClient = sql,
): Promise<Map<string, RunUsageCostSummary>> {
  const ids = [...new Set(runIds)];
  if (ids.length === 0) return new Map();
  const rows = await client<Array<RunUsageCostTotalsRow & { run_id: string }>>`
    select au.run_id, ${runUsageCostColumns(client)}
    from usage_attribution au
    where au.run_id = any(${client.array(ids)})
    group by au.run_id
  `;
  return new Map(rows.map((row) => [row.run_id, summarizeRunUsageCost(row)]));
}

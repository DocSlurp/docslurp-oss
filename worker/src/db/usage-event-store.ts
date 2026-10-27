import { randomUUID } from "node:crypto";

import type { JSONValue, PendingQuery, Sql } from "postgres";

import type { UsageEvent } from "../models.js";
import { billableCents } from "../pipeline/usage-ledger.js";
import type { WorkflowState } from "../pipeline/pipeline.js";

function toJson(sql: Sql<Record<string, unknown>>, value: unknown) {
  return sql.json(JSON.parse(JSON.stringify(value ?? {})) as JSONValue);
}

const BULK_WRITE_BATCH_SIZE = 1000;

function batchedRows<T>(rows: T[], batchSize = BULK_WRITE_BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < rows.length; index += batchSize) {
    batches.push(rows.slice(index, index + batchSize));
  }
  return batches;
}

/**
 * Metadata as persisted: an event that is not a price-card unit charge keeps
 * its cost as `providerCostCents` (our cost, for internal reports) and is
 * marked `billable: false`, because it is written at 0 credits.
 */
function persistedMetadata(usage: UsageEvent): Record<string, unknown> {
  if (billableCents(usage) > 0 || usage.metadata?.unitCharge === true) return { ...usage.metadata };
  const stored = usage.metadata?.providerCostCents;
  return {
    ...usage.metadata,
    providerCostCents: typeof stored === "number" && Number.isFinite(stored) ? stored : Math.max(0, Number(usage.costCents) || 0),
    billable: false,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The scope every Usage Event of a run is stamped with at write time. */
export function runUsageScope(state: WorkflowState): {
  orgId: string | null;
  workspaceId: string | null;
  apiKeyId: string | null;
} {
  return {
    orgId: state.run.orgId ?? null,
    workspaceId: state.run.workspaceId ?? null,
    apiKeyId: stringOrNull(state.run.stats?.apiKeyId),
  };
}

function runUsageRows(client: Sql<Record<string, unknown>>, state: WorkflowState, usageEvents: UsageEvent[]) {
  const scope = runUsageScope(state);
  return usageEvents.map((usage) => ({
    id: usage.id ?? randomUUID(),
    user_id: state.run.userId,
    run_id: state.run.id,
    // Tenant columns (migration 0041): spend outlives run and workspace deletion.
    org_id: scope.orgId,
    workspace_id: scope.workspaceId,
    api_key_id: stringOrNull(usage.metadata?.apiKeyId) ?? scope.apiKeyId,
    provider: usage.provider,
    model: usage.model,
    metric: usage.metric,
    amount: usage.amount,
    unit: usage.unit,
    // Customer credits: only price-card unit charges bill (sub-cent precision kept);
    // provider and compute cost stay in metadata for our own reports.
    cost_cents: billableCents(usage),
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    // runId keeps the event classified as ingest spend after the run is deleted.
    metadata: toJson(client, { ...persistedMetadata(usage), runId: state.run.id }),
  }));
}

const USAGE_EVENT_COLUMNS = [
  "id", "user_id", "run_id", "provider", "model", "metric", "amount", "unit",
  "cost_cents", "input_tokens", "output_tokens", "metadata", "org_id", "workspace_id", "api_key_id",
] as const;

/**
 * Insert a run's usage events (ON CONFLICT (id) DO NOTHING) and return the
 * cost of the rows actually inserted.
 */
export async function persistRunUsageEvents(args: {
  client: Sql<Record<string, unknown>>;
  state: WorkflowState;
  usageEvents: UsageEvent[];
}): Promise<number> {
  const { client, state, usageEvents } = args;
  if (usageEvents.length === 0) {
    return 0;
  }

  const rows = runUsageRows(client, state, usageEvents);
  const inserted: Array<{ id: string; cost_cents: number }> = [];
  for (const batch of batchedRows(rows)) {
    inserted.push(
      ...(await client<{ id: string; cost_cents: number }[]>`
        insert into usage_events ${client(batch, ...USAGE_EVENT_COLUMNS)}
        on conflict (id) do nothing
        returning id, cost_cents
      `),
    );
  }

  // Non-unit events are written at cost_cents = 0, so this is exactly what
  // the usage_events trigger adds to workspace_runs.spent_cents (0056): the
  // run's spend delta for the cap, the credit debit and the credit lease.
  return inserted.reduce((total, row) => total + Number(row.cost_cents ?? 0), 0);
}

/**
 * persistRunUsageEvents plus debitRunUsageCredits as independent statements for
 * pipelineTransaction. Each batch is one statement: the insert, and (when the
 * run has an org) the pending debit for exactly the rows it newly inserted, so
 * a retried checkpoint debits nothing. `cost` reads the inserted cost back from
 * the statements' results.
 */
export function runUsageEventStatements(args: {
  client: Sql<Record<string, unknown>>;
  state: WorkflowState;
  usageEvents: UsageEvent[];
}): { statements: PendingQuery<any>[]; cost: (results: readonly unknown[][]) => number } {
  const { client, state, usageEvents } = args;
  const orgId = state.run.orgId;
  const statements = batchedRows(runUsageRows(client, state, usageEvents)).map((batch) => orgId
    ? client`
      with inserted as (
        insert into usage_events ${client(batch, ...USAGE_EVENT_COLUMNS)}
        on conflict (id) do nothing
        returning id, cost_cents
      ), total as (select coalesce(sum(cost_cents), 0) as cents from inserted),
      debit as (
        select enqueue_org_credit_debit(
          ${orgId}, total.cents, ${state.run.userId}, 'usage', ${state.run.id}, ${state.run.workspaceId ?? null}, '{}'::jsonb
        ) from total
      )
      select id, cost_cents, (select count(*) from debit) as debits from inserted`
    : client`
      insert into usage_events ${client(batch, ...USAGE_EVENT_COLUMNS)}
      on conflict (id) do nothing
      returning id, cost_cents`);
  return {
    statements,
    cost: (results) => results.reduce((sum: number, rows) => sum + rows.reduce((inner: number, row) => inner + Number((row as { cost_cents?: unknown }).cost_cents ?? 0), 0), 0),
  };
}

/**
 * Persist run-less worker Usage Events (graph rebuilds) stamped with their
 * scope, and append the pending credit debit for the newly inserted billable
 * cost in the same statement batch. Returns that cost.
 */
export async function persistScopedUsageEvents(args: {
  client: Sql<Record<string, unknown>>;
  userId: string;
  scope: { orgId: string | null; workspaceId: string | null; apiKeyId?: string | null };
  usageEvents: UsageEvent[];
  debitMetadata?: Record<string, unknown>;
}): Promise<number> {
  const { client, scope, usageEvents, userId } = args;
  if (usageEvents.length === 0) return 0;
  const rows = usageEvents.map((usage) => ({
    id: usage.id ?? randomUUID(),
    user_id: userId,
    run_id: null,
    provider: usage.provider,
    model: usage.model,
    metric: usage.metric,
    amount: usage.amount,
    unit: usage.unit,
    cost_cents: billableCents(usage),
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    metadata: toJson(client, {
      ...persistedMetadata(usage),
      ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
      ...(scope.orgId ? { orgId: scope.orgId } : {}),
    }),
    org_id: scope.orgId,
    workspace_id: scope.workspaceId,
    api_key_id: stringOrNull(usage.metadata?.apiKeyId) ?? scope.apiKeyId ?? null,
  }));
  const billableIds = new Set(rows.filter((row) => Number(row.cost_cents) > 0).map((row) => row.id));
  let cost = 0;
  for (const batch of batchedRows(rows)) {
    const inserted = await client<{ id: string; cost_cents: number }[]>`
      insert into usage_events ${client(
        batch,
        "id", "user_id", "run_id", "provider", "model", "metric", "amount", "unit",
        "cost_cents", "input_tokens", "output_tokens", "metadata", "org_id", "workspace_id", "api_key_id",
      )}
      on conflict (id) do nothing
      returning id, cost_cents
    `;
    cost += inserted.reduce((total, row) => total + (billableIds.has(row.id) ? Number(row.cost_cents ?? 0) : 0), 0);
  }
  if (cost > 0 && scope.orgId) {
    await client`
      select enqueue_org_credit_debit(
        ${scope.orgId}, ${cost}, ${userId}, 'usage', null, ${scope.workspaceId},
        ${toJson(client, args.debitMetadata ?? {})}
      )
    `;
  }
  return cost;
}

/**
 * Spend a run's billable usage from the org's credit pools, asynchronously.
 *
 * The hot path only appends a pending debit (enqueue_org_credit_debit,
 * migration 0030): an insert that never locks the org's organizations row.
 * Locking that row per checkpoint stalled one org at 576 slots (12 s per
 * debit, 2026-10-09 re-run). The maintenance flusher applies each org's
 * pending debits through debit_org_credits within seconds (included before
 * prepaid, one ledger row per pool), and admission subtracts the pending sum,
 * so the API and worker still share one SQL implementation.
 *
 * Call it in the same transaction as persistRunUsageEvents, with the cost of
 * the newly inserted billable events only, so a retried checkpoint is never
 * charged twice.
 */
export async function debitRunUsageCredits(args: {
  client: Sql<Record<string, unknown>>;
  state: WorkflowState;
  costCents: number;
}): Promise<void> {
  const { client, costCents, state } = args;
  if (costCents <= 0 || !state.run.orgId) {
    return;
  }

  await client`
    select enqueue_org_credit_debit(
      ${state.run.orgId},
      ${costCents},
      ${state.run.userId},
      'usage',
      ${state.run.id},
      ${state.run.workspaceId ?? null},
      '{}'::jsonb
    )
  `;
}

/**
 * Apply pending credit debits (migration 0030), one org per transaction so a
 * flush never holds more than one org row lock. Orgs whose row is busy are
 * skipped until the next flush. Safe to run from several processes at once.
 */
export async function flushPendingCreditDebits(
  client: Sql<Record<string, unknown>>,
  options: { maxOrgs?: number } = {},
): Promise<{ orgs: number; debits: number; credits: number }> {
  const orgs = await client<{ org_id: string }[]>`
    select org_id from pending_debit_orgs(${options.maxOrgs ?? 500}::int)
  `;
  let debits = 0;
  let credits = 0;
  let applied = 0;
  for (const { org_id } of orgs) {
    const [row] = await client<{ debits: number; credits: string | number }[]>`
      select * from apply_pending_org_debits(${org_id}, true)
    `;
    if (Number(row?.debits ?? 0) > 0) applied += 1;
    debits += Number(row?.debits ?? 0);
    credits += Number(row?.credits ?? 0);
  }
  return { orgs: applied, debits, credits };
}

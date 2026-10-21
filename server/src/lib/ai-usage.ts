import { recordUsageReceipt, usageTraceContext } from "@docslurp/shared/observability";
import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";

import {
  buildPricedAiUsageLedgerEvent,
  estimateAiUsageCostCents,
  formatAiUsageConsoleLog,
  hasAiUsageLedgerTokens,
  priceAiUsageEvent,
  type AiUsageLedgerEvent,
  type AiUsagePricing,
} from "@docslurp/shared";
import { sql, type SqlClient } from "../db.js";
import { currentChatTurn, trackChatTurnWrite, type ChatTurnContext } from "./chat-turn-context.js";
import { currentRequestApiKeyId } from "./request-context.js";

/**
 * Usage Event ledger (write side).
 *
 * Callers say "this AI call happened, in this scope". The ledger owns pricing,
 * the `[ai-usage]` console line, scope stamping, and persistence into
 * `usage_events`. Scope keys are stamped into metadata under exactly the keys
 * `services/usage-attribution.ts` reads (`orgId`, `workspaceId`,
 * `workspaceIds`, `sessionId`, `apiKeyId`); `runId` goes to the `run_id` column.
 * The resolved org, single workspace and API key are also stamped into the
 * `org_id`, `workspace_id` and `api_key_id` columns (migration 0042), which
 * attribution reads first.
 */

export type UsageEvent = AiUsageLedgerEvent & { id?: string };

export interface UsageInput {
  /** Deterministic id makes a retried write idempotent (`on conflict (id) do nothing`). */
  id?: string;
  provider: string;
  model: string;
  metric: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  amount?: number;
  unit?: string;
  costCents?: number;
  metadata?: Record<string, unknown> | null;
  /** Embedding calls omit `output_tokens` from the console line. */
  logOutputTokens?: boolean;
}

export interface UsageScope {
  orgId?: string | null;
  workspaceId?: string | null;
  workspaceIds?: readonly string[] | null;
  sessionId?: string | null;
  runId?: string | null;
  /** Defaults to the API key authenticating the current request, for per-key spend limits. */
  apiKeyId?: string | null;
}

/** Narrow sink for strategy helpers: report actual usage, nothing else. */
export interface UsageRecorder {
  record(input: UsageInput): void;
}

type UsageClient = SqlClient | TransactionSql;

/** Build, log, and persist one Usage Event in the given scope. */
export async function recordUsageEvent(args: {
  userId: string;
  scope: UsageScope;
  usage: UsageInput;
  client?: UsageClient;
}): Promise<UsageEvent | null> {
  const event = logUsage(args.usage);
  if (!hasAiUsageLedgerTokens(event)) {
    return null;
  }
  return await insertUsageEvent(args.client ?? sql, args.userId, args.scope, event);
}

/** A non-AI, cost-only Usage Event (storage meter, platform fees). */
export interface CostEventInput {
  /** Deterministic id makes the write idempotent (`on conflict (id) do nothing`). */
  id: string;
  provider: string;
  model: string;
  metric: string;
  amount: number;
  unit: string;
  costCents: number;
  metadata?: Record<string, unknown>;
}

/**
 * Log and persist a cost-only Usage Event in the given scope. Returns whether
 * the row was newly inserted, so callers debit credits exactly once.
 */
export async function recordCostEvent(args: {
  userId: string;
  scope: UsageScope;
  event: CostEventInput;
  client?: UsageClient;
}): Promise<boolean> {
  const { event } = args;
  console.log(
    `[usage] ${event.metric} provider=${event.provider} model=${event.model} amount=${event.amount} unit=${event.unit} cost_cents=${event.costCents}`,
  );
  const metadata = stampUsageScope(event.metadata ?? {}, { apiKeyId: null, ...args.scope });
  const client = args.client ?? sql;
  const scope = scopeColumns(args.scope, metadata);
  const rows = await client`
    insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents, input_tokens, output_tokens, metadata, org_id, workspace_id, api_key_id)
    values (
      ${event.id},
      ${args.userId},
      ${args.scope.runId ?? null},
      ${event.provider},
      ${event.model},
      ${event.metric},
      ${event.amount},
      ${event.unit},
      ${event.costCents},
      0,
      0,
      ${JSON.stringify(metadata)}::text::jsonb,
      ${resolvedOrgId(client, args.scope, scope)},
      ${resolvedWorkspaceId(client, args.scope, scope)},
      ${scope.apiKeyId}
    )
    on conflict (id) do nothing
    returning id
  `;
  if (rows.length > 0) recordUsageReceipt(event, { ...args.scope, ...metadata });
  return rows.length > 0;
}

export interface UsageLedger extends UsageRecorder {
  /** Buffer events that were already logged elsewhere (e.g. child searches). */
  adopt(events: Iterable<UsageEvent | undefined>): void;
  /** Every recorded or adopted event, including ones already flushed. */
  events(): UsageEvent[];
  /** Persist events not yet flushed, stamped with the ledger scope. */
  flush(options?: UsageFlushOptions): Promise<UsageEvent[]>;
  /**
   * Persist unflushed events inside a caller-owned transaction. Call
   * `commit()` once the transaction commits so a rollback stays retryable.
   */
  flushWithin(
    client: UsageClient,
    options?: UsageFlushOptions,
  ): Promise<{ events: UsageEvent[]; commit(): void }>;
}

export interface UsageFlushOptions {
  /** Merged over the ledger scope. */
  scope?: UsageScope;
  /** Overrides the ledger userId (e.g. a journal created before auth resolves). */
  userId?: string;
}

/** Buffered ledger: logs on record, persists on flush. */
export function createUsageLedger(args: {
  userId?: string | null;
  scope?: UsageScope;
}): UsageLedger {
  const events: UsageEvent[] = [];
  let flushedCount = 0;

  const flushWithin: UsageLedger["flushWithin"] = async (client, options) => {
    const end = events.length;
    const pending = events.slice(flushedCount, end);
    const written: UsageEvent[] = [];
    if (pending.length > 0) {
      const userId = options?.userId ?? args.userId;
      if (!userId) {
        throw new Error("Usage ledger cannot persist events without a userId");
      }
      const scope = { ...args.scope, ...options?.scope };
      for (const event of pending) {
        written.push(await insertUsageEvent(client, userId, scope, event));
      }
    }
    return {
      events: written,
      commit() {
        flushedCount = Math.max(flushedCount, end);
      },
    };
  };

  return {
    record(input) {
      const event = logUsage(input);
      if (hasAiUsageLedgerTokens(event)) {
        events.push(event);
      }
    },
    adopt(adopted) {
      for (const event of adopted) {
        if (event && hasAiUsageLedgerTokens(event)) {
          events.push({ ...priceAiUsageEvent(event), id: event.id ?? randomUUID() });
        }
      }
    },
    events() {
      return [...events];
    },
    async flush(options) {
      const batch = await flushWithin(sql, options);
      batch.commit();
      return batch.events;
    },
    flushWithin,
  };
}

export function estimateApiAiUsageCostCents(input: {
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}): number {
  return estimateAiUsageCostCents(input, {
    fallback: resolveApiAiUsagePricing(),
  });
}

export function stampUsageScope(
  metadata: Record<string, unknown>,
  scope: UsageScope,
): Record<string, unknown> {
  const stamped = { ...usageTraceContext(), ...metadata };
  if (scope.orgId) stamped.orgId = scope.orgId;
  if (scope.workspaceId) stamped.workspaceId = scope.workspaceId;
  if (scope.workspaceIds && scope.workspaceIds.length > 0) {
    stamped.workspaceIds = [...new Set(scope.workspaceIds)];
  }
  if (scope.sessionId) stamped.sessionId = scope.sessionId;
  if (scope.runId) stamped.runId = scope.runId;
  const apiKeyId = scope.apiKeyId === undefined ? currentRequestApiKeyId() : scope.apiKeyId;
  if (apiKeyId) stamped.apiKeyId = apiKeyId;
  return stamped;
}

function logUsage({ id, ...input }: UsageInput): UsageEvent {
  const event = { ...priceAiUsageEvent(buildPricedAiUsageLedgerEvent(input, {
    fallback: resolveApiAiUsagePricing(),
  })), id: id ?? randomUUID() };
  console.log(
    formatAiUsageConsoleLog(event, {
      includeOutputTokens: input.logOutputTokens,
    }),
  );
  event.metadata = { ...usageTraceContext(), ...event.metadata };
  return event;
}

const ORG_PLAN_TTL_MS = 30_000;
const orgPlanCache = new Map<string, { planId: string | null; expiresAt: number }>();

/**
 * Plan of the org the event bills, for the plan-neutral AI credit factor on
 * bonus plans. Looked up with the same org resolution the insert uses. A failed
 * lookup bills the base price rather than blocking the usage write.
 */
async function resolveBilledPlanId(client: UsageClient, scope: UsageScope, columns: ScopeColumns): Promise<string | null> {
  const cached = scope.orgId ? orgPlanCache.get(scope.orgId) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.planId;
  try {
    const rows = await client`select o.plan_id from organizations o where o.id = ${resolvedOrgId(client, scope, columns)}`;
    const planId = Array.isArray(rows) && typeof rows[0]?.plan_id === "string" ? rows[0].plan_id : null;
    if (scope.orgId && planId) orgPlanCache.set(scope.orgId, { planId, expiresAt: Date.now() + ORG_PLAN_TTL_MS });
    return planId;
  } catch {
    return null;
  }
}

/** Test hook: forget cached org plans. */
export function clearOrgPlanCache(): void {
  orgPlanCache.clear();
}

function insertUsageEvent(
  client: UsageClient,
  userId: string,
  scope: UsageScope,
  logged: UsageEvent,
): Promise<UsageEvent> {
  const turn = currentChatTurn();
  if (!turn) return writeUsageEvent(client, userId, scope, logged, null);
  return trackChatTurnWrite(turn, writeUsageEvent(client, userId, scope, logged, turn));
}

/**
 * Stamp the chat turn on an event. Once the turn has failed (and refunds are
 * on), a late event, such as a tool search finishing after the error response,
 * is recorded at its provider cost but bills no credits.
 */
function stampChatTurn(event: UsageEvent, turn: ChatTurnContext | null): UsageEvent {
  if (!turn) return event;
  const metadata: Record<string, unknown> = { ...event.metadata, chatTurnId: turn.id };
  if (turn.status !== "failed" || !turn.refundOnFailure) return { ...event, metadata };
  return {
    ...event,
    costCents: 0,
    metadata: { ...metadata, billable: false, chatTurnRefund: { reason: "undelivered", credits: Math.max(0, event.costCents), late: true } },
  };
}

async function writeUsageEvent(
  client: UsageClient,
  userId: string,
  scope: UsageScope,
  logged: UsageEvent,
  turn: ChatTurnContext | null,
): Promise<UsageEvent> {
  const columns = scopeColumns(scope, stampUsageScope(logged.metadata, scope));
  const planId = await resolveBilledPlanId(client, scope, columns);
  const event = stampChatTurn(planId ? { ...priceAiUsageEvent(logged, { planId }), id: logged.id } : logged, turn);
  const metadata = stampUsageScope(event.metadata, scope);
  const id = event.id ?? randomUUID();
  await client`
    with recorded as (
      insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents, input_tokens, output_tokens, metadata, org_id, workspace_id, api_key_id)
      values (
        ${id},
        ${userId},
        ${scope.runId ?? null},
        ${event.provider},
        ${event.model},
        ${event.metric},
        ${event.amount},
        ${event.unit},
        ${event.costCents},
        ${event.inputTokens},
        ${event.outputTokens},
        ${JSON.stringify(metadata)}::text::jsonb,
        ${resolvedOrgId(client, scope, columns)},
        ${resolvedWorkspaceId(client, scope, columns)},
        ${columns.apiKeyId}
      )
      on conflict (id) do nothing
      returning cost_cents, org_id, workspace_id
    )
    select enqueue_org_credit_debit(
      recorded.org_id, recorded.cost_cents, ${userId}, 'usage',
      ${scope.runId ?? null}, recorded.workspace_id,
      ${JSON.stringify({ sessionId: scope.sessionId ?? null, metric: event.metric, ...(turn ? { chatTurnId: turn.id, usageEventId: id } : {}) })}::text::jsonb
    )
    from recorded
    where recorded.org_id is not null
      and recorded.cost_cents > 0 and ${metadata.billable !== false}
  `;
  recordUsageReceipt(event, { ...scope, ...metadata });
  if (turn) {
    const providerCost = Number(metadata.providerCostCents);
    const refund = metadata.chatTurnRefund as { credits?: unknown } | undefined;
    turn.events.push({
      creditCents: metadata.billable === false ? 0 : Math.max(0, event.costCents),
      waivedCreditCents: typeof refund?.credits === "number" ? refund.credits : 0,
      providerCostCents: Number.isFinite(providerCost) ? Math.max(0, providerCost) : 0,
    });
  }
  return event;
}

export interface VoidedChatTurnUsage {
  orgId: string;
  /** Credits the voided events had debited (pending or already flushed). */
  credits: number;
  eventIds: string[];
}

/**
 * Void the credits a chat turn's Usage Events billed: `cost_cents` drops to 0
 * and the original credits move to `metadata.chatTurnRefund`, so spend read
 * through usage_attribution no longer counts them while the provider cost
 * (`metadata.providerCostCents`) stays for our own accounting. Only events
 * that enqueued a debit are touched, and a voided event is never matched
 * again, so a repeated call voids nothing. Run it inside the refund
 * transaction (services/billing/chat-turn-billing.ts), which settles the
 * pending and flushed debits these credits correspond to.
 */
export async function voidChatTurnUsage(
  client: UsageClient,
  args: { turnId: string; reason: string },
): Promise<VoidedChatTurnUsage[]> {
  const rows = await (client as SqlClient)<{ org_id: string; credits: string; event_ids: string[] }[]>`
    with voided as (
      update usage_events ue
      set cost_cents = 0,
        metadata = ue.metadata || jsonb_build_object(
          'billable', false,
          'chatTurnRefund', jsonb_build_object('reason', ${args.reason}::text, 'credits', ue.cost_cents)
        )
      where ue.metadata ->> 'chatTurnId' = ${args.turnId}
        and ue.org_id is not null
        and ue.run_id is null
        and ue.cost_cents > 0
        and coalesce(ue.metadata ->> 'billable', 'true') <> 'false'
      returning ue.id, ue.org_id, (ue.metadata #>> '{chatTurnRefund,credits}')::numeric as credits
    )
    select org_id, sum(credits)::text as credits, array_agg(id order by id) as event_ids
    from voided
    group by org_id
    order by org_id
  `;
  return rows.map((row) => ({ orgId: row.org_id, credits: Number(row.credits), eventIds: [...row.event_ids] }));
}

interface ScopeColumns {
  /** The single attributed workspace the writer knows about, if any. */
  workspaceId: string | null;
  /** First workspace of a cross-workspace split, used only to resolve the org. */
  splitWorkspaceId: string | null;
  split: boolean;
  apiKeyId: string | null;
}

function scopeColumns(scope: UsageScope, metadata: Record<string, unknown>): ScopeColumns {
  const ids = [...new Set(scope.workspaceIds ?? [])];
  const workspaceId = scope.workspaceId ?? (ids.length === 1 ? ids[0]! : null);
  return {
    workspaceId,
    splitWorkspaceId: ids[0] ?? null,
    split: !workspaceId && ids.length > 1,
    apiKeyId: typeof metadata.apiKeyId === "string" ? metadata.apiKeyId : null,
  };
}

/**
 * The tenant columns stamped on the event (migration 0042), resolved at write
 * time so the spend survives run and workspace deletion. Workspace: the
 * scope's, else the run's, else the Search Session's (not for cross-workspace
 * splits). Org: the scope's, else that workspace's, the run's, or the first
 * split workspace's org. Appended after the original values so the earlier
 * parameters keep their positions.
 */
function resolvedWorkspaceId(client: UsageClient, scope: UsageScope, columns: ScopeColumns) {
  const sessionId = columns.split ? null : scope.sessionId ?? null;
  return client`coalesce(
    ${columns.workspaceId}::text,
    (select wr.workspace_id from workspace_runs wr where wr.id = ${scope.runId ?? null}::text),
    (
      select case when jsonb_typeof(ss.metadata) = 'string'
        then (ss.metadata #>> '{}')::jsonb ->> 'workspaceId'
        else ss.metadata ->> 'workspaceId'
      end
      from search_sessions ss
      where ss.id = ${sessionId}::text
    )
  )`;
}

function resolvedOrgId(client: UsageClient, scope: UsageScope, columns: ScopeColumns) {
  return client`coalesce(
    ${scope.orgId ?? null}::text,
    (select w.org_id from workspaces w where w.id = ${resolvedWorkspaceId(client, scope, columns)}),
    (select wr.org_id from workspace_runs wr where wr.id = ${scope.runId ?? null}::text),
    (select w.org_id from workspaces w where w.id = ${columns.splitWorkspaceId}::text)
  )`;
}

export function resolveApiAiUsagePricing(): AiUsagePricing {
  return {
    costPer1kInputTokens: readCostRate(
      process.env.COST_PER_1K_INPUT_TOKENS,
      0.01,
    ),
    costPer1kOutputTokens: readCostRate(
      process.env.COST_PER_1K_OUTPUT_TOKENS,
      0.03,
    ),
  };
}

function readCostRate(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

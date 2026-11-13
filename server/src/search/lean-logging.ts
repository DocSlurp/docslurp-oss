import { randomUUID } from "node:crypto";

import { BILLABLE_UNIT_METRICS, searchCredits, searchUnits, type SearchMode } from "@docslurp/shared";

import { persistUsageEvent, recordUnitCharge, type UsageEvent } from "../lib/ai-usage.js";
import { currentChatTurn } from "../lib/chat-turn-context.js";
import { currentRequestApiKeyId } from "../lib/request-context.js";

/**
 * Lean logging for API-key keyword and hybrid searches, the cheap high-volume tiers. Two things a search otherwise
 * keeps forever cost more than the search itself at those prices, so for these searches:
 *
 * - Search history (the search_sessions row and its result rows) expires after SEARCH_API_HISTORY_RETENTION_DAYS
 *   (default 30); the maintenance sweep deletes it.
 * - The charge is batched: searches are counted in process and written as one usage event per
 *   (user, organization, project, key, mode) every SEARCH_CHARGE_BATCH_MS (default 5 s), instead of one per search.
 *   The search's own non-billable usage (the query embedding) is summed the same way, one event per key, provider,
 *   model and metric with the batch's total tokens and cost, so every call is still logged and persisted.
 *   The batch id is fixed before the first write attempt, and a usage event insert is idempotent by id, so a retried
 *   flush cannot bill twice. Spend limits and balances see a search at most one flush interval late; the host's
 *   shutdown drain flushes what is pending.
 *
 * Dashboard (session) searches, chat turns and deep searches keep full history and a per-search charge.
 * SEARCH_API_LEAN_LOGGING=0 turns both off.
 */
export function leanSearchLogging(mode: SearchMode | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.SEARCH_API_LEAN_LOGGING ?? "").trim() === "0") return false;
  return (mode === "keyword" || mode === "hybrid") && Boolean(currentRequestApiKeyId()) && !currentChatTurn();
}

/** Days an API-key keyword or hybrid search stays in search history. */
export function apiSearchHistoryRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const days = Number((env.SEARCH_API_HISTORY_RETENTION_DAYS ?? "").trim() || 30);
  return Number.isFinite(days) && days >= 1 ? Math.floor(days) : 30;
}

const BATCH_MS = (() => {
  const ms = Number((process.env.SEARCH_CHARGE_BATCH_MS ?? "").trim() || 5_000);
  return Number.isFinite(ms) && ms >= 100 ? Math.min(ms, 60_000) : 5_000;
})();

type ChargeGroup = { userId: string; orgId: string | null; projectId: string; apiKeyId: string; mode: SearchMode };
type ChargeBatch = ChargeGroup & { kind: "charge"; id: string; searches: number };
type UsageBatch = { kind: "usage"; id: string; userId: string; orgId: string | null; projectId: string; apiKeyId: string; event: UsageEvent & { calls: number } };
type Batch = ChargeBatch | UsageBatch;

const open = new Map<string, Batch>();
/** Batches whose write failed: retried with the same id, never merged into a new one. */
const retry: Batch[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;

/** Counts one lean search charge for the current request's API key. */
export function enqueueSearchCharge(group: Omit<ChargeGroup, "apiKeyId"> & { apiKeyId?: string | null }): void {
  const apiKeyId = group.apiKeyId ?? currentRequestApiKeyId();
  if (!apiKeyId) throw new Error("a batched search charge needs an API key");
  const key = ["charge", group.userId, group.orgId ?? "", group.projectId, apiKeyId, group.mode].join("\u0000");
  const existing = open.get(key);
  const batch: ChargeBatch = existing?.kind === "charge" ? existing : { kind: "charge", ...group, apiKeyId, id: `search-batch:${randomUUID()}`, searches: 0 };
  batch.searches += 1;
  open.set(key, batch);
  scheduleFlush();
}

/**
 * Sums a lean search's non-billable usage events (query embedding) into per-key batches. Billable events are
 * refused: they are charged per search, never batched here.
 */
export function enqueueSearchUsage(scope: { userId: string; orgId: string | null; projectId: string; apiKeyId?: string | null }, events: readonly UsageEvent[]): void {
  const apiKeyId = scope.apiKeyId ?? currentRequestApiKeyId();
  if (!apiKeyId) throw new Error("batched search usage needs an API key");
  for (const event of events) {
    if (event.metadata?.billable !== false) throw new Error(`only non-billable usage is batched (${event.metric})`);
    const key = ["usage", scope.userId, scope.orgId ?? "", scope.projectId, apiKeyId, event.provider, event.model, event.metric, event.unit ?? ""].join("\u0000");
    const existing = open.get(key);
    if (existing?.kind === "usage") {
      const sum = existing.event;
      sum.calls += 1;
      sum.amount = (sum.amount ?? 0) + (event.amount ?? 0);
      sum.inputTokens = (sum.inputTokens ?? 0) + (event.inputTokens ?? 0);
      sum.outputTokens = (sum.outputTokens ?? 0) + (event.outputTokens ?? 0);
      sum.costCents = (sum.costCents ?? 0) + (event.costCents ?? 0);
    } else {
      const id = `search-usage-batch:${randomUUID()}`;
      open.set(key, { kind: "usage", id, userId: scope.userId, orgId: scope.orgId, projectId: scope.projectId, apiKeyId,
        event: { ...event, id, calls: 1, metadata: { ...event.metadata, billable: false, batched: true } } });
    }
  }
  scheduleFlush();
}

function scheduleFlush(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flushSearchCharges(); }, BATCH_MS);
  timer.unref?.();
}

async function writeBatch(batch: Batch): Promise<void> {
  if (batch.kind === "usage") {
    const { calls, ...event } = batch.event;
    await persistUsageEvent({ userId: batch.userId, scope: { orgId: batch.orgId, projectId: batch.projectId, apiKeyId: batch.apiKeyId },
      event: { ...event, metadata: { ...event.metadata, calls } } });
    return;
  }
  await recordUnitCharge({
    userId: batch.userId,
    scope: { orgId: batch.orgId, projectId: batch.projectId, apiKeyId: batch.apiKeyId },
    charge: {
      id: batch.id,
      metric: BILLABLE_UNIT_METRICS.search,
      amount: batch.searches,
      unit: "search",
      credits: searchCredits(batch.searches, { mode: batch.mode }),
      metadata: { llmStrategies: false, searchMode: batch.mode, batched: true, searchUnits: batch.searches * searchUnits({ mode: batch.mode }) },
    },
  });
}

/** Writes every pending batch; failed batches stay queued (same id) for the next flush. */
export function flushSearchCharges(): Promise<void> {
  if (flushing) return flushing.then(() => flushSearchCharges());
  const batches = [...retry.splice(0), ...open.values()];
  open.clear();
  if (batches.length === 0) return Promise.resolve();
  flushing = (async () => {
    const results = await Promise.allSettled(batches.map(writeBatch));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      const batch = batches[index]!;
      retry.push(batch);
      console.error(`[search-charge] batch ${batch.id} (${batch.kind === "charge" ? `${batch.searches} searches` : `${batch.event.calls} ${batch.event.metric} calls`}) not written, will retry: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    });
    if (retry.length > 0) scheduleFlush();
  })().finally(() => { flushing = null; });
  return flushing;
}

/** Pending searches not yet written (tests and shutdown logs). */
export function pendingSearchCharges(): number {
  return [...retry, ...open.values()].reduce((sum, batch) => sum + (batch.kind === "charge" ? batch.searches : 0), 0);
}

/** Usage events summed but not yet written (tests and shutdown logs). */
export function pendingSearchUsageCalls(): number {
  return [...retry, ...open.values()].reduce((sum, batch) => sum + (batch.kind === "usage" ? batch.event.calls : 0), 0);
}

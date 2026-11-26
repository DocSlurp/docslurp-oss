/**
 * Read map: the parallel form of the read loop, for tasks whose reads do not depend on each other.
 *
 * `runReadLoop` carries one state through a chain of steps. `runReadMap` reads a fixed list of items (windows of one
 * document, usually) with one fresh model call each, several in flight at once, and returns every answer in item order
 * for the caller to merge. The same rules hold: code decides what is read, every budget is checked before the call it
 * bounds, and a budget stop is a result, never an exception.
 *
 * An optional `lookup` answers an item from the caller's own store (an earlier attempt of the same run). A hit is not a
 * model call: it spends no budget and is still served after a budget has stopped new calls.
 */

export interface ReadMapBudget {
  /** Model calls started. A `lookup` hit is not a call. */
  maxCalls: number;
  /** Tokens across all calls: the estimate when a call starts, the provider's count once it reports one. */
  maxInputTokens: number;
  maxCostCents: number;
  maxWallMs: number;
  /** Items in flight at once. */
  concurrency: number;
  /** Optional, default 0. Do not start a call when less wall time than this remains. */
  minCallWallMs?: number;
}

export type ReadMapStoppedBy = "exhausted" | "steps" | "input-tokens" | "wall-clock" | "cost" | "errors" | "aborted";

export type ReadMapOutcome<R> =
  | { status: "ok"; value: R; cached: boolean }
  /** The call threw. Only with `onError: "continue"`, or for calls in flight when another one stopped the map. */
  | { status: "failed" }
  /** Never started: a budget, an error or an abort stopped the map first. */
  | { status: "skipped" };

export interface ReadMapResult<R> {
  /** `complete` only when every item has an answer. */
  status: "complete" | "partial";
  /** The first reason an item was not read; `exhausted` when every item was tried. */
  stoppedBy: ReadMapStoppedBy;
  /** One outcome per item, in item order. */
  outcomes: Array<ReadMapOutcome<R>>;
  /** The first thrown value, kept so a caller that must fail can rethrow the original error. */
  error?: unknown;
  usage: { calls: number; cached: number; failed: number; skipped: number; inputTokens: number; costCents: number; wallMs: number };
}

export interface ReadMapPorts {
  /** External stop, checked before every call (for example the run's cost cap). Reported as `cost`. */
  shouldStop?(): boolean;
  now?(): number;
  signal?: AbortSignal;
}

const finiteSpend = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

function validateBudget(budget: ReadMapBudget): void {
  for (const key of ["maxCalls", "concurrency"] as const) {
    if (typeof budget[key] !== "number" || !Number.isFinite(budget[key]) || budget[key] < 0) throw new Error(`read map: invalid budget ${key}`);
  }
  // A caller with no limit of its own says so with Infinity; NaN and negatives are mistakes.
  for (const key of ["maxInputTokens", "maxCostCents", "maxWallMs"] as const) {
    if (typeof budget[key] !== "number" || Number.isNaN(budget[key]) || budget[key] < 0) throw new Error(`read map: invalid budget ${key}`);
  }
  const min = budget.minCallWallMs;
  if (min !== undefined && (typeof min !== "number" || !Number.isFinite(min) || min < 0)) throw new Error("read map: invalid budget minCallWallMs");
}

export async function runReadMap<I, R>(args: {
  items: readonly I[];
  /**
   * One model read of one item. Throwing fails that item. As in the read loop, a thrown object's finite, non-negative
   * `costCents` and `inputTokens` are added to usage (throw a `ReadStepError`); nothing else on it is read.
   */
  map(args: { item: I; index: number; signal: AbortSignal }): Promise<{ value: R; costCents: number; inputTokens?: number }>;
  /** An answer the caller already holds. `null` or a throw is a miss. */
  lookup?(args: { item: I; index: number }): Promise<{ value: R } | null>;
  /** Estimated input tokens of one item, for `maxInputTokens`. Absent: only provider-reported counts are charged. */
  estimateTokens?(item: I): number;
  budget: ReadMapBudget;
  ports?: ReadMapPorts;
  /** `stop` (default): after the first failure no new item starts. `continue`: the item is marked failed. */
  onError?: "stop" | "continue";
}): Promise<ReadMapResult<R>> {
  const { items, budget } = args;
  validateBudget(budget);
  const ports = args.ports ?? {};
  const now = ports.now ?? Date.now;
  const startedAt = now();
  const minCallWallMs = budget.minCallWallMs ?? 0;
  const outcomes: Array<ReadMapOutcome<R>> = items.map(() => ({ status: "skipped" }));
  let calls = 0;
  let inputTokens = 0;
  let costCents = 0;
  /** The first budget that refused a call. Later items are still looked up. */
  let budgetStop: ReadMapStoppedBy | null = null;
  /** An error or abort: nothing more starts, not even a lookup. */
  let halt: "errors" | "aborted" | null = null;
  let firstError: unknown;
  let hasError = false;

  const ctl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctl.abort();
  if (ports.signal?.aborted) ctl.abort();
  ports.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = Number.isFinite(budget.maxWallMs)
    ? setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, Math.min(budget.maxWallMs, 2 ** 31 - 1))
    : null;
  const elapsed = () => Math.max(0, now() - startedAt);

  const estimate = (item: I): number => {
    try {
      return args.estimateTokens ? finiteSpend(args.estimateTokens(item)) : 0;
    } catch {
      return 0;
    }
  };

  /** Why a call may not start now, or null. */
  const refusal = (tokens: number): ReadMapStoppedBy | null => {
    try {
      if (ports.shouldStop?.()) return "cost";
    } catch {
      // A throwing external check is not a reason to stop.
    }
    if (calls >= budget.maxCalls) return "steps";
    if (inputTokens + tokens > budget.maxInputTokens) return "input-tokens";
    if (costCents >= budget.maxCostCents) return "cost";
    if (timedOut || elapsed() >= budget.maxWallMs || budget.maxWallMs - elapsed() < minCallWallMs) return "wall-clock";
    return null;
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (halt) return;
      if (ports.signal?.aborted) {
        halt = "aborted";
        return;
      }
      const index = next++;
      if (index >= items.length) return;
      const item = items[index]!;

      if (args.lookup) {
        let hit: { value: R } | null = null;
        try {
          hit = await args.lookup({ item, index });
        } catch {
          hit = null;
        }
        if (hit && typeof hit === "object") {
          outcomes[index] = { status: "ok", value: hit.value, cached: true };
          continue;
        }
        if (halt) return;
      }

      if (budgetStop) continue;
      const reserved = estimate(item);
      const refused = refusal(reserved);
      if (refused) {
        budgetStop = refused;
        continue;
      }
      calls++;
      inputTokens += reserved;
      try {
        const out = await args.map({ item, index, signal: ctl.signal });
        if (typeof out.inputTokens === "number" && Number.isFinite(out.inputTokens) && out.inputTokens >= 0) {
          inputTokens += out.inputTokens - reserved;
        }
        costCents += finiteSpend(out.costCents);
        outcomes[index] = { status: "ok", value: out.value, cached: false };
      } catch (error) {
        outcomes[index] = { status: "failed" };
        // A failed call may have spent money: read only two numeric fields, defensively, and charge them.
        try {
          const spent = error as { costCents?: unknown; inputTokens?: unknown } | null;
          if (spent && typeof spent === "object") {
            costCents += finiteSpend(spent.costCents);
            const reported = spent.inputTokens;
            if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) inputTokens += reported - reserved;
          }
        } catch {
          // A hostile getter reports nothing.
        }
        if (!hasError) {
          hasError = true;
          firstError = error;
        }
        if (ports.signal?.aborted) halt = "aborted";
        else if (timedOut) budgetStop ??= "wall-clock";
        else if ((args.onError ?? "stop") === "stop") halt = "errors";
      }
    }
  };

  try {
    const workers = Math.max(1, Math.min(Math.floor(budget.concurrency) || 1, items.length));
    await Promise.all(Array.from({ length: workers }, () => worker()));
  } finally {
    if (timer) clearTimeout(timer);
    ports.signal?.removeEventListener("abort", onAbort);
  }
  if (!halt && ports.signal?.aborted && outcomes.some((outcome) => outcome.status !== "ok")) halt = "aborted";

  const count = (status: ReadMapOutcome<R>["status"]) => outcomes.filter((outcome) => outcome.status === status).length;
  const skipped = count("skipped");
  return {
    status: outcomes.every((outcome) => outcome.status === "ok") ? "complete" : "partial",
    stoppedBy: halt ?? (skipped > 0 || timedOut ? budgetStop : null) ?? "exhausted",
    outcomes,
    ...(hasError ? { error: firstError } : {}),
    usage: {
      calls,
      cached: outcomes.filter((outcome) => outcome.status === "ok" && outcome.cached).length,
      failed: count("failed"),
      skipped,
      inputTokens,
      costCents,
      wallMs: elapsed(),
    },
  };
}

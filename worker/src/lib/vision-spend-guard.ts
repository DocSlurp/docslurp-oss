import type { UsageEvent } from "../models.js";

/**
 * Per-run guard on vision provider spend. Customers are charged only for pages vision reads
 * (Rich page credits), and the run cost cap counts only those charges, but a rejected attempt
 * (degenerate, refusal, truncated: `billable: false`) still costs us the provider call. A
 * hostile upload can make every page reject, so without this guard the provider spend of a
 * run has no bound once the per-document vision page cap is gone.
 *
 * Before each vision call the stage asks `admit`. The guard counts the provider cost of every
 * vision attempt in the run (billable or not) plus a reservation for each call in flight, and:
 *
 * - **Provider budget**: refuses when the projected spend would pass the run's budget
 *   (`VISION_RUN_PROVIDER_BUDGET_CENTS`, default 2,500 cents, lowered to the run cost cap when the
 *   run has one).
 * - **Rejection breaker**: refuses once at least `VISION_REJECTION_BREAKER_MIN_PAGES` pages
 *   (default 10) were rejected and they are at least `VISION_REJECTION_BREAKER_RATE` (default 0.2)
 *   of the pages attempted.
 *
 * Spend committed by other activities (page tasks, shards, earlier attempts) comes from the
 * store (`usage_attribution` plus live page-task leases); spend not yet checkpointed comes from
 * this process's usage ledger. A refusal is sticky for the guard's lifetime.
 */
export interface VisionRunSpend {
  /** Provider cost of every vision attempt committed for the run, billable or not. */
  providerCostCents: number;
  /** Distinct pages with at least one committed vision attempt. */
  attemptedPages: number;
  /** Distinct pages whose committed attempt was rejected. */
  rejectedPages: number;
  /** Vision page tasks of the run running in other activities (live leases). */
  inFlightPages: number;
}

export type VisionRunSpendSource = (
  runId: string,
  exclude?: { documentId: string; pageNumber: number },
) => Promise<VisionRunSpend>;

export interface VisionGuardConfig {
  budgetCents: number;
  breakerMinRejectedPages: number;
  breakerRejectedRate: number;
}

export type VisionGuardStopReason = "provider-budget" | "rejection-breaker";

export interface VisionGuardStop {
  reason: VisionGuardStopReason;
  providerCostCents: number;
  reservedCents: number;
  budgetCents: number;
  attemptedPages: number;
  rejectedPages: number;
}

export type VisionAdmission =
  | { admitted: true; release: () => void }
  | { admitted: false; stop: VisionGuardStop };

export const DEFAULT_VISION_RUN_PROVIDER_BUDGET_CENTS = 2_500;
export const DEFAULT_VISION_REJECTION_BREAKER_MIN_PAGES = 10;
export const DEFAULT_VISION_REJECTION_BREAKER_RATE = 0.2;
/** Vision usage metrics: a page read and a failed or rejected attempt. */
export const VISION_USAGE_METRICS = ["page-analysis", "page-analysis-attempt"] as const;
/** How long a store snapshot is reused before the guard reads it again. */
const REMOTE_REFRESH_MS = 5_000;
const REMOTE_REFRESH_ADMISSIONS = 20;

const warned = new Set<string>();

function envNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  valid: (value: number) => boolean,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && valid(value)) return value;
  if (!warned.has(`${name}=${raw}`)) {
    warned.add(`${name}=${raw}`);
    // Never off by typo: a malformed value keeps the default guard.
    console.warn(`[vision-guard] ${name}=${JSON.stringify(raw.slice(0, 60))} is invalid; using ${fallback}`);
  }
  return fallback;
}

export function resolveVisionGuardConfig(
  run: { pipeline: { maxCostCents?: number | null } },
  env: Record<string, string | undefined> = process.env,
): VisionGuardConfig {
  const budget = envNumber(env, "VISION_RUN_PROVIDER_BUDGET_CENTS", DEFAULT_VISION_RUN_PROVIDER_BUDGET_CENTS, (v) => v > 0);
  const cap = run.pipeline.maxCostCents;
  return {
    budgetCents: typeof cap === "number" && cap > 0 ? Math.min(budget, cap) : budget,
    breakerMinRejectedPages: Math.trunc(envNumber(env, "VISION_REJECTION_BREAKER_MIN_PAGES",
      DEFAULT_VISION_REJECTION_BREAKER_MIN_PAGES, (v) => v >= 1)),
    breakerRejectedRate: envNumber(env, "VISION_REJECTION_BREAKER_RATE", DEFAULT_VISION_REJECTION_BREAKER_RATE,
      (v) => v > 0 && v <= 1),
  };
}

function isVisionUsage(event: UsageEvent): boolean {
  return (VISION_USAGE_METRICS as readonly string[]).includes(event.metric);
}

function pageKey(event: UsageEvent): string | null {
  const documentId = event.metadata?.documentId;
  const pageNumber = event.metadata?.pageNumber;
  return typeof documentId === "string" && typeof pageNumber === "number" ? `${documentId}:${pageNumber}` : null;
}

export function isRejectedVisionAttempt(event: UsageEvent): boolean {
  return event.metric === "page-analysis-attempt" && event.metadata?.outcome === "rejected";
}

/** Provider cost of a vision usage event, as `usage-event-store` persists it (`providerCostCents`). */
function providerCost(event: UsageEvent): number {
  const stored = event.metadata?.providerCostCents;
  const cost = typeof stored === "number" ? stored : Number(event.costCents);
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

interface LocalTally {
  costCents: number;
  attempted: Set<string>;
  rejected: Set<string>;
}

function tally(events: readonly UsageEvent[]): LocalTally {
  const result: LocalTally = { costCents: 0, attempted: new Set(), rejected: new Set() };
  for (const event of events) {
    if (!isVisionUsage(event)) continue;
    result.costCents += providerCost(event);
    const key = pageKey(event);
    if (!key) continue;
    result.attempted.add(key);
    if (isRejectedVisionAttempt(event)) result.rejected.add(key);
  }
  return result;
}

export class VisionRunGuard {
  private stopped: VisionGuardStop | null = null;
  private inFlightCents = 0;
  /** Store snapshot plus the ledger's pending vision usage when it was read. */
  private base: { spend: VisionRunSpend; pending: LocalTally; at: number; admissions: number } | null = null;
  /** Vision usage this guard has seen recorded since `base` was read. */
  private recordedEvents: UsageEvent[] = [];

  constructor(
    private readonly runId: string,
    private readonly config: VisionGuardConfig,
    private readonly pendingUsage: () => readonly UsageEvent[],
    private readonly source?: VisionRunSpendSource,
    private readonly exclude?: { documentId: string; pageNumber: number },
    private readonly now: () => number = Date.now,
  ) {}

  get stop(): VisionGuardStop | null {
    return this.stopped;
  }

  /** Tell the guard about a vision usage event this process recorded (success, failure or rejection). */
  observe(event: UsageEvent | null | undefined): void {
    if (event && isVisionUsage(event)) this.recordedEvents.push(event);
  }

  /** Admit one vision call reserving `reserveCents`, or refuse with why. */
  async admit(reserveCents: number): Promise<VisionAdmission> {
    if (this.stopped) return { admitted: false, stop: this.stopped };
    const reserve = Number.isFinite(reserveCents) && reserveCents > 0 ? reserveCents : 0;
    const spend = await this.currentSpend();
    const reservedCents = (spend.inFlightPages + 1) * reserve + this.inFlightCents;
    const { breakerMinRejectedPages, breakerRejectedRate, budgetCents } = this.config;
    let reason: VisionGuardStopReason | null = null;
    if (spend.rejectedPages >= breakerMinRejectedPages &&
      spend.rejectedPages / Math.max(1, spend.attemptedPages) >= breakerRejectedRate) {
      reason = "rejection-breaker";
    } else if (spend.providerCostCents + reservedCents > budgetCents) {
      reason = "provider-budget";
    }
    if (reason) {
      this.stopped = {
        reason,
        providerCostCents: round(spend.providerCostCents),
        reservedCents: round(reservedCents),
        budgetCents,
        attemptedPages: spend.attemptedPages,
        rejectedPages: spend.rejectedPages,
      };
      return { admitted: false, stop: this.stopped };
    }
    this.inFlightCents += reserve;
    let released = false;
    return {
      admitted: true,
      release: () => {
        if (released) return;
        released = true;
        this.inFlightCents -= reserve;
      },
    };
  }

  /**
   * Committed spend from the store (refreshed every few seconds or admissions) plus everything
   * recorded in this process since: the ledger's pending events when the snapshot was read (read
   * before the store, so an event checkpointed in between counts twice rather than never) and
   * events observed after it.
   */
  private async currentSpend(): Promise<VisionRunSpend> {
    const now = this.now();
    // Without a store nothing is committed elsewhere: read the ledger once and keep counting what
    // this guard observes (a checkpoint could otherwise drop events from both sides).
    const stale = this.base !== null && this.source !== undefined &&
      (now - this.base.at >= REMOTE_REFRESH_MS || this.base.admissions >= REMOTE_REFRESH_ADMISSIONS);
    if (!this.base || stale) {
      const pending = tally(this.pendingUsage());
      this.recordedEvents = [];
      const spend = this.source
        ? await this.source(this.runId, this.exclude)
        : { providerCostCents: 0, attemptedPages: 0, rejectedPages: 0, inFlightPages: 0 };
      this.base = { spend, pending, at: now, admissions: 0 };
    }
    this.base.admissions += 1;
    const since = tally(this.recordedEvents);
    const { spend, pending } = this.base;
    // Page counts: committed pages plus local pages (a page counted on both sides is rare and
    // only makes the guard stricter).
    const attempted = new Set([...pending.attempted, ...since.attempted]);
    const rejected = new Set([...pending.rejected, ...since.rejected]);
    return {
      providerCostCents: spend.providerCostCents + pending.costCents + since.costCents,
      attemptedPages: spend.attemptedPages + attempted.size,
      rejectedPages: spend.rejectedPages + rejected.size,
      inFlightPages: spend.inFlightPages,
    };
  }
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Test hook: forget which malformed env values already warned. */
export function resetVisionGuardWarningsForTest(): void {
  warned.clear();
}

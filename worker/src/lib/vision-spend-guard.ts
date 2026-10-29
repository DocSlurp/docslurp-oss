import { randomUUID } from "node:crypto";

/**
 * Guard on vision provider spend. Customers are charged only for pages vision reads (Rich page
 * credits), and the run cost cap counts only those charges, but a rejected or failed attempt
 * (`billable: false`) still costs us the provider call. A hostile upload can make every page
 * reject, so without this guard the provider spend of a run has no bound once the per-document
 * vision page cap is gone, and many small runs from one org would each start from zero.
 *
 * Every vision provider call (legacy pages, routed regions and their fallbacks, document-map
 * OCR, self-critique, deferred page materialization) asks `admit` first with a reservation priced
 * at that call's own model and a bounded input and output size (`visionCallReserveCents`). The
 * backend admits atomically per run and per org (Postgres: advisory locks, so every worker of the
 * run sees the same ledger) and refuses when:
 *
 * - **Provider budget**: the run's settled vision spend plus every live reservation of the run
 *   plus this one passes `VISION_RUN_PROVIDER_BUDGET_CENTS` (default 2,500 cents, lowered to the
 *   run cost cap when the run has one).
 * - **Rejection breaker**: at least `VISION_REJECTION_BREAKER_MIN_PAGES` pages (default 10) were
 *   rejected and they are at least `VISION_REJECTION_BREAKER_RATE` (default 0.2) of the pages
 *   attempted in the run.
 * - **Org unbilled limit**: the org's unbilled vision provider spend (rejected and failed
 *   attempts) over the last `VISION_ORG_UNBILLED_WINDOW_HOURS` (default 24), plus every live
 *   reservation of the org plus this one, passes `VISION_ORG_UNBILLED_LIMIT_CENTS` (default
 *   5,000 cents). This bound holds across runs, reprocessing and extraction.
 *
 * Each admitted call settles once, whatever happens to it: its actual provider cost, whether the
 * customer is billed for it, and the page it read (rejected or not). A reservation that is never
 * settled (a crashed worker) counts in full once it expires. A refusal is sticky for the guard.
 */
export interface VisionGuardConfig {
  budgetCents: number;
  breakerMinRejectedPages: number;
  breakerRejectedRate: number;
  /** Rolling limit on the org's unbilled vision provider spend. */
  orgUnbilledLimitCents: number;
  orgWindowHours: number;
}

export type VisionGuardStopReason = "provider-budget" | "rejection-breaker" | "org-unbilled-limit";

export interface VisionGuardStop {
  reason: VisionGuardStopReason;
  providerCostCents: number;
  reservedCents: number;
  budgetCents: number;
  attemptedPages: number;
  rejectedPages: number;
  orgUnbilledCents: number;
  orgLimitCents: number;
}

/** What one admitted call cost once it finished (success, rejection or failure). */
export interface VisionSettlement {
  /** Provider cost of the call, billable or not. */
  costCents: number;
  /** The customer is charged for the call (a page read); false for rejected and failed attempts. */
  billable: boolean;
  /** The page the call read, for the rejection breaker. */
  page?: { documentId: string; pageNumber: number; rejected: boolean };
}

/** The run's and org's ledger as the backend read it, under its locks. */
export interface VisionSpendSnapshot {
  runCostCents: number;
  runReservedCents: number;
  attemptedPages: number;
  rejectedPages: number;
  orgUnbilledCents: number;
  orgReservedCents: number;
}

export interface VisionAdmitRequest {
  runId: string;
  orgId: string | null;
  reserveCents: number;
  config: VisionGuardConfig;
}

export type VisionBackendAdmission =
  | { admitted: true; reservationId: string }
  | { admitted: false; stop: VisionGuardStop };

/** Shared vision spend ledger: Postgres in workers (db/vision-spend-store.ts), memory otherwise. */
export interface VisionSpendBackend {
  admit(request: VisionAdmitRequest): Promise<VisionBackendAdmission>;
  settle(reservationId: string, settlement: VisionSettlement): Promise<void>;
}

export type VisionAdmission =
  | { admitted: true; settle: (settlement: VisionSettlement) => Promise<void> }
  | { admitted: false; stop: VisionGuardStop };

export const DEFAULT_VISION_RUN_PROVIDER_BUDGET_CENTS = 2_500;
export const DEFAULT_VISION_REJECTION_BREAKER_MIN_PAGES = 10;
export const DEFAULT_VISION_REJECTION_BREAKER_RATE = 0.2;
export const DEFAULT_VISION_ORG_UNBILLED_LIMIT_CENTS = 5_000;
export const DEFAULT_VISION_ORG_WINDOW_HOURS = 24;
/** A reservation not settled within this long (a crashed worker) counts in full. */
export const VISION_RESERVATION_TTL_MS = 15 * 60_000;

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
  run: { pipeline?: { maxCostCents?: number | null } },
  env: Record<string, string | undefined> = process.env,
): VisionGuardConfig {
  const budget = envNumber(env, "VISION_RUN_PROVIDER_BUDGET_CENTS", DEFAULT_VISION_RUN_PROVIDER_BUDGET_CENTS, (v) => v > 0);
  const cap = run.pipeline?.maxCostCents;
  return {
    budgetCents: typeof cap === "number" && cap > 0 ? Math.min(budget, cap) : budget,
    breakerMinRejectedPages: Math.trunc(envNumber(env, "VISION_REJECTION_BREAKER_MIN_PAGES",
      DEFAULT_VISION_REJECTION_BREAKER_MIN_PAGES, (v) => v >= 1)),
    breakerRejectedRate: envNumber(env, "VISION_REJECTION_BREAKER_RATE", DEFAULT_VISION_REJECTION_BREAKER_RATE,
      (v) => v > 0 && v <= 1),
    orgUnbilledLimitCents: envNumber(env, "VISION_ORG_UNBILLED_LIMIT_CENTS", DEFAULT_VISION_ORG_UNBILLED_LIMIT_CENTS,
      (v) => v > 0),
    orgWindowHours: Math.trunc(envNumber(env, "VISION_ORG_UNBILLED_WINDOW_HOURS", DEFAULT_VISION_ORG_WINDOW_HOURS,
      (v) => v >= 1 && v <= 168)),
  };
}

/** The admission rule both backends apply to the snapshot they read under their locks. */
export function decideVisionAdmission(
  snapshot: VisionSpendSnapshot,
  reserveCents: number,
  config: VisionGuardConfig,
  orgScoped: boolean,
): VisionGuardStop | null {
  const reservedCents = snapshot.runReservedCents + reserveCents;
  let reason: VisionGuardStopReason | null = null;
  if (snapshot.rejectedPages >= config.breakerMinRejectedPages &&
    snapshot.rejectedPages / Math.max(1, snapshot.attemptedPages) >= config.breakerRejectedRate) {
    reason = "rejection-breaker";
  } else if (snapshot.runCostCents + reservedCents > config.budgetCents) {
    reason = "provider-budget";
  } else if (orgScoped && snapshot.orgUnbilledCents + snapshot.orgReservedCents + reserveCents > config.orgUnbilledLimitCents) {
    reason = "org-unbilled-limit";
  }
  if (!reason) return null;
  return {
    reason,
    providerCostCents: round(snapshot.runCostCents),
    reservedCents: round(reservedCents),
    budgetCents: config.budgetCents,
    attemptedPages: snapshot.attemptedPages,
    rejectedPages: snapshot.rejectedPages,
    orgUnbilledCents: round(snapshot.orgUnbilledCents),
    orgLimitCents: config.orgUnbilledLimitCents,
  };
}

export function sanitizeCents(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Process-local ledger for runs without a store (tests, local CLI runs). Same rule as the
 * Postgres backend; it only sees this process.
 */
export class MemoryVisionSpendBackend implements VisionSpendBackend {
  private readonly runs = new Map<string, { costCents: number; pages: Map<string, boolean> }>();
  private readonly orgs = new Map<string, Array<{ at: number; cents: number }>>();
  private readonly reservations = new Map<string, { runId: string; orgId: string | null; cents: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async admit(request: VisionAdmitRequest): Promise<VisionBackendAdmission> {
    const reserve = sanitizeCents(request.reserveCents);
    const run = this.runs.get(request.runId) ?? { costCents: 0, pages: new Map() };
    const live = [...this.reservations.values()];
    const since = this.now() - request.config.orgWindowHours * 3_600_000;
    const snapshot: VisionSpendSnapshot = {
      runCostCents: run.costCents,
      runReservedCents: live.filter((r) => r.runId === request.runId).reduce((sum, r) => sum + r.cents, 0),
      attemptedPages: run.pages.size,
      rejectedPages: [...run.pages.values()].filter(Boolean).length,
      orgUnbilledCents: request.orgId
        ? (this.orgs.get(request.orgId) ?? []).filter((e) => e.at > since).reduce((sum, e) => sum + e.cents, 0)
        : 0,
      orgReservedCents: request.orgId
        ? live.filter((r) => r.orgId === request.orgId).reduce((sum, r) => sum + r.cents, 0)
        : 0,
    };
    const stop = decideVisionAdmission(snapshot, reserve, request.config, request.orgId !== null);
    if (stop) return { admitted: false, stop };
    const reservationId = randomUUID();
    this.reservations.set(reservationId, { runId: request.runId, orgId: request.orgId, cents: reserve });
    return { admitted: true, reservationId };
  }

  /** Settled spend, pages and live reservations of one run (tests and diagnostics). */
  inspect(runId: string): { costCents: number; attemptedPages: number; rejectedPages: number; liveReservations: number } {
    const run = this.runs.get(runId);
    return {
      costCents: run?.costCents ?? 0,
      attemptedPages: run?.pages.size ?? 0,
      rejectedPages: run ? [...run.pages.values()].filter(Boolean).length : 0,
      liveReservations: [...this.reservations.values()].filter((r) => r.runId === runId).length,
    };
  }

  async settle(reservationId: string, settlement: VisionSettlement): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return;
    this.reservations.delete(reservationId);
    const cost = sanitizeCents(settlement.costCents);
    const run = this.runs.get(reservation.runId) ?? { costCents: 0, pages: new Map() };
    run.costCents += cost;
    if (settlement.page) {
      const key = `${settlement.page.documentId}:${settlement.page.pageNumber}`;
      run.pages.set(key, run.pages.get(key) === true || settlement.page.rejected);
    }
    this.runs.set(reservation.runId, run);
    if (!settlement.billable && cost > 0 && reservation.orgId) {
      const entries = this.orgs.get(reservation.orgId) ?? [];
      entries.push({ at: this.now(), cents: cost });
      this.orgs.set(reservation.orgId, entries);
    }
  }
}

/** Shared by every store-less state in this process, so page tasks of one run see each other. */
const processBackend = new MemoryVisionSpendBackend();

export interface VisionGuardHost {
  run: { id: string; orgId?: string | null; pipeline?: { maxCostCents?: number | null } };
  /** Set by loadRunState from the store; absent in tests and store-less runs. */
  visionSpend?: VisionSpendBackend;
}

export class VisionRunGuard {
  private stopped: VisionGuardStop | null = null;

  constructor(
    private readonly run: { id: string; orgId: string | null },
    private readonly config: VisionGuardConfig,
    private readonly backend: VisionSpendBackend,
  ) {}

  get stop(): VisionGuardStop | null {
    return this.stopped;
  }

  /**
   * Admit one vision call reserving `reserveCents`, or refuse with why. An admitted call must
   * settle exactly once (later calls are ignored); settling never throws.
   */
  async admit(reserveCents: number): Promise<VisionAdmission> {
    if (this.stopped) return { admitted: false, stop: this.stopped };
    const admission = await this.backend.admit({
      runId: this.run.id, orgId: this.run.orgId, reserveCents: sanitizeCents(reserveCents), config: this.config,
    });
    if (!admission.admitted) {
      this.stopped = admission.stop;
      console.warn(
        `[vision-guard] org=${this.run.orgId ?? "none"} run=${this.run.id} stopped=${admission.stop.reason} ` +
          `providerCents=${admission.stop.providerCostCents} reservedCents=${admission.stop.reservedCents} ` +
          `budgetCents=${admission.stop.budgetCents} orgUnbilledCents=${admission.stop.orgUnbilledCents} ` +
          `orgLimitCents=${admission.stop.orgLimitCents} rejected=${admission.stop.rejectedPages} attempted=${admission.stop.attemptedPages}`,
      );
      return admission;
    }
    let settled = false;
    return {
      admitted: true,
      settle: async (settlement) => {
        if (settled) return;
        settled = true;
        try {
          await this.backend.settle(admission.reservationId, settlement);
        } catch (error) {
          // The reservation stays and counts in full until it expires: stricter, never looser.
          console.warn(`[vision-guard] run=${this.run.id} settle failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    };
  }
}

const guards = new WeakMap<object, VisionRunGuard>();

/** The vision guard of one activity's state (one per state, so a refusal is sticky for it). */
export function visionGuardFor(host: VisionGuardHost): VisionRunGuard {
  let guard = guards.get(host);
  if (!guard) {
    guard = new VisionRunGuard({ id: host.run.id, orgId: host.run.orgId ?? null }, resolveVisionGuardConfig(host.run),
      host.visionSpend ?? processBackend);
    guards.set(host, guard);
  }
  return guard;
}

/** Tokens a page image can take: about one per 700 pixels, at least a typical page's 2,200. */
const IMAGE_TOKENS_PER_PIXEL = 1 / 700;
const MIN_IMAGE_TOKENS = 2_200;
/** Rasters are bounded to 16 MP (lib/raster-bounds.ts): the bound when the size is unknown. */
const MAX_RASTER_PIXELS = 16_000_000;
const PROMPT_OVERHEAD_TOKENS = 200;

/** Upper bound on one vision call's input tokens: the prompt plus the image at its size. */
export function visionInputTokenBound(image: { widthPx: number | null; heightPx: number | null } | null, prompt = ""): number {
  const pixels = image?.widthPx && image.heightPx ? Math.min(image.widthPx * image.heightPx, MAX_RASTER_PIXELS) : MAX_RASTER_PIXELS;
  return Math.max(MIN_IMAGE_TOKENS, Math.ceil(pixels * IMAGE_TOKENS_PER_PIXEL)) +
    Math.ceil(prompt.length / 3) + PROMPT_OVERHEAD_TOKENS;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Test hook: forget which malformed env values already warned. */
export function resetVisionGuardWarningsForTest(): void {
  warned.clear();
}

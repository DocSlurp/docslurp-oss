import { randomUUID } from "node:crypto";

import { configuredVisionModel, worstCaseVisionRequestCents } from "./vision-pricing.js";

/**
 * Vision attempt guard. Customers are charged only for pages vision reads (one Rich page charge per
 * page per run), but every request we send to a vision provider can cost us money: a rejected or
 * failed request, an inline retry, the alternate-route retry, the streaming-to-JSON fallback, a
 * self-critique pass and a second read of a page already charged create no new charge. Provider cost
 * data cannot bound that (interrupted streams, inline retries and failures before the first chunk
 * report estimated or no usage), so the guard counts requests instead and never reads a cost.
 *
 * Every HTTP request that can reach a vision provider is admitted first, at the lowest common request
 * point (`fetchWithProviderRetry` and the local runtime call, through the `VisionRequestGate` that
 * `executeVisionRuntime` requires). Admission refuses when:
 *
 * - **Page bound**: the run already admitted `VISION_PAGE_ATTEMPTS` (default 2) requests for this
 *   page and purpose (whole-page read, document-map OCR, self-critique), or
 *   `VISION_REGION_ATTEMPTS_PER_PAGE` (default 12) routed region requests for this page. Refuses
 *   that page only.
 * - **Rejection breaker**: at least `VISION_BREAKER_MIN_FAILURES` (default 20) of the run's requests
 *   failed or were rejected, and they are at least `VISION_BREAKER_FAILURE_RATE` (default 0.25) of the
 *   run's admitted requests. Sticky for the run.
 * - **Org bound**: the org has `VISION_ORG_UNCHARGED_ATTEMPT_LIMIT` uncharged requests in the last
 *   24 hours. A request counts as uncharged from the moment it is admitted (pessimistic) and is
 *   un-counted only when it is confirmed to have created a new customer Rich page charge. The count is
 *   kept per org with no foreign key to runs or workspaces, so deleting either cannot reset it, and it
 *   holds across runs, reprocessing and extraction. Sticky only when settled uncharged requests alone
 *   reach the limit; requests still in flight never make a refusal sticky.
 *
 * Default org limit: `floor(VISION_ORG_EXPOSURE_TARGET_CENTS / worst-case request price)`, clamped to
 * [`MIN_ORG_ATTEMPT_LIMIT`, `MAX_ORG_ATTEMPT_LIMIT`], where the worst-case request is the configured
 * vision model (`DOCSLURP_VISION_MODEL_URI`, else the built-in default) at list price with a 16 MP
 * image and its full output cap (`worstCaseVisionRequestCents`). The worst daily uncharged provider
 * spend per org is then limit x that price, about the $40 target.
 */
export type VisionAttemptPurpose = "page" | "region" | "map-ocr" | "critique";

export interface VisionAttemptTarget {
  documentId: string;
  pageNumber: number;
  purpose: VisionAttemptPurpose;
}

export interface VisionGuardConfig {
  /** Requests per page per purpose (whole page, map OCR, critique). */
  pageAttempts: number;
  /** Routed region requests per page. */
  regionAttempts: number;
  breakerMinFailures: number;
  breakerFailureRate: number;
  /** Uncharged requests per org per rolling 24 hours. */
  orgAttemptLimit: number;
}

export type VisionGuardStopReason = "page-attempt-limit" | "rejection-breaker" | "org-attempt-limit" | "unscoped-run";

export interface VisionGuardStop {
  reason: VisionGuardStopReason;
  /** The refusal holds for every later request of this guard (a count limit was reached). */
  sticky: boolean;
  pageAttempts: number;
  pageLimit: number;
  runAttempts: number;
  runFailures: number;
  /** The org's uncharged requests in the window, in flight included. */
  orgAttempts: number;
  /** ...of which settled (finished without a new customer charge). */
  orgSettledAttempts: number;
  orgLimit: number;
}

/** Counts the backend read under its locks for one admission. */
export interface VisionAttemptSnapshot {
  scoped: boolean;
  pageAttempts: number;
  runAttempts: number;
  runFailures: number;
  orgAttempts: number;
  orgSettledAttempts: number;
}

export interface VisionAdmitRequest {
  runId: string;
  /** Org of the run as the caller knows it; the Postgres backend reads it from the run row instead. */
  orgId: string | null;
  target: VisionAttemptTarget;
  config: VisionGuardConfig;
}

export type VisionBackendAdmission =
  | { admitted: true; ticketId: string }
  | { admitted: false; stop: VisionGuardStop };

export interface VisionSettleRequest {
  runId: string;
  target: VisionAttemptTarget;
  /** Every request the call admitted. */
  tickets: string[];
  /** Requests that failed or whose output was rejected (rejection breaker). */
  failed: string[];
  /** The request whose output created a new customer charge for the page, if any. */
  charged: string | null;
}

/** Shared attempt ledger: Postgres in workers (db/vision-attempt-store.ts), memory otherwise. */
export interface VisionAttemptBackend {
  admit(request: VisionAdmitRequest): Promise<VisionBackendAdmission>;
  settle(request: VisionSettleRequest): Promise<void>;
}

/** One request admission per HTTP request a vision call sends (`executeVisionRuntime` requires one). */
export interface VisionRequestGate {
  /** Admit the next request; throws `VisionGuardStopError` when refused, before anything is sent. */
  admit(): Promise<void>;
  /** The latest admitted request failed or its output was rejected. */
  failed(): void;
}

export const DEFAULT_VISION_PAGE_ATTEMPTS = 2;
export const DEFAULT_VISION_REGION_ATTEMPTS_PER_PAGE = 12;
export const DEFAULT_VISION_BREAKER_MIN_FAILURES = 20;
export const DEFAULT_VISION_BREAKER_FAILURE_RATE = 0.25;
export const VISION_ORG_WINDOW_HOURS = 24;
/** Target worst-case uncharged provider spend per org per day the default org limit is sized for. */
export const VISION_ORG_EXPOSURE_TARGET_CENTS = 4_000;
export const MIN_ORG_ATTEMPT_LIMIT = 100;
export const MAX_ORG_ATTEMPT_LIMIT = 20_000;
/** Org limit when the configured vision model has no list price (local or private runtimes). */
export const UNPRICED_ORG_ATTEMPT_LIMIT = 2_000;

const RANGES = {
  VISION_PAGE_ATTEMPTS: [1, 4],
  VISION_REGION_ATTEMPTS_PER_PAGE: [0, 64],
  VISION_BREAKER_MIN_FAILURES: [1, 10_000],
  VISION_BREAKER_FAILURE_RATE: [0.01, 1],
  VISION_ORG_UNCHARGED_ATTEMPT_LIMIT: [1, 100_000],
} as const;

const warned = new Set<string>();

function envNumber(env: Record<string, string | undefined>, name: keyof typeof RANGES, fallback: number, integer = true): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  const [min, max] = RANGES[name];
  const warn = (message: string) => {
    if (warned.has(`${name}=${raw}`)) return;
    warned.add(`${name}=${raw}`);
    console.warn(`[vision-guard] ${name}=${JSON.stringify(raw.slice(0, 60))} ${message}`);
  };
  // Never off by typo: a malformed value keeps the default, an out-of-range one is clamped.
  if (!Number.isFinite(parsed)) {
    warn(`is invalid; using ${fallback}`);
    return fallback;
  }
  const value = integer ? Math.trunc(parsed) : parsed;
  const clamped = Math.min(max, Math.max(min, value));
  if (clamped !== value) warn(`is outside [${min}, ${max}]; using ${clamped}`);
  return clamped;
}

/** Default org limit for the configured vision model (see the module comment for the formula). */
export function defaultOrgAttemptLimit(env: Record<string, string | undefined> = process.env): number {
  const worst = worstCaseVisionRequestCents(configuredVisionModel(env));
  if (!worst || !(worst > 0)) return UNPRICED_ORG_ATTEMPT_LIMIT;
  return Math.min(MAX_ORG_ATTEMPT_LIMIT, Math.max(MIN_ORG_ATTEMPT_LIMIT, Math.floor(VISION_ORG_EXPOSURE_TARGET_CENTS / worst)));
}

export function resolveVisionGuardConfig(env: Record<string, string | undefined> = process.env): VisionGuardConfig {
  return {
    pageAttempts: envNumber(env, "VISION_PAGE_ATTEMPTS", DEFAULT_VISION_PAGE_ATTEMPTS),
    regionAttempts: envNumber(env, "VISION_REGION_ATTEMPTS_PER_PAGE", DEFAULT_VISION_REGION_ATTEMPTS_PER_PAGE),
    breakerMinFailures: envNumber(env, "VISION_BREAKER_MIN_FAILURES", DEFAULT_VISION_BREAKER_MIN_FAILURES),
    breakerFailureRate: envNumber(env, "VISION_BREAKER_FAILURE_RATE", DEFAULT_VISION_BREAKER_FAILURE_RATE, false),
    orgAttemptLimit: envNumber(env, "VISION_ORG_UNCHARGED_ATTEMPT_LIMIT", defaultOrgAttemptLimit(env)),
  };
}

export function pageAttemptLimit(config: VisionGuardConfig, purpose: VisionAttemptPurpose): number {
  return purpose === "region" ? config.regionAttempts : config.pageAttempts;
}

/** The admission rule both backends apply to the counts they read under their locks. */
export function decideVisionAdmission(
  snapshot: VisionAttemptSnapshot,
  target: VisionAttemptTarget,
  config: VisionGuardConfig,
): VisionGuardStop | null {
  const pageLimit = pageAttemptLimit(config, target.purpose);
  const stop = (reason: VisionGuardStopReason, sticky: boolean): VisionGuardStop => ({
    reason, sticky,
    pageAttempts: snapshot.pageAttempts, pageLimit,
    runAttempts: snapshot.runAttempts, runFailures: snapshot.runFailures,
    orgAttempts: snapshot.orgAttempts, orgSettledAttempts: snapshot.orgSettledAttempts, orgLimit: config.orgAttemptLimit,
  });
  // A run with no org (and no workspace org) cannot be bounded per org: refuse, never skip the bound.
  if (!snapshot.scoped) return stop("unscoped-run", true);
  if (snapshot.runFailures >= config.breakerMinFailures &&
    snapshot.runFailures / Math.max(1, snapshot.runAttempts) >= config.breakerFailureRate) {
    return stop("rejection-breaker", true);
  }
  // This page only: other pages of the run keep their own budget.
  if (snapshot.pageAttempts >= pageLimit) return stop("page-attempt-limit", false);
  if (snapshot.orgAttempts >= config.orgAttemptLimit) {
    // Sticky only when finished uncharged requests alone fill the limit; in-flight ones may still be charged.
    return stop("org-attempt-limit", snapshot.orgSettledAttempts >= config.orgAttemptLimit);
  }
  return null;
}

/**
 * Process-local ledger for runs without a store (tests, local CLI runs). Same rule as the Postgres
 * backend; it only sees this process.
 */
export class MemoryVisionAttemptBackend implements VisionAttemptBackend {
  private readonly pages = new Map<string, { attempts: number; failures: number }>();
  private readonly charged = new Set<string>();
  private readonly orgs = new Map<string, Map<string, { at: number; settled: boolean }>>();
  private readonly tickets = new Map<string, string | null>();

  constructor(private readonly now: () => number = Date.now) {}

  async admit(request: VisionAdmitRequest): Promise<VisionBackendAdmission> {
    const runPages = [...this.pages.entries()].filter(([key]) => key.startsWith(`${request.runId}\u0000`)).map(([, row]) => row);
    const page = this.pages.get(pageKey(request.runId, request.target));
    const since = this.now() - VISION_ORG_WINDOW_HOURS * 3_600_000;
    const org = request.orgId ? this.orgRows(request.orgId, since) : [];
    const stop = decideVisionAdmission({
      scoped: request.orgId !== null,
      pageAttempts: page?.attempts ?? 0,
      runAttempts: runPages.reduce((sum, row) => sum + row.attempts, 0),
      runFailures: runPages.reduce((sum, row) => sum + row.failures, 0),
      orgAttempts: org.length,
      orgSettledAttempts: org.filter((row) => row.settled).length,
    }, request.target, request.config);
    if (stop) return { admitted: false, stop };
    const ticketId = randomUUID();
    const key = pageKey(request.runId, request.target);
    const row = this.pages.get(key) ?? { attempts: 0, failures: 0 };
    row.attempts += 1;
    this.pages.set(key, row);
    const rows = this.orgs.get(request.orgId!) ?? new Map();
    rows.set(ticketId, { at: this.now(), settled: false });
    this.orgs.set(request.orgId!, rows);
    this.tickets.set(ticketId, request.orgId);
    return { admitted: true, ticketId };
  }

  async settle(request: VisionSettleRequest): Promise<void> {
    const row = this.pages.get(pageKey(request.runId, request.target));
    if (row) row.failures += request.failed.length;
    const chargeKey = `${request.runId}\u0000${request.target.documentId}\u0000${request.target.pageNumber}`;
    for (const ticket of request.tickets) {
      const orgRows = this.orgs.get(this.tickets.get(ticket) ?? "");
      if (!orgRows?.has(ticket)) continue;
      if (ticket === request.charged && !this.charged.has(chargeKey)) {
        this.charged.add(chargeKey);
        orgRows.delete(ticket);
      } else {
        orgRows.get(ticket)!.settled = true;
      }
    }
  }

  /** Counts of one run and org (tests and diagnostics). */
  inspect(runId: string, orgId: string): { runAttempts: number; runFailures: number; orgAttempts: number; orgSettledAttempts: number } {
    const runPages = [...this.pages.entries()].filter(([key]) => key.startsWith(`${runId}\u0000`)).map(([, row]) => row);
    const org = this.orgRows(orgId, this.now() - VISION_ORG_WINDOW_HOURS * 3_600_000);
    return {
      runAttempts: runPages.reduce((sum, row) => sum + row.attempts, 0),
      runFailures: runPages.reduce((sum, row) => sum + row.failures, 0),
      orgAttempts: org.length,
      orgSettledAttempts: org.filter((row) => row.settled).length,
    };
  }

  private orgRows(orgId: string, since: number): Array<{ at: number; settled: boolean }> {
    return [...(this.orgs.get(orgId)?.values() ?? [])].filter((row) => row.at > since);
  }
}

function pageKey(runId: string, target: VisionAttemptTarget): string {
  return `${runId}\u0000${target.documentId}\u0000${target.pageNumber}\u0000${target.purpose}`;
}

/** Shared by every store-less state in this process, so page tasks of one run see each other. */
const processBackend = new MemoryVisionAttemptBackend();

/** Thrown when the run's vision guard refuses a request; that request was never sent. */
export class VisionGuardStopError extends Error {
  constructor(readonly stop: VisionGuardStop) {
    super(`vision request refused: ${stop.reason} (page ${stop.pageAttempts}/${stop.pageLimit}, run ` +
      `${stop.runFailures}/${stop.runAttempts} failed, org ${stop.orgAttempts}/${stop.orgLimit} uncharged)`);
    this.name = "VisionGuardStopError";
  }
}

/** The guard refusal behind `error` (it may be wrapped as a `cause`), or null. */
export function findVisionGuardStop(error: unknown): VisionGuardStop | null {
  for (let cur: unknown = error, depth = 0; cur && depth < 8; depth += 1) {
    if (cur instanceof VisionGuardStopError) return cur.stop;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

export interface VisionGuardHost {
  run: { id: string; orgId?: string | null };
  /** Set by loadRunState from the store; absent in tests and store-less runs. */
  visionAttempts?: VisionAttemptBackend;
}

export class VisionRunGuard {
  private stopped: VisionGuardStop | null = null;

  constructor(
    private readonly run: { id: string; orgId: string | null },
    private readonly config: VisionGuardConfig,
    private readonly backend: VisionAttemptBackend,
  ) {}

  /** The sticky refusal, once a count limit was reached. */
  get stop(): VisionGuardStop | null {
    return this.stopped;
  }

  /** A gate for one vision call on `target`; `finish` it exactly once, in a `finally`. */
  call(target: VisionAttemptTarget): VisionCallGate {
    return new VisionCallGate(this, target);
  }

  /** @internal Admit one request; throws `VisionGuardStopError` when refused. */
  async admitRequest(target: VisionAttemptTarget): Promise<string> {
    if (this.stopped) throw new VisionGuardStopError(this.stopped);
    const admission = await this.backend.admit({ runId: this.run.id, orgId: this.run.orgId, target, config: this.config });
    if (admission.admitted) return admission.ticketId;
    if (admission.stop.sticky) this.stopped = admission.stop;
    const { stop } = admission;
    console.warn(
      `[vision-guard] org=${this.run.orgId ?? "none"} run=${this.run.id} refused=${stop.reason} sticky=${stop.sticky} ` +
        `document=${target.documentId} page=${target.pageNumber} purpose=${target.purpose} pageAttempts=${stop.pageAttempts}/${stop.pageLimit} ` +
        `runFailures=${stop.runFailures}/${stop.runAttempts} orgAttempts=${stop.orgAttempts}/${stop.orgLimit} orgSettled=${stop.orgSettledAttempts}`,
    );
    throw new VisionGuardStopError(stop);
  }

  /** @internal */
  async settle(target: VisionAttemptTarget, tickets: Array<{ id: string; failed: boolean }>, charged: string | null): Promise<void> {
    if (tickets.length === 0) return;
    try {
      await this.backend.settle({
        runId: this.run.id, target, tickets: tickets.map((ticket) => ticket.id),
        failed: tickets.filter((ticket) => ticket.failed).map((ticket) => ticket.id), charged,
      });
    } catch (error) {
      // Unsettled requests stay counted as uncharged: stricter, never looser.
      console.warn(`[vision-guard] run=${this.run.id} settle failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** The requests of one vision call (one page, region, map OCR page or critique page). */
export class VisionCallGate implements VisionRequestGate {
  private readonly tickets: Array<{ id: string; failed: boolean }> = [];
  private chargedTicket: string | null = null;
  private finished = false;

  constructor(private readonly guard: VisionRunGuard, readonly target: VisionAttemptTarget) {}

  async admit(): Promise<void> {
    if (this.finished) throw new Error("vision call gate already finished");
    this.tickets.push({ id: await this.guard.admitRequest(this.target), failed: false });
  }

  failed(): void {
    const last = this.tickets.at(-1);
    if (last) last.failed = true;
  }

  /** Requests admitted so far. */
  get requests(): number {
    return this.tickets.length;
  }

  /**
   * The call's accepted output created a new customer Rich page charge: its last successful request is
   * un-counted from the org bound (once per run and page, checked again by the backend).
   */
  charged(): void {
    this.chargedTicket = [...this.tickets].reverse().find((ticket) => !ticket.failed)?.id ?? null;
  }

  /** Settle every admitted request; never throws. Later calls are ignored. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.guard.settle(this.target, this.tickets, this.chargedTicket);
  }
}

const guards = new WeakMap<object, VisionRunGuard>();

/** The vision guard of one activity's state (one per state, so a sticky refusal holds for it). */
export function visionGuardFor(host: VisionGuardHost): VisionRunGuard {
  let guard = guards.get(host);
  if (!guard) {
    guard = new VisionRunGuard({ id: host.run.id, orgId: host.run.orgId ?? null }, resolveVisionGuardConfig(),
      host.visionAttempts ?? processBackend);
    guards.set(host, guard);
  }
  return guard;
}

/** Run `fn` with a gate for one vision call on `target`, settling its requests afterwards. */
export async function withVisionCall<T>(
  host: VisionGuardHost,
  target: VisionAttemptTarget,
  fn: (gate: VisionCallGate) => Promise<T>,
): Promise<T> {
  const gate = visionGuardFor(host).call(target);
  try {
    return await fn(gate);
  } finally {
    await gate.finish();
  }
}

/** A usage ledger that charges Rich pages (pipeline/usage-ledger.ts). */
export interface RichChargingLedger<I, E> {
  record(input: I): E;
  hasRichCharge(documentId: string, pageNumber: number): boolean;
}

/**
 * Record a successful page read and tell the gate whether it created a new customer Rich page charge
 * (so its request leaves the org's uncharged count). Critique, second reads of a page this ledger
 * already charged and metrics that charge nothing stay uncharged.
 */
export function recordVisionRead<I, E>(
  ledger: RichChargingLedger<I, E>,
  gate: VisionCallGate,
  page: { documentId: string; pageNumber: number },
  input: I,
): E {
  const before = ledger.hasRichCharge(page.documentId, page.pageNumber);
  const event = ledger.record(input);
  if (!before && ledger.hasRichCharge(page.documentId, page.pageNumber)) gate.charged();
  return event;
}

/** Test hook: forget which malformed env values already warned. */
export function resetVisionGuardWarningsForTest(): void {
  warned.clear();
}

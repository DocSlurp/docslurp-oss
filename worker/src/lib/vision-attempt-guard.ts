import { randomUUID } from "node:crypto";

import { configuredVisionModel, maxCatalogWorstCaseVisionRequestCents, worstCaseVisionRequestCents } from "./vision-pricing.js";

/**
 * Vision attempt guard. Customers are charged only for pages vision reads (one Rich page charge per
 * page per run), but every request we send to a vision provider can cost us money: a rejected or
 * failed request, an inline retry, the alternate-route retry, the streaming-to-JSON fallback, a
 * self-critique pass and a second read of a page already charged create no new charge. Provider cost
 * data cannot bound that (interrupted streams, inline retries and failures before the first chunk
 * report estimated or no usage), so the guard counts requests, each weighted by the worst case its
 * route can cost (list price, 16 MP image, enforced output cap), and never reads a reported cost.
 *
 * Every vision call made through `executeVisionRuntime` (vision-extract pages and routed regions,
 * document-map OCR, deferred materialization, self-critique) admits each HTTP request it sends, at
 * the lowest common request point: `fetchWithProviderRetry`, inside its concurrency limiter right
 * before `fetch`, and the local runtime call. Not covered: the decision-model verifier, page-image
 * embeddings and media frame description. Admission refuses when:
 *
 * - **Page bound**: the run already admitted `VISION_PAGE_ATTEMPTS` (default 2) requests for this
 *   page and purpose (whole-page read, document-map OCR, self-critique), or
 *   `VISION_REGION_ATTEMPTS_PER_PAGE` (default 12) routed region requests for this page. Refuses
 *   that page only.
 * - **Rejection breaker**: at least `VISION_BREAKER_MIN_FAILURES` (default 20) of the run's requests
 *   failed or were rejected, and they are at least `VISION_BREAKER_FAILURE_RATE` (default 0.25) of the
 *   run's admitted requests. Sticky for the run.
 * - **Org bound**: the org's uncharged requests in the last 24 hours, by weight, plus this one would
 *   pass `VISION_ORG_UNCHARGED_LIMIT_CENTS` (default $40). A request counts as uncharged from the
 *   moment it is admitted (pessimistic) and leaves the count only in the checkpoint transaction that
 *   persists the customer Rich page charge it created (`rich:<run>:<document>:<page>`, first insert
 *   wins; db/usage-event-store.ts). The count is kept per org with no foreign key to runs or
 *   workspaces, so deleting either cannot reset it. Sticky only when settled uncharged requests alone
 *   leave no room; requests still in flight or awaiting their checkpoint never make a refusal sticky.
 *
 * Requests a provider refuses before accepting them (429, 503/529 overload, and on a streaming
 * request a 400/404/405/415/422/501 that only says streaming is unsupported) are handed back: they
 * leave the page bound, the breaker and the org count. Throttles are bounded per call by
 * `VISION_THROTTLE_ALLOWANCE` (default 5); past it the wait goes to Temporal with its Retry-After.
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
  /** Worst-case cents of uncharged requests per org per rolling 24 hours. */
  orgLimitCents: number;
  /** Unbilled throttles (429, 503/529) one call may hand back before the wait goes to Temporal. */
  throttleAllowance: number;
}

export type VisionGuardStopReason =
  | "page-attempt-limit"
  | "rejection-breaker"
  | "org-attempt-limit"
  | "unscoped-run"
  /** A store-backed run without the shared Postgres ledger: refused, never counted per process. */
  | "no-attempt-ledger";

export interface VisionGuardStop {
  reason: VisionGuardStopReason;
  /** The refusal holds for every later request of this guard (a count limit was reached). */
  sticky: boolean;
  pageAttempts: number;
  pageLimit: number;
  runAttempts: number;
  runFailures: number;
  /** Worst-case cents of the org's uncharged requests in the window, in flight included. */
  orgCents: number;
  /** ...of which settled (finished without a new customer charge). */
  orgSettledCents: number;
  orgLimitCents: number;
  /** Worst-case cents of the refused request. */
  requestCents: number;
}

/** Counts the backend read under its locks for one admission. */
export interface VisionAttemptSnapshot {
  scoped: boolean;
  pageAttempts: number;
  runAttempts: number;
  runFailures: number;
  orgCents: number;
  orgSettledCents: number;
}

export interface VisionAdmitRequest {
  runId: string;
  /** Org of the run as the caller knows it; the Postgres backend reads it from the run row instead. */
  orgId: string | null;
  target: VisionAttemptTarget;
  config: VisionGuardConfig;
  /** Worst-case cents of this request on its route (vision-pricing.ts `visionRequestWeightCents`). */
  weightCents: number;
}

export type VisionBackendAdmission =
  | { admitted: true; ticketId: string }
  | { admitted: false; stop: VisionGuardStop };

export interface VisionSettleRequest {
  runId: string;
  target: VisionAttemptTarget;
  /** Every request the call admitted and did not hand back. */
  tickets: string[];
  /** Requests that failed or whose output was rejected (rejection breaker). */
  failed: string[];
  /**
   * The request whose output buffered the page's Rich charge. It stays counted (in flight) until the
   * checkpoint that persists that charge removes it (db/usage-event-store.ts); the memory backend,
   * which has no checkpoint, removes it here on the page's first charge in the run.
   */
  charged: string | null;
}

export interface VisionReleaseRequest {
  runId: string;
  target: VisionAttemptTarget;
  ticketId: string;
}

/** Shared attempt ledger: Postgres in workers (db/vision-attempt-store.ts), memory in store-less runs. */
export interface VisionAttemptBackend {
  admit(request: VisionAdmitRequest): Promise<VisionBackendAdmission>;
  /** Hand back a request the provider refused before accepting it: it leaves every count. */
  release(request: VisionReleaseRequest): Promise<void>;
  settle(request: VisionSettleRequest): Promise<void>;
}

/** Why a request leaves the counts: refused before acceptance, or cancelled before it was sent. */
export type VisionUnbilledKind = "throttle" | "unsupported" | "cancelled";

/** One request admission per HTTP request a vision call sends (`executeVisionRuntime` requires one). */
export interface VisionRequestGate {
  /**
   * Admit the next request; throws `VisionGuardStopError` when refused, before anything is sent.
   * `weightCents` is the request's worst case on its route; unset weighs the costliest catalog model.
   */
  admit(request?: { weightCents?: number }): Promise<void>;
  /** The latest admitted request failed or its output was rejected (it may have been billed). */
  failed(): void;
  /**
   * The provider refused the latest admitted request before accepting it: a throttle (429, 503/529)
   * or, on a streaming request, a capability error. It leaves the page bound, breaker and org count.
   * `cancelled` hands back a request the caller aborted after admission and before sending it.
   * Returns false once the call's throttle allowance is spent (`unsupported` and `cancelled` are not
   * limited).
   */
  unbilled(kind: VisionUnbilledKind): Promise<boolean>;
}

export const DEFAULT_VISION_PAGE_ATTEMPTS = 2;
export const DEFAULT_VISION_REGION_ATTEMPTS_PER_PAGE = 12;
export const DEFAULT_VISION_BREAKER_MIN_FAILURES = 20;
export const DEFAULT_VISION_BREAKER_FAILURE_RATE = 0.25;
export const DEFAULT_VISION_THROTTLE_ALLOWANCE = 5;
export const VISION_ORG_WINDOW_HOURS = 24;
/** Worst-case uncharged provider spend per org per rolling day (`VISION_ORG_UNCHARGED_LIMIT_CENTS`). */
export const DEFAULT_VISION_ORG_LIMIT_CENTS = 4_000;

const RANGES = {
  VISION_PAGE_ATTEMPTS: [1, 4],
  VISION_REGION_ATTEMPTS_PER_PAGE: [0, 64],
  VISION_BREAKER_MIN_FAILURES: [1, 10_000],
  VISION_BREAKER_FAILURE_RATE: [0.01, 1],
  VISION_ORG_UNCHARGED_LIMIT_CENTS: [1, 1_000_000],
  VISION_THROTTLE_ALLOWANCE: [0, 20],
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

/** Weight of a request admitted without one: the costliest worst case we know of, never less. */
export function defaultVisionRequestWeightCents(env: Record<string, string | undefined> = process.env): number {
  return Math.max(maxCatalogWorstCaseVisionRequestCents(), worstCaseVisionRequestCents(configuredVisionModel(env)) ?? 0);
}

export function resolveVisionGuardConfig(env: Record<string, string | undefined> = process.env): VisionGuardConfig {
  return {
    pageAttempts: envNumber(env, "VISION_PAGE_ATTEMPTS", DEFAULT_VISION_PAGE_ATTEMPTS),
    regionAttempts: envNumber(env, "VISION_REGION_ATTEMPTS_PER_PAGE", DEFAULT_VISION_REGION_ATTEMPTS_PER_PAGE),
    breakerMinFailures: envNumber(env, "VISION_BREAKER_MIN_FAILURES", DEFAULT_VISION_BREAKER_MIN_FAILURES),
    breakerFailureRate: envNumber(env, "VISION_BREAKER_FAILURE_RATE", DEFAULT_VISION_BREAKER_FAILURE_RATE, false),
    orgLimitCents: envNumber(env, "VISION_ORG_UNCHARGED_LIMIT_CENTS", DEFAULT_VISION_ORG_LIMIT_CENTS),
    throttleAllowance: envNumber(env, "VISION_THROTTLE_ALLOWANCE", DEFAULT_VISION_THROTTLE_ALLOWANCE),
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
  weightCents: number,
): VisionGuardStop | null {
  const pageLimit = pageAttemptLimit(config, target.purpose);
  const stop = (reason: VisionGuardStopReason, sticky: boolean): VisionGuardStop => ({
    reason, sticky,
    pageAttempts: snapshot.pageAttempts, pageLimit,
    runAttempts: snapshot.runAttempts, runFailures: snapshot.runFailures,
    orgCents: roundCents(snapshot.orgCents), orgSettledCents: roundCents(snapshot.orgSettledCents),
    orgLimitCents: config.orgLimitCents, requestCents: roundCents(weightCents),
  });
  // A run with no org (and no workspace org) cannot be bounded per org: refuse, never skip the bound.
  if (!snapshot.scoped) return stop("unscoped-run", true);
  if (snapshot.runFailures >= config.breakerMinFailures &&
    snapshot.runFailures / Math.max(1, snapshot.runAttempts) >= config.breakerFailureRate) {
    return stop("rejection-breaker", true);
  }
  // This page only: other pages of the run keep their own budget.
  if (snapshot.pageAttempts >= pageLimit) return stop("page-attempt-limit", false);
  if (snapshot.orgCents + weightCents > config.orgLimitCents) {
    // Sticky only when finished uncharged requests alone leave no room; in-flight ones may still be charged.
    return stop("org-attempt-limit", snapshot.orgSettledCents + weightCents > config.orgLimitCents);
  }
  return null;
}

function roundCents(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/**
 * Process-local ledger for store-less runs (tests, local CLI runs). Same rule as the Postgres backend;
 * it only sees this process. With no checkpoint, a page's first charge in the run leaves the count at
 * settlement.
 */
export class MemoryVisionAttemptBackend implements VisionAttemptBackend {
  private readonly pages = new Map<string, { attempts: number; failures: number }>();
  private readonly charged = new Set<string>();
  private readonly orgs = new Map<string, Map<string, { at: number; settled: boolean; weight: number }>>();
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
      orgCents: org.reduce((sum, row) => sum + row.weight, 0),
      orgSettledCents: org.filter((row) => row.settled).reduce((sum, row) => sum + row.weight, 0),
    }, request.target, request.config, request.weightCents);
    if (stop) return { admitted: false, stop };
    const ticketId = randomUUID();
    const key = pageKey(request.runId, request.target);
    const row = this.pages.get(key) ?? { attempts: 0, failures: 0 };
    row.attempts += 1;
    this.pages.set(key, row);
    const rows = this.orgs.get(request.orgId!) ?? new Map();
    rows.set(ticketId, { at: this.now(), settled: false, weight: request.weightCents });
    this.orgs.set(request.orgId!, rows);
    this.tickets.set(ticketId, request.orgId);
    return { admitted: true, ticketId };
  }

  async release(request: VisionReleaseRequest): Promise<void> {
    const orgRows = this.orgs.get(this.tickets.get(request.ticketId) ?? "");
    if (!orgRows?.delete(request.ticketId)) return;
    const row = this.pages.get(pageKey(request.runId, request.target));
    if (row) row.attempts = Math.max(0, row.attempts - 1);
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

  /** Worst-case cents of one org's uncharged requests (tests and diagnostics). */
  orgCents(orgId: string): number {
    return roundCents(this.orgRows(orgId, this.now() - VISION_ORG_WINDOW_HOURS * 3_600_000).reduce((sum, row) => sum + row.weight, 0));
  }

  private orgRows(orgId: string, since: number): Array<{ at: number; settled: boolean; weight: number }> {
    return [...(this.orgs.get(orgId)?.values() ?? [])].filter((row) => row.at > since);
  }
}

/**
 * The backend of a store-backed run whose store has no attempt ledger: refuses every request, loudly.
 * A per-process count would let every worker of the run and every run of the org start from zero.
 */
class MissingVisionAttemptBackend implements VisionAttemptBackend {
  async admit(request: VisionAdmitRequest): Promise<VisionBackendAdmission> {
    console.error(`[vision-guard] run=${request.runId} has no shared vision attempt ledger; refusing every vision request`);
    return { admitted: false, stop: {
      reason: "no-attempt-ledger", sticky: true, pageAttempts: 0, pageLimit: pageAttemptLimit(request.config, request.target.purpose),
      runAttempts: 0, runFailures: 0, orgCents: 0, orgSettledCents: 0, orgLimitCents: request.config.orgLimitCents,
      requestCents: roundCents(request.weightCents),
    } };
  }

  async release(): Promise<void> {}

  async settle(): Promise<void> {}
}

function pageKey(runId: string, target: VisionAttemptTarget): string {
  return `${runId}\u0000${target.documentId}\u0000${target.pageNumber}\u0000${target.purpose}`;
}

/** Shared by every store-less state in this process, so page tasks of one run see each other. */
const processBackend = new MemoryVisionAttemptBackend();
const missingBackend = new MissingVisionAttemptBackend();

/** Thrown when the run's vision guard refuses a request; that request was never sent. */
export class VisionGuardStopError extends Error {
  constructor(readonly stop: VisionGuardStop) {
    super(`vision request refused: ${stop.reason} (page ${stop.pageAttempts}/${stop.pageLimit}, run ` +
      `${stop.runFailures}/${stop.runAttempts} failed, org ${stop.orgCents}+${stop.requestCents}/${stop.orgLimitCents} uncharged cents)`);
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
  /**
   * The shared ledger, set by loadRunState from the store. Absent (undefined) only in store-less runs,
   * which count per process; null marks a store-backed run without one, which refuses every request.
   */
  visionAttempts?: VisionAttemptBackend | null;
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

  /** Unbilled throttles one call may hand back. */
  get throttleAllowance(): number {
    return this.config.throttleAllowance;
  }

  /** @internal Admit one request; throws `VisionGuardStopError` when refused. */
  async admitRequest(target: VisionAttemptTarget, weightCents: number): Promise<string> {
    if (this.stopped) throw new VisionGuardStopError(this.stopped);
    const admission = await this.backend.admit({ runId: this.run.id, orgId: this.run.orgId, target, config: this.config, weightCents });
    if (admission.admitted) return admission.ticketId;
    if (admission.stop.sticky) this.stopped = admission.stop;
    const { stop } = admission;
    console.warn(
      `[vision-guard] org=${this.run.orgId ?? "none"} run=${this.run.id} refused=${stop.reason} sticky=${stop.sticky} ` +
        `document=${target.documentId} page=${target.pageNumber} purpose=${target.purpose} pageAttempts=${stop.pageAttempts}/${stop.pageLimit} ` +
        `runFailures=${stop.runFailures}/${stop.runAttempts} orgCents=${stop.orgCents}+${stop.requestCents}/${stop.orgLimitCents} orgSettledCents=${stop.orgSettledCents}`,
    );
    throw new VisionGuardStopError(stop);
  }

  /** @internal Hand back a request refused before acceptance; a failure leaves it counted (stricter). */
  async releaseRequest(target: VisionAttemptTarget, ticketId: string, kind: VisionUnbilledKind): Promise<void> {
    // Hand-backs rest on "the provider did not bill this" (provider-retry.ts isUnbilledThrottleStatus):
    // logged per org so provider spend without matching counted requests can be traced.
    console.warn(
      `[vision-throttle-handback] org=${this.run.orgId ?? "none"} run=${this.run.id} kind=${kind} ` +
        `document=${target.documentId} page=${target.pageNumber} purpose=${target.purpose}`,
    );
    try {
      await this.backend.release({ runId: this.run.id, target, ticketId });
    } catch (error) {
      console.warn(`[vision-guard] run=${this.run.id} release failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
  private readonly tickets: Array<{ id: string; failed: boolean; released: boolean }> = [];
  private chargedTicket: string | null = null;
  private throttles = 0;
  private finished = false;

  constructor(private readonly guard: VisionRunGuard, readonly target: VisionAttemptTarget) {}

  async admit(request: { weightCents?: number } = {}): Promise<void> {
    if (this.finished) throw new Error("vision call gate already finished");
    const weight = request.weightCents !== undefined && request.weightCents > 0 ? request.weightCents : defaultVisionRequestWeightCents();
    this.tickets.push({ id: await this.guard.admitRequest(this.target, weight), failed: false, released: false });
  }

  failed(): void {
    const last = this.tickets.at(-1);
    if (last && !last.released) last.failed = true;
  }

  async unbilled(kind: VisionUnbilledKind): Promise<boolean> {
    const last = this.tickets.at(-1);
    if (kind === "throttle") this.throttles += 1;
    if (last && !last.released && !last.failed) {
      last.released = true;
      await this.guard.releaseRequest(this.target, last.id, kind);
    }
    return kind !== "throttle" || this.throttles <= this.guard.throttleAllowance;
  }

  /** Requests admitted so far and not handed back. */
  get requests(): number {
    return this.tickets.filter((ticket) => !ticket.released).length;
  }

  /** The latest request that succeeded: the one a page read's Rich charge is attributed to. */
  get readTicket(): string | null {
    return [...this.tickets].reverse().find((ticket) => !ticket.failed && !ticket.released)?.id ?? null;
  }

  /**
   * The call's accepted output buffered a new customer Rich page charge carrying `readTicket`: the
   * checkpoint that persists the charge un-counts that request from the org bound.
   */
  charged(): void {
    this.chargedTicket = this.readTicket;
  }

  /** Settle every admitted request; never throws. Later calls are ignored. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.guard.settle(this.target, this.tickets.filter((ticket) => !ticket.released), this.chargedTicket);
  }
}

const guards = new WeakMap<object, VisionRunGuard>();

/** The vision guard of one activity's state (one per state, so a sticky refusal holds for it). */
export function visionGuardFor(host: VisionGuardHost): VisionRunGuard {
  let guard = guards.get(host);
  if (!guard) {
    guard = new VisionRunGuard({ id: host.run.id, orgId: host.run.orgId ?? null }, resolveVisionGuardConfig(),
      host.visionAttempts === null ? missingBackend : host.visionAttempts ?? processBackend);
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
  record(input: I, options?: { visionAttemptTicket?: string | null }): E;
  hasRichCharge(documentId: string, pageNumber: number): boolean;
}

/**
 * Record a successful page read. When it buffers the run's Rich charge for the page, the charge
 * carries the read's request ticket, and the checkpoint that persists the charge (first insert of
 * `rich:<run>:<document>:<page>` wins) removes that request from the org's uncharged count.
 * Critique, second reads of a page this ledger already charged and metrics that charge nothing stay
 * uncharged.
 */
export function recordVisionRead<I, E>(
  ledger: RichChargingLedger<I, E>,
  gate: VisionCallGate,
  page: { documentId: string; pageNumber: number },
  input: I,
): E {
  const before = ledger.hasRichCharge(page.documentId, page.pageNumber);
  const event = ledger.record(input, { visionAttemptTicket: gate.readTicket });
  if (!before && ledger.hasRichCharge(page.documentId, page.pageNumber)) gate.charged();
  return event;
}

/** Test hook: forget which malformed env values already warned. */
export function resetVisionGuardWarningsForTest(): void {
  warned.clear();
}

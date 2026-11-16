/*
 * Page reader warm start (DOCSLURP_PAGE_READER_WARM_MIN_PAGES; docs/extraction/ocr.md, "Warm start").
 *
 * A reader whose provider implements the optional `warm` capability (extractors/plugins.ts PageImageReaderWarm) is never
 * waited on while it boots:
 *
 * - Each run counts its reader-eligible pages in this worker process (the provider's VMs are leased per process). Below
 *   the threshold the run never starts a reader and every page keeps its other route (hosted vision, or the recogniser
 *   and hosted escalation for OCR).
 * - At the threshold the host reserves the provider's start-up estimate (`estimateJobCostCents(0)`) against the
 *   organization's daily reader budget, then asks the provider to start a reader for the run's scope without waiting.
 *   Pages keep their other route meanwhile; pages already sent there stay there.
 * - Jobs go to the reader only once `warm.status` reports `ready`, marked `requireReady`, so a VM that went away between
 *   the check and the job fails the job at once (its pages take their other route) instead of booting another.
 * - A failed, refused or slow start never delays or fails a page. A run starts at most PAGE_READER_WARM_MAX_LAUNCHES
 *   readers per process, and a second only after the first one read pages.
 * - The start-up reservation stands until the run's first reader job has been sent (that job records the boot as its
 *   provider cost); a reader that never served a job keeps it for the day (fail closed).
 *
 * Unset, the threshold is the provider's own `warm.minPages` (its cost model), else 500; `off` restores the blocking
 * behaviour (jobs wait for the reader).
 */
import type { PageImageReaderProvider, PageReaderWarmStatus } from "../extractors/plugins.js";
import { processPageReaderOrgBudget, type PageReaderOrgBudget } from "./page-reader-budget.js";

export const DEFAULT_PAGE_READER_WARM_MIN_PAGES = 500;
export const PAGE_READER_WARM_MIN_PAGES_LIMIT = 1_000_000;
/** Readers one run may start in one worker process; after the first, only when an earlier one read pages. */
export const PAGE_READER_WARM_MAX_LAUNCHES = 3;
/** Runs tracked per process (least recently used dropped first). */
const MAX_TRACKED_RUNS = 4096;

/**
 * The warm-start threshold in reader pages, or null when warm start does not apply: `off`, or a provider without `warm`.
 * Throws on a value other than `off` or an integer from 1 to 1000000 (the startup checks call it).
 */
export function pageReaderWarmMinPages(provider: Pick<PageImageReaderProvider, "warm"> | null, env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.DOCSLURP_PAGE_READER_WARM_MIN_PAGES?.trim().toLowerCase();
  let configured: number | null = null;
  if (raw && raw !== "off") {
    const parsed = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > PAGE_READER_WARM_MIN_PAGES_LIMIT) {
      throw new Error(`DOCSLURP_PAGE_READER_WARM_MIN_PAGES must be off or an integer from 1 to ${PAGE_READER_WARM_MIN_PAGES_LIMIT}; got ${JSON.stringify(raw)}`);
    }
    configured = parsed;
  }
  if (raw === "off" || !provider?.warm) return null;
  return configured ?? provider.warm.minPages ?? DEFAULT_PAGE_READER_WARM_MIN_PAGES;
}

/** The same, never throwing: a value the startup check would refuse reads as off. */
export function pageReaderWarmPolicy(provider: Pick<PageImageReaderProvider, "warm"> | null, env: NodeJS.ProcessEnv = process.env): { minPages: number } | null {
  try {
    const minPages = pageReaderWarmMinPages(provider, env);
    return minPages === null ? null : { minPages };
  } catch {
    return null;
  }
}

type Scope = { orgId: string; runId: string };

interface RunWarm {
  scope: Scope;
  demand: number;
  minPages: number;
  launches: number;
  launching: boolean;
  /** The start-up reservation on the organization's daily reader budget, until the run's first reader job. */
  reservation: { ticket: string; budget: PageReaderOrgBudget } | null;
  state: PageReaderWarmStatus["state"];
  bootMs: number | null;
  bootCostCents: number | null;
  pages: { reader: number; hostedWhileWarming: number; hostedBelowThreshold: number; hostedUnavailable: number };
}

const runs = new Map<string, RunWarm>();

function keyOf(scope: Scope): string {
  return `${scope.orgId}\u0000${scope.runId}`;
}

function entryFor(scope: Scope, minPages = DEFAULT_PAGE_READER_WARM_MIN_PAGES): RunWarm {
  const key = keyOf(scope);
  let entry = runs.get(key);
  if (entry) {
    runs.delete(key); // re-inserted: least recently used first
  } else {
    entry = {
      scope: { ...scope }, demand: 0, minPages, launches: 0, launching: false, reservation: null, state: "none", bootMs: null, bootCostCents: null,
      pages: { reader: 0, hostedWhileWarming: 0, hostedBelowThreshold: 0, hostedUnavailable: 0 },
    };
  }
  runs.set(key, entry);
  while (runs.size > MAX_TRACKED_RUNS) runs.delete(runs.keys().next().value!);
  return entry;
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

/** The provider's status for the scope, shape-checked; anything thrown or malformed reads as `failed`. */
function statusOf(provider: PageImageReaderProvider, scope: Scope, entry: RunWarm | null, logTag: string): PageReaderWarmStatus["state"] {
  let status: PageReaderWarmStatus;
  try {
    status = provider.warm!.status({ ...scope });
  } catch (error) {
    console.warn(`${logTag} warm-status failed run=${scope.runId}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
    return "failed";
  }
  const state = (["none", "booting", "ready", "failed", "refused"] as const).find((value) => value === status?.state) ?? "failed";
  if (entry && state !== entry.state) {
    entry.state = state;
    if (state === "ready") {
      entry.bootMs = count(status.bootMs);
      entry.bootCostCents = count(status.bootCostCents);
      console.log(
        `${logTag} warm-ready run=${scope.runId} bootSeconds=${entry.bootMs === null ? "na" : (entry.bootMs / 1000).toFixed(1)} ` +
          `bootCostCents=${entry.bootCostCents === null ? "na" : entry.bootCostCents.toFixed(3)} demand=${entry.demand}`,
      );
    } else if (state === "failed" || state === "refused") {
      console.warn(`${logTag} warm-${state} run=${scope.runId} demand=${entry.demand}; pages keep their other route`);
    }
  }
  return state;
}

export type PageReaderWarmGate = "ready" | "warming" | "below-threshold" | "unavailable";

export interface PageReaderWarmContext {
  state: { run?: { id?: string; orgId?: string | null }; pageReaderBudget?: PageReaderOrgBudget | null };
  logTag: string;
  minPages: number;
  /** The organization's daily reader cap, in cents (DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS). */
  orgDailyMaxCostCents: number;
}

/**
 * Count `pages` of reader demand for the run and say where they may go now: `ready` (send reader jobs, `requireReady`),
 * `warming` (a reader is starting: read them the other way and check again), `below-threshold` or `unavailable` (read
 * them the other way). Starts the run's reader, without waiting for it, when its demand in this process reaches the
 * threshold and the organization's daily reader budget admits the start-up estimate. Never throws.
 */
export async function pageReaderWarmGate(provider: PageImageReaderProvider, ctx: PageReaderWarmContext, pages: number): Promise<PageReaderWarmGate> {
  const run = ctx.state.run;
  if (!provider.warm || !run?.id || typeof run.orgId !== "string" || !run.orgId) return "unavailable";
  const scope = { orgId: run.orgId, runId: run.id };
  const entry = entryFor(scope, ctx.minPages);
  entry.minPages = ctx.minPages;
  entry.demand += Number.isSafeInteger(pages) && pages > 0 ? pages : 0;
  const state = statusOf(provider, scope, entry, ctx.logTag);
  if (state === "ready") return "ready";
  if (state === "booting" || entry.launching) return "warming";
  if (entry.demand < ctx.minPages) return "below-threshold";
  if (entry.launches >= PAGE_READER_WARM_MAX_LAUNCHES || (entry.launches > 0 && entry.pages.reader === 0)) return "unavailable";
  entry.launching = true; // set before any await: concurrent documents of the run start one reader
  try {
    const budget = ctx.state.pageReaderBudget === undefined ? processPageReaderOrgBudget : ctx.state.pageReaderBudget;
    if (!budget) {
      console.error(`${ctx.logTag} warm refused run=${scope.runId}: no organization spend ledger`);
      return "unavailable";
    }
    let reserveCents = 0;
    try {
      const estimate = provider.estimateJobCostCents?.(0);
      reserveCents = typeof estimate === "number" && Number.isFinite(estimate) && estimate > 0 ? estimate : 0;
    } catch {
      reserveCents = 0;
    }
    // A start-up the host cannot bound is never made: it would spend outside the organization's daily reader cap.
    if (!(reserveCents >= 0.0001)) {
      console.error(`${ctx.logTag} warm refused run=${scope.runId}: provider=${provider.id} gave no positive start-up estimate to reserve`);
      return "unavailable";
    }
    let admission: Awaited<ReturnType<PageReaderOrgBudget["admit"]>>;
    try {
      admission = await budget.admit({ orgId: scope.orgId, reserveCents, capCents: ctx.orgDailyMaxCostCents });
    } catch (error) {
      console.error(`${ctx.logTag} warm refused run=${scope.runId}: organization spend ledger failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
      return "unavailable";
    }
    if (!admission.admitted) {
      console.warn(`${ctx.logTag} warm refused run=${scope.runId}: organization reader cost today ${admission.committedCents.toFixed(2)} cents plus the start-up's ${reserveCents.toFixed(2)} reaches the daily cap ${ctx.orgDailyMaxCostCents}`);
      return "unavailable";
    }
    let started: PageReaderWarmStatus["state"];
    try {
      const status = provider.warm.start({ ...scope });
      started = (["none", "booting", "ready", "failed", "refused"] as const).find((value) => value === status?.state) ?? "failed";
    } catch (error) {
      console.warn(`${ctx.logTag} warm-start failed run=${scope.runId}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
      started = "failed";
    }
    entry.launches += 1;
    console.log(`${ctx.logTag} warm-start run=${scope.runId} provider=${provider.id} demand=${entry.demand} minPages=${ctx.minPages} launch=${entry.launches} state=${started} reservedCents=${reserveCents.toFixed(3)}`);
    if (started === "refused" || started === "none") {
      // Nothing was started, so nothing was spent: the reservation goes back.
      await budget.settle(admission.ticket, 0).catch(() => undefined);
    } else {
      // Kept (as reserved) until a job runs on the reader; a start that failed may have billed, so it is not returned.
      if (entry.reservation) await entry.reservation.budget.settle(entry.reservation.ticket, 0).catch(() => undefined);
      entry.reservation = { ticket: admission.ticket, budget };
    }
    const now = statusOf(provider, scope, entry, ctx.logTag);
    return now === "ready" ? "ready" : now === "booting" ? "warming" : "unavailable";
  } finally {
    entry.launching = false;
  }
}

/** Non-blocking: whether the run's reader is ready now (checked before each reader job). */
export function pageReaderWarmState(provider: PageImageReaderProvider, scope: Scope, logTag: string): PageReaderWarmStatus["state"] {
  if (!provider.warm) return "none";
  return statusOf(provider, scope, runs.get(keyOf(scope)) ?? null, logTag);
}

/** Count pages by where they went, for the run's warm telemetry. */
export function recordPageReaderWarmRouting(scope: Scope, route: keyof RunWarm["pages"], pages: number): void {
  if (!(pages > 0)) return;
  const entry = runs.get(keyOf(scope));
  if (entry) entry.pages[route] += pages;
}

/**
 * A reader job of the run was sent: the start-up reservation goes back, since the job records the boot as its own
 * provider cost (and reserved it in its own estimate).
 */
export async function releasePageReaderWarmReservation(scope: Scope): Promise<void> {
  const entry = runs.get(keyOf(scope));
  const reservation = entry?.reservation;
  if (!entry || !reservation) return;
  entry.reservation = null;
  await reservation.budget.settle(reservation.ticket, 0).catch((error) => {
    console.error(`[page-reader] warm reservation settle failed run=${scope.runId}; it stands for the day: ${String(error).slice(0, 200)}`);
  });
}

/** One line of the run's warm telemetry in this process (cumulative), for SigNoz: `[...] warm-summary run=... readerPages=...`. */
export function logPageReaderWarmSummary(scope: Scope, route: string, documentId: string, logTag: string): void {
  const entry = runs.get(keyOf(scope));
  if (!entry) return;
  const hosted = entry.pages.hostedWhileWarming + entry.pages.hostedBelowThreshold + entry.pages.hostedUnavailable;
  console.log(
    `${logTag} warm-summary run=${scope.runId} route=${route} document=${documentId} state=${entry.state} demand=${entry.demand} minPages=${entry.minPages} ` +
      `launches=${entry.launches} readerPages=${entry.pages.reader} hostedPages=${hosted} hostedWhileWarming=${entry.pages.hostedWhileWarming} ` +
      `hostedBelowThreshold=${entry.pages.hostedBelowThreshold} hostedUnavailable=${entry.pages.hostedUnavailable} ` +
      `bootSeconds=${entry.bootMs === null ? "na" : (entry.bootMs / 1000).toFixed(1)} bootCostCents=${entry.bootCostCents === null ? "na" : entry.bootCostCents.toFixed(3)}`,
  );
}

/** The run's warm telemetry in this process (tests and diagnostics). */
export function pageReaderWarmSnapshot(scope: Scope): Readonly<Omit<RunWarm, "reservation">> & { reserved: boolean } | null {
  const entry = runs.get(keyOf(scope));
  if (!entry) return null;
  const { reservation, ...rest } = entry;
  return { ...rest, pages: { ...rest.pages }, reserved: reservation !== null };
}

/** Planning's own count of a run's reader demand, per run state (vision-extract planPageTasks). */
const plannedDemand = new WeakMap<object, number>();

/** Add `pages` to the run state's planned reader demand; true once it has reached `minPages`. */
export function plannedPageReaderDemandReached(stateKey: object, pages: number, minPages: number): boolean {
  const total = (plannedDemand.get(stateKey) ?? 0) + (pages > 0 ? pages : 0);
  plannedDemand.set(stateKey, total);
  return total >= minPages;
}

export function resetPageReaderWarmForTest(): void {
  runs.clear();
}

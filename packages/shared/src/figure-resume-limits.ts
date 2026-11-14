/*
 * Every figure resume limit in one place (docs/extraction/doppler-figures.md, "Caps"): the defaults, their environment
 * overrides and the bounds an override is clamped to. The runner, the API's request routes and the chat's offer all read
 * them from here, so the three never disagree about when a document is spent.
 *
 * What a resume pass can produce is bounded by the figure VM, not by the document: one VM returns at most
 * DOPPLER_FIGURE_LIMITS.maxFiles files and maxTotalBytes bytes, whatever the document's own allowance
 * (dopplerAssetCaps: 2,048 + 2 per page files, 64 MiB + 1.25 MiB per page, up to 32,768 files and 4 GiB). A big
 * figure-heavy document therefore legitimately needs many passes, and a small one at most one or two. The caps scale
 * with pages for that reason:
 *
 *   - launches: 1.5x the passes the document's allowance needs after its first pass (at least one per open unit), clamped
 *     to [launchFloor, launchCeiling];
 *   - VM time: vmHeadroom x the expected passes x the estimated cost of one launch (vmMsPerLaunch, plus vmMsPerPage for
 *     each page it converts: a sharded document resumes one shard at a time, an unsharded one re-reads all its pages,
 *     gaps or not), clamped to [docVmSecondsFloor, docVmSecondsCeiling] and to FIGURE_RESUME_HARD.documentVmMs. Measured resume VM time is charged against it, and
 *     each launch's timeout is capped by what is left;
 *   - per unit (a shard, a gap or the unsharded document): the passes its own share of the allowance needs (the whole
 *     document's for the unsharded one) plus two, at least 3, at most FIGURE_RESUME_HARD.unitResumes;
 *   - no progress: noProgressLimit launched resumes in a row whose gain is under the minimum stop the document. The
 *     minimum is measured against what one pass can deliver (FIGURE_RESUME_PASS), never against the backlog, since one
 *     VM returns at most 64 MiB / 2,048 files however much is left: minProgressPercent of a pass's bytes (3.2 MiB at 5%)
 *     or of its files (103, with minProgressBytes in all), or that share of the work items it could close (at least one).
 *
 * A stopped document is blocked with a reason code (`attempts`, `vm-budget`, `no-progress`), logged and counted
 * (`resume.capped`). A reprocess (a new, customer-paid run) clears every block. A single-document request clears a cap
 * block too, by granting one extension (half the base caps again, at least the floors), at most maxGrants times per
 * run: a request can buy more VM time, but a bounded amount (FIGURE_RESUME_HARD.documentVmMs caps the VM budget grants
 * included). DOCSLURP_FIGURE_RESUME_MAX_GRANTS=0 is the kill switch: no request extends a budget. Org concurrency and the
 * org daily VM budget apply on top.
 *
 * An override outside its bounds (or unparsable) falls back to the default with a warning, never a silent clamp: a typo
 * such as 12000 for 120 must not widen a cost knob.
 */
import { dopplerAssetCaps } from "./doppler-assets.js";
import { DOPPLER_FIGURE_LIMITS } from "./doppler-figures.js";

type Env = Record<string, string | undefined>;

/** Retry and queue limits shared by the runner, the route and the chat tool. */
export const FIGURE_RESUME_LIMITS = {
  /** Failures one unit may have before it is closed (a VM or provider failure, R2-M3). */
  maxAttempts: 3,
  /** Backoff before attempt n+1 (ms). */
  backoffMs: [2 * 60_000, 15 * 60_000, 2 * 3600_000] as const,
  /** Delay before the first automatic attempt after a partial level commits (ms). */
  firstDelayMs: 2 * 60_000,
  /** Documents one bulk request (a project) may queue. */
  bulkMax: 100,
  /** Resume VM minutes per organization per UTC day (DOCSLURP_FIGURE_RESUME_ORG_DAILY_VM_MINUTES overrides). */
  orgDailyVmMinutes: 120,
  /** Resumes running at once on one worker (DOCSLURP_FIGURE_RESUME_CONCURRENCY overrides, 1..16). */
  concurrency: 2,
  /** Resumes running at once across the fleet (DOCSLURP_FIGURE_RESUME_GLOBAL_MAX overrides, 1..256). */
  globalMax: 8,
} as const;

/** What one resume VM can return (the figure VM's own caps, DOPPLER_FIGURE_LIMITS). */
export const FIGURE_RESUME_PASS = { files: DOPPLER_FIGURE_LIMITS.maxFiles, bytes: DOPPLER_FIGURE_LIMITS.maxTotalBytes } as const;

/** Hard ceilings no override can pass. The ledger enforces them as a backstop (resume-cap), whatever the policy says. */
export const FIGURE_RESUME_HARD = {
  /**
   * Resumes of one unit (document_extraction_shards.resumes, or the unsharded level's), grants included: room for a unit
   * that holds a whole 4 GiB allowance (63 passes plus failures) with grants on top.
   */
  unitResumes: 128,
  /** Resume launches of one document, grants included (document_extraction_levels.resume_vm_launches is CHECKed at 1000). */
  documentLaunches: 512,
  /** Resume VM time of one document per run, grants included: no env value or grant count passes it (12 hours). */
  documentVmMs: 12 * 3_600_000,
  /** Grants per run (document_extraction_levels.resume_grants is CHECKed at this). */
  grants: 10,
} as const;


export const FIGURE_RESUME_ORG_DAILY_ENV = "DOCSLURP_FIGURE_RESUME_ORG_DAILY_VM_MINUTES";
export const FIGURE_RESUME_CONCURRENCY_ENV = "DOCSLURP_FIGURE_RESUME_CONCURRENCY";
export const FIGURE_RESUME_GLOBAL_ENV = "DOCSLURP_FIGURE_RESUME_GLOBAL_MAX";

/** The per-document budget's environment variables, defaults and bounds. */
export const FIGURE_RESUME_BUDGET_ENV = {
  launchFloor: { name: "DOCSLURP_FIGURE_RESUME_LAUNCH_FLOOR", fallback: 3, min: 1, max: 64 },
  launchCeiling: { name: "DOCSLURP_FIGURE_RESUME_LAUNCH_CEILING", fallback: 128, min: 1, max: FIGURE_RESUME_HARD.documentLaunches },
  vmMsPerPage: { name: "DOCSLURP_FIGURE_RESUME_VM_MS_PER_PAGE", fallback: 50, min: 1, max: 2_000 },
  vmMsPerLaunch: { name: "DOCSLURP_FIGURE_RESUME_VM_MS_PER_LAUNCH", fallback: 3_000, min: 0, max: 120_000 },
  vmHeadroom: { name: "DOCSLURP_FIGURE_RESUME_VM_HEADROOM", fallback: 2, min: 1, max: 16 },
  docVmSecondsFloor: { name: "DOCSLURP_FIGURE_RESUME_DOC_VM_SECONDS_FLOOR", fallback: 180, min: 60, max: 3_600 },
  docVmSecondsCeiling: { name: "DOCSLURP_FIGURE_RESUME_DOC_VM_SECONDS_CEILING", fallback: 4 * 3_600, min: 60, max: 12 * 3_600 },
  noProgressLimit: { name: "DOCSLURP_FIGURE_RESUME_NO_PROGRESS", fallback: 3, min: 1, max: 32 },
  minProgressPercent: { name: "DOCSLURP_FIGURE_RESUME_MIN_PROGRESS_PERCENT", fallback: 5, min: 0, max: 50 },
  minProgressBytes: { name: "DOCSLURP_FIGURE_RESUME_MIN_PROGRESS_BYTES", fallback: 4_096, min: 0, max: 1_048_576 },
  /** 0 is the kill switch: no request extends a budget. */
  maxGrants: { name: "DOCSLURP_FIGURE_RESUME_MAX_GRANTS", fallback: 2, min: 0, max: 10 },
} as const;

export type FigureResumeBudgetConfig = { [K in keyof typeof FIGURE_RESUME_BUDGET_ENV]: number };

/** Why the runner stopped a document. The last three are the budget's; a request may grant past them (bounded). */
export const FIGURE_RESUME_BLOCK_REASONS = ["attempts", "vm-budget", "no-progress", "figures-off", "resume-off", "stale", "refused", "unscanned"] as const;
export type FigureResumeBlockReason = (typeof FIGURE_RESUME_BLOCK_REASONS)[number];
/** Blocks a single-document request clears by granting an extension. */
export const FIGURE_RESUME_BUDGET_BLOCKS = ["attempts", "vm-budget", "no-progress"] as const satisfies readonly FigureResumeBlockReason[];
export function isFigureResumeBudgetBlock(reason: unknown): reason is (typeof FIGURE_RESUME_BUDGET_BLOCKS)[number] {
  return (FIGURE_RESUME_BUDGET_BLOCKS as readonly unknown[]).includes(reason);
}

const warned = new Set<string>();
/**
 * An integer override in [min, max]; anything else (unparsable, `1e3`, `05`, out of range) is the default, with one
 * warning per variable and value (L3: never a silent clamp that widens a cost knob).
 */
function boundedInt(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return fallback;
  const value = Number.parseInt(trimmed, 10);
  if (Number.isSafeInteger(value) && String(value) === trimmed && value >= min && value <= max) return value;
  const key = `${name}=${trimmed}`;
  if (!warned.has(key) && warned.size < 256) {
    warned.add(key);
    console.warn(`[figure-resume] ${name}=${JSON.stringify(trimmed.slice(0, 16))} is not an integer in ${min}..${max}; using the default ${fallback}`);
  }
  return fallback;
}

/** The per-document budget configuration (an override outside its bounds keeps the default, with a warning). */
export function figureResumeBudgetConfig(env: Env = process.env): FigureResumeBudgetConfig {
  const read = (key: keyof typeof FIGURE_RESUME_BUDGET_ENV) => {
    const spec = FIGURE_RESUME_BUDGET_ENV[key];
    return boundedInt(spec.name, env[spec.name], spec.fallback, spec.min, spec.max);
  };
  const launchFloor = read("launchFloor");
  const docVmSecondsFloor = read("docVmSecondsFloor");
  return {
    launchFloor,
    launchCeiling: Math.max(launchFloor, read("launchCeiling")),
    vmMsPerPage: read("vmMsPerPage"),
    vmMsPerLaunch: read("vmMsPerLaunch"),
    vmHeadroom: read("vmHeadroom"),
    docVmSecondsFloor,
    docVmSecondsCeiling: Math.max(docVmSecondsFloor, read("docVmSecondsCeiling")),
    noProgressLimit: read("noProgressLimit"),
    minProgressPercent: read("minProgressPercent"),
    minProgressBytes: read("minProgressBytes"),
    maxGrants: read("maxGrants"),
  };
}

const pagesOf = (pageCount: number) => (Number.isSafeInteger(pageCount) && pageCount > 0 ? pageCount : 1);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const grantsOf = (grants: number) => (Number.isSafeInteger(grants) && grants > 0 ? grants : 0);

/**
 * Resume passes a document's figure allowance can need after its first pass: what is left of dopplerAssetCaps (files and
 * bytes) over what one VM returns (FIGURE_RESUME_PASS), at least 1. 10 pages: 1. 1,000 pages: 20. 20,000 pages: 63.
 */
export function figureResumeExpectedPasses(pageCount: number): number {
  const caps = dopplerAssetCaps(pagesOf(pageCount));
  const byBytes = Math.ceil(Math.max(0, caps.totalBytes - FIGURE_RESUME_PASS.bytes) / FIGURE_RESUME_PASS.bytes);
  const byFiles = Math.ceil(Math.max(0, caps.files - FIGURE_RESUME_PASS.files) / FIGURE_RESUME_PASS.files);
  return Math.max(1, byBytes, byFiles);
}

/** What one grant adds to a base cap: half of it, at least the floor. */
const grantStep = (base: number, floor: number) => Math.max(floor, Math.ceil(base / 2));

/**
 * The document's lifetime resume launches: 1.5x its expected passes, at least one per open unit, clamped to
 * [launchFloor, launchCeiling], plus what its grants added. Never above FIGURE_RESUME_HARD.documentLaunches.
 */
export function figureResumeLaunchCap(args: { pageCount: number; units?: number; grants?: number }, config: FigureResumeBudgetConfig = figureResumeBudgetConfig()): number {
  const want = Math.max(Math.ceil(figureResumeExpectedPasses(args.pageCount) * 1.5), Math.max(0, Math.trunc(args.units ?? 0)));
  const base = clamp(want, config.launchFloor, config.launchCeiling);
  return Math.min(FIGURE_RESUME_HARD.documentLaunches, base + grantsOf(args.grants ?? 0) * grantStep(base, config.launchFloor));
}

/**
 * Pages one resume launch converts (M2): a shard's pages for a sharded document (its pages over its shards), every page
 * for an unsharded one. Gaps never divide it: an unsharded document's own resume re-reads all its pages.
 */
export function figureResumeLaunchPages(args: { pageCount: number; shards?: number }): number {
  const shards = Math.max(0, Math.trunc(args.shards ?? 0));
  return shards === 0 ? pagesOf(args.pageCount) : Math.ceil(pagesOf(args.pageCount) / shards);
}

/** Estimated VM time of one resume launch: vmMsPerLaunch plus vmMsPerPage for each page it converts. */
export function figureResumeLaunchVmMs(args: { pageCount: number; shards?: number }, config: FigureResumeBudgetConfig = figureResumeBudgetConfig()): number {
  return config.vmMsPerLaunch + figureResumeLaunchPages(args) * config.vmMsPerPage;
}

/**
 * The document's lifetime resume VM time (ms): vmHeadroom x its expected passes x one launch's estimated time, clamped to
 * [docVmSecondsFloor, docVmSecondsCeiling], plus what its grants added. 10 pages: 180 s. 1,000 pages unsharded: 2,120 s.
 * 20,000 pages in 32 shards: 4,316 s.
 */
export function figureResumeVmBudgetMs(args: { pageCount: number; shards?: number; grants?: number }, config: FigureResumeBudgetConfig = figureResumeBudgetConfig()): number {
  const estimate = config.vmHeadroom * figureResumeExpectedPasses(args.pageCount) * figureResumeLaunchVmMs(args, config);
  const base = clamp(estimate, config.docVmSecondsFloor * 1000, config.docVmSecondsCeiling * 1000);
  const granted = base + Math.min(FIGURE_RESUME_HARD.grants, grantsOf(args.grants ?? 0)) * grantStep(base, config.docVmSecondsFloor * 1000);
  return Math.min(FIGURE_RESUME_HARD.documentVmMs, granted);
}

/**
 * Whether one launched resume made progress worth another (L1, r2 H1). `before`/`after` are the document's open work
 * (resumable images, gaps, shards not complete); `units` its resume units (a resume runs one); `added` and `addedBytes`
 * what the resume stored. The gain is measured against one pass's capacity, never the backlog (a 3,000-page document
 * storing a full 64 MiB pass is progress however much is left). Any of:
 *   - bytes: addedBytes >= minProgressPercent of a pass's bytes (3.2 MiB at 5%);
 *   - files: added >= minProgressPercent of a pass's files (103), carrying minProgressBytes in all;
 *   - closed work: at least minProgressPercent of what one pass could close (one unit's share of the work, at most a
 *     pass's files), and at least one item.
 * A source that yields one tiny figure a pass makes none of them on a big backlog (4 KiB is under 3.2 MiB and 103 files,
 * and 1 closed item under the share), so the stop still fires; a small document closing its last item still progresses.
 */
export function figureResumeProgressed(
  args: { before: number; after: number; added: number; addedBytes: number; units?: number },
  config: FigureResumeBudgetConfig = figureResumeBudgetConfig(),
): boolean {
  const pct = config.minProgressPercent / 100;
  const before = Math.max(0, args.before);
  const addedBytes = Math.max(0, args.addedBytes);
  const added = Math.max(0, args.added);
  if (addedBytes > 0 && addedBytes >= Math.ceil(FIGURE_RESUME_PASS.bytes * pct)) return true;
  if (added > 0 && addedBytes >= config.minProgressBytes && added >= Math.max(1, Math.ceil(FIGURE_RESUME_PASS.files * pct))) return true;
  const passItems = Math.min(before / Math.max(1, Math.trunc(args.units ?? 1)), FIGURE_RESUME_PASS.files);
  const closed = Math.max(0, before - Math.max(0, args.after));
  return closed > 0 && closed >= Math.max(1, Math.ceil(passItems * pct));
}

/**
 * Resumes of one unit (M1): the passes its share of the allowance needs plus two for failures, at least
 * FIGURE_RESUME_LIMITS.maxAttempts, plus half that per grant, at most FIGURE_RESUME_HARD.unitResumes. A shard's share is
 * 1.25 MiB a page (never above the document's allowance); the unsharded document's unit is the document, so it gets the
 * document's expected passes. 32-page shard: 3. 625-page shard: 15. 3,000 pages unsharded: 61.
 */
export function figureResumeUnitCap(args: { unitPages: number; documentPages?: number; whole?: boolean; grants?: number }): number {
  const documentPages = pagesOf(args.documentPages ?? args.unitPages);
  const passes = args.whole
    ? figureResumeExpectedPasses(documentPages)
    : Math.ceil(Math.min(pagesOf(args.unitPages) * Math.floor(1.25 * 1024 * 1024), dopplerAssetCaps(documentPages).totalBytes) / FIGURE_RESUME_PASS.bytes);
  const base = Math.max(FIGURE_RESUME_LIMITS.maxAttempts, passes + 2);
  const granted = base + Math.min(FIGURE_RESUME_HARD.grants, grantsOf(args.grants ?? 0)) * Math.max(FIGURE_RESUME_LIMITS.maxAttempts, Math.ceil(base / 2));
  return Math.min(FIGURE_RESUME_HARD.unitResumes, granted);
}

/**
 * The open threshold for a unit's own failures or no-progress resumes (H1): the base limit, plus the base again per
 * grant (a grant never clears a unit's count, so a poisoned unit stays sorted last).
 */
export function figureResumeUnitStrikeLimit(base: number, grants = 0): number {
  return base * (1 + Math.min(FIGURE_RESUME_HARD.grants, grantsOf(grants)));
}

/** Resume VM milliseconds one organization may use per UTC day. */
export function figureResumeOrgDailyVmMs(env: Env = process.env): number {
  return boundedInt(FIGURE_RESUME_ORG_DAILY_ENV, env[FIGURE_RESUME_ORG_DAILY_ENV], FIGURE_RESUME_LIMITS.orgDailyVmMinutes, 0, 24 * 60) * 60_000;
}
/** Resumes running at once across the fleet (live leases). */
export function figureResumeGlobalMax(env: Env = process.env): number {
  return boundedInt(FIGURE_RESUME_GLOBAL_ENV, env[FIGURE_RESUME_GLOBAL_ENV], FIGURE_RESUME_LIMITS.globalMax, 1, 256);
}
/** Resumes one worker runs at once. */
export function figureResumeConcurrency(env: Env = process.env): number {
  return boundedInt(FIGURE_RESUME_CONCURRENCY_ENV, env[FIGURE_RESUME_CONCURRENCY_ENV], FIGURE_RESUME_LIMITS.concurrency, 1, 16);
}

/** Backoff before the next attempt after `attempts` resumes (the last delay repeats). */
export function figureResumeBackoffMs(attempts: number): number {
  const delays = FIGURE_RESUME_LIMITS.backoffMs;
  return delays[Math.min(Math.max(0, Math.trunc(attempts)), delays.length - 1)]!;
}

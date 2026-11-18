import { z } from "zod";

/**
 * Run ETAs. Users see buckets only, never a precise countdown: a run's remaining time is uncertain and a bucket that
 * holds is more useful than seconds that jump. A run with no basis (no page count yet, no observed progress and no
 * project history) has no ETA: clients show "estimating", never a guess.
 */
export const ETA_BUCKETS = ["<1m", "1-5m", "5-15m", "15-60m", "1-3h", ">3h"] as const;
export const etaBucketSchema = z.enum(ETA_BUCKETS);
export type EtaBucket = z.infer<typeof etaBucketSchema>;

/** observed: this run's own pages per minute since its worker started. historical: the project's completed runs. */
export const etaBasisSchema = z.enum(["observed", "historical"]);
export type EtaBasis = z.infer<typeof etaBasisSchema>;

export const runEtaSchema = z.object({
  seconds: z.number().nonnegative(),
  bucket: etaBucketSchema,
  basis: etaBasisSchema,
  /** True when the ETA is not based on this run's own progress (a queued run, from project history): label it an estimate. */
  estimate: z.boolean(),
  /** The rate the ETA divides by, pages per minute. */
  pagesPerMinute: z.number().nonnegative(),
});
export type RunEta = z.infer<typeof runEtaSchema>;

/** Bucket for a remaining time in seconds. Boundaries belong to the higher bucket (exactly 60 s is "1-5m"). */
export function etaBucket(seconds: number): EtaBucket {
  if (!Number.isFinite(seconds) || seconds < 60) return "<1m";
  if (seconds < 5 * 60) return "1-5m";
  if (seconds < 15 * 60) return "5-15m";
  if (seconds < 60 * 60) return "15-60m";
  if (seconds < 3 * 60 * 60) return "1-3h";
  return ">3h";
}

/** A run must have worked this long, and finished at least this many pages, before its own rate is trusted. */
export const ETA_MIN_OBSERVED_SECONDS = 10;
export const ETA_MIN_OBSERVED_PAGES = 1;
/** Project history needs this many completed pages to be a basis. */
export const ETA_MIN_HISTORICAL_PAGES = 10;

export interface RunEtaInput {
  status: string;
  pagesTotal: number;
  pagesProcessed: number;
  /** When a worker first picked the run up (falls back to null: no observed rate). */
  startedAt: string | Date | null;
  /** Completed runs of the run's project: total pages and total wall time (ms). */
  history?: { pages: number; runtimeMs: number } | null;
  /** Epoch ms; injected so the function stays pure. */
  now: number;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Project-history pages per minute, or null when history is too thin to be a basis. */
export function historicalPagesPerMinute(history: { pages: number; runtimeMs: number } | null | undefined): number | null {
  if (!history || !Number.isFinite(history.pages) || history.pages < ETA_MIN_HISTORICAL_PAGES || !finitePositive(history.runtimeMs)) return null;
  return history.pages / (history.runtimeMs / 60_000);
}

/** This run's own pages per minute since its worker started, or null when it has not worked long enough to say. */
export function observedPagesPerMinute(input: Pick<RunEtaInput, "pagesProcessed" | "startedAt" | "now">): number | null {
  if (!input.startedAt || !Number.isFinite(input.pagesProcessed) || input.pagesProcessed < ETA_MIN_OBSERVED_PAGES) return null;
  const started = new Date(input.startedAt).getTime();
  const elapsedSeconds = (input.now - started) / 1000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < ETA_MIN_OBSERVED_SECONDS) return null;
  return input.pagesProcessed / (elapsedSeconds / 60);
}

/**
 * Remaining time for one active run. Processing runs use their observed rate; a run without one (queued, or just
 * picked up) uses the project's historical rate, flagged as an estimate. Blocked, finished or unknown-size runs, and
 * runs with no basis, return null.
 */
export function estimateRunEta(input: RunEtaInput): RunEta | null {
  if (input.status !== "queued" && input.status !== "processing") return null;
  const total = Number.isFinite(input.pagesTotal) ? input.pagesTotal : 0;
  if (total <= 0) return null;
  const processed = Math.min(total, Math.max(0, Number.isFinite(input.pagesProcessed) ? input.pagesProcessed : 0));
  const remaining = total - processed;
  const observed = input.status === "processing" ? observedPagesPerMinute(input) : null;
  if (observed !== null && finitePositive(observed)) {
    const seconds = (remaining / observed) * 60;
    return { seconds, bucket: etaBucket(seconds), basis: "observed", estimate: false, pagesPerMinute: observed };
  }
  const historical = historicalPagesPerMinute(input.history);
  if (historical === null || !finitePositive(historical)) return null;
  const seconds = (remaining / historical) * 60;
  return { seconds, bucket: etaBucket(seconds), basis: "historical", estimate: true, pagesPerMinute: historical };
}

const activityCountsSchema = z.object({
  runs: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
});
export type ActivityCounts = z.infer<typeof activityCountsSchema>;

/**
 * The caller's organization at a glance, on the activity feed (`GET /v1/runs?activity=true` and the
 * `activity-summary` event of `/v1/runs/activity/stream`). Organization-scoped aggregates only: no run ids or names.
 */
export const activitySummarySchema = z.object({
  /** Queued runs: documents and pages waiting for a worker (pages known so far). */
  queued: activityCountsSchema,
  /** Processing runs: documents and pages still to do. */
  inProgress: activityCountsSchema.extend({
    pagesProcessed: z.number().int().nonnegative(),
    pagesTotal: z.number().int().nonnegative(),
  }),
  /** Runs completed in the last `recentWindowMinutes`. */
  recentlyCompleted: activityCountsSchema,
  recentWindowMinutes: z.number().int().positive(),
  /** Observed throughput of the organization's processing runs, pages per minute; null with none to observe. */
  pagesPerMinute: z.number().nonnegative().nullable(),
  /** Time until every active run finishes; null while any active run has no basis ("estimating"). */
  eta: z.object({ seconds: z.number().nonnegative(), bucket: etaBucketSchema, estimate: z.boolean() }).nullable(),
  /** More active runs than the summary reads: the counts cover the oldest ones and the ETA is null. */
  truncated: z.boolean(),
  generatedAt: z.string(),
});
export type ActivitySummary = z.infer<typeof activitySummarySchema>;

/** Upload-session progress (`GET /v1/uploads/direct/sessions/:id`, MCP getUploadStatus). */
export const uploadSessionProgressSchema = z.object({
  files: z.object({ total: z.number().int().nonnegative(), completed: z.number().int().nonnegative() }),
  bytes: z.object({ total: z.number().nonnegative(), completed: z.number().nonnegative() }),
  /** The run the session started; null until intake is confirmed. */
  run: z.object({
    id: z.string(),
    status: z.string(),
    documents: z.object({ total: z.number().int().nonnegative(), processed: z.number().int().nonnegative() }),
    pages: z.object({ total: z.number().int().nonnegative(), processed: z.number().int().nonnegative() }),
    pagesPerMinute: z.number().nonnegative().nullable(),
    eta: runEtaSchema.nullable(),
  }).nullable(),
});
export type UploadSessionProgress = z.infer<typeof uploadSessionProgressSchema>;

/**
 * Organization ETA from its active runs' ETAs: they run side by side, so the longest one. Null when there are none
 * or any one has no basis (the organization's ETA would be a guess); an estimate when any input is one.
 */
export function combineRunEtas(etas: ReadonlyArray<RunEta | null>): { seconds: number; bucket: EtaBucket; estimate: boolean } | null {
  if (etas.length === 0) return null;
  let seconds = 0;
  let estimate = false;
  for (const eta of etas) {
    if (!eta) return null;
    seconds = Math.max(seconds, eta.seconds);
    estimate ||= eta.estimate;
  }
  return { seconds, bucket: etaBucket(seconds), estimate };
}

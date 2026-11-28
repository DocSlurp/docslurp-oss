import { compilePipelinePlan } from "@docslurp/shared";
import { emitTelemetryLog, pageCountBucket, recordPipelineTelemetry } from "@docslurp/shared/observability";
import type { WorkflowState } from "./pipeline.js";

/**
 * Run milestones: the first time each happens for a run, stamped once on `project_runs` (migration 0183) and recorded
 * as `docslurp.run.milestone.duration`, seconds since the run was accepted (`created_at`), so queue wait is inside
 * the number. The conditional update makes the stamp exactly-once across workers, retries and resumes, so the metric
 * is recorded at most once (a worker that dies before its next export loses the sample; the column keeps the time).
 * The in-process set only saves the round trip after this process has stamped or seen the stamp.
 */
export type RunMilestone = "worker_started" | "first_page_extracted" | "first_page_completed" | "outcome_recorded";

export const RUN_MILESTONE_COLUMNS: Readonly<Record<RunMilestone, string>> = {
  worker_started: "worker_started_at",
  first_page_extracted: "first_page_extracted_at",
  first_page_completed: "first_page_completed_at",
  outcome_recorded: "outcome_recorded_at",
};

export type RunMilestoneHit = { seconds: number; pages: number };
/** Extra columns a milestone stamp may write in the same statement (`worker_started` records the run's resolved models). */
export type RunMilestoneExtra = { resolvedModels?: Record<string, unknown> };
export type RunMilestoneStore = { markRunMilestone(runId: string, milestone: RunMilestone, extra?: RunMilestoneExtra): Promise<RunMilestoneHit | null> };

/** Stages whose page checkpoint means the page has extracted content, by any method. */
const EXTRACTION_STAGES: ReadonlySet<string> = new Set(["extract-markdown", "extract-html", "vision-extract"]);
/** Stages that checkpoint pages one by one; the last one in a run's plan closes a page. */
const PAGE_CHECKPOINT_STAGES: ReadonlySet<string> = new Set([
  "split-pages", "page-embed", "extract-markdown", "extract-html", "render-images", "vision-extract", "structured-extract", "embed",
]);
/**
 * Stages that can change a document's page count: the page count read from the file, the virtual page index, and the
 * extraction stages (processed PDF pages, the text rule, frames of a multi-frame image). Later stages only read it.
 */
const PAGE_COUNT_STAGES: ReadonlySet<string> = new Set(["format-detect", "split-pages", "extract-markdown", "extract-html", "vision-extract"]);

/**
 * True once `pages_total` can no longer change: every page-counting stage this run executes has completed at run
 * level. A partial run that reuses all of them inherits measured counts, so it is final from its first stage boundary.
 * An unreadable plan is never final (the run's completion stamps it instead).
 */
export function pageCountsFinal(pipeline: Parameters<typeof compilePipelinePlan>[0], runStages: ReadonlyMap<string, { status: string }>): boolean {
  try {
    const plan = compilePipelinePlan(pipeline);
    const reused = new Set<string>(plan.reusedStages);
    return plan.stageOrder.every((stage) => !PAGE_COUNT_STAGES.has(stage) || reused.has(stage) || runStages.get(stage)?.status === "completed");
  } catch {
    return false;
  }
}

/** A worker process younger than this when it picks a run up was started for the work: a cold start. */
export const COLD_WORKER_UPTIME_SECONDS = 120;

const MAX_TRACKED = 10_000;
const attempted = new Set<string>();
const finalStages = new Map<string, string | null>();

/** The last page-checkpointing stage this run executes; null when the plan has none. */
export function finalPageStage(stageOrder: readonly string[], reusedStages: readonly string[] = []): string | null {
  const reused = new Set(reusedStages);
  for (let index = stageOrder.length - 1; index >= 0; index -= 1) {
    const stage = stageOrder[index]!;
    if (PAGE_CHECKPOINT_STAGES.has(stage) && !reused.has(stage)) return stage;
  }
  return null;
}

export function workerStartKind(uptimeSeconds = process.uptime()): "cold" | "warm" {
  return uptimeSeconds < COLD_WORKER_UPTIME_SECONDS ? "cold" : "warm";
}

/** Telemetry only: never fails or delays the stage beyond one conditional update per run, milestone and process. */
export async function noteRunMilestone(store: RunMilestoneStore | undefined, runId: string, milestone: RunMilestone,
  labels: Record<string, string> = {}, extra?: RunMilestoneExtra): Promise<void> {
  if (!store) return;
  const key = `${runId}:${milestone}`;
  if (attempted.has(key)) return;
  if (attempted.size >= MAX_TRACKED) attempted.clear();
  attempted.add(key);
  try {
    const hit = await store.markRunMilestone(runId, milestone, extra);
    // The page count is rarely measured when a worker first picks a run up, so start latency carries no page bucket.
    const pages: Record<string, string> = milestone === "worker_started" ? {} : { pages: pageCountBucket(hit?.pages ?? 0) };
    if (hit) recordPipelineTelemetry("run.milestone.duration", hit.seconds, { milestone, ...pages, ...labels }, "duration");
  } catch (error) {
    // Not stamped: let this process try again on its next page or stage rather than lose the milestone.
    attempted.delete(key);
    console.warn(`[run-milestone] run=${runId} milestone=${milestone} not recorded: ${error instanceof Error ? error.name : "error"}`);
  }
}

/** A page of the run finished `stageName`: stamps first-extracted and, for the plan's last page stage, first-completed. */
export async function noteRunPageStage(state: Pick<WorkflowState, "run" | "store">, stageName: string): Promise<void> {
  const store = state.store;
  if (!store) return;
  const runId = state.run.id;
  if (EXTRACTION_STAGES.has(stageName)) await noteRunMilestone(store, runId, "first_page_extracted");
  let final = finalStages.get(runId);
  if (final === undefined) {
    try {
      const plan = compilePipelinePlan(state.run.pipeline);
      final = finalPageStage(plan.stageOrder, plan.reusedStages);
    } catch {
      final = null;
    }
    if (finalStages.size >= MAX_TRACKED) finalStages.clear();
    finalStages.set(runId, final);
  }
  if (final === stageName) await noteRunMilestone(store, runId, "first_page_completed");
}

/**
 * A document finished a stage. Records `docslurp.document.milestone.duration` (seconds since run acceptance) when
 * its embeddings are written and when it is indexed, and closes the page milestones for documents that never
 * checkpoint pages: once a document is indexed, its first page is both extracted and complete.
 */
export async function noteDocumentStageComplete(state: Pick<WorkflowState, "run" | "store">, stage: string, pageCount: number): Promise<void> {
  const milestone = stage === "embed" ? "embedded" : stage === "index" ? "indexed" : null;
  if (!milestone) return;
  recordDocumentMilestone(state.run, milestone, pageCount);
  if (stage !== "index") return;
  const store = state.store;
  await noteRunMilestone(store, state.run.id, "first_page_extracted");
  await noteRunMilestone(store, state.run.id, "first_page_completed");
}

export function recordDocumentMilestone(run: { createdAt: Date }, milestone: "lexical_searchable" | "lexical_indexed" | "embedded" | "indexed", pageCount: number): void {
  const seconds = secondsSinceAccepted(run);
  if (seconds !== null) recordPipelineTelemetry("document.milestone.duration", seconds, { milestone, pages: pageCountBucket(pageCount) }, "duration");
}

/** Test seam: forget what this process has already attempted. */
export function resetRunMilestoneMemory(): void {
  attempted.clear();
  finalStages.clear();
}

/**
 * Records a run's terminal outcome once: the `outcome_recorded_at` stamp makes a retried terminal activity, or a late
 * one that the store ignored, record nothing. Cancelled runs are not counted.
 */
export async function noteRunOutcome(store: RunMilestoneStore | undefined, run: { id: string; createdAt: Date; pagesTotal: number },
  outcome: "completed" | "completed_with_failures" | "failed", failedStage?: string): Promise<void> {
  if (!store) return;
  try {
    const hit = await store.markRunMilestone(run.id, "outcome_recorded");
    if (hit) {
      recordRunOutcome(run, outcome, failedStage);
      noteRunEtaActual(run.id, hit, outcome);
    }
  } catch (error) {
    console.warn(`[run-milestone] run=${run.id} outcome not recorded: ${error instanceof Error ? error.name : "error"}`);
  }
}

/**
 * ETA accuracy: a run's actual duration (seconds since acceptance), logged once with its id so SigNoz can join it to
 * the API's first prediction (`docslurp.run.eta.predicted`) and measure how often the predicted bucket held.
 */
export function noteRunEtaActual(runId: string, hit: RunMilestoneHit, outcome: string): void {
  const seconds = Math.round(hit.seconds);
  const line = `[run-eta] actual run=${runId} seconds=${seconds} pages=${hit.pages} outcome=${outcome}`;
  console.log(line);
  emitTelemetryLog({
    severityText: "info", body: line, eventName: "docslurp.run.eta.actual",
    attributes: { "docslurp.run.id": runId, "docslurp.eta.actual_seconds": seconds, "docslurp.run.pages": hit.pages, "docslurp.run.outcome": outcome },
  });
}

/**
 * A run reached a terminal state: `docslurp.run.outcomes` (count), `docslurp.run.duration` (seconds since acceptance)
 * and, for a run that completed, `docslurp.run.pages_per_minute` over the same window.
 */
export function recordRunOutcome(run: { createdAt: Date; pagesTotal: number }, outcome: "completed" | "completed_with_failures" | "failed",
  failedStage?: string): void {
  const pages = pageCountBucket(run.pagesTotal);
  recordPipelineTelemetry("run.outcomes", 1, { outcome, pages, ...(failedStage ? { stage: metricStage(failedStage) } : {}) });
  const seconds = secondsSinceAccepted(run);
  if (seconds === null) return;
  recordPipelineTelemetry("run.duration", seconds, { outcome, pages }, "duration");
  if (outcome !== "failed" && run.pagesTotal > 0 && seconds > 0) {
    recordPipelineTelemetry("run.pages_per_minute", run.pagesTotal / (seconds / 60), { pages }, "rate");
  }
}

/** `docslurp.document.stage.failures`: a document's stage failed for good, by stage and reviewed public failure code. */
export function recordDocumentStageFailure(stage: string, code: string | undefined): void {
  recordPipelineTelemetry("document.stage.failures", 1, { stage: metricStage(stage), code: code ?? "processing_failed" });
}

/** `docslurp.document.stage.retries`: a document's stage is being retried, by stage and reason. */
export function recordDocumentStageRetry(stage: string, reason: string): void {
  recordPipelineTelemetry("document.stage.retries", 1, { stage: metricStage(stage), reason });
}

/**
 * `docslurp.pages.routed`: pages by where the automatic mode sent them and why. `route` is the destination
 * (`text`, `ocr`, `vision`), `reason` a bounded category. Counts pages, so a share is one division in the dashboard.
 */
export function recordPagesRouted(route: string, reason: string, pages: number): void {
  if (pages > 0) recordPipelineTelemetry("pages.routed", pages, { route, reason: metricLabel(reason) });
}

/** `docslurp.pages.escalation`: what became of pages sent beyond fast extraction (`replaced`, `failed`, `skipped`, ...). */
export function recordPageEscalation(route: string, outcome: string, pages: number): void {
  if (pages > 0) recordPipelineTelemetry("pages.escalation", pages, { route, outcome: metricLabel(outcome) });
}

/** Telemetry never throws: a run without a usable acceptance time (a partial state in a caller) records nothing. */
function secondsSinceAccepted(run: { createdAt?: Date }): number | null {
  const accepted = run.createdAt instanceof Date ? run.createdAt.getTime() : Number.NaN;
  return Number.isFinite(accepted) ? Math.max(0, (Date.now() - accepted) / 1000) : null;
}

/** Stage names are a closed set in the plan; anything else (a caller-supplied string) collapses to one label. */
function metricStage(stage: string): string {
  return /^[a-z][a-z0-9-]{0,40}$/.test(stage) ? stage : "other";
}

function metricLabel(value: string): string {
  return /^[a-z][a-z0-9_-]{0,40}$/.test(value) ? value : "other";
}

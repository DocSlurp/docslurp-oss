import { z } from "zod";
import {
  pipelineFeaturesSchema,
  runStageSchema,
  runStatusSchema,
  stageExecutionStatusSchema,
} from "./pipeline.js";

export const projectRunSchema = z.object({
  id: z.string(),
  /** Effective parent job identity; each child retains its own run ID. */
  jobId: z.string().optional(),
  userId: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  kind: z.string(),
  status: runStatusSchema,
  priority: z.number().int().default(0),
  controlState: z.string().nullable().default(null),
  /** Why the worker paused the run for spend (credit_exhausted, project_budget_paused, org_budget_paused, plan_not_entitled); it resumes by itself once the org may spend. */
  pauseReason: z.string().nullable().optional(),
  controlRequestedAt: z.string().nullable().default(null),
  stage: runStageSchema,
  totalDocuments: z.number(),
  processedDocuments: z.number(),
  pagesTotal: z.number(),
  pagesProcessed: z.number(),
  /**
   * Documents that failed a stage and were skipped. A Run with failed
   * Documents still completes (the rest were processed); clients show
   * "N of totalDocuments documents failed". Mirrors `stats.failedDocuments`.
   */
  failedDocuments: z.number().int().nonnegative().default(0),
  /**
   * Run cost, read from the usage ledger (`usage_attribution`): AI/API calls,
   * per-page fees and worker compute, with unbilled compute at its rate-card
   * estimate. The same figure as the progress snapshot's
   * `progress.usageTotals.costCents`; storage and network are excluded.
   */
  costCents: z.number().nonnegative().default(0),
  /** True when costCents includes a worker-compute estimate rather than a billed charge. */
  computeEstimated: z.boolean().default(false),
  /**
   * Billed run spend: costCents without the unbilled worker-compute estimate.
   * The run cost cap (`pipeline.maxCostCents`) is enforced against this figure.
   */
  billedCostCents: z.number().nonnegative().default(0),
  pipeline: pipelineFeaturesSchema,
  stats: z.record(z.string(), z.unknown()).default({}),
  artifacts: z.record(z.string(), z.string()).default({}),
  error: z.string().nullable(),
  costForecast: z
    .object({
      minCents: z.number(),
      maxCents: z.number(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectRun = z.infer<typeof projectRunSchema>;

export const projectRunStageStateSchema = z.object({
  runId: z.string(),
  documentId: z.string().nullable().default(null),
  stage: runStageSchema,
  status: stageExecutionStatusSchema,
  attempts: z.number().int().nonnegative(),
  artifactUri: z.string().nullable().default(null),
  stats: z.record(z.string(), z.unknown()).default({}),
  error: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  updatedAt: z.string(),
});
export type ProjectRunStageState = z.infer<
  typeof projectRunStageStateSchema
>;

export const projectRunEventTypeSchema = z.enum([
  "run.started",
  "run.progress",
  "run.failed",
  "run.completed",
  "stage.started",
  "stage.completed",
  "stage.failed",
  "document.started",
  "document.completed",
  "document.failed",
  /** A newer canonical version finished and replaced older versions in search. */
  "document.replaced",
  /** Superseded versions' derived data (chunks, pages, vectors, artifacts) was deleted. */
  "document.purged",
  /** A document's extracted text scored below the plausibility threshold (worker store). */
  "document.plausibility_warning",
]);
export type ProjectRunEventType = z.infer<typeof projectRunEventTypeSchema>;

export const projectRunEventSchema = z.object({
  id: z.string(),
  userId: z.string(),
  runId: z.string(),
  documentId: z.string().nullable().default(null),
  stage: runStageSchema.nullable().default(null),
  type: projectRunEventTypeSchema,
  status: stageExecutionStatusSchema.nullable().default(null),
  message: z.string().nullable().default(null),
  progress: z.record(z.string(), z.unknown()).default({}),
  stats: z.record(z.string(), z.unknown()).default({}),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});
export type ProjectRunEvent = z.infer<typeof projectRunEventSchema>;

export const temporalWorkflowStatusSchema = z.enum([
  "UNSPECIFIED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "CONTINUED_AS_NEW",
  "TIMED_OUT",
  "PAUSED",
  "UNKNOWN",
]);
export type TemporalWorkflowStatus = z.infer<
  typeof temporalWorkflowStatusSchema
>;

export const projectRunTemporalSchema = z.object({
  workflowId: z.string(),
  workflowRunId: z.string().nullable().default(null),
  workflowStatus: temporalWorkflowStatusSchema.nullable().default(null),
  stage: runStageSchema.nullable().default(null),
  stageIndex: z.number().int().nonnegative().nullable().default(null),
  totalStages: z.number().int().nonnegative().nullable().default(null),
  historyLength: z.number().int().nonnegative().nullable().default(null),
  historySizeBytes: z.number().int().nonnegative().nullable().default(null),
  startTime: z.string().nullable().default(null),
  executionTime: z.string().nullable().default(null),
  closeTime: z.string().nullable().default(null),
  elapsedMs: z.number().int().nonnegative().nullable().default(null),
  /**
   * Diagnostic only, not the run's cost: the workflow's in-memory sum of the
   * usage its activities returned. Attempts that failed or were retried
   * returned nothing, so it can fall short of the ledger. The run's cost is
   * `run.costCents` / `progress.usageTotals.costCents`.
   */
  activityUsageTally: z
    .object({
      inputTokens: z.number().nonnegative().default(0),
      outputTokens: z.number().nonnegative().default(0),
      costCents: z.number().default(0),
    })
    .default({
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
    }),
  queriedAt: z.string(),
});
export type ProjectRunTemporal = z.infer<typeof projectRunTemporalSchema>;

export const projectRunLifecycleStatusSchema = z.enum([
  "queued",
  "processing",
  "paused",
  "completed",
  "failed",
]);
export type ProjectRunLifecycleStatus = z.infer<
  typeof projectRunLifecycleStatusSchema
>;

export const projectRunProgressToneSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
]);
export type ProjectRunProgressTone = z.infer<
  typeof projectRunProgressToneSchema
>;

export const projectRunProgressPhaseSchema = z.object({
  key: z.string(),
  label: z.string(),
  stages: z.array(runStageSchema).default([]),
  status: projectRunProgressToneSchema,
  completedStages: z.number().int().nonnegative(),
  totalStages: z.number().int().nonnegative(),
});
export type ProjectRunProgressPhase = z.infer<
  typeof projectRunProgressPhaseSchema
>;

export const projectRunProgressStageRollupSchema = z.object({
  stage: runStageSchema,
  label: z.string(),
  status: projectRunProgressToneSchema,
  completedPages: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  pageRatio: z.number().nonnegative(),
  documents: z.object({
    completed: z.number().int().nonnegative(),
    processing: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  durationMs: z.number().nonnegative().default(0),
  latencyMs: z.number().nonnegative().default(0),
  inputTokens: z.number().nonnegative().default(0),
  outputTokens: z.number().nonnegative().default(0),
  costCents: z.number().default(0),
  /** Worker CPU time (user + system) spent in this stage, summed across stage executions. */
  cpuMs: z.number().nonnegative().optional(),
  /** Highest worker process RSS observed while this stage ran (not a sum of deltas). */
  peakRssBytes: z.number().nonnegative().optional(),
});
export type ProjectRunProgressStageRollup = z.infer<
  typeof projectRunProgressStageRollupSchema
>;

export const projectRunProgressModuleSchema = z.object({
  lifecycleStatus: projectRunLifecycleStatusSchema,
  currentStage: runStageSchema,
  currentStageLabel: z.string(),
  currentStageIndex: z.number().int().nonnegative().nullable().default(null),
  currentStagePosition: z.number().int().nonnegative().nullable().default(null),
  expectedStages: z.array(runStageSchema),
  completedStages: z.number().int().nonnegative(),
  totalStages: z.number().int().nonnegative(),
  percentComplete: z.number().int().min(0).max(100),
  phases: z.array(projectRunProgressPhaseSchema),
  stageRollups: z.array(projectRunProgressStageRollupSchema),
  pageRollup: z.object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    byStage: z.record(z.string(), z.number().int().nonnegative()).default({}),
    byDocument: z
      .record(z.string(), z.record(z.string(), z.number().int().nonnegative()))
      .default({}),
  }),
  usageTotals: z.object({
    inputTokens: z.number().nonnegative().default(0),
    outputTokens: z.number().nonnegative().default(0),
    /** Run cost: AI/API calls + per-page fees + worker compute. Storage and network are excluded. */
    costCents: z.number().default(0),
    /**
     * Billed spend: costCents without the unbilled worker-compute estimate.
     * What the run cost cap (`pipeline.maxCostCents`) is checked against.
     */
    billedCostCents: z.number().optional(),
    /** AI and API provider calls (LLM, embeddings, vision, OCR services). */
    aiCostCents: z.number().optional(),
    /** Part of aiCostCents billed for pages our own models read, at the self-hosted price. */
    selfHostedCostCents: z.number().optional(),
    /** What those pages would have cost at the hosted-equivalent list price. */
    selfHostedListCents: z.number().optional(),
    /** Per-page base fees. */
    feeCostCents: z.number().optional(),
    /** Worker CPU/RAM/GPU time. An estimate from the worker's hourly rate unless compute is billed. */
    computeCostCents: z.number().optional(),
    /** True when computeCostCents is a rate-card estimate (`costSource: "estimate"`), not a billed charge. */
    computeEstimated: z.boolean().optional(),
    /** Worker classes and regions that recorded compute for the run, for pages-per-$1 context. */
    workerClasses: z.array(z.string()).optional(),
    regions: z.array(z.string()).optional(),
  }),
  resourceTotals: z.object({
    elapsedMs: z.number().int().nonnegative().default(0),
    cpuUserMs: z.number().nonnegative().default(0),
    cpuSystemMs: z.number().nonnegative().default(0),
    cpuTotalMs: z.number().nonnegative().default(0),
    rssDeltaBytes: z.number().default(0),
    peakRssBytes: z.number().nonnegative().default(0),
  }),
});
export type ProjectRunProgressModule = z.infer<
  typeof projectRunProgressModuleSchema
>;

export const projectRunProgressSnapshotSchema = z.object({
  run: projectRunSchema,
  stages: z.array(projectRunStageStateSchema),
  recentEvents: z.array(projectRunEventSchema),
  temporal: projectRunTemporalSchema.nullable().default(null),
  progress: projectRunProgressModuleSchema.optional(),
  stats: z.record(z.string(), z.unknown()).default({}),
  artifacts: z.record(z.string(), z.string()).default({}),
});
export type ProjectRunProgressSnapshot = z.infer<
  typeof projectRunProgressSnapshotSchema
>;

/**
 * Terminal document status set by the PII policy (`piiPolicy.action =
 * "block_indexing"`): the document matched a configured pattern, so it is not
 * summarised, embedded or indexed and never appears in search or chat.
 */
export const PII_BLOCKED_DOCUMENT_STATUS = "pii_blocked";

/** Document statuses no pipeline stage will move on from. */
export const terminalDocumentStatuses = ["completed", "failed", "cancelled", PII_BLOCKED_DOCUMENT_STATUS] as const;

export function isTerminalDocumentStatus(status: string): boolean {
  return (terminalDocumentStatuses as readonly string[]).includes(status);
}

export const documentSchema = z.object({
  id: z.string(),
  userId: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  runId: z.string().nullable(),
  filename: z.string(),
  /**
   * Friendly title derived from the document's content (embedded metadata or its
   * first heading); null when none was found, so clients fall back to the filename.
   * Untrusted: derived from document content. Display only; never place in prompts
   * or treat as instructions.
   */
  title: z.string().nullable().optional(),
  mimeType: z.string(),
  sourceKey: z.string(),
  status: z.string(),
  /** Why the document is in its current status, when that needs explaining (e.g. a PII block). */
  statusReason: z.string().nullable().optional(),
  extractionMode: z.string(),
  pageCount: z.number(),
  /**
   * `measured`: the worker (or intake, for text and single images) counted `pageCount`. `estimated`: intake's guess from the
   * file's size for a format only the worker can count (PDF, Office, EPUB, multi-frame images); the worker replaces it with
   * its measured count before anything bills, and billing never reads the estimate.
   */
  pageCountSource: z.enum(["estimated", "measured"]).optional(),
  sourceSha256: z.string().nullable().optional(),
  dedupedFromDocumentId: z.string().nullable().optional(),
  dedupScope: z.enum(["project", "org"]).nullable().optional(),
  tags: z.array(z.string()).default([]),
  versionNumber: z.number().optional(),
  previousVersionId: z.string().nullable().optional(),
  /** Caller-chosen identity of the logical source (URL, site path, external key). */
  canonicalId: z.string().nullable().optional(),
  /** Set once a newer completed document with the same canonicalId replaces this one in search. */
  supersededAt: z.string().nullable().optional(),
  supersededByDocumentId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocumentRecord = z.infer<typeof documentSchema>;

export const documentIndexEntrySchema = documentSchema.extend({
  projectName: z.string(),
  orgName: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
});
export type DocumentIndexEntry = z.infer<typeof documentIndexEntrySchema>;

export const documentIndexResponseSchema = z.object({
  documents: z.array(documentIndexEntrySchema).default([]),
  totalCount: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(0),
  truncated: z.boolean().default(false),
});
export type DocumentIndexResponse = z.infer<typeof documentIndexResponseSchema>;

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

export function normalizePageNumber(value: unknown): number | null {
  return normalizePositiveInt(value);
}

export function normalizePageNumbers(
  values: Iterable<unknown> | null | undefined,
): number[] {
  if (!values) {
    return [];
  }

  const normalized = new Set<number>();
  for (const value of values) {
    const pageNumber = normalizePageNumber(value);
    if (pageNumber !== null) {
      normalized.add(pageNumber);
    }
  }

  return [...normalized].sort((left, right) => left - right);
}

/**
 * Splits extracted text into pages only when the text itself says where the
 * pages are. Returns null when the form feeds do not describe exactly
 * `pageCount` pages (or there is no page count to check them against), so no
 * text is ever labelled with another page's number. Unlike
 * `splitTextIntoPages` it never falls back to `---` rules or equal-length
 * slices, and it keeps empty pages in place.
 *
 * A document that is known to be one page (`pageCount === 1`) is that page.
 */
export function splitTextIntoPagesStrict(
  text: string,
  pageCount: number | null | undefined,
): string[] | null {
  const normalizedPageCount = normalizePageNumber(pageCount);
  if (normalizedPageCount === null) return null;
  const unified = text.replace(/\r\n/g, "\n");
  if (!unified.trim()) return [];
  if (normalizedPageCount === 1) return [unified.replace(/\f/g, "\n").trim()];

  const parts = unified.split("\f").map((page) => page.trim());
  while (parts.length > normalizedPageCount && parts[parts.length - 1] === "") parts.pop();
  return parts.length === normalizedPageCount ? parts : null;
}

export function splitTextIntoPages(
  text: string,
  pageCount?: number | null,
): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  const normalizedPageCount = normalizePageNumber(pageCount);

  // Explicit form-feed page breaks. When they describe exactly `pageCount` pages,
  // keep empty pages in place (scans, blank pages) so page N stays page N; `trim()`
  // above would strip leading/trailing form feeds, so split the untrimmed text.
  const positionalPages = text
    .replace(/\r\n/g, "\n")
    .split("\f")
    .map((page) => page.trim());
  while (
    normalizedPageCount !== null &&
    positionalPages.length > normalizedPageCount &&
    positionalPages[positionalPages.length - 1] === ""
  ) {
    positionalPages.pop();
  }
  if (normalizedPageCount !== null && normalizedPageCount > 1 && positionalPages.length === normalizedPageCount) {
    return positionalPages;
  }

  const explicitPages = positionalPages.filter(Boolean);
  if (explicitPages.length > 1) {
    return explicitPages;
  }

  const rulePages = normalized
    .split(/\n-{3,}\n/g)
    .map((page) => page.trim())
    .filter(Boolean);
  if (
    rulePages.length > 1 &&
    (normalizedPageCount === null || rulePages.length === normalizedPageCount)
  ) {
    return rulePages;
  }

  const fallbackPageCount = normalizedPageCount ?? 1;
  if (fallbackPageCount <= 1) {
    return [normalized];
  }

  const chunkSize = Math.ceil(normalized.length / fallbackPageCount);
  return Array.from({ length: fallbackPageCount }, (_, index) =>
    normalized.slice(index * chunkSize, (index + 1) * chunkSize).trim(),
  );
}

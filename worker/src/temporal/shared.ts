/**
 * Types and constants shared between Temporal workflows and activities.
 *
 * IMPORTANT: This file is bundled into the Temporal workflow sandbox.
 * It must contain only pure types, constants, and deterministic code.
 * No I/O, no randomness, no non-deterministic imports.
 */

import type { PipelineFeatures, VisionConfig } from "@docslurp/shared";
import { WORKFLOW_STAGE_ORDER } from "./workflow-stage-order.js";

/** Ordered pipeline stage names kept workflow-safe and checked against the shared plan. */
export const STAGE_ORDER = WORKFLOW_STAGE_ORDER;

export type StageName = (typeof STAGE_ORDER)[number];

// ── Activity input/output types ──

export interface StageInput {
  stageName: string;
  runId: string;
  totalStages: number;
  /** Accumulated artifact URIs from prior stages */
  artifacts: Record<string, string>;
  /** Hold an org worker slot while running (absent on pre-slot workflow histories). */
  slotGate?: boolean;
}

export interface StageOutput {
  /** New or changed artifact URIs produced by this stage */
  artifacts: Record<string, string>;
  usage: UsageSummary;
  stats: Record<string, unknown>;
  /** Stage groups only: how many of the group's stages ran (fewer when it yielded to a pause). */
  stagesRun?: number;
  /** Set when the stage ran with readControlState: the run's pause/cancel request at its completion checkpoint. */
  controlRequested?: boolean;
  /** In-process only (a stage group's next stage); never part of an activity result. */
  preloaded?: import("../db/store.js").PreloadedRunState;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface InitRunInput {
  runId: string;
  totalStages: number;
}

export interface InitRunOutput {
  documentIds: string[];
  artifacts: Record<string, string>;
  /** Page count per entry of documentIds (absent on older histories). */
  documentPages?: number[];
  /** MIME type per entry of documentIds (absent on older histories). */
  documentMimeTypes?: string[];
}

/** One document shard of a stage: the stage runs for these documents only. */
export interface StageShardInput extends StageInput {
  documentIds: string[];
  shardIndex: number;
  shardCount: number;
}

/** Recorded in workflow input so replay never depends on later env changes. */
export interface DocumentShardingInput {
  /** Fewest documents worth a shard of their own. */
  minDocsPerShard: number;
  /** Most shards per stage; bounds workflow history. */
  maxShards: number;
  /**
   * Fewest pages worth a shard. A shard costs a few seconds of fixed overhead
   * (loading the run, a slot lease, checkpoints), so tiny shards are slower
   * than none. Absent on runs started before it existed.
   */
  minPagesPerShard?: number;
}

/**
 * Stages whose work is independent per document, so their documents can run
 * as shards on several machines. The unsharded stage activity still runs
 * afterwards: it skips completed documents, retries any a shard left behind,
 * and owns the run-stage checkpoint.
 */
/**
 * Documents a format-specific stage actually works on; the rest pass through
 * it as no-ops, so only these are worth sharding. Other stages take all.
 */
export function stageWorksOn(stageName: string, mimeType: string | undefined): boolean {
  const mime = (mimeType ?? "").toLowerCase();
  switch (stageName) {
    case "pdf-tooling":
    case "extract-html":
      return mime === "application/pdf";
    case "render-images":
      return mime === "application/pdf" || mime.startsWith("image/");
    default:
      return true;
  }
}

export const SHARDABLE_STAGES: readonly string[] = [
  "pdf-tooling",
  "extract-markdown",
  "extract-html",
  "classify-route",
  "render-images",
  "pii-detect",
  "document-summary",
  "structured-extract",
  "embed",
];

export interface CompleteRunInput {
  runId: string;
}

export interface FailRunInput {
  runId: string;
  stage: string;
  message: string;
  /**
   * The stage group that was running (stage-groups.ts). The workflow cannot see
   * which of its stages failed; the run's last started stage (in the group) is
   * recorded instead of `stage`.
   */
  stageGroup?: string[];
}

// ── Workflow input/output types ──

export interface PipelineWorkflowInput {
  runId: string;
  pipeline: PipelineFeatures;
  stageOrder?: StageName[];
  /** Captured at workflow creation so replay does not depend on changing worker configuration. */
  pageConcurrency?: number;
  /** New runs may amortize dispatch across small bundles; absent keeps legacy commands. */
  pageBundleSize?: number;
  /**
   * Per-org worker slot gating: activities fail fast with WORKER_SLOT_UNAVAILABLE
   * when the org is at its plan ceiling and the workflow backs off (AIMD).
   * Absent on older histories, which keep their original command sequence.
   */
  slotGate?: boolean;
  /** Page fan-out runs in child workflows of at most this many pages (bounded history). */
  pageChildBatchSize?: number;
  /** Activities run on this queue when set; workflows stay on the workflow queue. */
  activityTaskQueue?: string;
  /** Split per-document stages into shards across machines (absent = one activity per stage). */
  documentSharding?: DocumentShardingInput;
  /** Run adjacent LIGHT_STAGES in one activity (absent = one activity per stage). */
  groupLightStages?: boolean;
  /**
   * Stages that may share one activity with their neighbours (stage-groups.ts).
   * Replaces LIGHT_STAGES grouping when set; absent on older histories.
   */
  groupableStages?: string[];
}

/** Several consecutive light stages run back to back in one activity. */
export interface StageGroupInput {
  stageNames: string[];
  runId: string;
  totalStages: number;
  artifacts: Record<string, string>;
  slotGate?: boolean;
  /** Stop before the next stage when the run has a pause or cancel request; report stagesRun. */
  yieldToControl?: boolean;
}

/**
 * Light, never-sharded stages whose per-run work is mostly bookkeeping. When
 * adjacent, they run in one activity: each stage boundary otherwise costs a
 * Temporal round trip and a run reload (~3 s in production).
 */
export const LIGHT_STAGES: readonly string[] = [
  "quarantine",
  "format-detect",
  "to-canonical",
  "format-tooling",
  "normalize",
  "split-pages",
];

/** Child workflow input: one bounded slice of a run's page tasks. */
export interface VisionPageBatchInput {
  runId: string;
  offset: number;
  limit: number;
  pageConcurrency: number;
  pageBundleSize: number;
  slotGate: boolean;
  activityTaskQueue?: string;
}

export interface VisionPageBatchPlan {
  /** Page tasks stored for the run (page_work_tasks rows with a payload). */
  total: number;
}

/** Temporal ApplicationFailure type for "org (or fleet) has no free worker slot". */
export const WORKER_SLOT_UNAVAILABLE = "WorkerSlotUnavailable";
/** Provider 429/5xx that survived in-process retries; Temporal retries with nextRetryDelay. */
export const PROVIDER_RATE_LIMITED = "ProviderRateLimited";
/**
 * Document-stage activities get STAGE_THROTTLED_ATTEMPTS Temporal attempts so a
 * provider 429 can wait out Retry-After, but any other failure becomes
 * non-retryable from attempt STAGE_ORDINARY_ATTEMPTS on. At 576 slots in one
 * org (2026-10-09 load-test re-run) 3 attempts were not enough to ride out
 * sustained embedding TPM throttling and 185 runs failed permanently.
 */
export const STAGE_ORDINARY_ATTEMPTS = 3;
export const STAGE_THROTTLED_ATTEMPTS = 8;

export interface VisionPageTask {
  runId: string;
  documentId: string;
  pageNumber: number;
  pageCount: number;
  vision: VisionConfig;
  /** Set by slot-gated workflows only. */
  slotGate?: boolean;
}

export interface PipelineWorkflowOutput {
  runId: string;
  usage: UsageSummary;
}

// ── Query/signal types ──

export interface DocumentProgress {
  documentId: string;
  stage: string;
  status: string;
  pagesTotal: number;
  percentComplete: number;
}

export interface RunProgress {
  stage: string;
  /** Set while a stage group runs: `stage` is only its first stage (the database has the current one). */
  stageGroup?: string[];
  stageIndex: number;
  totalStages: number;
  usage: UsageSummary;
  percentComplete: number;
  documentsProgress: DocumentProgress[];
  cpuMs: number;
  rssBytes: number;
}

export const TASK_QUEUE = "docslurp-pipeline";
export const WORKFLOW_ID_PREFIX = "run-";

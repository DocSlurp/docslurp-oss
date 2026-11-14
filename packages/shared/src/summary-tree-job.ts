import { z } from "zod";

import {
  SUMMARY_TREE_MAX_FAN_IN,
  SUMMARY_TREE_MAX_GROUP_SIZE,
  SUMMARY_TREE_MIN_DOCUMENT_LEAVES,
  SUMMARY_TREE_MIN_FAN_IN,
  SUMMARY_TREE_MIN_GROUP_SIZE,
  SUMMARY_TREE_SUMMARY_TARGET_WORDS,
} from "./summary-tree.js";
import { calculateAiUsageCostCents, type AiUsagePricing } from "./usage.js";

/**
 * Summary tree backfill: the job that builds trees for a project's already indexed documents (the build stage only
 * sees new uploads). Contract shared by the API, the worker, the SDK and the CLI.
 *
 * A job is started with a mandatory cost cap, runs leased on a worker, and can be cancelled. It parks as `blocked`,
 * holding no lease and making no call, while the deployment's build switch is off, while the provider balance probe
 * reports below its floor, or while the organization may not spend; it is looked at again on its own.
 */

/** Largest cap one job may be started with, in cents. A job needing more is started again after it stops. */
export const SUMMARY_TREE_BACKFILL_MAX_COST_CENTS = 10_000_000;

/** Body of `POST /v1/projects/:projectId/summary-tree/backfill`. The cap is mandatory: there is no uncapped job. */
export const startSummaryTreeBackfillSchema = z.object({
  /** The job stops before the model call that would pass this many cents. */
  maxCostCents: z.number().positive().max(SUMMARY_TREE_BACKFILL_MAX_COST_CENTS),
}).strict();
export type StartSummaryTreeBackfillInput = z.infer<typeof startSummaryTreeBackfillSchema>;

export const SUMMARY_TREE_JOB_STATUSES = ["queued", "running", "blocked", "completed", "failed", "cancelled"] as const;
export const summaryTreeJobStatusSchema = z.enum(SUMMARY_TREE_JOB_STATUSES);
export type SummaryTreeJobStatus = z.infer<typeof summaryTreeJobStatusSchema>;

/**
 * Why a job is parked.
 * - `build-off`: the deployment's build switch is off.
 * - `balance`: the deployment's provider balance probe reports below its floor, or could not answer.
 * - `credits`: the organization may not spend right now.
 * - `policy`: the project's privacy mode or model policy does not allow the summary model.
 */
export const SUMMARY_TREE_JOB_BLOCKED_REASONS = ["build-off", "balance", "credits", "policy"] as const;
export const summaryTreeJobBlockedReasonSchema = z.enum(SUMMARY_TREE_JOB_BLOCKED_REASONS);
export type SummaryTreeJobBlockedReason = z.infer<typeof summaryTreeJobBlockedReasonSchema>;

// --- Estimate ---------------------------------------------------------------------------------------------------------

export const summaryTreeBuildEstimateSchema = z.object({
  /** Documents the job will look at: current documents without a servable tree. */
  documents: z.number().int().nonnegative(),
  /** Of those, documents long enough to get a tree. The rest are marked skipped without a model call. */
  documentsToBuild: z.number().int().nonnegative(),
  pages: z.number().nonnegative(),
  leaves: z.number().int().nonnegative(),
  nodes: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costCents: z.number().nonnegative(),
  costCentsLow: z.number().nonnegative(),
  costCentsHigh: z.number().nonnegative(),
  seconds: z.number().nonnegative(),
  secondsLow: z.number().nonnegative(),
  secondsHigh: z.number().nonnegative(),
  /** `observed` once finished builds in this project (or organization) calibrate it. */
  basis: z.enum(["observed", "default"]),
});
export type SummaryTreeBuildEstimate = z.infer<typeof summaryTreeBuildEstimateSchema>;

/** What finished builds measured, per node and per call. */
export interface SummaryTreeBuildCalibration {
  /** Nodes the sample covers; below `SUMMARY_TREE_ESTIMATE_MIN_SAMPLE_NODES` the defaults are used. */
  sampleNodes: number;
  nodesPerLeaf: number;
  callsPerNode: number;
  inputTokensPerCall: number;
  outputTokensPerCall: number;
  /** Wall-clock seconds per node as the builds ran (their own concurrency included). */
  secondsPerNode: number;
}

export interface SummaryTreeBuildEstimateInput {
  /** One entry per document the job will look at: its leaves, the tokens in them and its pages. */
  documents: ReadonlyArray<{ leaves: number; leafTokens: number; pages: number }>;
  pricing: AiUsagePricing;
  /** Model calls in flight at once. */
  concurrency: number;
  calibration?: SummaryTreeBuildCalibration | null;
}

export const SUMMARY_TREE_ESTIMATE_MIN_SAMPLE_NODES = 20;
/** Instruction and framing around a group's text, in tokens. */
const PROMPT_OVERHEAD_TOKENS = 220;
/** Tokens per summary word, title line included. */
const TOKENS_PER_SUMMARY_WORD = 1.5;
/** Cut-off retries and group retries on top of one call per node. */
const DEFAULT_CALLS_PER_NODE = 1.05;
const DEFAULT_SECONDS_PER_CALL = 6;

/** Nodes a document of `leaves` leaves gets at the middle of the group and fan-in ranges: its groups and what sits above. */
export function estimateSummaryTreeNodes(leaves: number): { groups: number; nodes: number } {
  if (!Number.isFinite(leaves) || leaves < SUMMARY_TREE_MIN_DOCUMENT_LEAVES) return { groups: 0, nodes: 0 };
  const groupSize = (SUMMARY_TREE_MIN_GROUP_SIZE + SUMMARY_TREE_MAX_GROUP_SIZE) / 2;
  const fanIn = (SUMMARY_TREE_MIN_FAN_IN + SUMMARY_TREE_MAX_FAN_IN) / 2;
  const groups = Math.max(1, Math.ceil(leaves / groupSize));
  const upper = groups > 1 ? Math.ceil((groups - 1) / (fanIn - 1)) : 0;
  return { groups, nodes: groups + upper };
}

/**
 * Cost and wall-clock estimate of building trees for a set of documents, from counts alone: no document is read and
 * no model is called. Ranges are wide until finished builds calibrate them. Reuse from an earlier version is not
 * assumed: a document re-extracted since its last tree shares little with it.
 */
export function estimateSummaryTreeBuild(input: SummaryTreeBuildEstimateInput): SummaryTreeBuildEstimate {
  const calibration = input.calibration ?? null;
  const observed = Boolean(calibration && calibration.sampleNodes >= SUMMARY_TREE_ESTIMATE_MIN_SAMPLE_NODES);
  const summaryTokens = SUMMARY_TREE_SUMMARY_TARGET_WORDS * TOKENS_PER_SUMMARY_WORD;
  let documentsToBuild = 0;
  let pages = 0;
  let leaves = 0;
  let nodes = 0;
  let inputTokens = 0;
  for (const document of input.documents) {
    const shape = estimateSummaryTreeNodes(document.leaves);
    if (shape.nodes === 0) continue;
    documentsToBuild += 1;
    pages += Math.max(0, document.pages);
    leaves += document.leaves;
    const documentNodes = observed && calibration!.nodesPerLeaf > 0 ? Math.max(1, Math.round(document.leaves * calibration!.nodesPerLeaf)) : shape.nodes;
    nodes += documentNodes;
    // Every leaf is read once by its group; every summary but the root is read once by its parent.
    inputTokens += Math.max(0, document.leafTokens) + (documentNodes - 1) * summaryTokens + documentNodes * PROMPT_OVERHEAD_TOKENS;
  }
  const callsPerNode = observed && calibration!.callsPerNode >= 1 ? calibration!.callsPerNode : DEFAULT_CALLS_PER_NODE;
  const modelCalls = Math.ceil(nodes * callsPerNode);
  if (observed && calibration!.inputTokensPerCall > 0) inputTokens = modelCalls * calibration!.inputTokensPerCall;
  else inputTokens *= callsPerNode;
  const outputTokens = modelCalls * (observed && calibration!.outputTokensPerCall > 0 ? calibration!.outputTokensPerCall : summaryTokens);
  const costCents = calculateAiUsageCostCents({ inputTokens, outputTokens, ...input.pricing });
  const seconds = observed && calibration!.secondsPerNode > 0
    ? nodes * calibration!.secondsPerNode
    : (modelCalls * DEFAULT_SECONDS_PER_CALL) / Math.max(1, input.concurrency);
  const [low, high] = observed ? [0.75, 1.35] : [0.5, 2];
  return {
    documents: input.documents.length,
    documentsToBuild,
    pages,
    leaves,
    nodes,
    modelCalls,
    inputTokens: Math.round(inputTokens),
    outputTokens: Math.round(outputTokens),
    costCents,
    costCentsLow: costCents * low,
    costCentsHigh: costCents * high,
    seconds: Math.round(seconds),
    secondsLow: Math.round(seconds * low),
    secondsHigh: Math.round(seconds * high),
    basis: observed ? "observed" : "default",
  };
}

// --- Job --------------------------------------------------------------------------------------------------------------

export const summaryTreeJobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: summaryTreeJobStatusSchema,
  /** Set while `status` is `blocked`. */
  blockedReason: summaryTreeJobBlockedReasonSchema.nullable(),
  estimate: summaryTreeBuildEstimateSchema.nullable(),
  maxCostCents: z.number(),
  /** Documents the job set out to look at. */
  documentsTotal: z.number().int(),
  /** Documents whose tree is ready. */
  documentsReady: z.number().int(),
  /** Documents that get no tree (too short, tabular, media) or left the project while the job ran. */
  documentsSkipped: z.number().int(),
  /** Documents whose tree is incomplete after the job's retries; not served, picked up by the next job. */
  documentsPartial: z.number().int(),
  nodesBuilt: z.number().int(),
  modelCalls: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costCents: z.number(),
  /** Seconds left at the observed pace; null until enough has run. */
  etaSeconds: z.number().nullable(),
  error: z.string().nullable(),
  cancelRequested: z.boolean(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type SummaryTreeJob = z.infer<typeof summaryTreeJobSchema>;

/** A job that has not ended: queued, running, or parked. One per project. */
export function isSummaryTreeJobActive(job: Pick<SummaryTreeJob, "status">): boolean {
  return job.status === "queued" || job.status === "running" || job.status === "blocked";
}

/** `GET /v1/projects/:projectId/summary-tree/backfill`. */
export const projectSummaryTreeBackfillSchema = z.object({
  projectId: z.string(),
  /** What a job started now would cover and cost. */
  estimate: summaryTreeBuildEstimateSchema,
  activeJob: summaryTreeJobSchema.nullable(),
  lastJob: summaryTreeJobSchema.nullable(),
});
export type ProjectSummaryTreeBackfill = z.infer<typeof projectSummaryTreeBackfillSchema>;

/** Notes a finished job may carry in `error`; anything else the worker stored is internal. */
export const SUMMARY_TREE_JOB_NOTES = {
  cancelled: "Cancelled by request",
  costCap: "Stopped at the cost cap",
  disabled: "The summary tree was turned off for this project",
} as const;

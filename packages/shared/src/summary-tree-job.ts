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

/**
 * Largest cap the request schema accepts, in cents. The cap a deployment actually allows is lower: its operator's
 * ceiling (`summaryTreeBackfillCostCeilingCents`), which the API checks before a job is queued.
 */
export const SUMMARY_TREE_BACKFILL_MAX_COST_CENTS = 10_000_000;
/**
 * Smallest cap a job may be started with, in cents. The cap is stored with four decimals and must be above zero, so
 * a smaller value would round to a cap of nothing.
 */
export const SUMMARY_TREE_BACKFILL_MIN_COST_CENTS = 0.01;
/**
 * The operator's ceiling on one job's cap: `DOCSLURP_SUMMARY_TREE_BACKFILL_MAX_COST_CENTS`, in cents. Unset, empty or
 * not a number above zero: the default below. A job that needs more is started again after it stops at its cap.
 */
export const SUMMARY_TREE_BACKFILL_COST_CEILING_ENV = "DOCSLURP_SUMMARY_TREE_BACKFILL_MAX_COST_CENTS";
export const SUMMARY_TREE_BACKFILL_DEFAULT_COST_CEILING_CENTS = 10_000;
/** `code` of the refusal when a requested cap is above the deployment's ceiling. */
export const SUMMARY_TREE_BACKFILL_CAP_TOO_HIGH_CODE = "summary_tree_backfill_cap_too_high";

/** The most one backfill job may be capped at on this deployment, in cents. Never above the schema's own maximum. */
export function summaryTreeBackfillCostCeilingCents(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[SUMMARY_TREE_BACKFILL_COST_CEILING_ENV]?.trim() ?? "";
  const parsed = raw === "" ? Number.NaN : Number(raw);
  const ceiling = Number.isFinite(parsed) && parsed >= SUMMARY_TREE_BACKFILL_MIN_COST_CENTS ? parsed : SUMMARY_TREE_BACKFILL_DEFAULT_COST_CEILING_CENTS;
  return Math.min(ceiling, SUMMARY_TREE_BACKFILL_MAX_COST_CENTS);
}

/** Body of `POST /v1/projects/:projectId/summary-tree/backfill`. The cap is mandatory: there is no uncapped job. */
export const startSummaryTreeBackfillSchema = z.object({
  /**
   * The job stops before the model call that would pass this many cents. Counted in billed credits where the
   * deployment charges for the tree, in model cost otherwise (the estimate's `costBasis` says which).
   */
  maxCostCents: z.number().min(SUMMARY_TREE_BACKFILL_MIN_COST_CENTS).max(SUMMARY_TREE_BACKFILL_MAX_COST_CENTS),
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
 * - `unpriced`: the deployment charges for work but has no price for the summary tree unit.
 */
export const SUMMARY_TREE_JOB_BLOCKED_REASONS = ["build-off", "balance", "credits", "policy", "unpriced"] as const;
export const summaryTreeJobBlockedReasonSchema = z.enum(SUMMARY_TREE_JOB_BLOCKED_REASONS);
export type SummaryTreeJobBlockedReason = z.infer<typeof summaryTreeJobBlockedReasonSchema>;

// --- Estimate ---------------------------------------------------------------------------------------------------------

/**
 * What a job's cents count.
 * - `billed`: the deployment charges for the tree. Cents are credits billed to the organization, one summary tree
 *   unit per summary model call (billing.ts `summaryTreeUnitPrice`).
 * - `provider`: the deployment does not charge. Cents are the model's own cost, from its token prices.
 */
export const SUMMARY_TREE_COST_BASES = ["billed", "provider"] as const;
export const summaryTreeCostBasisSchema = z.enum(SUMMARY_TREE_COST_BASES);
export type SummaryTreeCostBasis = z.infer<typeof summaryTreeCostBasisSchema>;

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
  /** What the three cost figures count, and what the job's cap is counted in. */
  costBasis: summaryTreeCostBasisSchema.default("provider"),
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
  /**
   * Credits one summary tree unit bills (`summaryTreeUnitPrice`), where the deployment charges for the tree: the
   * estimate is then the billed credits of its model calls. Absent or null: the model's own cost from `pricing`.
   */
  unitCredits?: number | null;
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
  const billed = typeof input.unitCredits === "number" && Number.isFinite(input.unitCredits) && input.unitCredits > 0;
  // Billed: one unit per model call, the basis the job's cap is counted in. Otherwise the model's own token cost.
  const costCents = billed ? modelCalls * input.unitCredits! : calculateAiUsageCostCents({ inputTokens, outputTokens, ...input.pricing });
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
    costBasis: billed ? "billed" : "provider",
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
  /** What counted against `maxCostCents` so far, on the estimate's `costBasis`. */
  costCents: z.number(),
  costBasis: summaryTreeCostBasisSchema.default("provider"),
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
  /**
   * What a job started now would cover and cost: a recent estimate, refreshed about once a minute (the estimate route
   * and a started job's own estimate are always current). Null on a deployment that charges for work but has no price
   * for the tree.
   */
  estimate: summaryTreeBuildEstimateSchema.nullable(),
  activeJob: summaryTreeJobSchema.nullable(),
  lastJob: summaryTreeJobSchema.nullable(),
});
export type ProjectSummaryTreeBackfill = z.infer<typeof projectSummaryTreeBackfillSchema>;

/** Notes a finished job may carry in `error`; anything else the worker stored is internal. */
export const SUMMARY_TREE_JOB_NOTES = {
  cancelled: "Cancelled by request",
  costCap: "Stopped at the cost cap",
  disabled: "The summary tree was turned off for this project",
  /** A parked job that could not continue for `SUMMARY_TREE_JOB_MAX_PARKED_MS` ends `failed` with this note. */
  parkedTooLong: "Parked too long without being able to continue; start it again once the cause is resolved",
} as const;

/**
 * A parked job waits this long before it is looked at again the first time, twice as long after every further park
 * in a row, and never longer than the maximum. A job that stays parked for `SUMMARY_TREE_JOB_MAX_PARKED_MS` without
 * making progress ends `failed` (`SUMMARY_TREE_JOB_NOTES.parkedTooLong`), so parked jobs do not pile up.
 */
export const SUMMARY_TREE_JOB_PARK_BASE_MS = 60_000;
export const SUMMARY_TREE_JOB_PARK_MAX_MS = 30 * 60_000;
export const SUMMARY_TREE_JOB_MAX_PARKED_MS = 3 * 24 * 60 * 60_000;

/** How long the `parks`-th park in a row waits (`parks` counts from 1). */
export function summaryTreeJobParkDelayMs(parks: number, baseMs: number = SUMMARY_TREE_JOB_PARK_BASE_MS, maxMs: number = SUMMARY_TREE_JOB_PARK_MAX_MS): number {
  const step = Number.isFinite(parks) && parks > 1 ? Math.min(Math.floor(parks) - 1, 30) : 0;
  return Math.min(Math.max(0, maxMs), Math.max(0, baseMs) * 2 ** step);
}

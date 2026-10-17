import { z } from "zod";

import {
  defaultGraphEntityTypes,
  graphConfigSchema,
  graphEntityTypeSchema,
  type GraphConfig,
  type GraphDepth,
} from "./pipeline.js";
import { calculateAiUsageCostCents, type AiUsagePricing } from "./usage.js";

/**
 * What each graph depth buys. `windows` caps extraction calls per document;
 * when a document has more text than fits, windows are sampled evenly across
 * it. Shared so the worker's behavior and the API's estimates cannot drift.
 */
export const graphDepthProfiles: Record<
  GraphDepth,
  { windowChars: number; windows: number; maxOutputTokens: number; minConfidence: number }
> = {
  lean: { windowChars: 16_000, windows: 1, maxOutputTokens: 1200, minConfidence: 0.6 },
  standard: { windowChars: 12_000, windows: 4, maxOutputTokens: 1600, minConfidence: 0.5 },
  deep: { windowChars: 12_000, windows: 12, maxOutputTokens: 2400, minConfidence: 0.35 },
};

export const graphDepths = ["lean", "standard", "deep"] as const satisfies readonly GraphDepth[];

/** Community summaries are capped so re-clustering a large graph stays bounded. */
export const MAX_SUMMARIZED_GRAPH_COMMUNITIES = 200;

/** Entity types extraction uses for a config (the generic set when unset). */
export function effectiveGraphEntityTypes(config: Pick<GraphConfig, "entityTypes">): string[] {
  return config.entityTypes.length ? [...config.entityTypes] : [...defaultGraphEntityTypes];
}

/**
 * Stable fingerprint of everything that changes what extraction produces.
 * Documents extracted under another fingerprint are "stale". FNV-1a keeps it
 * dependency-free for browser and worker alike.
 */
export function graphConfigFingerprint(config: GraphConfig, model: string): string {
  const canonical = JSON.stringify({
    domain: config.domain?.trim() || null,
    entityTypes: [...effectiveGraphEntityTypes(config)].sort(),
    depth: config.depth,
    model,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // g2 preserves directed relationship endpoints; g1 graphs may contain
  // reversed edges. Mark them stale without scheduling a rebuild.
  return `g2-${hash.toString(16).padStart(8, "0")}`;
}

/** Observed per-window figures from earlier builds, used in place of defaults. */
export interface GraphBuildCalibration {
  inputTokensPerWindow?: number | null;
  outputTokensPerWindow?: number | null;
  secondsPerWindow?: number | null;
  /** Number of windows the observation averages over. */
  sampleWindows?: number | null;
}

export interface GraphBuildEstimateInput {
  /** Characters of chunk text per document to extract. */
  documentChars: number[];
  config: GraphConfig;
  pricing: AiUsagePricing;
  /** Documents extracted at once by the worker. */
  concurrency: number;
  calibration?: GraphBuildCalibration | null;
}

export const graphBuildEstimateSchema = z.object({
  depth: z.enum(graphDepths),
  documents: z.number().int().nonnegative(),
  characters: z.number().int().nonnegative(),
  windows: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  communitySummaries: z.number().int().nonnegative(),
  costCents: z.number().nonnegative(),
  costCentsLow: z.number().nonnegative(),
  costCentsHigh: z.number().nonnegative(),
  seconds: z.number().nonnegative(),
  secondsLow: z.number().nonnegative(),
  secondsHigh: z.number().nonnegative(),
  /** `observed` once a finished build in this workspace (or org) calibrates it. */
  basis: z.enum(["observed", "default"]),
});
export type GraphBuildEstimate = z.infer<typeof graphBuildEstimateSchema>;

const PROMPT_OVERHEAD_TOKENS = 450;
const KNOWN_ENTITY_HINT_TOKENS = 160;
const DEFAULT_OUTPUT_SHARE = 0.45;
const DEFAULT_SECONDS_PER_WINDOW = 9;
const ENTITIES_PER_WINDOW = 10;
const ENTITIES_PER_COMMUNITY = 6;
const COMMUNITY_SUMMARY_INPUT_TOKENS = 380;
const COMMUNITY_SUMMARY_OUTPUT_TOKENS = 120;
const SECONDS_PER_COMMUNITY_SUMMARY = 2.5;

/** Windows extraction will use for a document of `chars` characters. */
export function graphWindowsForDocument(chars: number, depth: GraphDepth): number {
  if (chars <= 0) return 0;
  const profile = graphDepthProfiles[depth];
  // Windows pack whole chunks, so they run a little under the character cap.
  return Math.min(profile.windows, Math.ceil(chars / (profile.windowChars * 0.9)));
}

/**
 * Cost and wall-clock estimate for extracting a set of documents and
 * re-summarizing communities. Ranges are wide on purpose until calibrated.
 */
export function estimateGraphBuild(input: GraphBuildEstimateInput): GraphBuildEstimate {
  const profile = graphDepthProfiles[input.config.depth];
  const calibration = input.calibration ?? null;
  const observed = Boolean(calibration?.sampleWindows && calibration.sampleWindows >= 4);
  const domainTokens = Math.ceil((input.config.domain?.length ?? 0) / 4);

  let windows = 0;
  let characters = 0;
  let inputTokens = 0;
  for (const chars of input.documentChars) {
    const documentWindows = graphWindowsForDocument(chars, input.config.depth);
    if (documentWindows === 0) continue;
    windows += documentWindows;
    characters += chars;
    const readChars = Math.min(chars, documentWindows * profile.windowChars);
    inputTokens +=
      Math.ceil(readChars / 4) +
      documentWindows * (PROMPT_OVERHEAD_TOKENS + domainTokens) +
      (documentWindows - 1) * KNOWN_ENTITY_HINT_TOKENS;
  }
  if (observed && calibration?.inputTokensPerWindow) {
    inputTokens = Math.round(windows * calibration.inputTokensPerWindow);
  }
  const outputPerWindow =
    observed && calibration?.outputTokensPerWindow
      ? calibration.outputTokensPerWindow
      : profile.maxOutputTokens * DEFAULT_OUTPUT_SHARE;
  let outputTokens = Math.round(windows * outputPerWindow);

  const communitySummaries = Math.min(
    MAX_SUMMARIZED_GRAPH_COMMUNITIES,
    Math.ceil((windows * ENTITIES_PER_WINDOW) / ENTITIES_PER_COMMUNITY),
  );
  inputTokens += communitySummaries * COMMUNITY_SUMMARY_INPUT_TOKENS;
  outputTokens += communitySummaries * COMMUNITY_SUMMARY_OUTPUT_TOKENS;

  const costCents = calculateAiUsageCostCents({ inputTokens, outputTokens, ...input.pricing });
  const secondsPerWindow =
    observed && calibration?.secondsPerWindow ? calibration.secondsPerWindow : DEFAULT_SECONDS_PER_WINDOW;
  const concurrency = Math.max(1, input.concurrency);
  const seconds =
    (windows * secondsPerWindow + communitySummaries * SECONDS_PER_COMMUNITY_SUMMARY) / concurrency;
  const [low, high] = observed ? [0.75, 1.35] : [0.5, 2];

  return {
    depth: input.config.depth,
    documents: input.documentChars.filter((chars) => chars > 0).length,
    characters,
    windows,
    inputTokens,
    outputTokens,
    communitySummaries,
    costCents,
    costCentsLow: costCents * low,
    costCentsHigh: costCents * high,
    seconds: Math.round(seconds),
    secondsLow: Math.round(seconds * low),
    secondsHigh: Math.round(seconds * high),
    basis: observed ? "observed" : "default",
  };
}

/** Partial graph settings update; fields left out keep their current value. */
export const updateWorkspaceGraphSchema = z
  .object({
    enabled: z.boolean().optional(),
    domain: z.string().trim().max(2000).nullable().optional(),
    entityTypes: z.array(graphEntityTypeSchema).max(16).optional(),
    depth: z.enum(graphDepths).optional(),
  })
  .strict();
export type UpdateWorkspaceGraphInput = z.infer<typeof updateWorkspaceGraphSchema>;

export const graphRebuildModeSchema = z.enum(["stale", "full"]);
export type GraphRebuildMode = z.infer<typeof graphRebuildModeSchema>;

export const startGraphRebuildSchema = z
  .object({
    /** `stale`: documents never extracted or extracted with other settings. `full`: every current document. */
    mode: graphRebuildModeSchema.default("stale"),
    /** Stop the job once actual spend reaches this many cents. */
    maxCostCents: z.number().positive().nullable().optional(),
  })
  .strict();
export type StartGraphRebuildInput = z.infer<typeof startGraphRebuildSchema>;

export const graphJobStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"]);
export type GraphJobStatus = z.infer<typeof graphJobStatusSchema>;

export const graphJobSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  mode: graphRebuildModeSchema,
  status: graphJobStatusSchema,
  phase: z.enum(["queued", "extracting", "communities", "done"]),
  config: graphConfigSchema,
  configHash: z.string(),
  model: z.string(),
  estimate: graphBuildEstimateSchema.nullable(),
  maxCostCents: z.number().nullable(),
  documentsTotal: z.number().int(),
  documentsProcessed: z.number().int(),
  documentsFailed: z.number().int(),
  windowsProcessed: z.number().int(),
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
export type GraphJob = z.infer<typeof graphJobSchema>;

export function isGraphJobActive(job: Pick<GraphJob, "status">): boolean {
  return job.status === "queued" || job.status === "running";
}

export const workspaceGraphStatusSchema = z.object({
  workspaceId: z.string(),
  enabled: z.boolean(),
  config: graphConfigSchema,
  configHash: z.string(),
  model: z.string(),
  /** The default vocabulary applied when `config.entityTypes` is empty. */
  effectiveEntityTypes: z.array(z.string()),
  /** Scope extraction uses when `config.domain` is empty. */
  fallbackScope: z.string(),
  stats: z.object({
    entities: z.number().int(),
    relationships: z.number().int(),
    communities: z.number().int(),
    mentions: z.number().int(),
    entityTypes: z.array(z.object({ type: z.string(), count: z.number().int() })),
  }),
  coverage: z.object({
    /** Current (completed, not superseded) documents. */
    documents: z.number().int(),
    /** Extracted with the current settings. */
    current: z.number().int(),
    /** Extracted with other settings. */
    stale: z.number().int(),
    /** Never extracted. */
    missing: z.number().int(),
    lastExtractedAt: z.string().nullable(),
  }),
  estimates: z.object({
    stale: graphBuildEstimateSchema,
    full: graphBuildEstimateSchema,
    /** Full rebuild at each depth, so the depth choice shows its price. */
    fullByDepth: z.record(z.enum(graphDepths), graphBuildEstimateSchema),
  }),
  activeJob: graphJobSchema.nullable(),
  lastJob: graphJobSchema.nullable(),
});
export type WorkspaceGraphStatus = z.infer<typeof workspaceGraphStatusSchema>;

/** Scope used when a workspace leaves `graph.domain` empty: its own definition. */
export function graphFallbackScope(workspace: { name: string; templateDescription?: string | null }): string {
  return [`Workspace "${workspace.name}"`, workspace.templateDescription?.trim()]
    .filter(Boolean)
    .join(": ");
}

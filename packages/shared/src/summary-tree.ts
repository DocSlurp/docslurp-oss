import { z } from "zod";

/**
 * Summary tree: shared contract.
 *
 * An opt-in, per-project derived index: model-written summaries of contiguous sections inside each long document, one
 * root per document. Summary rows live in a second LanceDB table (`summaries`, see vector-namespace.ts) in the project's
 * own database; Postgres holds a per-document state row and a node registry without text
 * (`document_summary_trees`, `document_summary_tree_nodes`).
 *
 * Two settings, both off unless a project owner turns them on:
 *
 * - pipeline `summaryTree: { enabled }`: build the tree for this project's documents.
 * - retrieval `summaryTree: "off" | "guide" | "include"`: how search uses it.
 *
 * Everything else (group sizes, summary length, deadline factors) is a server constant below, shown read-only in
 * `GET /v1/projects/:projectId/state`. There is no tenant-supplied prompt.
 */

// --- Settings ---------------------------------------------------------------------------------------------------------

/** Pipeline (build) setting. Changed only through `PATCH /v1/projects/:projectId/summary-tree`. */
export const summaryTreePipelineConfigSchema = z.object({ enabled: z.boolean().default(false) }).strict();
export type SummaryTreePipelineConfig = z.infer<typeof summaryTreePipelineConfigSchema>;
export const defaultSummaryTreePipelineConfig: SummaryTreePipelineConfig = { enabled: false };

/**
 * Retrieval (serve) setting.
 * - `off`: search never reads the summaries table.
 * - `guide`: summary hits select chunk ranges; returned and cited evidence is real chunks only.
 * - `include`: summary text is also returned, labelled, capped to a share of the context.
 */
export const SUMMARY_TREE_SEARCH_MODES = ["off", "guide", "include"] as const;
export const summaryTreeSearchModeSchema = z.enum(SUMMARY_TREE_SEARCH_MODES);
export type SummaryTreeSearchMode = z.infer<typeof summaryTreeSearchModeSchema>;
export const DEFAULT_SUMMARY_TREE_SEARCH_MODE: SummaryTreeSearchMode = "off";

/** Body of the partial settings endpoint: the only way the pipeline setting changes. */
export const updateProjectSummaryTreeSchema = z.object({ enabled: z.boolean() }).strict();
export type UpdateProjectSummaryTreeInput = z.infer<typeof updateProjectSummaryTreeSchema>;

// --- Deployment kill switches ----------------------------------------------------------------------------------------

/**
 * Two deployment kill switches, independent of each other. Each is on only for `on`, `1`, `true` or `yes` (trimmed, any
 * case); unset and unknown values are off (fail closed).
 *
 * - `DOCSLURP_SUMMARY_TREE_BUILD`: off means no tree is built and no summary model call is made, whatever projects
 *   say. The settings API refuses to enable the tree, and a project that already stores `enabled: true` stays inert.
 * - `DOCSLURP_SUMMARY_TREE_SERVE`: off means search never reads the summaries table; a retrieval adapter must return
 *   nothing, and the response is the same as for a project without a tree.
 *
 * A project keeps its stored settings whatever the switches say; the switches only cap what runs.
 */
export const SUMMARY_TREE_BUILD_ENV_FLAG = "DOCSLURP_SUMMARY_TREE_BUILD";
export const SUMMARY_TREE_SERVE_ENV_FLAG = "DOCSLURP_SUMMARY_TREE_SERVE";

export const SUMMARY_TREE_ENV_ON_VALUES: readonly string[] = ["on", "1", "true", "yes"];
export const SUMMARY_TREE_ENV_OFF_VALUES: readonly string[] = ["", "off", "0", "false", "no"];

type Env = Readonly<Record<string, string | undefined>>;

function switchOn(env: Env, flag: string): boolean {
  const value = env[flag]?.trim().toLowerCase();
  return value !== undefined && SUMMARY_TREE_ENV_ON_VALUES.includes(value);
}

/** Whether this deployment builds summary trees. `env` is explicit so browsers and tests never read `process`. */
export function summaryTreeBuildAvailable(env: Env): boolean {
  return switchOn(env, SUMMARY_TREE_BUILD_ENV_FLAG);
}

/** Whether this deployment lets search read summary trees. */
export function summaryTreeServeAvailable(env: Env): boolean {
  return switchOn(env, SUMMARY_TREE_SERVE_ENV_FLAG);
}

/** Startup warnings for switch values the parser does not know (each is treated as off). */
export function summaryTreeSwitchWarnings(env: Env): string[] {
  const warnings: string[] = [];
  for (const flag of [SUMMARY_TREE_BUILD_ENV_FLAG, SUMMARY_TREE_SERVE_ENV_FLAG]) {
    const raw = env[flag];
    if (raw === undefined) continue;
    const value = raw.trim().toLowerCase();
    if (SUMMARY_TREE_ENV_ON_VALUES.includes(value) || SUMMARY_TREE_ENV_OFF_VALUES.includes(value)) continue;
    warnings.push(`[summary-tree] ${flag} has an unknown value; it is treated as off (expected on or off)`);
  }
  return warnings;
}

// --- What runs --------------------------------------------------------------------------------------------------------

type TreePipeline = {
  summaryTree?: { enabled?: boolean } | null;
  embed?: boolean;
  indexVectors?: boolean;
} | null | undefined;

/** The stored pipeline setting, whatever the switches say. */
export function summaryTreeEnabled(pipeline: TreePipeline): boolean {
  return pipeline?.summaryTree?.enabled === true;
}

/**
 * Whether a run of this pipeline may build tree nodes: the project turned the tree on, the pipeline embeds and indexes
 * vectors, and the deployment's build switch is on. Every build path (stage, backfill batch) asks this before each
 * model call; false means zero calls.
 */
export function summaryTreeBuildActive(pipeline: TreePipeline, env: Env): boolean {
  return summaryTreeEnabled(pipeline)
    && pipeline?.embed === true
    && pipeline?.indexVectors === true
    && summaryTreeBuildAvailable(env);
}

/**
 * The search mode a request actually runs. It is `off` unless the pipeline has the tree enabled and the serve switch is
 * on; it is never derived "on" from the pipeline (the request or the project's retrieval default has to ask). A
 * per-request value wins over the project default. An unknown value is `off`.
 */
export function effectiveSummaryTreeSearchMode(args: {
  pipeline: TreePipeline;
  /** Per-request override. */
  requested?: SummaryTreeSearchMode | null;
  /** The project's retrieval default. */
  projectDefault?: SummaryTreeSearchMode | null;
  env: Env;
}): SummaryTreeSearchMode {
  if (!summaryTreeEnabled(args.pipeline) || !summaryTreeServeAvailable(args.env)) return "off";
  const mode = summaryTreeSearchModeSchema.safeParse(args.requested ?? args.projectDefault ?? DEFAULT_SUMMARY_TREE_SEARCH_MODE);
  return mode.success ? mode.data : "off";
}

/** Why a requested mode does not run, for the response field a later phase adds. */
export function summaryTreeSearchRefusal(args: { pipeline: TreePipeline; env: Env }): "disabled" | "serve-off" | null {
  if (!summaryTreeEnabled(args.pipeline)) return "disabled";
  if (!summaryTreeServeAvailable(args.env)) return "serve-off";
  return null;
}

// --- Settings rules ---------------------------------------------------------------------------------------------------

export const SUMMARY_TREE_BUILD_UNAVAILABLE_CODE = "summary_tree_unavailable";
export const SUMMARY_TREE_REQUIRES_VECTORS_CODE = "summary_tree_requires_vectors";
export const SUMMARY_TREE_SUMMARIZE_LOCKED_CODE = "summary_tree_summarize_locked";

export const SUMMARY_TREE_REQUIRES_VECTORS_MESSAGE =
  "The summary tree needs embeddings and the vector index; enable embed and indexVectors for this project first";
export const SUMMARY_TREE_SUMMARIZE_LOCKED_MESSAGE =
  "This project's template keeps document summaries off, and the summary tree needs them; choose another template first";

/** A summary-tree setting that cannot be stored. `code` is stable; `status` is the HTTP status the API answers with. */
export class SummaryTreeConfigError extends Error {
  constructor(
    readonly code: typeof SUMMARY_TREE_BUILD_UNAVAILABLE_CODE | typeof SUMMARY_TREE_REQUIRES_VECTORS_CODE | typeof SUMMARY_TREE_SUMMARIZE_LOCKED_CODE,
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
    this.name = "SummaryTreeConfigError";
  }
}

/**
 * The tree cannot exist without vectors: its nodes are embedded into the project's vector database and its leaves are
 * the indexed chunks. Returns the problem, or null. The pipeline schema calls this, so no stored or requested pipeline
 * can hold the tree without both.
 */
export function summaryTreeVectorProblem(pipeline: TreePipeline): string | null {
  if (!summaryTreeEnabled(pipeline)) return null;
  return pipeline?.embed === true && pipeline?.indexVectors === true ? null : SUMMARY_TREE_REQUIRES_VECTORS_MESSAGE;
}

/**
 * Enabling the tree turns document summaries on (the tree's root is the document summary); `summarize` never implies
 * the tree. Applied by `normalizePipelineFeatures`, so every stored pipeline with the tree on also has `summarize`.
 */
export function coerceSummaryTreeSummarize<T extends { summaryTree?: { enabled?: boolean } | null; summarize?: boolean }>(pipeline: T): T {
  return summaryTreeEnabled(pipeline) && pipeline.summarize !== true ? { ...pipeline, summarize: true } : pipeline;
}

// --- Server constants -------------------------------------------------------------------------------------------------

/** Bumped when grouping or hashing changes in a way that makes stored node hashes incomparable. Part of every node hash. */
export const SUMMARY_TREE_KEY_VERSION = 1;

/** A group (one summary node) covers at least this many children, counted in leaves or nodes, never tokens. */
export const SUMMARY_TREE_MIN_GROUP_SIZE = 4;
/** ...and at most this many; a longer section is cut at its lowest adjacent-similarity boundaries. */
export const SUMMARY_TREE_MAX_GROUP_SIZE = 12;
/** Children per node above the leaf level. */
export const SUMMARY_TREE_MAX_FAN_IN = 8;
/** Documents with fewer leaf chunks get no tree (the long-document floor). */
export const SUMMARY_TREE_MIN_DOCUMENT_LEAVES = 24;
/** Hard cap on nodes per document; a document that would exceed it is marked partial, never truncated silently. */
export const SUMMARY_TREE_MAX_NODES_PER_DOCUMENT = 5_000;
/** Levels above the leaves, root included. */
export const SUMMARY_TREE_MAX_LEVELS = 8;
/** Target summary length in words. A target, not a cap: a truncated summary is retried, never stored. */
export const SUMMARY_TREE_SUMMARY_TARGET_WORDS = 120;
/** A document whose leaves are more than this share tables is skipped. */
export const SUMMARY_TREE_MAX_TABLE_LEAF_SHARE = 0.5;
/** `include` mode: summary text takes at most this share of the returned context. */
export const SUMMARY_TREE_INCLUDE_CONTEXT_SHARE = 0.25;
/**
 * Deadline of the summary search leg relative to the chunk vector leg: with `Tv` that leg's elapsed time, the tree leg
 * must settle by `max(Tv * FACTOR, Tv + GRACE_MS)` or contribute nothing. Provisional until the latency measurement
 * sets them (`SUMMARY_TREE_DEADLINE_CALIBRATED`).
 */
export const SUMMARY_TREE_DEADLINE_FACTOR = 1.5;
export const SUMMARY_TREE_DEADLINE_GRACE_MS = 50;
export const SUMMARY_TREE_DEADLINE_CALIBRATED = false;

/** Normalized formats that never get a tree: tabular and structured data has no prose sections to summarize. */
export const SUMMARY_TREE_SKIPPED_FORMATS: readonly string[] = ["office-excel", "structured-csv", "structured-json"];

/** The deadline of the tree leg, in milliseconds since the search legs started. */
export function summaryTreeDeadlineMs(chunkLegMs: number): number {
  const elapsed = Number.isFinite(chunkLegMs) && chunkLegMs > 0 ? chunkLegMs : 0;
  return Math.max(elapsed * SUMMARY_TREE_DEADLINE_FACTOR, elapsed + SUMMARY_TREE_DEADLINE_GRACE_MS);
}

export const summaryTreeConstantsSchema = z.object({
  keyVersion: z.number().int(),
  minGroupSize: z.number().int(),
  maxGroupSize: z.number().int(),
  maxFanIn: z.number().int(),
  minDocumentLeaves: z.number().int(),
  maxNodesPerDocument: z.number().int(),
  maxLevels: z.number().int(),
  summaryTargetWords: z.number().int(),
  maxTableLeafShare: z.number(),
  includeContextShare: z.number(),
  deadlineFactor: z.number(),
  deadlineGraceMs: z.number(),
  deadlineCalibrated: z.boolean(),
  skippedFormats: z.array(z.string()),
});
export type SummaryTreeConstants = z.infer<typeof summaryTreeConstantsSchema>;

/** The constants as the state endpoint reports them (read-only). */
export const SUMMARY_TREE_CONSTANTS: SummaryTreeConstants = Object.freeze({
  keyVersion: SUMMARY_TREE_KEY_VERSION,
  minGroupSize: SUMMARY_TREE_MIN_GROUP_SIZE,
  maxGroupSize: SUMMARY_TREE_MAX_GROUP_SIZE,
  maxFanIn: SUMMARY_TREE_MAX_FAN_IN,
  minDocumentLeaves: SUMMARY_TREE_MIN_DOCUMENT_LEAVES,
  maxNodesPerDocument: SUMMARY_TREE_MAX_NODES_PER_DOCUMENT,
  maxLevels: SUMMARY_TREE_MAX_LEVELS,
  summaryTargetWords: SUMMARY_TREE_SUMMARY_TARGET_WORDS,
  maxTableLeafShare: SUMMARY_TREE_MAX_TABLE_LEAF_SHARE,
  includeContextShare: SUMMARY_TREE_INCLUDE_CONTEXT_SHARE,
  deadlineFactor: SUMMARY_TREE_DEADLINE_FACTOR,
  deadlineGraceMs: SUMMARY_TREE_DEADLINE_GRACE_MS,
  deadlineCalibrated: SUMMARY_TREE_DEADLINE_CALIBRATED,
  skippedFormats: [...SUMMARY_TREE_SKIPPED_FORMATS],
});

// --- Stored state -----------------------------------------------------------------------------------------------------

/**
 * `document_summary_trees.status`. `pending`: queued, nothing built. `building`: groups are being committed.
 * `partial`: a group failed after its retries or the coverage check did not hold; the document is not served.
 * `ready`: every leaf is under exactly one group and every node under exactly one parent; servable.
 * `skipped`: the document gets no tree (`skip_reason` says why).
 */
export const SUMMARY_TREE_DOCUMENT_STATUSES = ["pending", "building", "partial", "ready", "skipped"] as const;
export const summaryTreeDocumentStatusSchema = z.enum(SUMMARY_TREE_DOCUMENT_STATUSES);
export type SummaryTreeDocumentStatus = z.infer<typeof summaryTreeDocumentStatusSchema>;

/** `document_summary_tree_nodes.status`. Only `ready` nodes have a row in the summaries table. */
export const SUMMARY_TREE_NODE_STATUSES = ["pending", "ready", "failed"] as const;
export const summaryTreeNodeStatusSchema = z.enum(SUMMARY_TREE_NODE_STATUSES);
export type SummaryTreeNodeStatus = z.infer<typeof summaryTreeNodeStatusSchema>;

/** `document_summary_trees.skip_reason`. */
export const SUMMARY_TREE_SKIP_REASONS = ["format", "tables", "short", "media", "pii", "no-leaves"] as const;
export const summaryTreeSkipReasonSchema = z.enum(SUMMARY_TREE_SKIP_REASONS);
export type SummaryTreeSkipReason = z.infer<typeof summaryTreeSkipReasonSchema>;

/** Project-level build status in the state endpoint. */
export const SUMMARY_TREE_BUILD_STATUSES = ["off", "building", "partial", "ready"] as const;
export const summaryTreeBuildStatusSchema = z.enum(SUMMARY_TREE_BUILD_STATUSES);
export type SummaryTreeBuildStatus = z.infer<typeof summaryTreeBuildStatusSchema>;

export const summaryTreeDocumentCountsSchema = z.object({
  /** Current documents of the project (completed, not superseded). */
  total: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  building: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /** Current documents with no tree state yet. */
  missing: z.number().int().nonnegative(),
});
export type SummaryTreeDocumentCounts = z.infer<typeof summaryTreeDocumentCountsSchema>;

/**
 * `off`: the project has not enabled the tree. Otherwise `building` while any document is pending or building,
 * `partial` while any document is partial or has no tree state yet, and `ready` when every current document is ready
 * or skipped. The deployment switches do not change it: they are reported beside it.
 */
export function summaryTreeBuildStatus(enabled: boolean, counts: SummaryTreeDocumentCounts): SummaryTreeBuildStatus {
  if (!enabled) return "off";
  if (counts.building > 0) return "building";
  if (counts.partial > 0 || counts.missing > 0) return "partial";
  return "ready";
}

/** The `summaryTree` block of `GET /v1/projects/:projectId/state`. */
export const projectSummaryTreeStateSchema = z.object({
  /** The stored pipeline setting. */
  enabled: z.boolean(),
  /** The deployment builds trees (`DOCSLURP_SUMMARY_TREE_BUILD`). False: the setting cannot be turned on and builds nothing. */
  buildAvailable: z.boolean(),
  /** The deployment lets search read trees (`DOCSLURP_SUMMARY_TREE_SERVE`). */
  serveAvailable: z.boolean(),
  /** The project's stored retrieval default. */
  searchMode: summaryTreeSearchModeSchema,
  /** What a search with no per-request override runs. */
  effectiveSearchMode: summaryTreeSearchModeSchema,
  status: summaryTreeBuildStatusSchema,
  documents: summaryTreeDocumentCountsSchema,
  /** Registry rows of current documents with a row in the summaries table. */
  nodes: z.number().int().nonnegative(),
  constants: summaryTreeConstantsSchema,
});
export type ProjectSummaryTreeState = z.infer<typeof projectSummaryTreeStateSchema>;

// --- Summaries table row ----------------------------------------------------------------------------------------------

/**
 * One row of the `summaries` LanceDB table. `chunkStart`/`chunkEnd` are inclusive `document_chunks.chunk_index`
 * bounds, so `guide` mode fetches the covered chunks with one Postgres query. One row belongs to one document.
 */
export const summaryRowSchema = z.object({
  id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_:.-]+$/),
  documentId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
  runId: z.string().min(1).max(200),
  level: z.number().int().min(1).max(SUMMARY_TREE_MAX_LEVELS),
  chunkStart: z.number().int().nonnegative(),
  chunkEnd: z.number().int().nonnegative(),
  pageStart: z.number().int().nonnegative(),
  pageEnd: z.number().int().nonnegative(),
  /** Heading trail joined with " > "; empty when the section has no heading. */
  headingPath: z.string().max(2_000),
  text: z.string().min(1),
  vector: z.array(z.number().finite()).min(1),
}).strict().superRefine((row, ctx) => {
  if (row.chunkEnd < row.chunkStart) ctx.addIssue({ code: "custom", path: ["chunkEnd"], message: "chunkEnd must not be before chunkStart" });
  if (row.pageEnd < row.pageStart) ctx.addIssue({ code: "custom", path: ["pageEnd"], message: "pageEnd must not be before pageStart" });
});
export type SummaryRow = z.infer<typeof summaryRowSchema>;

/** Column order of the summaries table (the row shape above). */
export const SUMMARY_ROW_COLUMNS = [
  "id", "documentId", "runId", "level", "chunkStart", "chunkEnd", "pageStart", "pageEnd", "headingPath", "text", "vector",
] as const satisfies ReadonlyArray<keyof SummaryRow>;

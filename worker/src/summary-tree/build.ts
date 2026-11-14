import { SUMMARY_TREE_BUILD_HEARTBEAT_MS, SUMMARY_TREE_BUILD_STALE_MS, summaryTreeNodeCap, type SummaryRow, type SummaryTreeSkipReason } from "@docslurp/shared";
import type { Sql } from "postgres";

import {
  appendSummaryTreeRecords,
  compactSummaryTreeArtifact,
  readSummaryTreeArtifact,
  summaryTreeArtifactRoot,
  summaryTreePackKey,
  type SummaryTreeArtifactIO,
  type SummaryTreeRecord,
} from "./artifact.js";
import { checkSummaryTreeCoverage } from "./coverage.js";
import { SummaryTreeBuilder, type SummaryTreeNode } from "./grouping.js";
import { hashSummaryTreeNodes, leafHash, summaryTreeContextKey, type SummaryTreeHashContext } from "./hash.js";
import { createLeafTextSpool, scanEmbeddingArtifactLeaves, type LeafTextStore, type SummaryTreeLeafIndex } from "./leaf-index.js";
import { summaryTreeFormatSkipReason, type SummaryTreeDocumentSkipReason } from "./leaves.js";
import { resolveSummaryTreeLimits, SummaryTreeInputError, type SummaryTreeLimits } from "./limits.js";
import { planSummaryReuse, type StoredSummary, type SummaryReuseSource } from "./reuse.js";
import {
  deleteSummaryTreeNodes,
  findSummaryReusePredecessor,
  linkSummaryTreeNodes,
  loadSummaryTreeNodes,
  loadSummaryTreeState,
  readSummaryTreeCoverage,
  staleSummaryTreeNodeIds,
  summaryTreeCoverageProblems,
  SummaryTreeStateRefused,
  touchSummaryTreeBuild,
  upsertSummaryTreeNodes,
  writeSummaryTreeState as writeSummaryTreeStateRow,
  type SummaryTreeStateWrite,
  type StoredSummaryTreeNode,
  type SummaryTreeNodeRecord,
  type SummaryTreeScope,
} from "./state-store.js";
import {
  buildSummaryTreePrompt,
  generateSummaryWithRetry,
  summaryOutputTokenBudget,
  type SummaryCallResult,
  type SummaryCallUsage,
  type SummaryParseFailure,
} from "./summary.js";

/*
 * Builds one document's summary tree: the whole flow of the `summary-tree` stage for one document, with the
 * model, the embedder, usage recording and the spend decision injected. The pipeline stage and the backfill job
 * are thin callers of `buildDocumentSummaryTree`.
 *
 *   format skip -> scan the embed artifact (leaves, leaf hashes, adjacent similarities) -> skip rules
 *   -> state row `building` -> level by level: reuse (this document's own partial artifact, then the version it
 *   replaces), model calls for the rest, embed, registry rows and summary rows -> compact the artifact
 *   -> coverage invariant read back from Postgres -> `ready`, or `partial` (never served).
 *
 * What is committed when:
 *
 * - A summary's text is written to the artifact as its own immutable part the moment its model call returns.
 *   A build killed after N calls and started again reads those N parts back and makes exactly total - N calls.
 * - Registry rows and summary rows (text and vector) are written once per window of at most `concurrency`
 *   model calls: one embedding request and one table commit for the window instead of one per summary. A kill
 *   between a part and its window costs an embedding call on resume, never a model call.
 * - The state row is `building` from before the first write until the last check passes. Search serves a
 *   document's nodes only while its row is `ready`, so nothing of an unfinished tree is served. A rebuild leaves
 *   `ready` before it removes or replaces a single row of the earlier tree, and a document that stops qualifying
 *   leaves `ready` before its rows are wiped.
 * - A `building` row names its builder and is kept alive by it (`touchSummaryTreeBuild`). A build stops, without
 *   writing an outcome, as soon as another build has taken the row. A row whose builder stopped reporting for
 *   `SUMMARY_TREE_BUILD_STALE_MS` was left by a dead worker and blocks nothing.
 *
 * Nothing is skipped silently: every outcome is a status with a named reason and counts.
 */

type Client = Sql<Record<string, unknown>>;

/** Why one group's summary could not be produced. Named, never a provider message or document text. */
export type SummaryTreeGroupFailure =
  /** The model's host refused to write output for this text on content grounds. */
  | "content-refusal"
  /** Still cut off at double the output budget. */
  | "truncated-output"
  /** The model finished but broke the output contract. */
  | `invalid-output:${SummaryParseFailure}`
  /** The group's source text did not fit the prompt; a truncated prompt is never sent. */
  | "prompt-too-large"
  /** The call failed (network, throttling beyond its retries, a provider error). */
  | "model-error"
  /** The leaf text read back for the prompt is not the text that was hashed. */
  | "leaf-text-mismatch";

/** Thrown by a model adapter when the provider refused to produce output on content grounds. */
export class SummaryContentRefusalError extends Error {
  constructor(message = "The model provider refused to produce output for this content") {
    super(message);
    this.name = "SummaryContentRefusalError";
  }
}

const CONTENT_REFUSAL_RE = /inappropriate content|content[\s_-]?filter|content[\s_-]?policy|data_inspection_failed|content management policy/i;

/** Whether a model call failed because the provider refused the content (as opposed to being unavailable). */
export function isSummaryContentRefusal(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let link: unknown = error; link && typeof link === "object" && !seen.has(link); link = (link as { cause?: unknown }).cause) {
    seen.add(link);
    if (link instanceof SummaryContentRefusalError) return true;
    const message = String((link as { message?: unknown }).message ?? "");
    const body = String((link as { responseBody?: unknown }).responseBody ?? "");
    if (CONTENT_REFUSAL_RE.test(message) || CONTENT_REFUSAL_RE.test(body)) return true;
  }
  return false;
}

/** The build stops before its next model call: the switch went off or the caller's cap was reached. Not a group failure. */
class SummaryTreeStopped extends Error {
  constructor(readonly reason: string) {
    super(`summary tree build stopped: ${reason}`);
    this.name = "SummaryTreeStopped";
  }
}

export interface SummaryTreeModelRequest {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  /** 1, or 2 for the one retry at double the output budget after a cut-off answer. */
  attempt: number;
  nodeId: string;
  level: number;
  signal?: AbortSignal;
}

/** One model call. Throws on failure; throws `SummaryContentRefusalError` (or returns `finishReason: "content-filter"`) on a content refusal. */
export type SummaryTreeModel = (request: SummaryTreeModelRequest) => Promise<SummaryCallResult>;
/** Embeds summary texts into the project's embedding space, one vector per text. */
export type SummaryTreeEmbedder = (texts: string[], signal?: AbortSignal) => Promise<ArrayLike<number>[]>;

export interface SummaryTreeUsageDetail {
  nodeId: string;
  level: number;
  attempt: number;
  finishReason: string;
}

export type SummaryTreeRowWriter = (args: {
  sql: Client; scope: SummaryTreeScope; space: { model: string; dimensions: number };
  documentId: string; runId: string; rows: SummaryRow[]; root?: string; signal?: AbortSignal;
}) => Promise<unknown>;

export interface SummaryTreeBuildDeps {
  sql: Client;
  /** Storage of the text artifact (the run's bucket). */
  artifacts: SummaryTreeArtifactIO & { uri(key: string): string; keyFromUri(uri: string): string | null };
  /** Opens the document's embed artifact as bytes, or null when it has none. */
  openEmbeddingArtifact(signal?: AbortSignal): Promise<AsyncIterable<Uint8Array> | null>;
  summarize: SummaryTreeModel;
  embed: SummaryTreeEmbedder;
  /** Called for every model attempt that returned, kept or not, with the provider's own token counts. */
  recordUsage(usage: SummaryCallUsage, detail: SummaryTreeUsageDetail): void;
  /** Persists what was recorded so far. Called after every committed window and before the build returns. */
  flushUsage?(): Promise<void>;
  /** Whether this deployment and project still build trees. Asked before every model call; false makes none. */
  buildActive(): boolean;
  /** Null when the organization may spend, otherwise a named reason. Asked once, before the first model call. */
  spendRefusal(): Promise<string | null>;
  /** A named reason to stop before the next model call (a cost cap), or null. */
  stopReason?(): string | null;
  /** Called once for every model call that `stopReason` let through, when it has settled (returned or thrown). */
  callSettled?(): void;
  writeRows: SummaryTreeRowWriter;
  /** Strict delete of summary rows by id (nodes a rebuild replaced). */
  deleteRowsById(args: { scope: SummaryTreeScope; space: { model: string; dimensions: number }; ids: string[]; root?: string }): Promise<void>;
  /** Strict delete of every summary row of the document in one embedding space. */
  deleteDocumentRows(args: { scope: SummaryTreeScope; space: { model: string; dimensions: number }; documentIds: string[]; root?: string }): Promise<unknown>;
  /** Called once when a build that wrote or removed summary rows ends `ready`: the table has many small commits to compact. */
  tableChanged?(args: { scope: SummaryTreeScope; space: { model: string; dimensions: number }; root?: string }): void;
  /** LanceDB root override (tests). */
  lanceRoot?: string;
  /** Directory for the leaf text spool; the system temporary directory when unset. */
  tmpDirectory?: string;
  noteProgress?(label: string): void;
}

export interface SummaryTreeBuildInput {
  scope: SummaryTreeScope;
  documentId: string;
  runId: string;
  document: {
    normalizedFormat?: string | null;
    mimeType?: string | null;
    /** Stored chunk count, when known: a document below the long-document floor is skipped without reading its artifact. */
    chunkCount?: number | null;
    piiBlocked?: boolean;
  };
  /** `<run root>` the text artifact is written under (`<run root>/summary-tree/<documentId>/`). */
  runRoot: string;
  /** The project's embedding space. The document's leaf vectors must be in it; summaries are embedded into it. */
  space: { model: string; dimensions: number };
  /** Everything that decides what a summary says: resolved model id, text settings, length target. */
  hashContext: SummaryTreeHashContext;
  limits?: Partial<SummaryTreeLimits>;
  /** Model calls in flight at once, and the size of one commit window. */
  concurrency?: number;
  /** Who builds: stamped on the `building` row. Default `run:<runId>`. */
  owner?: string;
  /**
   * What to do when another builder holds the document's `building` row and still reports. True (the default, a
   * run's own stage: its retry after a crash must not wait): take the row over; the other build stops at its next
   * heartbeat. False (the backfill job): leave the document alone and return `blocked` (`build-in-progress`).
   * A row whose builder stopped reporting is always taken over.
   */
  takeOverLiveBuild?: boolean;
  /** Replaces `SUMMARY_TREE_BUILD_STALE_MS` and `SUMMARY_TREE_BUILD_HEARTBEAT_MS` (tests). */
  buildStaleMs?: number;
  heartbeatMs?: number;
  signal?: AbortSignal;
}

export type SummaryTreeBuildStatus =
  /** The build switch or the project setting is off: nothing was read, written or called. */
  | "off"
  /** The document gets no tree (`skipReason`). */
  | "skipped"
  /**
   * The organization may not spend, or the model route is unavailable: nothing was called, state row `pending`. Or
   * another build holds the document (`build-in-progress`): nothing was read or written.
   */
  | "blocked"
  /** The document is not a live document of this project: nothing was written. */
  | "refused"
  /** A group failed after its retry, a limit was reached or a check did not hold. Not served. */
  | "partial"
  | "ready";

export interface SummaryTreeBuildStats {
  summaryTreeStatus: SummaryTreeBuildStatus;
  summaryTreeSkipReason?: SummaryTreeSkipReason;
  /** The library's finer skip reason (`spreadsheet-format`, `table-heavy`, ...). */
  summaryTreeSkipDetail?: SummaryTreeDocumentSkipReason | "pii-blocked" | "chunk-count-below-floor" | "no-embedding-artifact";
  /** Why the build is `blocked`, `refused` or `partial`. */
  summaryTreeReason?: string;
  chunks: number;
  leaves: number;
  tableLeaves: number;
  overlapChunks: number;
  tableDetailChunks: number;
  /** Level-1 nodes (leaf groups). */
  groups: number;
  nodes: number;
  levels: number;
  /** Model requests sent, cut-off retries and group retries included. */
  modelCalls: number;
  /** Nodes whose summary a model wrote in this build. */
  generatedNodes: number;
  /** Nodes whose summary came from this document's own artifact (a resumed build). */
  reusedFromResume: number;
  /** Nodes whose summary was copied from the version this document replaces. */
  reusedFromPredecessor: number;
  /** `used`, or why the predecessor was not used. */
  predecessorReuse: string;
  failedGroups: number;
  failureReasons: Record<string, number>;
  truncationRetries: number;
  inputTokens: number;
  outputTokens: number;
  embeddedSummaries: number;
  rowsWritten: number;
  staleRowsDeleted: number;
  durationMs: number;
}

export interface SummaryTreeBuildResult {
  status: SummaryTreeBuildStatus;
  skipReason?: SummaryTreeSkipReason;
  reason?: string;
  /** The text artifact (`.../summary-tree/<documentId>/summaries.jsonl`), when the build wrote under it. */
  artifactUri?: string;
  stats: SummaryTreeBuildStats;
}

const SKIP_REASON: Record<SummaryTreeDocumentSkipReason, SummaryTreeSkipReason> = {
  "spreadsheet-format": "format",
  "structured-data-format": "format",
  "audio-video": "media",
  "no-leaves": "no-leaves",
  "table-heavy": "tables",
  "below-long-document-floor": "short",
};

/** Summaries copied or embedded per commit when no model call is involved (a resumed or reused layer). */
const REUSE_COMMIT_BATCH = 64;
/** A layer stops starting new groups once this many have failed: a provider that fails everything is not retried per group. */
const MAX_FAILED_GROUPS_PER_LAYER = 8;
const HEADING_PATH_MAX_CHARS = 2_000;

/** The row id of a node: unique within its document, stable for the same grouping, safe in a LanceDB filter. */
export function summaryTreeNodeId(documentId: string, node: Pick<SummaryTreeNode, "level" | "chunkStart" | "chunkEnd">): string {
  return `${documentId}:L${node.level}:${node.chunkStart}-${node.chunkEnd}`;
}

/** The text of a summary row and the text that is embedded for it: the title line, then the summary. */
export function summaryRowText(summary: StoredSummary): string {
  return summary.title ? `${summary.title}\n${summary.text}` : summary.text;
}

/** The heading trail of a summary row, cut on a code point so no half surrogate pair is stored. */
function headingPathText(headingPath: readonly string[]): string {
  const joined = headingPath.join(" > ");
  return joined.length <= HEADING_PATH_MAX_CHARS ? joined : Array.from(joined).slice(0, HEADING_PATH_MAX_CHARS / 2).join("");
}

function emptyStats(): SummaryTreeBuildStats {
  return {
    summaryTreeStatus: "off", chunks: 0, leaves: 0, tableLeaves: 0, overlapChunks: 0, tableDetailChunks: 0,
    groups: 0, nodes: 0, levels: 0, modelCalls: 0, generatedNodes: 0, reusedFromResume: 0, reusedFromPredecessor: 0,
    predecessorReuse: "not-looked-up", failedGroups: 0, failureReasons: {}, truncationRetries: 0, inputTokens: 0, outputTokens: 0,
    embeddedSummaries: 0, rowsWritten: 0, staleRowsDeleted: 0, durationMs: 0,
  };
}

interface WorkItem {
  hash: string;
  /** Every node of the layer with this hash; one summary serves them all. */
  nodes: number[];
  summary?: StoredSummary;
  origin: "resume" | "predecessor" | "model";
  failure?: SummaryTreeGroupFailure;
}

export async function buildDocumentSummaryTree(deps: SummaryTreeBuildDeps, input: SummaryTreeBuildInput): Promise<SummaryTreeBuildResult> {
  const startedAt = Date.now();
  const stats = emptyStats();
  const { scope, documentId, runId, signal } = input;
  const limits = resolveSummaryTreeLimits(input.limits);
  const concurrency = Math.max(1, Math.floor(input.concurrency ?? 4));
  const finish = (status: SummaryTreeBuildStatus, extra: { skipReason?: SummaryTreeSkipReason; reason?: string; artifactUri?: string } = {}): SummaryTreeBuildResult => {
    stats.summaryTreeStatus = status;
    if (extra.skipReason) stats.summaryTreeSkipReason = extra.skipReason;
    if (extra.reason) stats.summaryTreeReason = extra.reason;
    stats.durationMs = Date.now() - startedAt;
    return { status, ...extra, stats };
  };

  // The kill switch first: off means nothing is read, written or called.
  if (!deps.buildActive()) return finish("off", { reason: "build-switch-off" });
  signal?.throwIfAborted();

  const contextKey = summaryTreeContextKey(input.hashContext);
  const artifactRoot = summaryTreeArtifactRoot(input.runRoot, documentId);
  const artifactUri = deps.artifacts.uri(summaryTreePackKey(artifactRoot));
  let space = { model: input.space.model, dimensions: input.space.dimensions };
  const owner = input.owner ?? `run:${runId}`;

  let prior: Awaited<ReturnType<typeof loadSummaryTreeState>>;
  try {
    prior = await loadSummaryTreeState(deps.sql, scope, documentId, input.buildStaleMs ?? SUMMARY_TREE_BUILD_STALE_MS);
  } catch (error) {
    if (error instanceof SummaryTreeStateRefused) return finish("refused", { reason: "tenant-scope" });
    throw error;
  }
  // Another builder holds the document and still reports: a caller that must not take it over leaves it untouched.
  if (prior?.buildLive && prior.buildOwner !== owner && input.takeOverLiveBuild === false) {
    return finish("blocked", { reason: "build-in-progress" });
  }
  const priorSpace = prior?.embeddingModel && prior.dimension ? { model: prior.embeddingModel, dimensions: prior.dimension } : null;

  /** Whether this build wrote the `building` row: from then on its outcome is written only while it still holds it. */
  let holding = false;
  const writeSummaryTreeState = async (_sql: Client, write: SummaryTreeStateWrite): Promise<void> => {
    await writeSummaryTreeStateRow(deps.sql, { ...write, buildOwner: owner, ...(holding ? { expectOwner: owner } : {}) });
    holding = write.status === "building";
  };

  /**
   * Removes every summary row and registry row an earlier build left for this document. A tree that is being
   * served leaves `ready` first (keeping the earlier build's settings and embedding space on the row, so a build
   * that dies here is still found by the next one): search never reads a tree that is being taken apart.
   */
  const wipeEarlierTree = async () => {
    if (!prior) return;
    if (prior.status === "ready") {
      await writeSummaryTreeState(deps.sql, { scope, documentId, runId: prior.runId ?? runId, status: "building", configHash: prior.configHash, space: priorSpace });
    }
    if (priorSpace) await deps.deleteDocumentRows({ scope, space: priorSpace, documentIds: [documentId], root: deps.lanceRoot });
    await deleteSummaryTreeNodes(deps.sql, scope, documentId, "all");
  };

  const skip = async (detail: NonNullable<SummaryTreeBuildStats["summaryTreeSkipDetail"]>, skipReason: SummaryTreeSkipReason): Promise<SummaryTreeBuildResult> => {
    stats.summaryTreeSkipDetail = detail;
    try {
      // A document that had a tree and no longer qualifies keeps none of it.
      if (prior && prior.status !== "skipped") await wipeEarlierTree();
      await writeSummaryTreeState(deps.sql, { scope, documentId, runId, status: "skipped", skipReason });
    } catch (error) {
      if (error instanceof SummaryTreeStateRefused) return finish("refused", { reason: "document-not-live" });
      throw error;
    }
    return finish("skipped", { skipReason });
  };

  if (input.document.piiBlocked) return await skip("pii-blocked", "pii");
  const formatSkip = summaryTreeFormatSkipReason(input.document);
  if (formatSkip) return await skip(formatSkip, SKIP_REASON[formatSkip]);
  // Many small files: the stored chunk count already says the document is under the floor (leaves are a subset of chunks).
  if (typeof input.document.chunkCount === "number" && input.document.chunkCount >= 0 && input.document.chunkCount < limits.minDocumentLeaves) {
    stats.chunks = input.document.chunkCount;
    return await skip("chunk-count-below-floor", "short");
  }

  const bytes = await deps.openEmbeddingArtifact(signal);
  if (!bytes) return await skip("no-embedding-artifact", "no-leaves");
  const texts: LeafTextStore = await createLeafTextSpool({ directory: deps.tmpDirectory });
  /** Set when the heartbeat finds the `building` row gone or held by another builder. */
  let takenOver = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    let index: SummaryTreeLeafIndex;
    try {
      index = await scanEmbeddingArtifactLeaves({ bytes, document: input.document, texts, limits, signal, onProgress: () => deps.noteProgress?.("summary-tree:scan") });
    } catch (error) {
      if (!(error instanceof SummaryTreeInputError)) throw error;
      // The artifact is not usable for grouping (a leaf without a vector, mixed dimensions, no raw text).
      return await endWithoutCalls("partial", "leaf-vectors-unusable");
    }
    stats.chunks = index.counts.stats.chunks;
    stats.leaves = index.counts.stats.proseLeaves;
    stats.tableLeaves = index.counts.stats.tableLeaves;
    stats.overlapChunks = index.counts.excluded["overlap-chunk"];
    stats.tableDetailChunks = index.counts.excluded["table-detail-chunk"];
    if (index.counts.skipReason) return await skip(index.counts.skipReason, SKIP_REASON[index.counts.skipReason]);

    // The leaf vectors must be in the project's embedding space: that is where the summary rows go and where the
    // purge paths look for them.
    const observedDimensions = index.embedding.dimensions ?? 0;
    if ((index.embedding.model !== null && index.embedding.model !== space.model) || (space.dimensions > 0 && observedDimensions !== space.dimensions)) {
      return await endWithoutCalls("partial", "embedding-space-mismatch", index.leaves.length);
    }
    space = { model: space.model, dimensions: observedDimensions };

    const builder = new SummaryTreeBuilder(index.leaves, index.similarities, limits);
    stats.groups = builder.nodes.length;
    stats.nodes = builder.nodes.length;
    // Fewest nodes any tree over these groups can have. Over the cap: refuse before a single call is paid for.
    const fewestNodes = builder.nodes.length + (builder.nodes.length > 1 ? Math.ceil((builder.nodes.length - 1) / (limits.maxFanIn - 1)) : 0);
    // The cap scales with the document (limits scale with page count); an explicit limit is absolute.
    const nodeCap = input.limits?.maxNodes ?? Math.min(limits.maxNodes, summaryTreeNodeCap(index.leaves.length));
    if (fewestNodes > nodeCap) {
      return await endWithoutCalls("partial", "node-cap", index.leaves.length);
    }

    const refusal = await deps.spendRefusal();
    if (refusal) {
      return await endWithoutCalls("blocked", refusal, index.leaves.length);
    }

    // A tree built with other settings or into another embedding space shares nothing with this one but text:
    // its rows go before the first new row is written. Text is still reused by hash from the artifact.
    const sameBuild = prior !== null && prior.configHash === contextKey && priorSpace !== null
      && priorSpace.model === space.model && priorSpace.dimensions === space.dimensions;
    try {
      if (prior && !sameBuild) await wipeEarlierTree();
      await writeSummaryTreeState(deps.sql, { scope, documentId, runId, status: "building", configHash: contextKey, space, leafCount: index.leaves.length });
    } catch (error) {
      if (error instanceof SummaryTreeStateRefused) return finish("refused", { reason: "document-not-live" });
      throw error;
    }

    // The heartbeat: keeps the row alive while calls are in flight and notices a takeover between windows.
    const beat = async () => {
      if (takenOver) return;
      if (!(await touchSummaryTreeBuild(deps.sql, scope, documentId, owner))) takenOver = true;
    };
    heartbeat = setInterval(() => { void beat().catch(() => undefined); }, Math.max(1, input.heartbeatMs ?? SUMMARY_TREE_BUILD_HEARTBEAT_MS));
    heartbeat.unref?.();

    const registry: Map<string, StoredSummaryTreeNode> = sameBuild ? await loadSummaryTreeNodes(deps.sql, scope, documentId) : new Map();
    const own = await readSummaryTreeArtifact(deps.artifacts, artifactRoot);
    const ownSource: SummaryReuseSource = {
      entries: own.entries,
      // This document's own artifact, under its own run root.
      eligibility: { sameOrgProjectAndCanonicalChain: true, sourceNotPurged: true, sourceNotPiiBlockedOrRedacted: true },
    };
    const predecessorSource = await loadPredecessorSource();

    const leafHashByChunkIndex = new Map<number, string>();
    index.leaves.forEach((leaf, position) => leafHashByChunkIndex.set(leaf.chunkIndex, index.hashes[position]!));
    const leafPosition = new Map<number, number>();
    index.leaves.forEach((leaf, position) => leafPosition.set(leaf.chunkIndex, position));

    let hashes: string[] = [];
    const summaries = new Map<number, StoredSummary>();
    const vectors = new Map<number, ArrayLike<number>>();
    const nodeIds: string[] = [];
    const budget = summaryOutputTokenBudget(limits.summaryLengthWords);
    let stopped: string | null = null;

    const nodeRecord = (nodeIndex: number, status: SummaryTreeNodeRecord["status"]): SummaryTreeNodeRecord => {
      const node = builder.nodes[nodeIndex]!;
      return {
        id: nodeIds[nodeIndex]!, nodeHash: hashes[nodeIndex]!, level: node.level, ordinal: nodeIndex, status,
        chunkStart: node.chunkStart, chunkEnd: node.chunkEnd, pageStart: node.pageStart, pageEnd: node.pageEnd,
      };
    };

    const embedSummaries = async (nodeIndexes: readonly number[]): Promise<void> => {
      for (let from = 0; from < nodeIndexes.length; from += REUSE_COMMIT_BATCH) {
        const batch = nodeIndexes.slice(from, from + REUSE_COMMIT_BATCH);
        // One embedding per distinct text.
        const distinct = [...new Set(batch.map((nodeIndex) => summaryRowText(summaries.get(nodeIndex)!)))];
        signal?.throwIfAborted();
        const embedded = await deps.embed(distinct, signal);
        if (embedded.length !== distinct.length) throw new Error(`summary embedding returned ${embedded.length} vectors for ${distinct.length} texts`);
        const byText = new Map<string, ArrayLike<number>>();
        embedded.forEach((vector, position) => {
          if (!vector || vector.length !== space.dimensions) {
            throw new Error(`summary embedding has ${vector?.length ?? 0} dimensions, expected ${space.dimensions}`);
          }
          byText.set(distinct[position]!, vector);
        });
        for (const nodeIndex of batch) vectors.set(nodeIndex, byText.get(summaryRowText(summaries.get(nodeIndex)!))!);
        stats.embeddedSummaries += distinct.length;
      }
    };

    /** Registry rows and summary rows for nodes that have a summary and are not committed yet. */
    const commitNodes = async (nodeIndexes: readonly number[]): Promise<void> => {
      const pending = nodeIndexes.filter((nodeIndex) => {
        const stored = registry.get(nodeIds[nodeIndex]!);
        return !(stored && stored.status === "ready" && stored.nodeHash === hashes[nodeIndex] && stored.runId === runId);
      });
      if (pending.length === 0) return;
      await embedSummaries(pending);
      // The registry row exists before the summary row does, so a row in the table always has a registry row that
      // names it: a later rebuild finds and removes it even if this build dies between the two writes.
      await upsertSummaryTreeNodes(deps.sql, { scope, documentId, runId, rows: pending.map((nodeIndex) => nodeRecord(nodeIndex, "pending")) });
      const rows: SummaryRow[] = pending.map((nodeIndex) => {
        const node = builder.nodes[nodeIndex]!;
        return {
          id: nodeIds[nodeIndex]!, documentId, runId, level: node.level,
          chunkStart: node.chunkStart, chunkEnd: node.chunkEnd,
          pageStart: Math.max(0, node.pageStart ?? 0), pageEnd: Math.max(0, node.pageEnd ?? node.pageStart ?? 0),
          headingPath: headingPathText(node.headingPath),
          text: summaryRowText(summaries.get(nodeIndex)!),
          vector: Array.from(vectors.get(nodeIndex)!),
        };
      });
      await deps.writeRows({ sql: deps.sql, scope, space, documentId, runId, rows, root: deps.lanceRoot, signal });
      await upsertSummaryTreeNodes(deps.sql, { scope, documentId, runId, rows: pending.map((nodeIndex) => nodeRecord(nodeIndex, "ready")) });
      for (const nodeIndex of pending) registry.set(nodeIds[nodeIndex]!, { id: nodeIds[nodeIndex]!, nodeHash: hashes[nodeIndex]!, status: "ready", runId });
      stats.rowsWritten += rows.length;
    };

    const beforeCall = () => {
      signal?.throwIfAborted();
      if (takenOver) throw new SummaryTreeStopped("build-taken-over");
      if (!deps.buildActive()) throw new SummaryTreeStopped("build-switch-off");
      const reason = deps.stopReason?.() ?? null;
      if (reason) throw new SummaryTreeStopped(reason);
    };

    /** One group: build its prompt and call the model, with one retry of the whole group. */
    const generate = async (item: WorkItem): Promise<void> => {
      const nodeIndex = item.nodes[0]!;
      const node = builder.nodes[nodeIndex]!;
      let parts: Array<{ title?: string; text: string }>;
      if (node.childKind === "leaf") {
        const positions = node.children.map((chunkIndex) => leafPosition.get(chunkIndex)!);
        const leafTexts = await texts.read(positions);
        if (leafTexts.some((text, i) => leafHash(text) !== index.hashes[positions[i]!])) {
          item.failure = "leaf-text-mismatch";
          return;
        }
        parts = leafTexts.map((text) => ({ text }));
      } else {
        parts = node.children.map((child) => {
          const summary = summaries.get(child);
          if (!summary) throw new SummaryTreeInputError(`summary tree node ${nodeIndex} is built before its child ${child}`);
          return { title: summary.title, text: summary.text };
        });
      }
      const prompt = buildSummaryTreePrompt({ parts, headingPath: node.headingPath, lengthTargetWords: limits.summaryLengthWords });
      if (prompt.truncated) {
        item.failure = "prompt-too-large";
        return;
      }
      for (let groupAttempt = 1; groupAttempt <= 2; groupAttempt++) {
        const result = await generateSummaryWithRetry({
          maxOutputTokens: budget,
          call: async (maxOutputTokens, attempt) => {
            beforeCall();
            stats.modelCalls++;
            if (attempt > 1) stats.truncationRetries++;
            let response: SummaryCallResult;
            try {
              response = await deps.summarize({ system: prompt.system, prompt: prompt.prompt, maxOutputTokens, attempt, nodeId: nodeIds[nodeIndex]!, level: node.level, signal });
            } finally {
              deps.callSettled?.();
            }
            // Billed whether or not the answer is kept.
            deps.recordUsage(response.usage, { nodeId: nodeIds[nodeIndex]!, level: node.level, attempt, finishReason: response.finishReason });
            stats.inputTokens += response.usage.inputTokens;
            stats.outputTokens += response.usage.outputTokens;
            deps.noteProgress?.("summary-tree:model-call");
            if (response.finishReason === "content-filter") throw new SummaryContentRefusalError();
            return response;
          },
        });
        if (result.status === "ok") {
          item.summary = result.summary;
          item.failure = undefined;
          // Durable before anything else happens to it: a build killed now does not pay for this call again.
          await appendSummaryTreeRecords(deps.artifacts, artifactRoot, [{ hash: item.hash, ...result.summary }]);
          own.entries.set(item.hash, result.summary);
          return;
        }
        if (result.status === "error") {
          if (result.error instanceof SummaryTreeStopped) throw result.error;
          if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : result.error;
          item.failure = isSummaryContentRefusal(result.error) ? "content-refusal" : "model-error";
        } else {
          item.failure = result.status === "truncated" ? "truncated-output" : `invalid-output:${result.reason}`;
        }
      }
    };

    /** One layer of new nodes: reuse what can be reused, call the model for the rest, commit window by window. */
    const processLayer = async (created: readonly number[]): Promise<void> => {
      hashes = hashSummaryTreeNodes({ nodes: builder.nodes, leafHashByChunkIndex, context: contextKey, known: hashes });
      for (const nodeIndex of created) nodeIds[nodeIndex] = summaryTreeNodeId(documentId, builder.nodes[nodeIndex]!);
      const first = created[0]!;
      const layerHashes = created.map((nodeIndex) => hashes[nodeIndex]!);
      const resumePlan = planSummaryReuse({ nodeHashes: layerHashes, firstNode: first, source: ownSource });
      const predecessorPlan = planSummaryReuse({ nodeHashes: resumePlan.generate.map((entry) => entry.hash), source: predecessorSource });
      const fromPredecessor = new Map(predecessorPlan.reuse.map((entry) => [entry.hash, entry.summary]));

      const items: WorkItem[] = [
        ...resumePlan.reuse.map((entry): WorkItem => ({ hash: entry.hash, nodes: [entry.node], summary: entry.summary, origin: "resume" })),
        ...resumePlan.generate.map((entry): WorkItem => {
          const copied = fromPredecessor.get(entry.hash);
          return copied ? { hash: entry.hash, nodes: entry.nodes, summary: copied, origin: "predecessor" } : { hash: entry.hash, nodes: entry.nodes, origin: "model" };
        }),
      ].sort((a, b) => a.nodes[0]! - b.nodes[0]!);

      let failed = 0;
      for (let cursor = 0; cursor < items.length;) {
        // A window: up to `concurrency` model calls, or up to a batch of summaries that need none.
        const window: WorkItem[] = [];
        let calls = 0;
        while (cursor < items.length && calls < concurrency && window.length < REUSE_COMMIT_BATCH) {
          const item = items[cursor++]!;
          window.push(item);
          if (item.origin === "model") calls++;
        }
        signal?.throwIfAborted();
        if (takenOver) {
          stopped = "build-taken-over";
          return;
        }
        const copied = window.filter((item) => item.origin === "predecessor");
        if (copied.length > 0) {
          // Copied into this version's own artifact: nothing later reads the predecessor's.
          const records: SummaryTreeRecord[] = copied.map((item) => ({ hash: item.hash, ...item.summary! }));
          await appendSummaryTreeRecords(deps.artifacts, artifactRoot, records);
          for (const record of records) own.entries.set(record.hash, { title: record.title, text: record.text });
        }
        const settled = await Promise.allSettled(window.filter((item) => item.origin === "model").map((item) => generate(item)));
        // Commit what the window produced before reporting what stopped it, so every paid call is kept.
        const done: number[] = [];
        const failedNodes: number[] = [];
        for (const item of window) {
          if (item.summary) {
            for (const nodeIndex of item.nodes) {
              summaries.set(nodeIndex, item.summary);
              done.push(nodeIndex);
            }
            if (item.origin === "resume") stats.reusedFromResume += item.nodes.length;
            else if (item.origin === "predecessor") stats.reusedFromPredecessor += item.nodes.length;
            else stats.generatedNodes += item.nodes.length;
          } else if (item.failure) {
            failed++;
            stats.failedGroups++;
            stats.failureReasons[item.failure] = (stats.failureReasons[item.failure] ?? 0) + 1;
            failedNodes.push(...item.nodes);
          }
        }
        await commitNodes(done);
        if (failedNodes.length > 0) {
          await upsertSummaryTreeNodes(deps.sql, { scope, documentId, runId, rows: failedNodes.map((nodeIndex) => nodeRecord(nodeIndex, "failed")) });
        }
        await deps.flushUsage?.();
        await beat();
        deps.noteProgress?.("summary-tree:commit");
        const rejected = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
        if (rejected) {
          if (rejected.reason instanceof SummaryTreeStopped) {
            stopped = rejected.reason.reason;
            return;
          }
          throw rejected.reason;
        }
        if (failed >= MAX_FAILED_GROUPS_PER_LAYER) return;
      }
    };

    let created = builder.nodes.map((_, nodeIndex) => nodeIndex);
    let partialReason: string | null = null;
    for (;;) {
      await processLayer(created);
      if (stopped) {
        partialReason = `stopped:${stopped}`;
        break;
      }
      if (stats.failedGroups > 0) {
        partialReason = `group-failed:${Object.keys(stats.failureReasons).sort().join(",")}`;
        break;
      }
      if (builder.done) break;
      const needed = builder.vectorsNeeded().filter((nodeIndex) => !vectors.has(nodeIndex));
      if (needed.length > 0) await embedSummaries(needed);
      created = builder.advance((nodeIndex) => vectors.get(nodeIndex));
      // Vectors are kept only for nodes that still wait for a parent.
      for (const nodeIndex of [...vectors.keys()]) if (builder.nodes[nodeIndex]!.parent !== null) vectors.delete(nodeIndex);
      stats.nodes = builder.nodes.length;
      if (builder.nodes.length > nodeCap) {
        partialReason = "node-cap";
        break;
      }
    }
    stats.nodes = builder.nodes.length;
    stats.levels = builder.nodes.reduce((top, node) => Math.max(top, node.level), 0);

    const writePartial = async (reason: string): Promise<SummaryTreeBuildResult> => {
      // Another build holds the row now: its state is not this build's to write.
      if (takenOver) {
        await deps.flushUsage?.();
        return finish("partial", { reason: "stopped:build-taken-over", artifactUri });
      }
      await writeSummaryTreeState(deps.sql, {
        scope, documentId, runId, status: "partial", configHash: contextKey, space, error: reason,
        leafCount: index.leaves.length, nodeCount: [...registry.values()].filter((node) => node.status === "ready").length, levelCount: stats.levels,
      });
      await deps.flushUsage?.();
      return finish("partial", { reason, artifactUri });
    };
    if (partialReason) return await writePartial(partialReason);

    const tree = builder.tree();
    const violations = checkSummaryTreeCoverage(tree);
    if (violations.length > 0 || tree.root === null) {
      return await writePartial(`coverage:${[...new Set(violations.map((violation) => violation.kind))].sort().join(",") || "missing-root"}`);
    }

    // Rows of nodes this build did not produce (an earlier build of the same settings over other leaves).
    const keep = nodeIds.slice(0, tree.nodes.length);
    const stale = await staleSummaryTreeNodeIds(deps.sql, scope, documentId, keep);
    if (stale.length > 0) {
      await deps.deleteRowsById({ scope, space, ids: stale, root: deps.lanceRoot });
      await deleteSummaryTreeNodes(deps.sql, scope, documentId, stale);
      stats.staleRowsDeleted = stale.length;
    }
    await linkSummaryTreeNodes(deps.sql, {
      scope, documentId,
      links: tree.nodes.map((node, nodeIndex) => ({ id: nodeIds[nodeIndex]!, parentId: node.parent === null ? null : nodeIds[node.parent]!, ordinal: nodeIndex })),
    });
    await compactSummaryTreeArtifact(deps.artifacts, artifactRoot, tree.nodes.map((_, nodeIndex) => ({ hash: hashes[nodeIndex]!, ...summaries.get(nodeIndex)! })));

    // The invariant is read back from Postgres, after the last write, and decides whether the tree is served.
    const coverage = await readSummaryTreeCoverage(deps.sql, { scope, documentId, leafChunkIndexes: tree.leafChunkIndexes });
    const problems = summaryTreeCoverageProblems(coverage, { nodes: tree.nodes.length, rootId: nodeIds[tree.root]! });
    if (problems.length > 0) return await writePartial(`coverage:${problems.join(",")}`);

    await writeSummaryTreeState(deps.sql, {
      scope, documentId, runId, status: "ready", configHash: contextKey, space,
      leafCount: index.leaves.length, nodeCount: tree.nodes.length, levelCount: stats.levels, rootNodeId: nodeIds[tree.root]!,
    });
    await deps.flushUsage?.();
    if (stats.rowsWritten > 0 || stats.staleRowsDeleted > 0) deps.tableChanged?.({ scope, space, root: deps.lanceRoot });
    return finish("ready", { artifactUri });

    async function loadPredecessorSource(): Promise<SummaryReuseSource | null> {
      const found = await findSummaryReusePredecessor(deps.sql, scope, documentId);
      if ("refused" in found) {
        stats.predecessorReuse = found.refused;
        return null;
      }
      // The registered artifact must be the predecessor's own tree artifact in this bucket, and nothing else.
      const key = deps.artifacts.keyFromUri(found.predecessor.artifactUri);
      const suffix = `/summary-tree/${found.predecessor.documentId}/summaries.jsonl`;
      if (!key || !key.endsWith(suffix)) {
        stats.predecessorReuse = "predecessor-artifact-unregistered";
        return null;
      }
      const contents = await readSummaryTreeArtifact(deps.artifacts, key.slice(0, -"/summaries.jsonl".length));
      stats.predecessorReuse = contents.entries.size > 0 ? "used" : "predecessor-artifact-empty";
      return {
        entries: contents.entries,
        // Each flag is what `findSummaryReusePredecessor` just checked against the database.
        eligibility: { sameOrgProjectAndCanonicalChain: true, sourceNotPurged: true, sourceNotPiiBlockedOrRedacted: true },
      };
    }
  } catch (error) {
    // The document left the project (deleted, superseded, archived) or another build took the row while this one
    // ran: what was paid for is recorded, nothing more is written, and the caller is told instead of failed.
    // `SummaryRowsRefused` is the row writer's refusal (stages/lancedb-summaries.ts), matched by name: this module
    // takes its writer as a dependency.
    if (error instanceof SummaryTreeStateRefused || (error instanceof Error && error.name === "SummaryRowsRefused")) {
      await deps.flushUsage?.();
      return finish("refused", { reason: takenOver ? "build-taken-over" : "document-not-live" });
    }
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await texts.dispose();
  }

  /**
   * Ends a build that made no model call. `partial`: the document cannot be built as it is; the state row says so
   * and keeps the earlier tree's settings and embedding space, so a later rebuild still finds its rows. `blocked`:
   * the document is left as it was, with a `pending` row only when it had none.
   */
  async function endWithoutCalls(status: "blocked" | "partial", reason: string, leafCount?: number): Promise<SummaryTreeBuildResult> {
    try {
      if (status === "partial" || !prior) {
        await writeSummaryTreeState(deps.sql, {
          scope, documentId, runId, status: status === "partial" ? "partial" : "pending", error: reason, leafCount,
          configHash: prior?.configHash ?? null, space: priorSpace,
        });
      }
    } catch (error) {
      if (error instanceof SummaryTreeStateRefused) return finish("refused", { reason: "document-not-live" });
      throw error;
    }
    return finish(status, { reason });
  }
}

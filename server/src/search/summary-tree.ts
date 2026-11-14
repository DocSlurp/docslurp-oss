import {
  SUMMARY_TREE_GUIDE_CHUNKS_PER_HIT,
  SUMMARY_TREE_GUIDE_HITS,
  SUMMARY_TREE_GUIDE_MAX_RANGE,
  SUMMARY_TREE_INCLUDE_CONTEXT_SHARE,
  SUMMARY_TREE_SEARCH_HITS,
  effectiveSummaryTreeSearchMode,
  resolveEmbeddingRoute,
  summaryTreeDeadlineMs,
  summaryTreeGuideSlots,
  summaryTreeSearchModeSchema,
  type PipelineFeatures,
  type SummaryTreeSearchMode,
  type SummaryTreeSearchOutcome,
  type SummaryTreeSearchSkipReason,
  type SummaryTreeSummary,
} from "@docslurp/shared";

import { sql } from "../db.js";
import type { SearchChunk, SearchOptions } from "../services/search.js";
import { loadEligibleDocuments, nativeScopeSupported, scopeEligibleDocuments, type EligibleDocument } from "./eligible-documents.js";
import { fullyIndexedDocument } from "./eligibility.js";
import type { SearchFilters } from "./filters.js";
import { lanceDbSummarySearch, type LanceDbSummaryHit } from "./lancedb.js";
import { embeddingNoiseBaseline, resolveMinScore, vectorRelevance } from "./relevance.js";
import { rerankBM25 } from "./rerank.js";
import { retrievalScope } from "./retrieval-scope.js";
import { countSearchEvent, recordSearchPhase } from "./timings.js";
import { estimateTextTokens } from "./token-estimate.js";

/**
 * Summary-tree retrieval leg (packages/shared/src/summary-tree.ts).
 *
 * The leg searches the project's `summaries` table beside the chunk legs, with the query vector the chunk leg
 * already has (no model call), and turns the summary hits into:
 * - `guide`: real chunks from the hits' chunk ranges, placed after a protected prefix of the chunk legs' ranking
 *   (`placeGuidedChunks`). Returned and cited evidence is chunks only.
 * - `include`: the same, plus the summaries themselves in a separate, labelled `summaries` array, capped to a share
 *   of the returned context (`capIncludedSummaries`).
 *
 * Tenant boundary. A summary node is served only when all of these hold:
 * 1. Its document is in the project's eligible set, in the request's scope, with `treeReady` (Postgres: a `ready`
 *    tree for the document's current run and this embedding space) and without a pending correction reindex. That
 *    set is the `documentId IN (…)` prefilter of the LanceDB query; the table is never read without it and never
 *    probed to find out whether trees exist.
 * 2. After the query, each hit is checked against the eligible set again (a hint may have dropped the cached set
 *    while the query ran) and its `runId` must be the document's current run.
 * 3. One Postgres query then confirms, at request time and without any cache, that the document is still a completed,
 *    current document of this project in the request's scope, that its tree is still `ready` for that run and space,
 *    and that the node is a `ready` registry row of that tree. The same query reads the guided chunks, by the
 *    registry's own chunk range, for the document's current run only. A hit without a row in its result is dropped,
 *    in both modes: a deleted, superseded or corrected document serves no node even with every cache warm and every
 *    notification lost.
 *
 * Search never fails because of the tree: any error is a skipped leg (`skipped: "error"`).
 */

// --- Plan -------------------------------------------------------------------------------------------------------------

export interface SummaryTreeSearchPlan {
  /** The mode asked for: the request's own value, else the project's retrieval default. Never `off`. */
  requested: Exclude<SummaryTreeSearchMode, "off">;
  /** The mode the leg runs in, or null when this search cannot run it (the response then reports `skipped: "mode"`). */
  run: Exclude<SummaryTreeSearchMode, "off"> | null;
}

/**
 * Whether, and how, one search uses the tree. Null means the tree plays no part: nothing is read and the response has
 * no `summaryTree` field, exactly as before the feature existed.
 *
 * - Neither the request nor the project default asks for it: null.
 * - It can run (pipeline has the tree on, the deployment serves it, hybrid or deep mode on the native path, no
 *   spatial filter, document-level filters only): the leg runs.
 * - It cannot run and only the project default asked: null. A project default is clamped silently, like every other
 *   default a search mode turns off (search-mode.ts), so keyword searches and a deployment with the serve switch off
 *   answer byte-for-byte as a project without a tree does, and stay cacheable.
 * - It cannot run and the request itself asked: the response says so (`applied: "off"`, `skipped: "mode"`). A
 *   disabled pipeline and a serve switch that is off are reported the same way.
 *
 * A sub-search of decomposition, stepback or multi-hop runs `guide` even when `include` was asked: its results are
 * fused as chunks by the parent, and a summary must never enter that list.
 */
export function planSummaryTreeSearch(args: {
  /** The request's own `summaryTree`, undefined when it sent none. */
  explicit: SummaryTreeSearchMode | undefined;
  projectDefault: SummaryTreeSearchMode | undefined;
  pipeline: Pick<PipelineFeatures, "summaryTree" | "embed" | "indexVectors"> | null | undefined;
  env: Readonly<Record<string, string | undefined>>;
  searchMode: "keyword" | "hybrid" | "deep";
  /** The search runs on the native path (LanceDB legs in parallel). */
  native: boolean;
  /** The request's filters, before the project scope is added. */
  filters: SearchFilters | undefined;
  subSearch: boolean;
}): SummaryTreeSearchPlan | null {
  const explicit = args.explicit === undefined ? undefined : summaryTreeSearchModeSchema.safeParse(args.explicit);
  // An unparseable request value asks for nothing; it never falls through to the project default.
  if (explicit && !explicit.success) return null;
  const projectDefault = summaryTreeSearchModeSchema.safeParse(args.projectDefault ?? "off");
  const asked = explicit ? explicit.data : projectDefault.success ? projectDefault.data : "off";
  if (asked === "off") return null;
  const servable = effectiveSummaryTreeSearchMode({ pipeline: args.pipeline, requested: asked, env: args.env }) !== "off";
  const runnable = servable && args.searchMode !== "keyword" && args.native && !args.filters?.geo && nativeScopeSupported(args.filters);
  if (runnable) return { requested: asked, run: args.subSearch ? "guide" : asked };
  return explicit ? { requested: asked, run: null } : null;
}

// --- Leg result -------------------------------------------------------------------------------------------------------

export interface SummaryTreeLegResult {
  applied: SummaryTreeSearchMode;
  skipped?: SummaryTreeSearchSkipReason;
  /** Wall time since the retrieval legs started. */
  ms: number;
  /** Real chunks from the summary hits' ranges, best first. Empty when skipped. */
  guided: SearchChunk[];
  /** `include` only: the validated summaries, best first, before the context cap. */
  summaries: SummaryTreeSummary[];
  /** Counts for the search session's diagnostics (no content). */
  stats: { candidateDocuments: number; hits: number; staleDropped: number; belowFloor: number; validated: number };
}

const EMPTY_STATS: SummaryTreeLegResult["stats"] = { candidateDocuments: 0, hits: 0, staleDropped: 0, belowFloor: 0, validated: 0 };

function skippedResult(reason: SummaryTreeSearchSkipReason, ms: number, stats = EMPTY_STATS): SummaryTreeLegResult {
  return { applied: "off", skipped: reason, ms, guided: [], summaries: [], stats };
}

/** The leg result behind the (empty or guided) chunk list a retrieval adapter returned. */
const legResults = new WeakMap<SearchChunk[], SummaryTreeLegResult>();

export function summaryTreeLegChunks(result: SummaryTreeLegResult): SearchChunk[] {
  const chunks = [...result.guided];
  legResults.set(chunks, result);
  return chunks;
}

export function summaryTreeLegResultOf(chunks: SearchChunk[] | undefined): SummaryTreeLegResult | null {
  return chunks ? legResults.get(chunks) ?? null : null;
}

export function summaryTreeOutcome(plan: SummaryTreeSearchPlan, result: Pick<SummaryTreeLegResult, "applied" | "skipped" | "ms"> | null): SummaryTreeSearchOutcome {
  if (!result) return { requested: plan.requested, applied: "off", skipped: "mode", ms: 0 };
  return {
    requested: plan.requested,
    applied: result.applied,
    ...(result.skipped ? { skipped: result.skipped } : {}),
    ms: Math.max(0, Math.round(result.ms)),
  };
}

/**
 * The outcome of a search that ran as sub-searches (decomposition, stepback, multi-hop): the tree applied only if it
 * applied in every sub-search; otherwise the first skip is reported. Sub-searches run `guide`.
 */
export function combineSummaryTreeOutcomes(plan: SummaryTreeSearchPlan, children: SummaryTreeSearchOutcome[]): SummaryTreeSearchOutcome {
  if (children.length === 0) return summaryTreeOutcome(plan, null);
  const ms = Math.max(...children.map((child) => child.ms));
  const skipped = children.find((child) => child.applied === "off");
  if (skipped) return { requested: plan.requested, applied: "off", skipped: skipped.skipped ?? "error", ms };
  return { requested: plan.requested, applied: "guide", ms };
}

// --- Deadline ---------------------------------------------------------------------------------------------------------

/**
 * Test and measurement hook: called with every leg once both it and the vector leg have settled, with the leg's own
 * time even when the search had already given up on it. `ignoreDeadline` lets every leg finish (its full time,
 * Postgres read included, is what calibrating `SUMMARY_TREE_DEADLINE_FACTOR` and `_GRACE_MS` needs); it is for
 * measurement runs only (SUMMARY_TREE_DEADLINE_MEASURE in search-summary-tree.db.test.ts) and nothing in the
 * server sets it.
 */
export type SummaryTreeLegObserver = (sample: { vectorMs: number; treeMs: number; deadlineMs: number; skipped: SummaryTreeSearchSkipReason | null }) => void;
let legObserver: SummaryTreeLegObserver | null = null;
let ignoreDeadlineForMeasurement = false;
export function observeSummaryTreeLegs(observer: SummaryTreeLegObserver | null, options: { ignoreDeadline?: boolean } = {}): void {
  legObserver = observer;
  ignoreDeadlineForMeasurement = observer !== null && options.ignoreDeadline === true;
}

/**
 * Runs the leg under its deadline. With `Tv` the chunk vector leg's elapsed time, the leg must settle within
 * `summaryTreeDeadlineMs(Tv)` of the legs' common start, or it contributes nothing: no partial guide, and the work
 * still running is abandoned (`expired()` tells it to stop before its Postgres query). A leg that settles before the
 * vector leg does is always in time. Never rejects.
 */
export async function runSummaryTreeLegWithDeadline(args: {
  /** `performance.now()` when the retrieval legs started. */
  startedAt: number;
  /** Resolves with the chunk vector leg's elapsed ms since `startedAt`, however that leg ended. */
  vectorSettled: Promise<number>;
  run(expired: () => boolean): Promise<SummaryTreeLegResult>;
}): Promise<SummaryTreeLegResult> {
  let expired = false;
  const elapsed = () => performance.now() - args.startedAt;
  const work = Promise.resolve()
    .then(() => args.run(() => expired))
    .catch((error: unknown) => {
      // The error's name only: its message can quote a query or a row.
      console.warn(`[search] summary-tree leg failed: ${error instanceof Error ? error.name : "error"}`);
      return skippedResult("error", elapsed());
    })
    .then((result) => ({ ...result, ms: elapsed() }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const vectorSettled = args.vectorSettled.catch(() => elapsed());
  const deadline = vectorSettled.then((vectorMs) => new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), Math.max(0, summaryTreeDeadlineMs(vectorMs) - elapsed()));
    timer.unref?.();
  }));
  const winner = await (ignoreDeadlineForMeasurement ? work : Promise.race([work, deadline]));
  if (timer) clearTimeout(timer);
  let result: SummaryTreeLegResult;
  if (winner === "deadline") {
    expired = true;
    result = skippedResult("deadline", elapsed());
  } else {
    // The leg settled first; when the vector leg is still running there is no deadline to have missed yet.
    result = winner;
  }
  recordSearchPhase("summaryTree", result.ms);
  if (result.skipped) countSearchEvent("summaryTreeSkipped");
  const observer = legObserver;
  if (observer || result.skipped === "deadline") {
    // Once the abandoned leg does settle, its own time is known: what a calibration of the deadline needs.
    void Promise.all([work, vectorSettled]).then(([settled, vectorMs]) => {
      const deadlineMs = summaryTreeDeadlineMs(vectorMs);
      if (result.skipped === "deadline") {
        // Its time stops before the Postgres read (the leg was told to stop), so it is a lower bound.
        console.info(`[search-timing] summaryTreeLate vector=${Math.round(vectorMs)} tree=${Math.round(settled.ms)} deadline=${Math.round(deadlineMs)}`);
      }
      try {
        observer?.({ vectorMs, treeMs: settled.ms, deadlineMs, skipped: result.skipped ?? null });
      } catch { /* a measurement hook never affects search */ }
    });
  }
  return result;
}

// --- Leg --------------------------------------------------------------------------------------------------------------

type GuideRow = {
  hit_id: string;
  document_id: string;
  filename: string | null;
  level: number;
  chunk_start: number;
  chunk_end: number;
  page_start: number | null;
  page_end: number | null;
  id: string | null;
  run_id: string | null;
  chunk_index: number | null;
  text: string | null;
  heading_path: string[] | null;
  page_number: number | null;
  token_estimate: number | null;
  metadata: Record<string, unknown> | null;
};

export interface SummaryTreeLegDeps {
  /** services/search.ts `mapChunk`: a chunk row as the other legs return it. */
  mapChunk(row: {
    id: string; document_id: string; run_id: string; chunk_index: number; text: string; heading_path: string[];
    page_number: number | null; token_estimate: number; rank: number; filename: string; metadata: Record<string, unknown>;
  }, score: number): SearchChunk;
}

/** Documents whose summary nodes this search may read: in scope, vector-ready, tree ready, no pending correction reindex. */
function treeCandidates(documents: EligibleDocument[]): Map<string, EligibleDocument> {
  return new Map(documents.filter((document) => document.vectorReady && document.treeReady && !document.lanceStale).map((document) => [document.id, document]));
}

/**
 * The single Postgres read of the leg: validates every hit against live rows and reads the guided chunks. Counted as
 * `summaryTreeFetch` in the search timings (tests assert exactly one per search).
 */
async function validateAndFetch(args: {
  projectId: string;
  orgId: string;
  embeddingModel: string;
  dimension: number;
  filters: SearchFilters | undefined;
  runId: string | undefined;
  hits: Array<{ hit_id: string; document_id: string; run_id: string; guide: boolean }>;
}): Promise<GuideRow[]> {
  countSearchEvent("summaryTreeFetch");
  const scope = retrievalScope({ projectId: args.projectId, filters: args.filters, runId: args.runId });
  return await sql<GuideRow[]>`
    with hits as (
      select * from jsonb_to_recordset(${sql.json(args.hits)}::jsonb) as h(hit_id text, document_id text, run_id text, guide boolean)
    ),
    valid as (
      select h.hit_id, h.guide, d.id as document_id, d.run_id, d.filename,
        n.level, n.chunk_start, n.chunk_end, n.page_start, n.page_end
      from hits h
      join documents d on d.id = h.document_id
      join document_summary_trees t on t.document_id = d.id
      join document_summary_tree_nodes n on n.id = h.hit_id and n.document_id = d.id
      where d.project_id = ${args.projectId} and d.org_id = ${args.orgId}
        and ${fullyIndexedDocument("d")} and d.purged_at is null
        and d.run_id = h.run_id
        and t.project_id = d.project_id and t.org_id = d.org_id
        and t.status = 'ready' and t.run_id = d.run_id and t.built_at is not null
        and t.embedding_model = ${args.embeddingModel} and t.dimension = ${args.dimension}
        and not exists (
          select 1 from document_corrections dc
          where dc.document_id = d.id and dc.reindex_completed_at > t.built_at
        )
        and n.status = 'ready' and n.run_id = d.run_id and n.project_id = d.project_id
        and ${scope.vectorDocument()}
    )
    select v.hit_id, v.document_id, v.filename, v.level, v.chunk_start, v.chunk_end, v.page_start, v.page_end,
      c.id, c.run_id, c.chunk_index, c.text, c.heading_path, c.page_number, c.token_estimate, c.metadata
    from valid v
    left join lateral (
      select c.id, c.run_id, c.chunk_index, c.text, c.heading_path, c.page_number, c.token_estimate, c.metadata
      from document_chunks c
      where v.guide
        and v.chunk_end - v.chunk_start < ${SUMMARY_TREE_GUIDE_MAX_RANGE}
        and c.document_id = v.document_id
        and c.chunk_index between v.chunk_start and v.chunk_end
        -- Stale runs are dropped: only chunks of the document's current run.
        and c.run_id = v.run_id
        -- The tree's leaves: overlap chunks and table row/cell chunks repeat text another chunk carries.
        and coalesce(c.metadata ->> 'overlapIndex', '0') = '0'
        and coalesce(c.metadata ->> 'tableGranularity', '') not in ('row', 'cell')
      order by c.chunk_index
      limit ${SUMMARY_TREE_GUIDE_MAX_RANGE}
    ) c on true
  `;
}

/** The best `SUMMARY_TREE_GUIDE_CHUNKS_PER_HIT` chunks of one hit's range: BM25 against the query, document order on ties. */
function pickGuidedChunks(query: string, chunks: SearchChunk[]): SearchChunk[] {
  if (chunks.length <= SUMMARY_TREE_GUIDE_CHUNKS_PER_HIT) return chunks;
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const position = new Map(chunks.map((chunk, index) => [chunk.id, index]));
  return rerankBM25(query, chunks.map((chunk) => ({ id: chunk.id, text: chunk.text, score: 0 })))
    .sort((a, b) => (b.crossScore ?? 0) - (a.crossScore ?? 0) || position.get(a.id)! - position.get(b.id)!)
    .slice(0, SUMMARY_TREE_GUIDE_CHUNKS_PER_HIT)
    .map((ranked) => byId.get(ranked.id)!);
}

/**
 * One run of the leg, without its deadline (see `runSummaryTreeLegWithDeadline`). Throws on failure; the deadline
 * wrapper turns that into a skipped leg.
 */
export async function summaryTreeLeg(args: {
  mode: Exclude<SummaryTreeSearchMode, "off">;
  query: string;
  queryVector: number[];
  projectId: string;
  orgId: string;
  pipeline: Pick<PipelineFeatures, "embedding">;
  /** For the relevance floor on summary hits (relevance.ts `embeddingPipelineId`). */
  embeddingPipeline: string | null;
  options: Pick<SearchOptions, "filters" | "runId" | "minScore">;
  expired(): boolean;
  deps: SummaryTreeLegDeps;
}): Promise<SummaryTreeLegResult> {
  const embedding = resolveEmbeddingRoute(args.pipeline.embedding);
  const space = { projectId: args.projectId, embeddingModel: embedding.model, dimension: args.queryVector.length };
  const candidates = treeCandidates(scopeEligibleDocuments(await loadEligibleDocuments(space), args.options.filters, args.options.runId));
  const stats = { ...EMPTY_STATS, candidateDocuments: candidates.size };
  if (candidates.size === 0) return skippedResult("not-ready", 0, stats);

  const searched = await lanceDbSummarySearch({
    orgId: args.orgId, projectId: args.projectId, embeddingModel: embedding.model, queryVector: args.queryVector,
    documentIds: [...candidates.keys()], limit: SUMMARY_TREE_SEARCH_HITS,
  });
  if (searched.status === "missing") {
    // Postgres says trees are ready but the table is not there: an inconsistency, not "no tree yet".
    countSearchEvent("summaryTreeTableMissing");
    return skippedResult("error", 0, stats);
  }
  stats.hits = searched.hits.length;
  if (args.expired()) return skippedResult("deadline", 0, stats);

  // Re-check against the eligible set as it is now: a withdrawal hint drops the cached set while the query runs.
  const current = treeCandidates(scopeEligibleDocuments(await loadEligibleDocuments(space), args.options.filters, args.options.runId));
  const baseline = embeddingNoiseBaseline(args.embeddingPipeline);
  const floor = resolveMinScore(args.options.minScore);
  const ranked: Array<LanceDbSummaryHit & { relevance: number }> = [];
  for (const hit of searched.hits) {
    const document = current.get(hit.documentId);
    if (!document || !candidates.has(hit.documentId) || hit.runId !== document.runId) {
      stats.staleDropped += 1;
      continue;
    }
    const relevance = baseline === null ? 1 : vectorRelevance(hit.score, baseline);
    if (floor > 0 && relevance < floor) {
      stats.belowFloor += 1;
      continue;
    }
    ranked.push({ ...hit, relevance });
  }
  if (stats.staleDropped > 0) countSearchEvent("summaryTreeStaleDropped");
  if (ranked.length === 0) return { applied: args.mode, ms: 0, guided: [], summaries: [], stats };

  // The first SUMMARY_TREE_GUIDE_HITS hits narrow enough to guide have their range fetched.
  let guides = 0;
  const hits = ranked.map((hit) => {
    const guide = guides < SUMMARY_TREE_GUIDE_HITS && hit.chunkEnd - hit.chunkStart < SUMMARY_TREE_GUIDE_MAX_RANGE;
    if (guide) guides += 1;
    return { hit_id: hit.id, document_id: hit.documentId, run_id: hit.runId, guide };
  });
  const rows = await validateAndFetch({
    projectId: args.projectId, orgId: args.orgId, embeddingModel: embedding.model, dimension: args.queryVector.length,
    filters: args.options.filters, runId: args.options.runId, hits,
  });

  const rowsByHit = new Map<string, GuideRow[]>();
  for (const row of rows) rowsByHit.set(row.hit_id, [...(rowsByHit.get(row.hit_id) ?? []), row]);
  stats.validated = rowsByHit.size;
  if (stats.validated < ranked.length) countSearchEvent("summaryTreeInvalidDropped");

  const guided: SearchChunk[] = [];
  const guidedIds = new Set<string>();
  const summaries: SummaryTreeSummary[] = [];
  for (const hit of ranked) {
    const hitRows = rowsByHit.get(hit.id);
    // No row: Postgres no longer vouches for this node. It is neither a guide nor a returned summary.
    if (!hitRows || hitRows.length === 0) continue;
    const node = hitRows[0]!;
    const chunks = hitRows
      .filter((row): row is GuideRow & { id: string; run_id: string; chunk_index: number; text: string } =>
        row.id !== null && row.run_id !== null && row.chunk_index !== null && row.text !== null)
      .map((row) => args.deps.mapChunk({
        id: row.id, document_id: row.document_id, run_id: row.run_id, chunk_index: row.chunk_index, text: row.text,
        heading_path: row.heading_path ?? [], page_number: row.page_number, token_estimate: row.token_estimate ?? 0,
        rank: 0, filename: node.filename ?? "", metadata: row.metadata ?? {},
      }, hit.score))
      // Chunk rows only ever stand for document text.
      .filter((chunk) => chunk.source === "document");
    for (const chunk of pickGuidedChunks(args.query, chunks)) {
      if (guidedIds.has(chunk.id)) continue;
      guidedIds.add(chunk.id);
      guided.push(chunk);
    }
    if (args.mode === "include") {
      summaries.push({
        kind: "summary",
        id: hit.id,
        documentId: node.document_id,
        filename: node.filename ?? "",
        // Position and range come from the registry row, not the LanceDB row.
        level: node.level,
        summary: hit.text,
        headingPath: hit.headingPath ? hit.headingPath.split(" > ").map((part) => part.trim()).filter(Boolean) : [],
        pageStart: node.page_start,
        pageEnd: node.page_end,
        chunkStart: node.chunk_start,
        chunkEnd: node.chunk_end,
        relevance: hit.relevance,
      });
    }
  }
  return { applied: args.mode, ms: 0, guided, summaries, stats };
}

// --- Fusion -----------------------------------------------------------------------------------------------------------

/**
 * Places guided chunks into the final result list without ever removing or demoting the chunk legs' top results.
 *
 * `base` is the list the search returns without the tree (after fusion, the relevance floor, rerank and MMR), already
 * cut to `limit`. Plain reciprocal-rank fusion of a guided list with it let chunks that appear in both lists overtake
 * a rank-2 chunk and push supporting evidence out of the returned set; this rule cannot:
 *
 * 1. `slots = summaryTreeGuideSlots(limit)` positions at most go to guided chunks, never more than there are guided
 *    chunks to place.
 * 2. The protected prefix is the first `min(base.length, limit - slots)` entries of `base`. They keep their
 *    positions.
 * 3. After the prefix come guided chunks that are not in it, in guide order, up to `slots`. A guided chunk that
 *    `base` already holds below the prefix moves up to its guided position; it is not duplicated.
 * 4. Then the rest of `base` in its own order, until `limit`.
 *
 * So a list shorter than `limit - slots` loses nothing (guided chunks are appended), and a full list gives up at most
 * its last `slots` entries.
 *
 * `dedupeKey` is the project's one-result-per-file control (search-controls.ts `dedupeByFilename`, on by default),
 * which runs after this: once results span more than one file it keeps only the first result of each file. Guided
 * chunks never change what that control does to `base`:
 * - `base` is all from one file (the control would leave it alone): only guided chunks of that same file are placed.
 *   A chunk from a second file would make the control collapse `base` to one result.
 * - otherwise (the control collapses `base` anyway, or `base` is empty): a guided chunk is placed only when it will be
 *   the first result of its file, so one whose file already has a result in the protected prefix, or an earlier guided
 *   chunk, is left out instead of taking a position and then being removed.
 * So with that control on, the tree adds at most one chunk per file the chunk legs' top results do not cover, and
 * nothing across files when they found a single file.
 */
export function placeGuidedChunks<T extends { id: string }>(args: {
  base: T[];
  guided: T[];
  limit: number;
  dedupeKey?: (item: T) => string | null | undefined;
}): { results: T[]; placed: number; protectedPrefix: number } {
  const limit = Math.max(0, Math.floor(args.limit));
  const base = args.base.slice(0, limit);
  const seenGuided = new Set<string>();
  const guidedAll = args.guided.filter((item) => !seenGuided.has(item.id) && Boolean(seenGuided.add(item.id)));
  const baseKeys = new Set(args.dedupeKey ? base.map((item) => args.dedupeKey!(item)).filter(Boolean) : []);
  // One file in `base`: keep to it, and the control stays untriggered (no per-file filtering below).
  const singleFile = args.dedupeKey && baseKeys.size === 1 ? [...baseKeys][0]! : null;
  const guided = singleFile === null ? guidedAll : guidedAll.filter((item) => args.dedupeKey!(item) === singleFile);
  const dedupe = args.dedupeKey && singleFile === null ? args.dedupeKey : undefined;
  const place = (slots: number): { results: T[]; placed: number; protectedPrefix: number } => {
    const protectedPrefix = Math.min(base.length, limit - slots);
    const prefix = base.slice(0, protectedPrefix);
    const prefixIds = new Set(prefix.map((item) => item.id));
    const keys = new Set(dedupe ? prefix.map((item) => dedupe(item)).filter(Boolean) : []);
    const chosen: T[] = [];
    for (const item of guided) {
      if (chosen.length >= slots) break;
      if (prefixIds.has(item.id)) continue;
      const key = dedupe?.(item);
      if (key && keys.has(key)) continue;
      if (key) keys.add(key);
      chosen.push(item);
    }
    const chosenIds = new Set(chosen.map((item) => item.id));
    const rest = base.slice(protectedPrefix).filter((item) => !chosenIds.has(item.id));
    return { results: [...prefix, ...chosen, ...rest].slice(0, limit), placed: chosen.length, protectedPrefix };
  };
  // Reserve only the positions that end up used: when fewer guided chunks can be placed than were reserved, the
  // prefix grows back (which can only rule out more of them), until the two agree.
  let slots = Math.min(summaryTreeGuideSlots(limit), guided.length);
  for (;;) {
    const placement = place(slots);
    if (placement.placed === slots) return placement;
    slots = placement.placed;
  }
}

/**
 * `include`: the summaries returned beside the results, best first, while their tokens stay within
 * `SUMMARY_TREE_INCLUDE_CONTEXT_SHARE` of the whole returned context (result text plus summaries). A summary is
 * never truncated: one that does not fit is left out, and so are the ones after it. With no results there is no
 * context to take a share of, so no summary is returned.
 */
export function capIncludedSummaries(summaries: SummaryTreeSummary[], resultTexts: string[]): SummaryTreeSummary[] {
  const resultTokens = resultTexts.reduce((sum, text) => sum + estimateTextTokens(text), 0);
  if (resultTokens === 0) return [];
  const share = SUMMARY_TREE_INCLUDE_CONTEXT_SHARE;
  // summaryTokens <= share * (resultTokens + summaryTokens)
  const budget = (share / (1 - share)) * resultTokens;
  const kept: SummaryTreeSummary[] = [];
  let used = 0;
  for (const summary of summaries) {
    const tokens = estimateTextTokens(summary.summary);
    if (used + tokens > budget) break;
    used += tokens;
    kept.push(summary);
  }
  return kept;
}

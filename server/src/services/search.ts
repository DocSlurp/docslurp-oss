import { randomUUID } from "node:crypto";
import { qualifyCommunitySummary } from "../search/community-context.js";
import { retrievalScope } from "../search/retrieval-scope.js";
import type {
  CanonicalBlockType,
  DeferredSearchStats,
  CitationLocator,
  CanonicalEvidenceType,
  LayoutRegion,
  PrivacyMode,
  SearchResult,
  SourceTrace,
  TableCell,
  TableCellValueType,
  TableChunkGranularity,
  WorkspaceChatFallbackReason,
} from "@docslurp/shared";
import {
  BILLABLE_UNIT_METRICS,
  PRICE_CARD,
  searchCredits,
  deferredProfilesEnabled,
  citationLocatorSchema,
  indexConfigHash,
  indexConfigOf,
  type PipelineFeatures,
  MAX_LOCATOR_BOXES,
  resolveEmbeddingRoute,
  normalizePageNumber,
  normalizePageNumbers,
} from "@docslurp/shared";

import { sql, type SqlClient } from "../db.js";
import { recordUnitCharge } from "../lib/ai-usage.js";
import { currentChatTurn } from "../lib/chat-turn-context.js";
import { currentRequestSignal } from "../lib/request-context.js";
import { jsonRecord } from "../lib/json-record.js";
import { lanceDbFullTextSearch, lanceDbVectorSearch, warmLanceDbSearch, type LanceDbSearchHit } from "../search/lancedb.js";
import { decodeLanceChunkHydration } from "@docslurp/shared/lancedb-hydration";
import {
  loadEligibleDocuments,
  matchesServingHash,
  nativeScopeSupported,
  scopeEligibleDocuments,
  type EligibleDocument,
} from "../search/eligible-documents.js";
import { reciprocalRankFusion } from "../search/rrf.js";
import type { IndexConfigMap } from "../search/index-serving.js";
import { servedVectorSearch, type IndexServing } from "../search/index-serving.js";
import { embedQuery } from "../search/session-planner.js";
import type { SearchFilters } from "../search/filters.js";
import { type SearchUsageEvent } from "../search/session.js";
import { searchChunkToResult } from "../search/session-execution.js";
import { runSearchSession, type SearchSessionRunnerAdapters } from "../search/session-runner.js";
import {
  resolveSearchSetup,
  loadWorkspacePipeline,
  type SearchAvailabilityRow,
} from "../search/session-setup.js";
import { getDeferredContext } from "../search/deferred/deferred-context.js";
import { runDeferredPageSearch } from "../search/deferred/deferred-search.js";
import { getWorkspaceAccess } from "./organizations.js";
import { resolveSearchMaterializationPolicy } from "../search/deferred/request-policy.js";
import { andSqlFragments, type SqlFragment } from "../lib/sql-fragments.js";
import {
  earlyLexicalDocument,
  lexicalSearchableDocument,
  servableInProgressVersion,
} from "../search/eligibility.js";
import { queryPhraseWindows } from "../search/relevance.js";
import { currentSearchAdmissionGroup, withSearchSlot, type SearchAdmission } from "../search/search-limiter.js";
import { currentChatSessionId } from "../lib/chat-agent-context.js";
import {
  boundedSearchQuery,
  currentSearchSignal,
  isSearchAborted,
  isSearchBoundError,
  isSearchStatementTimeout,
  searchStatementTimeoutMs,
  withSearchSignal,
} from "../search/query-bounds.js";
import { collectSearchTimings, countSearchEvent, recordSearchPhase, timePhase, type SearchTimings } from "../search/timings.js";

export { MissingWorkspaceScopeError } from "../search/session-setup.js";

export interface SearchChunk {
  id: string;
  documentId: string;
  runId: string;
  chunkIndex: number;
  text: string;
  headingPath: string[];
  pageNumber: number | null;
  tokenEstimate: number;
  score: number;
  /**
   * Raw match strength in 0..1, measured before fusion (see search/relevance.ts);
   * unlike `score` it does not depend on the other hits. Undefined: never measured.
   */
  relevance?: number;
  /**
   * Lexical rows that need not contain every query term: "partial" came from the
   * OR backoff (may match on one term), "phrase" from the three-word phrase query.
   */
  lexicalMatch?: "partial" | "phrase";
  filename: string;
  pageNumbers: number[];
  blockIds: string[];
  blockTypes: CanonicalBlockType[];
  evidenceType: CanonicalEvidenceType | null;
  canonicalDocumentUri: string | null;
  tableGranularity: TableChunkGranularity | null;
  tableRowIndex: number | null;
  tableRowCount: number | null;
  tableColumnNames: string[];
  tableColumnTypes: TableCellValueType[];
  tableCells: TableCell[];
  tableCell: TableCell | null;
  regionBoxes: LayoutRegion[];
  regions: LayoutRegion[];
  regionCoordinateSpace: string | null;
  sourceTrace: SourceTrace | null;
  /** Exact evidence position (passage/box, slide, sheet range, media moment); null when unknown. */
  locator?: CitationLocator | null;
  source: "document" | "community_summary" | "web";
  retrievalStage: "full-index" | "page-index";
  /** Set when a deferred-search locator (Index Map node or page image) picked this chunk's page. */
  deferredLocator?: "map-node" | "page-image";
}

export interface SearchActivity {
  id: string; groupId: string; query: string; status: "loading" | "success" | "error";
  runtimeMs?: number; resultCount?: number; inputTokens?: number; outputTokens?: number; aggregate?: boolean;
}

export interface SearchOptions {
  onSearchActivity?: (activity: SearchActivity) => void;
  runId?: string;
  limit?: number;
  queryVector?: number[];
  useHyDE?: boolean;
  useRerank?: boolean;
  rerankProvider?: "bm25" | "deepinfra";
  rerankModel?: "Qwen/Qwen3-Reranker-0.6B";
  /** Per-adapter and fused candidate cap, 1..200; independent of rerank and output limit. */
  candidateDepth?: number;
  /** Explicit relevance order or lost-in-middle prompt packing; omitted preserves legacy behavior. */
  resultOrder?: "relevance" | "prompt";
  useMmr?: boolean;
  mmrLambda?: number;
  filters?: SearchFilters;
  variant?: string;
  parentRetrieval?: boolean;
  summarySeed?: boolean;
  queryRewrite?: boolean;
  queryDecompose?: boolean;
  stepback?: boolean;
  glossary?: Record<string, string[]>;
  useContextualCompression?: boolean;
  selfQuery?: boolean;
  adaptiveRetrieval?: boolean;
  queryTier?: "simple" | "multi-facet" | "analytical";
  enableGraphExpansion?: boolean;
  enableCommunityExpansion?: boolean;
  enableWebFallback?: boolean;
  graphHops?: number;
  iterativeMultiHop?: boolean;
  internalAgenticDepth?: number;
  suppressSessionLog?: boolean;
  rootSessionId?: string;
  /**
   * Relevance floor, 0..1: results whose raw relevance is lower are dropped.
   * 0 disables it. Omitted: the workspace default, else SEARCH_MIN_SCORE.
   */
  minScore?: number;
}

/** What the relevance floor did to this search. */
export interface SearchRelevanceFloor {
  /** Floor that was applied; 0 means disabled. */
  minScore: number;
  /** Retrieved candidates removed for being below the floor. */
  dropped: number;
  /** True when nothing relevant was found in a searchable workspace: `results` is empty. */
  noMatch: boolean;
}

export interface SearchResponse {
  results: SearchResult[];
  sessionId: string;
  availability: SearchAvailability;
  relevanceFloor?: SearchRelevanceFloor;
  usageEvents?: SearchUsageEvent[];
  /** Phase durations in ms (setup, embed, vector, text, …, total). */
  timings?: SearchTimings;
  /** Present when the search touched deferred-mode documents (map/visual). */
  deferred?: DeferredSearchStats;
}

export interface SearchAvailability {
  status: "empty" | "pending" | "partial" | "complete";
  isPartial: boolean;
  /** Some searchable documents are served by keyword search only (vectors not indexed yet). */
  keywordOnly: boolean;
  scope: {
    workspaceId: string;
    runId: string | null;
  };
  coverage: {
    totalDocuments: number;
    indexedDocuments: number;
    pageIndexedDocuments: number;
    searchableDocuments: number;
    pageOnlyDocuments: number;
    keywordOnlyDocuments: number;
    /** Documents that failed (or whose Run stalled); the rest of the scope is still searched. */
    failedDocuments: number;
    inProgressDocuments: number;
    totalPages: number;
    searchablePages: number;
    indexedChunkCount: number;
    queuedRuns: number;
    processingRuns: number;
  };
  resultBreakdown: {
    indexedResultCount: number;
    pageResultCount: number;
  };
  message: string | null;
}

type ProgressivePageRow = {
  id: string;
  document_id: string;
  run_id: string;
  page_number: number;
  text: string;
  token_estimate: number;
  rank: number;
  filename: string;
};

type CommunitySummaryRow = {
  id: string;
  run_id: string;
  label: string;
  summary: string;
  member_count: number;
  rank: number;
};

export const wholeCorpusContextLimits = {
  maxDocuments: 12,
  maxChunks: 24,
  maxTokens: 12000,
  maxChars: 60000,
} as const;

export interface WholeCorpusWorkspaceContext {
  eligible: boolean;
  reason: WorkspaceChatFallbackReason | null;
  results: SearchResult[];
  stats: {
    documentCount: number;
    chunkCount: number;
    tokenEstimate: number;
    charEstimate: number;
    maxDocuments: number;
    maxChunks: number;
    maxTokens: number;
    maxChars: number;
  };
}

type ChunkRow = {
  id: string;
  document_id: string;
  run_id: string;
  chunk_index: number;
  text: string;
  heading_path: string[];
  page_number: number | null;
  token_estimate: number;
  rank: number;
  filename: string;
  metadata: Record<string, unknown>;
};

/** Sources whose "page" is a placeholder (one flat recording / deck / sheet), so a page fallback would be a fake position. */
const NON_PAGINATED_FILE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|mp4|m4v|mov|mkv|webm|avi|pptx?|xlsx?|xlsm|csv|tsv)$/i;

/**
 * The ingest worker stores a locator on each chunk's metadata. Chunks indexed before locators existed fall back to
 * their page, which is accurate for paginated sources. For recordings, decks and sheets (whose page is always 1) and
 * for a stored locator of another kind that fails validation, there is no honest page, so the result is null and
 * callers keep using the citation's text and filename.
 */
export function readChunkLocator(
  value: unknown,
  pageNumber: number | null,
  hints: { filename?: string | null; extractor?: string | null } = {},
): CitationLocator | null {
  if (value && typeof value === "object") {
    const parsed = citationLocatorSchema.safeParse(value);
    if (parsed.success) {
      const locator = parsed.data;
      return "boxes" in locator && locator.boxes.length > MAX_LOCATOR_BOXES ? { ...locator, boxes: locator.boxes.slice(0, MAX_LOCATOR_BOXES) } : locator;
    }
    const kind = (value as { kind?: unknown }).kind;
    if (typeof kind === "string" && kind !== "page") return null;
  }
  if (hints.extractor?.startsWith("media:") || (hints.filename && NON_PAGINATED_FILE.test(hints.filename))) return null;
  return pageNumber ? { kind: "page", pageNumber, charStart: null, charEnd: null, boxes: [] } : null;
}

/** Exported for the worker-to-citation round-trip test. */
export function mapChunk(row: ChunkRow, score: number): SearchChunk {
  const metadata = jsonRecord(row.metadata);
  const pageNumbers = normalizePageNumbers(
    readNumberArray(metadata.pageNumbers),
  );
  const blockTypes = readStringArray(
    metadata.blockTypes,
  ) as CanonicalBlockType[];
  const evidenceType = readEvidenceType(metadata.evidenceType);
  const sourceTrace = readSourceTrace(metadata.sourceTrace, metadata);
  const pageNumber =
    normalizePageNumber(row.page_number) ??
    (pageNumbers.length === 1 ? pageNumbers[0]! : null);
  return {
    id: row.id,
    documentId: row.document_id,
    runId: row.run_id,
    chunkIndex: row.chunk_index,
    text: readChunkDisplayText(metadata, row.text),
    headingPath: row.heading_path ?? [],
    pageNumber,
    tokenEstimate: row.token_estimate,
    filename: row.filename ?? "",
    score,
    pageNumbers,
    blockIds: readStringArray(metadata.blockIds),
    blockTypes,
    evidenceType,
    canonicalDocumentUri:
      typeof metadata.canonicalDocumentUri === "string"
        ? metadata.canonicalDocumentUri
        : null,
    tableGranularity: readTableGranularity(metadata.tableGranularity),
    tableRowIndex: readNullableNumber(metadata.tableRowIndex),
    tableRowCount: readNullableNumber(metadata.tableRowCount),
    tableColumnNames: readStringArray(metadata.tableColumnNames),
    tableColumnTypes: readTableColumnTypes(metadata.tableColumnTypes),
    tableCells: readTableCells(metadata.tableCells),
    tableCell: readTableCell(metadata.tableCell),
    regionBoxes: readRegionBoxes(metadata.regionBoxes),
    regions: readRegionBoxes(metadata.regions ?? metadata.regionBoxes),
    regionCoordinateSpace:
      typeof metadata.regionCoordinateSpace === "string"
        ? metadata.regionCoordinateSpace
        : null,
    sourceTrace,
    locator: readChunkLocator(metadata.locator, pageNumber, { filename: row.filename, extractor: sourceTrace?.extractor }),
    source:
      metadata.source === "community_summary" || metadata.source === "web"
        ? metadata.source
        : "document",
    retrievalStage: "full-index",
  };
}

function mapProgressivePageRow(
  row: ProgressivePageRow,
  score: number,
): SearchChunk {
  return {
    id: row.id,
    documentId: row.document_id,
    runId: row.run_id,
    chunkIndex: Math.max(0, row.page_number - 1),
    text: row.text,
    headingPath: [],
    pageNumber: row.page_number,
    tokenEstimate: row.token_estimate,
    filename: row.filename,
    score,
    pageNumbers: [row.page_number],
    blockIds: [],
    blockTypes: [],
    evidenceType: null,
    canonicalDocumentUri: null,
    tableGranularity: null,
    tableRowIndex: null,
    tableRowCount: null,
    tableColumnNames: [],
    tableColumnTypes: [],
    tableCells: [],
    tableCell: null,
    regionBoxes: [],
    regions: [],
    regionCoordinateSpace: null,
    sourceTrace: {
      canonicalDocumentUri: null,
      parserArtifactUri: null,
      sourceArtifactUri: null,
      blockIds: [],
      pageNumbers: [row.page_number],
      extractor: "page-index",
    },
    locator: { kind: "page", pageNumber: row.page_number, charStart: null, charEnd: null, boxes: [] },
    source: "document",
    retrievalStage: "page-index",
  };
}

type WholeCorpusSummaryRow = {
  document_count: number;
  chunk_count: number;
  token_estimate: number;
  char_estimate: number;
};

export async function loadWorkspaceWholeCorpusContext(args: {
  workspaceId: string;
  filters?: SearchFilters;
  runId?: string;
  userId: string;
  maxDocuments?: number;
  maxChunks?: number;
  maxTokens?: number;
  maxChars?: number;
}): Promise<WholeCorpusWorkspaceContext> {
  const limits = {
    maxDocuments: args.maxDocuments ?? wholeCorpusContextLimits.maxDocuments,
    maxChunks: args.maxChunks ?? wholeCorpusContextLimits.maxChunks,
    maxTokens: args.maxTokens ?? wholeCorpusContextLimits.maxTokens,
    maxChars: args.maxChars ?? wholeCorpusContextLimits.maxChars,
  };

  const emptyContext: WholeCorpusWorkspaceContext = {
    eligible: false,
    reason: "load-failed",
    results: [],
    stats: {
      documentCount: 0,
      chunkCount: 0,
      tokenEstimate: 0,
      charEstimate: 0,
      ...limits,
    },
  };

  try {
    const access = await getWorkspaceAccess(args.workspaceId, args.userId);
    if (!access) {
      return emptyContext;
    }

    const scope = retrievalScope({ workspaceId: access.workspaceId, filters: args.filters, runId: args.runId });
    const [summary] = await sql<WholeCorpusSummaryRow[]>`
      select
        count(distinct c.document_id)::int as document_count,
        count(*)::int as chunk_count,
        coalesce(sum(c.token_estimate), 0)::int as token_estimate,
        coalesce(sum(length(c.text)), 0)::int as char_estimate
      from document_chunks c
      join documents d on d.id = c.document_id
      where d.workspace_id = ${access.workspaceId}
        and ${lexicalSearchableDocument("d")}
        and ${scope.chunk()}
    `;

    const stats = {
      documentCount: summary?.document_count ?? 0,
      chunkCount: summary?.chunk_count ?? 0,
      tokenEstimate: summary?.token_estimate ?? 0,
      charEstimate: summary?.char_estimate ?? 0,
      ...limits,
    };

    // If no chunks exist yet (embed stage not yet run), fall back to page-level context.
    // This happens when a document was page-indexed but not yet chunk-embedded.
    if (stats.chunkCount === 0) {
      const [pageSummary] = await sql<
        { page_count: number; char_estimate: number }[]
      >`
        select count(*)::int as page_count,
               coalesce(sum(length(p.text)), 0)::int as char_estimate
        from document_pages p
        join documents d on d.id = p.document_id
        where d.workspace_id = ${access.workspaceId}
          and ${lexicalSearchableDocument("d")}
        and ${scope.page()}
      `;
      const pageCount = pageSummary?.page_count ?? 0;
      const pageChars = pageSummary?.char_estimate ?? 0;
      if (pageCount > 0 && pageChars <= limits.maxChars) {
        const pageRows = await sql<ProgressivePageRow[]>`
          select p.id, p.document_id, p.run_id, p.page_number, p.text,
                 p.token_estimate, d.filename, 0::int as rank
          from document_pages p
          join documents d on d.id = p.document_id
          where d.workspace_id = ${access.workspaceId}
            and ${lexicalSearchableDocument("d")}
        and ${scope.page()}
          order by d.filename asc, p.page_number asc
          limit ${limits.maxChunks}
        `;
        const results = pageRows.map((row, index) =>
          searchChunkToResult(mapProgressivePageRow(row, 1 / (1 + index))),
        );
        return {
          eligible: true,
          reason: null,
          results,
          stats: { ...stats, chunkCount: pageCount, charEstimate: pageChars },
        };
      }
      return {
        eligible: false,
        reason: "empty-workspace",
        results: [],
        stats,
      };
    }

    if (stats.documentCount > limits.maxDocuments) {
      return {
        eligible: false,
        reason: "document-limit-exceeded",
        results: [],
        stats,
      };
    }

    if (stats.chunkCount > limits.maxChunks) {
      return {
        eligible: false,
        reason: "chunk-limit-exceeded",
        results: [],
        stats,
      };
    }

    if (stats.tokenEstimate > limits.maxTokens) {
      return {
        eligible: false,
        reason: "token-limit-exceeded",
        results: [],
        stats,
      };
    }

    if (stats.charEstimate > limits.maxChars) {
      return {
        eligible: false,
        reason: "char-limit-exceeded",
        results: [],
        stats,
      };
    }

    const rows = await sql<ChunkRow[]>`
      select
        c.id,
        c.document_id,
        c.run_id,
        c.chunk_index,
        c.text,
        c.heading_path,
        c.page_number,
        c.token_estimate,
        0::int as rank,
        d.filename,
        c.metadata
      from document_chunks c
      join documents d on d.id = c.document_id
      where d.workspace_id = ${access.workspaceId}
        and ${lexicalSearchableDocument("d")}
        and ${scope.chunk()}
      order by d.filename asc, c.chunk_index asc
      limit ${limits.maxChunks}
    `;

    const results = rows.map((row, index) =>
      searchChunkToResult(mapChunk(row, 1 / (1 + index))),
    );
    return {
      eligible: true,
      reason: null,
      results,
      stats,
    };
  } catch {
    return emptyContext;
  }
}

export function deriveSearchAvailability(
  row: SearchAvailabilityRow | undefined,
  scope: { workspaceId: string; runId?: string },
  resultBreakdown?: { indexedResultCount: number; pageResultCount: number },
): SearchAvailability {
  const coverage = {
    totalDocuments: row?.total_documents ?? 0,
    indexedDocuments: row?.indexed_documents ?? 0,
    pageIndexedDocuments: row?.page_indexed_documents ?? 0,
    searchableDocuments: row?.searchable_documents ?? 0,
    pageOnlyDocuments:
      row?.page_only_documents ??
      Math.max(
        0,
        (row?.searchable_documents ?? 0) -
          (row?.indexed_documents ?? 0) -
          (row?.keyword_only_documents ?? 0),
      ),
    keywordOnlyDocuments: row?.keyword_only_documents ?? 0,
    failedDocuments: row?.failed_documents ?? 0,
    inProgressDocuments: row?.in_progress_documents ?? 0,
    totalPages: row?.total_pages ?? 0,
    searchablePages: row?.searchable_pages ?? 0,
    indexedChunkCount: row?.indexed_chunk_count ?? 0,
    queuedRuns: row?.queued_runs ?? 0,
    processingRuns: row?.processing_runs ?? 0,
  };

  const resultCounts = {
    indexedResultCount: resultBreakdown?.indexedResultCount ?? 0,
    pageResultCount: resultBreakdown?.pageResultCount ?? 0,
  };

  const hasChunkIndexCoverage = coverage.indexedChunkCount > 0;
  const hasSearchablePageCoverage = coverage.searchablePages > 0;
  const activeRunCount = coverage.queuedRuns + coverage.processingRuns;
  const activeDocumentCount = coverage.inProgressDocuments;
  const failedDocumentCount = coverage.failedDocuments;
  const failedRunCount = row?.failed_runs ?? 0;
  const stalledRunCount = row?.stalled_runs ?? 0;

  let status: SearchAvailability["status"] = "complete";
  if (coverage.totalDocuments === 0) {
    status = "empty";
  } else if (
    coverage.searchableDocuments === 0 &&
    !hasChunkIndexCoverage &&
    !hasSearchablePageCoverage
  ) {
    status =
      activeRunCount > 0 || activeDocumentCount > 0 ? "pending" : "empty";
  } else if (
    coverage.indexedDocuments < coverage.totalDocuments ||
    (coverage.pageIndexedDocuments > 0 &&
      coverage.searchablePages < coverage.totalPages) ||
    coverage.inProgressDocuments > 0 ||
    coverage.queuedRuns > 0 ||
    coverage.processingRuns > 0 ||
    coverage.failedDocuments > 0
  ) {
    status = "partial";
  }

  let message: string | null = null;
  if (status === "pending") {
    message = `Search is still warming up for this scope. ${coverage.searchableDocuments}/${coverage.totalDocuments} documents are searchable so far.`;
  } else if (status === "partial") {
    message = partialAvailabilityMessage(coverage);
  } else if (status === "empty") {
    if (
      coverage.totalDocuments > 0 &&
      (failedDocumentCount > 0 || failedRunCount > 0 || stalledRunCount > 0)
    ) {
      const failedDocLabel =
        failedDocumentCount === 1
          ? "1 document has"
          : `${failedDocumentCount} documents have`;
      message = [
        `No searchable content is available for this scope because ${failedDocLabel} failed or stalled during processing.`,
        "Retry or reprocess the failed run to rebuild the index.",
      ].join(" ");
    } else {
      message = "No searchable documents are available for this scope yet.";
    }
  }

  return {
    status,
    isPartial: status === "partial" || status === "pending",
    keywordOnly: coverage.keywordOnlyDocuments > 0,
    scope: {
      workspaceId: scope.workspaceId,
      runId: scope.runId ?? null,
    },
    coverage,
    resultBreakdown: resultCounts,
    message,
  };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "Searching 31 of 48 pages (3 of 5 documents); 2 documents still processing, 1 keyword-only so far; 2 documents failed; retry them from the activity panel." */
export function partialAvailabilityMessage(
  coverage: SearchAvailability["coverage"],
): string {
  const scope =
    coverage.totalPages > 0
      ? `Searching ${coverage.searchablePages} of ${plural(coverage.totalPages, "page")} (${coverage.searchableDocuments} of ${plural(coverage.totalDocuments, "document")})`
      : `Searching ${coverage.searchableDocuments} of ${plural(coverage.totalDocuments, "document")}`;
  const notes = [
    coverage.inProgressDocuments > 0
      ? `${plural(coverage.inProgressDocuments, "document")} still processing`
      : null,
    coverage.keywordOnlyDocuments > 0
      ? `${coverage.keywordOnlyDocuments} keyword-only until vector indexing finishes`
      : null,
  ].filter(Boolean);
  const base = notes.length > 0 ? `${scope}; ${notes.join(", ")}` : scope;
  if (coverage.failedDocuments > 0) {
    const retry = coverage.failedDocuments === 1 ? "retry it" : "retry them";
    return `${base}; ${plural(coverage.failedDocuments, "document")} failed; ${retry} from the activity panel.`;
  }
  return `${base}.`;
}

function buildSearchAvailability(
  row: SearchAvailabilityRow | undefined,
  scope: { workspaceId: string; runId?: string },
  chunks: SearchChunk[],
): SearchAvailability {
  return deriveSearchAvailability(row, scope, {
    indexedResultCount: chunks.filter(
      (chunk) => chunk.retrievalStage === "full-index",
    ).length,
    pageResultCount: chunks.filter(
      (chunk) => chunk.retrievalStage === "page-index",
    ).length,
  });
}

function supportsProgressivePageSearch(filters: SearchFilters | undefined): boolean {
  return retrievalScope({ filters }).supportsPages;
}

/**
 * ANN vector search via LanceDB.
 *
 * Uses LanceDB shard tables (per-org namespace isolation) for cosine similarity,
 * then hydrates full chunk metadata from PostgreSQL document_chunks.
 */
async function vectorSearch(
  queryVector: number[],
  userId: string,
  workspaceId: string,
  options: SearchOptions,
  serving: IndexServing | null = null,
  privacyMode?: PrivacyMode,
): Promise<SearchChunk[]> {
  const access = await getWorkspaceAccess(workspaceId, userId);
  if (!access) return [];

  const embedding = resolveEmbeddingRoute(serving?.embedding ?? (await loadWorkspacePipeline(workspaceId)).embedding);
  // Persisted model/dimension metadata prevents legacy tables from mixing vector spaces.
  // Dedup copies (same content re-ingested) own no LanceDB rows: their vectors
  // stay keyed by the document that was embedded. Walk deduped_from to that
  // owner so copies are searchable, then map hits to the copy's chunk with the
  // same chunk index.
  const docRows = await sql<{ id: string; owner_id: string }[]>`
    with recursive current_docs as (
      select distinct d.id from documents d
      join vector_indexes v on v.document_id = d.id
      where d.workspace_id = ${workspaceId}
        and d.status = 'completed' and d.superseded_at is null
        and ${retrievalScope({ workspaceId, filters: options.filters, runId: options.runId }).vectorDocument()}
        and v.backend = 'lancedb'
        and v.embedding_model = ${embedding.model}
        and v.dimension = ${queryVector.length}
    ),
    chain as (
      select c.id, d.id as node, d.deduped_from_document_id as next, 0 as depth
      from current_docs c join documents d on d.id = c.id
      union all
      select chain.id, d.id, d.deduped_from_document_id, chain.depth + 1
      from chain join documents d on d.id = chain.next
      where chain.depth < 8
    )
    select distinct on (chain.id) chain.id, chain.node as owner_id
    from chain
    join documents owner on owner.id = chain.node
    where ${serving?.hash
      ? serving.hash.op === "eq"
        ? sql`owner.index_config_hash = ${serving.hash.value}`
        : sql`owner.index_config_hash is distinct from ${serving.hash.value}`
      : sql`true`}
    order by chain.id, chain.depth desc
  `;
  const scopedRows = docRows;
  const documentIds = scopedRows.map((row) => row.id);
  if (documentIds.length === 0) return [];
  const copiesByOwner = new Map<string, string[]>();
  for (const row of scopedRows) {
    if (!row.owner_id || row.owner_id === row.id) continue;
    copiesByOwner.set(row.owner_id, [...(copiesByOwner.get(row.owner_id) ?? []), row.id]);
  }
  const searchDocumentIds = [...new Set([...documentIds, ...copiesByOwner.keys()])];

  const limit = options.limit ?? 20;

  // ANN search across LanceDB shard tables
  const hits = await lanceDbVectorSearch({
    orgId: access.orgId,
    embeddingModel: embedding.model,
    legacyDocumentIds: searchDocumentIds,
    queryVector,
    documentIds: searchDocumentIds,
    limit,
    privacyMode,
  });

  if (hits.length === 0) return [];

  const currentIds = new Set(documentIds);
  const rowsByHit = await hydrateHitsFromPostgres(hits, currentIds, copiesByOwner, workspaceId, options);
  // Preserve LanceDB ranking order
  const seen = new Set<string>();
  return hits.flatMap((hit) => (rowsByHit.get(hit.id) ?? []).flatMap((row) => {
    if (seen.has(row.id)) return [];
    seen.add(row.id);
    return [mapChunk(row, hit.score)];
  }));
}

/**
 * Chunk rows for LanceDB hits from PostgreSQL (metadata, heading_path, etc.):
 * own chunks by id, dedup copies by (copy document, chunk index). One query.
 */
async function hydrateHitsFromPostgres(
  hits: LanceDbSearchHit[],
  currentIds: ReadonlySet<string>,
  copiesByOwner: ReadonlyMap<string, string[]>,
  workspaceId: string,
  options: SearchOptions,
): Promise<Map<string, ChunkRow[]>> {
  const rowsByHit = new Map<string, ChunkRow[]>();
  if (hits.length === 0) return rowsByHit;
  const ownHitIds = hits.filter((hit) => currentIds.has(hit.documentId)).map((hit) => hit.id);
  const copyPairs = hits.flatMap((hit) => currentIds.has(hit.documentId) || hit.chunkIndex === null
    ? []
    : (copiesByOwner.get(hit.documentId) ?? []).map((documentId) => ({ hit: hit.id, document_id: documentId, chunk_index: hit.chunkIndex })));
  const whereClause = buildChunkSearchWhere(options.filters, options.runId);
  const rows = await sql<(ChunkRow & { hit_id: string })[]>`
    select c.id, c.document_id, c.run_id, c.chunk_index, c.text, c.heading_path,
           c.page_number, c.token_estimate, c.metadata, d.filename,
           0::int as rank, c.id as hit_id
    from document_chunks c
    join documents d on d.id = c.document_id
    where c.id in (select jsonb_array_elements_text(${sql.json(ownHitIds)}::jsonb))
      and d.workspace_id = ${workspaceId}
      and ${whereClause}
    union all
    select c.id, c.document_id, c.run_id, c.chunk_index, c.text, c.heading_path,
           c.page_number, c.token_estimate, c.metadata, d.filename,
           0::int as rank, pairs.hit as hit_id
    from jsonb_to_recordset(${sql.json(copyPairs)}::jsonb) as pairs(hit text, document_id text, chunk_index int)
    join document_chunks c on c.document_id = pairs.document_id and c.chunk_index = pairs.chunk_index
    join documents d on d.id = c.document_id
    where d.workspace_id = ${workspaceId}
      and ${whereClause}
  `;
  for (const row of rows) rowsByHit.set(row.hit_id, [...(rowsByHit.get(row.hit_id) ?? []), row]);
  return rowsByHit;
}

/**
 * Native (SEARCH_LANCEDB_NATIVE) hydration: a hit on a document in scope
 * whose row carries the hydration columns becomes a chunk with no Postgres
 * read. Rows without them (tables not backfilled yet) and hits that serve
 * dedup copies are hydrated from Postgres in one query. Order and scores
 * follow `hits`; `score(hit, index)` sets each chunk's score.
 */
async function hydrateNativeHits(args: {
  hits: LanceDbSearchHit[];
  documents: ReadonlyMap<string, EligibleDocument>;
  copiesByOwner: ReadonlyMap<string, string[]>;
  workspaceId: string;
  options: SearchOptions;
  score: (hit: LanceDbSearchHit, index: number) => number;
}): Promise<SearchChunk[]> {
  const rowsByHit = new Map<string, ChunkRow[]>();
  const misses: LanceDbSearchHit[] = [];
  let stale = 0;
  for (const hit of args.hits) {
    const document = args.documents.get(hit.documentId);
    const hydration = decodeLanceChunkHydration(hit.hydration);
    const copies = args.copiesByOwner.get(hit.documentId);
    // A correction reindex rewrites a document's chunks under new ids and
    // leaves its LanceDB rows stale (lanceStale, from the cached set): those
    // hits hydrate from Postgres, which drops chunks that no longer exist.
    if (document?.lanceStale) stale += 1;
    if (document && !document.lanceStale && hydration && typeof hit.text === "string" && hit.chunkIndex !== null && hydration.runId === document.runId) {
      rowsByHit.set(hit.id, [{
        id: hit.id, document_id: hit.documentId, run_id: hydration.runId, chunk_index: hit.chunkIndex, text: hit.text,
        heading_path: hydration.headingPath, page_number: hydration.pageNumber, token_estimate: hydration.tokenEstimate,
        rank: 0, filename: document.filename, metadata: hydration.metadata,
      }]);
      if (copies?.length) misses.push(hit);
    } else {
      misses.push(hit);
    }
  }
  if (stale > 0) countSearchEvent("nativeHydrationStale");
  if (misses.length > 0) {
    countSearchEvent("nativeHydrationPostgres");
    const fromPostgres = await hydrateHitsFromPostgres(misses, new Set(args.documents.keys()), args.copiesByOwner, args.workspaceId, args.options);
    for (const [hitId, rows] of fromPostgres) rowsByHit.set(hitId, [...(rowsByHit.get(hitId) ?? []), ...rows.filter((row) => !(rowsByHit.get(hitId) ?? []).some((own) => own.id === row.id))]);
  }
  const seen = new Set<string>();
  return args.hits.flatMap((hit, index) => (rowsByHit.get(hit.id) ?? []).flatMap((row) => {
    if (seen.has(row.id)) return [];
    seen.add(row.id);
    return [mapChunk(row, args.score(hit, index))];
  }));
}

/** Eligible documents in scope for a native search, with the dedup copy → owner map LanceDB hits resolve through. */
function nativeSearchScope(documents: EligibleDocument[]): {
  byId: Map<string, EligibleDocument>; copiesByOwner: Map<string, string[]>; searchDocumentIds: string[];
} {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const copiesByOwner = new Map<string, string[]>();
  for (const document of documents) {
    if (!document.ownerId || document.ownerId === document.id) continue;
    copiesByOwner.set(document.ownerId, [...(copiesByOwner.get(document.ownerId) ?? []), document.id]);
  }
  return { byId, copiesByOwner, searchDocumentIds: [...new Set([...byId.keys(), ...copiesByOwner.keys()])] };
}

interface NativeSearchContext {
  workspaceId: string;
  orgId: string;
  pipeline: PipelineFeatures;
  indexConfigs: IndexConfigMap;
  privacyMode?: PrivacyMode;
}

/**
 * Vector search with eligibility from the cached set and hydration from the
 * LanceDB row. Null when the request needs the Postgres path (chunk-level
 * filters).
 */
async function nativeVectorSearch(
  queryVector: number[],
  context: NativeSearchContext,
  options: SearchOptions,
  serving: IndexServing | null,
): Promise<SearchChunk[] | null> {
  if (!nativeScopeSupported(options.filters)) return null;
  const embedding = resolveEmbeddingRoute(serving?.embedding ?? context.pipeline.embedding);
  const set = await timePhase("vecEligible", () => loadEligibleDocuments({ workspaceId: context.workspaceId, embeddingModel: embedding.model, dimension: queryVector.length }));
  const documents = scopeEligibleDocuments(set, options.filters, options.runId)
    .filter((document) => document.vectorReady && matchesServingHash(document, serving?.hash));
  if (documents.length === 0) return [];
  const scope = nativeSearchScope(documents);
  const hits = await timePhase("vecLance", () => lanceDbVectorSearch({
    orgId: context.orgId,
    embeddingModel: embedding.model,
    legacyDocumentIds: scope.searchDocumentIds,
    queryVector,
    documentIds: scope.searchDocumentIds,
    limit: options.limit ?? 20,
    privacyMode: context.privacyMode,
    hydrate: true,
  }));
  return await timePhase("vecHydrate", () => hydrateNativeHits({ hits, documents: scope.byId, copiesByOwner: scope.copiesByOwner,
    workspaceId: context.workspaceId, options, score: (hit) => hit.score }));
}

const NATIVE_FALLBACK_LOG_INTERVAL_MS = 10 * 60_000;
const nativeFallbackLogged = new Map<string, number>();

/**
 * Native keyword search fell back to Postgres FTS for a whole org (a table
 * without an FTS index, one that failed to open, ...): logged at most every
 * ten minutes per org and reason, so a deploy ahead of the backfill shows
 * which orgs still need it.
 */
function logNativeLexicalFallback(orgId: string, reason: string, table: string | undefined): void {
  const key = `${orgId}\u0000${reason}`;
  const now = Date.now();
  if ((nativeFallbackLogged.get(key) ?? 0) > now) return;
  if (nativeFallbackLogged.size > 10_000) nativeFallbackLogged.clear();
  nativeFallbackLogged.set(key, now + NATIVE_FALLBACK_LOG_INTERVAL_MS);
  console.warn(`[search] native keyword search fell back to Postgres FTS org=${orgId} reason=${reason}${table ? ` table=${table}` : ""}`);
}

/** False for queries using websearch_to_tsquery operators BM25 cannot honour: "quoted phrases" and -negation. */
export function nativeLexicalQuerySupported(query: string): boolean {
  return !/"[^"]*[^"\s][^"]*"/.test(query) && !/(?:^|\s)-[\p{L}\p{N}"]/u.test(query);
}

/**
 * Keyword search as BM25 top-k from LanceDB's FTS index over the eligible
 * documents, exact over the whole scope (no candidate sample, unlike the
 * Postgres branch's SEARCH_LEXICAL_CANDIDATES cap). Documents served by
 * keyword search before they have vectors (early lexical) are not in LanceDB
 * yet: Postgres FTS covers just those and the lists are fused. Null when the
 * request needs the Postgres path: chunk-level filters, several index configs,
 * or a table without an FTS index.
 */
async function nativeTextSearch(
  query: string,
  userId: string,
  context: NativeSearchContext,
  options: SearchOptions,
): Promise<SearchChunk[] | null> {
  if (!nativeScopeSupported(options.filters)) return null;
  // The BM25 index has no positions and its query is plain terms: a quoted
  // phrase would match its words anywhere and `-term` would boost the term.
  // websearch_to_tsquery honours both, so those queries keep the Postgres path.
  if (!nativeLexicalQuerySupported(query)) {
    countSearchEvent("nativeLexicalOperators");
    return null;
  }
  const currentHash = indexConfigHash(indexConfigOf(context.pipeline));
  if (Object.keys(context.indexConfigs).some((hash) => hash !== currentHash)) return null;
  const embedding = resolveEmbeddingRoute(context.pipeline.embedding);
  const limit = options.limit ?? 20;
  const set = await loadEligibleDocuments({ workspaceId: context.workspaceId, embeddingModel: embedding.model, dimension: embedding.dimensions });
  const inScope = scopeEligibleDocuments(set, options.filters, options.runId);
  const native = inScope.filter((document) => document.vectorReady && !document.lanceStale);
  // Postgres FTS covers documents not in LanceDB yet (early lexical) and those whose rows are stale.
  const tail = inScope.filter((document) => (document.lexical && !document.vectorReady) || (document.vectorReady && document.lanceStale));
  let nativeChunks: SearchChunk[] = [];
  if (native.length > 0) {
    const scope = nativeSearchScope(native);
    let result: Awaited<ReturnType<typeof lanceDbFullTextSearch>>;
    try {
      result = await lanceDbFullTextSearch({
        orgId: context.orgId, embeddingModel: embedding.model, dimension: embedding.dimensions, query,
        documentIds: scope.searchDocumentIds, legacyDocumentIds: scope.searchDocumentIds, limit,
      });
    } catch (error) {
      if (isSearchAborted(error)) throw error;
      countSearchEvent("nativeLexicalError");
      return null;
    }
    if (!result.indexed) {
      countSearchEvent("nativeLexicalUnindexed");
      logNativeLexicalFallback(context.orgId, result.fallback ?? "no-fts-index", result.table);
      return null;
    }
    // OR-semantics BM25: relevance is judged by term coverage, like the Postgres OR backoff.
    nativeChunks = (await hydrateNativeHits({ hits: result.hits, documents: scope.byId, copiesByOwner: scope.copiesByOwner,
      workspaceId: context.workspaceId, options, score: (_hit, index) => 1 / (60 + index + 1) }))
      .map((chunk) => ({ ...chunk, lexicalMatch: "partial" as const }));
  }
  if (tail.length === 0) return nativeChunks;
  countSearchEvent("nativeLexicalTail");
  const requested = new Set(options.filters?.documentIds ?? []);
  const tailIds = tail.map((document) => document.id).filter((id) => requested.size === 0 || requested.has(id));
  if (tailIds.length === 0) return nativeChunks;
  const tailChunks = await textSearch(query, userId, { ...options, filters: { ...options.filters, documentIds: tailIds } });
  if (nativeChunks.length === 0) return tailChunks;
  if (tailChunks.length === 0) return nativeChunks;
  return reciprocalRankFusion([nativeChunks, tailChunks]).slice(0, limit)
    .map((chunk, index) => ({ ...chunk, score: 1 / (60 + index + 1) }));
}

const lexicalBackoffStopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "about",
  "by",
  "can",
  "class",
  "classes",
  "course",
  "courses",
  "does",
  "for",
  "from",
  "give",
  "how",
  "in",
  "is",
  "list",
  "me",
  "of",
  "on",
  "please",
  "show",
  "tell",
  "the",
  "to",
  "what",
  "which",
  "with",
]);

function buildLexicalBackoffTsQuery(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 3 &&
        !lexicalBackoffStopWords.has(token) &&
        /[a-z]/.test(token),
    );

  const uniqueTokens = [...new Set(tokens)];
  if (uniqueTokens.length === 0) {
    return null;
  }

  return uniqueTokens.join(" | ");
}

function mapRankedChunkRows(rows: ChunkRow[], partial = false, phraseIds?: ReadonlySet<string>): SearchChunk[] {
  return rows.map((row) => ({
    ...mapChunk(row, 1 / (60 + row.rank)),
    ...(partial ? { lexicalMatch: phraseIds?.has(row.id) ? "phrase" as const : "partial" as const } : {}),
  }));
}

function buildChunkSearchWhere(filters: SearchFilters | undefined, runId: string | undefined): SqlFragment {
  return sql`${lexicalSearchableDocument("d")} and ${retrievalScope({ filters, runId }).chunk()}`;
}

function buildProgressivePageWhere(filters: SearchFilters | undefined, runId: string | undefined): SqlFragment {
  return retrievalScope({ filters, runId }).progressivePage();
}

/**
 * Matches ranked per lexical statement (SEARCH_LEXICAL_CANDIDATES, default
 * 1000). Ranking every match was the 2026-10-20 incident: a conversational
 * OR backoff matched most of a 285K-chunk workspace, and each statement read
 * and sorted every match's tsvector and text for minutes. Now the first N
 * matches (GIN bitmap order) are ranked by ts_rank_cd and only the top `limit`
 * fetch their text. Selective queries match fewer than N and rank exactly as
 * before; very broad ones rank a bounded sample, which the dense branch and
 * fusion complement.
 */
export function lexicalCandidateLimit(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.SEARCH_LEXICAL_CANDIDATES);
  return env.SEARCH_LEXICAL_CANDIDATES?.trim() && Number.isFinite(parsed)
    ? Math.min(100_000, Math.max(50, Math.trunc(parsed)))
    : 1_000;
}

type LexicalParser = "websearch" | "plain" | "tsquery";

/**
 * Top `limit` chunks matching `query` (parsed by websearch_to_tsquery,
 * plainto_tsquery or to_tsquery), ranked over at most lexicalCandidateLimit()
 * matches. Each parser is a static statement so pg_stat_activity and traces
 * show which one ran.
 */
export function rankedLexicalChunks(client: SqlClient, args: {
  where: SqlFragment;
  parser: LexicalParser;
  query: string;
  limit: number;
  candidates?: number;
}) {
  const { where, query, limit } = args;
  const candidates = Math.max(limit, args.candidates ?? lexicalCandidateLimit());
  const topChunks = client`
    select c.id, c.document_id, c.run_id, c.chunk_index, c.text, c.heading_path,
           c.page_number, c.token_estimate, c.metadata, d.filename,
           row_number() over (order by ranked.score desc, ranked.id) as rank
    from ranked
    join document_chunks c on c.id = ranked.id
    join documents d on d.id = c.document_id
    order by rank
  `;
  switch (args.parser) {
    case "websearch":
      return client<ChunkRow[]>`
        with candidates as materialized (
          select c.id, c.ts_content from document_chunks c join documents d on d.id = c.document_id
          where ${where} and c.ts_content @@ websearch_to_tsquery('english', ${query})
          limit ${candidates}
        ), ranked as (
          select id, ts_rank_cd(ts_content, websearch_to_tsquery('english', ${query})) as score
          from candidates order by score desc, id limit ${limit}
        )
        ${topChunks}
      `;
    case "plain":
      return client<ChunkRow[]>`
        with candidates as materialized (
          select c.id, c.ts_content from document_chunks c join documents d on d.id = c.document_id
          where ${where} and c.ts_content @@ plainto_tsquery('english', ${query})
          limit ${candidates}
        ), ranked as (
          select id, ts_rank_cd(ts_content, plainto_tsquery('english', ${query})) as score
          from candidates order by score desc, id limit ${limit}
        )
        ${topChunks}
      `;
    case "tsquery":
      return client<ChunkRow[]>`
        with candidates as materialized (
          select c.id, c.ts_content from document_chunks c join documents d on d.id = c.document_id
          where ${where} and c.ts_content @@ to_tsquery('english', ${query})
          limit ${candidates}
        ), ranked as (
          select id, ts_rank_cd(ts_content, to_tsquery('english', ${query})) as score
          from candidates order by score desc, id limit ${limit}
        )
        ${topChunks}
      `;
  }
}

async function textSearch(
  query: string,
  _userId: string,
  options: SearchOptions,
): Promise<SearchChunk[]> {
  const limit = options.limit ?? 20;
  const where = buildChunkSearchWhere(options.filters, options.runId);
  const lexical = (parser: LexicalParser, text: string) =>
    boundedSearchQuery((client) => rankedLexicalChunks(client, { where, parser, query: text, limit }));

  // websearch_to_tsquery handles quoted phrases, AND/OR/-, and is more forgiving than
  // plainto_tsquery on special characters. Fall back to plainto_tsquery on parse errors.
  const lexicalBackoffQuery = buildLexicalBackoffTsQuery(query);

  try {
    try {
      const rows = await lexical("websearch", query);
      if (rows.length > 0) {
        return mapRankedChunkRows(rows);
      }

      if (!lexicalBackoffQuery) {
        return [];
      }

      const lexicalRows = await lexical("tsquery", lexicalBackoffQuery);
      // Preserve phrase matches in conversational queries: OR backoff alone lets
      // repeated generic words crowd out the subject of the question.
      const phrases = queryPhraseWindows(query).map((window) => `"${window}"`).join(" OR ");
      const phraseRows = phrases ? await lexical("websearch", phrases) : [];
      const seen = new Set<string>();
      return mapRankedChunkRows([...phraseRows, ...lexicalRows].filter(row => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      }), true, new Set(phraseRows.map((row) => row.id)));
    } catch (error) {
      // A timed-out or aborted statement must not be re-run as a fallback.
      if (isSearchBoundError(error)) throw error;
      // websearch_to_tsquery can fail on degenerate inputs (all stop words, lone operators).
      // Fall back to plainto_tsquery which is always safe.
      try {
        const rows = await lexical("plain", query);
        if (rows.length > 0) {
          return mapRankedChunkRows(rows);
        }
        if (!lexicalBackoffQuery) {
          return [];
        }
        return mapRankedChunkRows(await lexical("tsquery", lexicalBackoffQuery), true);
      } catch (fallbackError) {
        if (isSearchBoundError(fallbackError)) throw fallbackError;
        return [];
      }
    }
  } catch (error) {
    if (isSearchAborted(error)) throw error;
    // The statement timeout degrades this search to its other branches (dense,
    // pages); the chat pending-search retry reads `lexicalTimeout` and stops.
    countSearchEvent("lexicalTimeout");
    console.warn(`[search] lexical branch timed out after ${searchStatementTimeoutMs()}ms; continuing without keyword results`);
    return [];
  }
}

/** A branch whose statement hit the search timeout contributes nothing; the search continues. */
async function degradeOnTimeout<T>(branch: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isSearchStatementTimeout(error)) throw error;
    countSearchEvent(`${branch}Timeout`);
    console.warn(`[search] ${branch} branch timed out after ${searchStatementTimeoutMs()}ms; continuing without it`);
    return fallback;
  }
}

async function progressivePageSearch(
  query: string,
  _userId: string,
  options: SearchOptions,
): Promise<SearchChunk[]> {
  if (!supportsProgressivePageSearch(options.filters)) {
    return [];
  }

  const limit = options.limit ?? 20;
  const whereClause = buildProgressivePageWhere(options.filters, options.runId);

  const rows = await degradeOnTimeout<ProgressivePageRow[]>("progressive", [], () => boundedSearchQuery((client) => client<ProgressivePageRow[]>`
    select
        progressive_pages.id,
        progressive_pages.document_id,
        progressive_pages.run_id,
        progressive_pages.page_number,
        progressive_pages.text,
        progressive_pages.token_estimate,
        progressive_pages.filename,
        row_number() over (
          order by ts_rank_cd(progressive_pages.ts_content, websearch_to_tsquery('english', ${query})) desc
        ) as rank
      from (
        select
          p.id,
          p.document_id,
          p.run_id,
          p.page_number,
          p.text,
          p.token_estimate,
          p.created_at,
          d.filename,
          to_tsvector('english', p.text) as ts_content
        from document_pages p
        join documents d on d.id = p.document_id
        join document_run_stage_states page_stage
          on page_stage.run_id = p.run_id
          and page_stage.document_id = p.document_id
          and page_stage.stage_name = 'page-index'
          and page_stage.status = 'completed'
        left join document_run_stage_states index_stage
          on index_stage.run_id = p.run_id
          and index_stage.document_id = p.document_id
          and index_stage.stage_name = 'index'
          and index_stage.status = 'completed'
        where index_stage.document_id is null
          and ${servableInProgressVersion("d")}
          -- Chunks outrank raw pages: once keyword search serves the
          -- document's chunks, its pages would only duplicate them.
          and not ${earlyLexicalDocument("d")}
      ) progressive_pages
      where ${whereClause}
        and progressive_pages.ts_content @@ websearch_to_tsquery('english', ${query})
      order by ts_rank_cd(progressive_pages.ts_content, websearch_to_tsquery('english', ${query})) desc
      limit ${limit}
  `));

  return rows.map((row) => mapProgressivePageRow(row, 1 / (80 + row.rank)));
}

async function completedPageSearch(args: {
  query: string;
  workspaceId: string;
  options: SearchOptions;
  shouldSearch: boolean;
}): Promise<SearchChunk[]> {
  if (
    !args.shouldSearch ||
    !supportsProgressivePageSearch(args.options.filters)
  ) {
    return [];
  }

  try {
    const limit = args.options.limit ?? 20;
    const pageRows = await boundedSearchQuery((client) => client<ProgressivePageRow[]>`
      select p.id, p.document_id, p.run_id, p.page_number, p.text,
             p.token_estimate, d.filename,
             row_number() over (order by ts_rank_cd(to_tsvector('english', p.text), websearch_to_tsquery('english', ${args.query})) desc)::int as rank
      from document_pages p
      join documents d on d.id = p.document_id
      left join document_chunks c on c.document_id = p.document_id
      where d.workspace_id = ${args.workspaceId}
        and d.status = 'completed' and d.superseded_at is null
        and c.id is null
        and ${retrievalScope({ workspaceId: args.workspaceId, filters: args.options.filters, runId: args.options.runId }).page()}
        and to_tsvector('english', p.text) @@ websearch_to_tsquery('english', ${args.query})
      order by rank asc
      limit ${limit}
    `);

    return pageRows.map((row) =>
      mapProgressivePageRow(row, 1 / (80 + row.rank)),
    );
  } catch (error) {
    if (isSearchAborted(error)) throw error;
    if (isSearchStatementTimeout(error)) countSearchEvent("completedPagesTimeout");
    // websearch_to_tsquery may fail on degenerate inputs; skip silently.
    return [];
  }
}

async function communitySummarySearch(
  query: string,
  workspaceId: string,
  options: SearchOptions,
): Promise<SearchChunk[]> {
  const limit = options.limit ?? 20;
  const rows = await degradeOnTimeout<CommunitySummaryRow[]>("community", [], () => boundedSearchQuery((client) => client<CommunitySummaryRow[]>`
    select
      community.id,
      community.run_id,
      community.label,
      community.summary,
      community.member_count,
      row_number() over (
        order by ts_rank_cd(
          to_tsvector('english', community.label || ' ' || community.summary),
          websearch_to_tsquery('english', ${query})
        ) desc
      )::int as rank
    from kg_communities community
    where community.workspace_id = ${workspaceId}
      and to_tsvector('english', community.label || ' ' || community.summary)
        @@ websearch_to_tsquery('english', ${query})
    order by rank asc
    limit ${limit}
  `));

  return rows.map((row) => ({
    id: `community:${row.id}`,
    documentId: `community:${row.id}`,
    runId: row.run_id,
    chunkIndex: 0,
    text: qualifyCommunitySummary(row.summary, { ...options.filters, ...(options.runId ? { runId: options.runId } : {}) }),
    headingPath: [row.label],
    pageNumber: null,
    tokenEstimate: Math.ceil(qualifyCommunitySummary(row.summary, { ...options.filters, ...(options.runId ? { runId: options.runId } : {}) }).length / 4),
    score: 1 / (120 + row.rank),
    filename: `${row.label} community`,
    pageNumbers: [],
    blockIds: [],
    blockTypes: [],
    evidenceType: null,
    canonicalDocumentUri: null,
    tableGranularity: null,
    tableRowIndex: null,
    tableRowCount: row.member_count,
    tableColumnNames: [],
    tableColumnTypes: [],
    tableCells: [],
    tableCell: null,
    regionBoxes: [],
    regions: [],
    regionCoordinateSpace: null,
    sourceTrace: null,
    source: "community_summary",
    retrievalStage: "full-index",
  }));
}

async function graphNeighborSearch(
  query: string,
  workspaceId: string,
  options: SearchOptions,
): Promise<SearchChunk[]> {
  const limit = options.limit ?? 20;
  const hops = Math.max(1, Math.min(options.graphHops ?? 1, 3));

  try {
    const rows = await boundedSearchQuery((client) => client<ChunkRow[]>`
      with recursive seed_nodes as (
        select node.id
        from kg_nodes node
        where node.workspace_id = ${workspaceId}
          and to_tsvector('english', node.canonical_name)
            @@ websearch_to_tsquery('english', ${query})
        order by node.mention_count desc, node.source_document_count desc
        limit 8
      ),
      walk as (
        select id as node_id, 0 as depth
        from seed_nodes
        union
        select
          case
            when edge.source_node_id = walk.node_id then edge.target_node_id
            else edge.source_node_id
          end as node_id,
          walk.depth + 1 as depth
        from walk
        join kg_edges edge
          on edge.workspace_id = ${workspaceId}
         and (edge.source_node_id = walk.node_id or edge.target_node_id = walk.node_id)
        where walk.depth < ${hops}
      ),
      related_chunks as (
        select
          entity.chunk_id,
          max(entity.mention_count)::int as weight
        from chunk_entities entity
        join walk on walk.node_id = entity.node_id
        group by entity.chunk_id
      )
      select
        chunk.id,
        chunk.document_id,
        chunk.run_id,
        chunk.chunk_index,
        chunk.text,
        chunk.heading_path,
        chunk.page_number,
        chunk.token_estimate,
        row_number() over (order by related_chunks.weight desc, chunk.chunk_index asc)::int as rank,
        document.filename,
        chunk.metadata
      from related_chunks
      join document_chunks chunk on chunk.id = related_chunks.chunk_id
      join documents document on document.id = chunk.document_id
      where document.workspace_id = ${workspaceId}
        and ${lexicalSearchableDocument("document")}
        and ${retrievalScope({ workspaceId, filters: options.filters, runId: options.runId }).graphChunk()}
      order by rank asc
      limit ${limit}
    `);
    return mapRankedChunkRows(rows);
  } catch (error) {
    if (isSearchAborted(error)) throw error;
    if (isSearchStatementTimeout(error)) countSearchEvent("graphTimeout");
    return [];
  }
}

/** NUL bytes are valid JSON and UTF-8 but rejected by Postgres text parameters. */
export function stripNulBytes(value: string): string {
  return value.replaceAll("\u0000", "");
}

/** Workspace → org, learned from completed setups, so admission can share slots fairly per org. */
const workspaceOrgs = new Map<string, string>();

function searchAdmission(options: SearchOptions): SearchAdmission {
  const workspaceId = options.filters?.workspaceId?.trim();
  return {
    tenant: workspaceId ? workspaceOrgs.get(workspaceId) ?? `workspace:${workspaceId}` : null,
    // One chat agent turn (or API batch) holds at most SEARCH_MAX_SLOTS_PER_TURN slots.
    group: currentChatSessionId() ?? currentSearchAdmissionGroup(),
  };
}

function withSearchSlotTimed<T>(signal: AbortSignal | undefined, fn: () => Promise<T>, admission: SearchAdmission): Promise<T> {
  const started = performance.now();
  return withSearchSlot(signal, () => {
    recordSearchPhase("queue", performance.now() - started);
    return fn();
  }, admission);
}

export async function hybridSearch(rawQuery: string, userId: string, options: SearchOptions = {}): Promise<SearchResponse> {
  // Postgres text cannot hold NUL, so a query carrying one failed every lexical lookup with a 500.
  const query = stripNulBytes(rawQuery);
  const activity: SearchActivity = { id: randomUUID(), groupId: options.rootSessionId ?? randomUUID(), query, status: "loading" };
  const started = Date.now();
  activity.aggregate = Boolean(options.queryDecompose || options.stepback || options.iterativeMultiHop);
  const report = options.onSearchActivity;
  report?.(activity);
  try {
    // Root searches wait for a process-wide slot (search/search-limiter.ts); the wait is timed as `queueMs`.
    // Search SQL is cancelled when the request (or chat turn) aborts (search/query-bounds.ts).
    const signal = currentSearchSignal() ?? getDeferredContext()?.signal ?? currentRequestSignal();
    const { value: result, timings } = await collectSearchTimings(() => withSearchSignal(signal, () =>
      withSearchSlotTimed(signal, () => executeHybridSearch(query, userId, { ...options, rootSessionId: activity.groupId }), searchAdmission(options))));
    result.timings = timings;
    console.info(`[search-timing] ${Object.entries(timings).map(([key, ms]) => `${key.replace(/Ms$/, "")}=${ms}`).join(" ")} results=${result.results.length}`);
    // Price card: one search per root query (sub-searches of decomposition and
    // multi-hop are part of it); LLM query strategies count as llmSearchMultiplier.
    // Searches a chat turn runs are part of the chat answer's price.
    if (!options.rootSessionId && !currentChatTurn()) await chargeSearch(result, userId, activity.id);
    report?.({ ...activity, status: "success", runtimeMs: Date.now() - started, resultCount: result.results.length,
      inputTokens: result.usageEvents?.reduce((sum, event) => sum + (event.inputTokens ?? 0), 0),
      outputTokens: result.usageEvents?.reduce((sum, event) => sum + (event.outputTokens ?? 0), 0),
    });
    return result;
  } catch (error) {
    report?.({ ...activity, status: "error", runtimeMs: Date.now() - started });
    throw error;
  }
}

/**
 * Bill one completed root search (PRICE_CARD.searchPer1k). A search that ran an
 * LLM query strategy (HyDE, rewrite, stepback, compression, self-query,
 * decomposition: any call with output tokens) counts as llmSearchMultiplier
 * searches. Query embeddings and strategy tokens are our cost, recorded
 * non-billable by the Search Session journal.
 */
async function chargeSearch(result: SearchResponse, userId: string, searchId: string): Promise<void> {
  const workspaceId = result.availability?.scope?.workspaceId;
  if (!workspaceId) return;
  const llmStrategies = (result.usageEvents ?? []).some((event) => (event.outputTokens ?? 0) > 0);
  try {
    await recordUnitCharge({
      userId,
      scope: { workspaceId, sessionId: result.sessionId },
      charge: {
        id: `search:${searchId}`,
        metric: BILLABLE_UNIT_METRICS.search,
        amount: 1,
        unit: "search",
        credits: searchCredits(1, { llmStrategies }),
        metadata: { llmStrategies, searchUnits: llmStrategies ? PRICE_CARD.llmSearchMultiplier : 1 },
      },
    });
  } catch (error) {
    // A failed charge never fails the search the user already has.
    console.error(`[search] charge failed session=${result.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function executeHybridSearch(
  query: string,
  userId: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const setup = await timePhase("setup", () => resolveSearchSetup(userId, options));
  if (workspaceOrgs.size < 50_000) workspaceOrgs.set(setup.normalizedScope.workspaceId, `org:${setup.normalizedScope.orgId}`);
  const wholeCorpusFallback = async (filters = setup.resolvedOptions.filters): Promise<SearchResult[]> => {
    const corpusCtx = await loadWorkspaceWholeCorpusContext({
      workspaceId: setup.normalizedScope.workspaceId,
      userId,
      filters,
      runId: setup.resolvedOptions.runId,
      maxDocuments: wholeCorpusContextLimits.maxDocuments,
      maxChunks: wholeCorpusContextLimits.maxChunks,
      maxTokens: wholeCorpusContextLimits.maxTokens,
      maxChars: wholeCorpusContextLimits.maxChars,
    });
    return corpusCtx.eligible ? corpusCtx.results : [];
  };

  const native: NativeSearchContext | null = setup.lanceNative
    ? { workspaceId: setup.normalizedScope.workspaceId, orgId: setup.normalizedScope.orgId, pipeline: setup.workspacePipeline,
        indexConfigs: setup.indexConfigs, privacyMode: setup.privacyMode }
    : null;
  const nativeVectorOrLegacy = (vector: number[], options: SearchOptions, serving: IndexServing | null) => native
    ? nativeVectorSearch(vector, native, options, serving).then((chunks) => chunks ?? vectorSearch(vector, userId, native.workspaceId, options, serving, setup.privacyMode))
    : vectorSearch(vector, userId, setup.normalizedScope.workspaceId, options, serving, setup.privacyMode);
  const nativeTextOrLegacy = (text: string, options: SearchOptions) => native
    ? nativeTextSearch(text, userId, native, options).then((chunks) => chunks ?? textSearch(text, userId, options))
    : textSearch(text, userId, options);
  // Native search skips page branches the cached coverage says have nothing to serve.
  const pageOnlyDocuments = setup.availabilityRow?.page_only_documents;
  const skipProgressive = Boolean(native) && pageOnlyDocuments === 0;
  const pageOnlyCompleted = async (): Promise<boolean> => {
    if (!native) return true;
    const embedding = resolveEmbeddingRoute(native.pipeline.embedding);
    const set = await loadEligibleDocuments({ workspaceId: native.workspaceId, embeddingModel: embedding.model, dimension: embedding.dimensions });
    return set.pageOnlyCompletedDocuments > 0;
  };

  return runSearchSession({
    query,
    userId,
    options: setup.resolvedOptions,
    setup,
    adapters: {
      parallelRetrieval: Boolean(native),
      warmVectorIndex: native && process.env.SEARCH_LANCE_WARM !== "0" ? () => {
        const embedding = resolveEmbeddingRoute(native.pipeline.embedding);
        void warmLanceDbSearch({ orgId: native.orgId, embeddingModel: embedding.model, dimension: embedding.dimensions, hydrate: true });
      } : undefined,
      buildAvailability: (chunks, effectiveOptions) =>
        buildSearchAvailability(
          setup.availabilityRow,
          {
            workspaceId: setup.normalizedScope.workspaceId,
            runId: effectiveOptions.runId ?? effectiveOptions.filters?.runId,
          },
          chunks,
        ),
      runSearch: hybridSearch,
      vectorSearch: ({ queryVector, userId, workspaceId, options, query }) =>
        timePhase("vector", () => servedVectorSearch({
          workspaceId,
          pipeline: setup.workspacePipeline,
          indexConfigs: setup.indexConfigs,
          queryVector,
          query,
          deps: {
            search: (vector, serving) => native && workspaceId === native.workspaceId
              ? nativeVectorOrLegacy(vector, options, serving)
              : vectorSearch(vector, userId, workspaceId, options, serving, setup.privacyMode),
            embed: (text, embedding) => embedQuery(text, embedding, setup.session, setup.privacyMode, workspaceId, setup.normalizedScope.orgId),
            diagnostic: (name, value) => setup.session.recordDiagnostic(name, value as never),
          },
        })),
      textSearch: ({ query, options }) =>
        timePhase("text", () => nativeTextOrLegacy(query, options)),
      graphNeighborSearch: ({ query, workspaceId, options }) =>
        timePhase("graph", () => graphNeighborSearch(query, workspaceId, options)),
      communitySummarySearch: ({ query, workspaceId, options }) =>
        timePhase("community", () => communitySummarySearch(query, workspaceId, options)),
      progressivePageSearch: ({ query, userId, options }) => skipProgressive
        ? Promise.resolve([])
        : timePhase("progressive", () => progressivePageSearch(query, userId, options)),
      completedPageSearch: async (args) => args.shouldSearch && await pageOnlyCompleted() ? completedPageSearch(args) : [],
      wholeCorpusFallback,
      ...(deferredProfilesEnabled()
        ? {
            deferredPageSearch: async (deferredArgs: Parameters<NonNullable<SearchSessionRunnerAdapters["deferredPageSearch"]>>[0]) => {
              const context = getDeferredContext();
              // Context-less callers (completions, compat, aggregate, automation) still
              // run under their own API key's policy; unresolvable keys fail closed.
              const policy = () => resolveSearchMaterializationPolicy({
                context,
                workspacePipeline: setup.workspacePipeline,
                workspaceId: setup.normalizedScope.workspaceId,
              });
              return timePhase("deferred", () => runDeferredPageSearch({
                ...deferredArgs,
                orgId: setup.normalizedScope.orgId,
                workspaceId: setup.normalizedScope.workspaceId,
                policy,
                privacyMode: setup.privacyMode,
                openRouterApiKey: setup.openRouterApiKey,
                journal: setup.session,
                onEvent: context?.onEvent,
                signal: context?.signal,
                search: {
                  textSearch: ({ query, userId, options }) => textSearch(query, userId, options),
                  vectorSearch: ({ queryVector, userId, workspaceId, options }) =>
                    vectorSearch(queryVector, userId, workspaceId, options, null, setup.privacyMode),
                },
              }));
            },
          }
        : {}),
    },
  });
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
}

function readNullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function readEvidenceType(value: unknown): CanonicalEvidenceType | null {
  if (
    value === "heading" ||
    value === "paragraph" ||
    value === "list" ||
    value === "table" ||
    value === "code" ||
    value === "quote" ||
    value === "raw" ||
    value === "mixed"
  ) {
    return value;
  }
  return null;
}

function readTableGranularity(value: unknown): TableChunkGranularity | null {
  if (value === "table" || value === "row" || value === "cell") {
    return value;
  }
  return null;
}

function readTableColumnTypes(value: unknown): TableCellValueType[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is TableCellValueType =>
          item === "empty" ||
          item === "string" ||
          item === "number" ||
          item === "boolean" ||
          item === "date" ||
          item === "currency" ||
          item === "percentage",
      )
    : [];
}

function readTableCells(value: unknown): TableCell[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const cell = readTableCell(item);
    return cell ? [cell] : [];
  });
}

function readRegionBoxes(value: unknown): LayoutRegion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const candidate = entry as Record<string, unknown>;
    const pageNumber = normalizePageNumber(candidate.pageNumber);
    const x = readNullableNumber(candidate.x);
    const y = readNullableNumber(candidate.y);
    const width = readNullableNumber(candidate.width);
    const height = readNullableNumber(candidate.height);

    if (
      pageNumber === null ||
      x === null ||
      y === null ||
      width === null ||
      height === null
    ) {
      return [];
    }

    const polygon = Array.isArray(candidate.polygon)
      ? candidate.polygon.flatMap((point) => {
          if (!point || typeof point !== "object") {
            return [];
          }
          const px = readNullableNumber((point as Record<string, unknown>).x);
          const py = readNullableNumber((point as Record<string, unknown>).y);
          if (px === null || py === null) {
            return [];
          }
          return [{ x: px, y: py }];
        })
      : [];

    return [{ pageNumber, x, y, width, height, polygon }];
  });
}

function readSourceTrace(
  value: unknown,
  fallbackMetadata: Record<string, unknown>,
): SourceTrace {
  const candidate =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const canonicalDocumentUri =
    typeof candidate.canonicalDocumentUri === "string"
      ? candidate.canonicalDocumentUri
      : typeof fallbackMetadata.canonicalDocumentUri === "string"
        ? fallbackMetadata.canonicalDocumentUri
        : null;

  return {
    canonicalDocumentUri,
    parserArtifactUri:
      typeof candidate.parserArtifactUri === "string"
        ? candidate.parserArtifactUri
        : null,
    sourceArtifactUri:
      typeof candidate.sourceArtifactUri === "string"
        ? candidate.sourceArtifactUri
        : null,
    blockIds: readStringArray(candidate.blockIds ?? fallbackMetadata.blockIds),
    pageNumbers: normalizePageNumbers(
      readNumberArray(candidate.pageNumbers ?? fallbackMetadata.pageNumbers),
    ),
    extractor:
      typeof candidate.extractor === "string"
        ? candidate.extractor
        : typeof fallbackMetadata.source === "string"
          ? fallbackMetadata.source
          : null,
  };
}

function readTableCell(value: unknown): TableCell | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const columnIndex =
    typeof candidate.columnIndex === "number" ? candidate.columnIndex : null;
  const columnName =
    typeof candidate.columnName === "string" ? candidate.columnName : null;
  const rawValue =
    typeof candidate.rawValue === "string" ? candidate.rawValue : null;
  const valueType = readTableColumnTypes([candidate.valueType])[0] ?? null;
  const typedValue = candidate.typedValue;

  if (
    columnIndex === null ||
    columnName === null ||
    rawValue === null ||
    valueType === null
  ) {
    return null;
  }

  if (
    typedValue !== null &&
    typeof typedValue !== "string" &&
    typeof typedValue !== "number" &&
    typeof typedValue !== "boolean" &&
    typedValue !== undefined
  ) {
    return null;
  }

  return {
    columnIndex,
    columnName,
    rawValue,
    valueType,
    typedValue: typedValue === undefined ? null : typedValue,
    pageNumber: normalizePageNumber(candidate.pageNumber),
    bbox:
      candidate.bbox && typeof candidate.bbox === "object"
        ? {
            x:
              readNullableNumber(
                (candidate.bbox as Record<string, unknown>).x,
              ) ?? 0,
            y:
              readNullableNumber(
                (candidate.bbox as Record<string, unknown>).y,
              ) ?? 0,
            width:
              readNullableNumber(
                (candidate.bbox as Record<string, unknown>).width,
              ) ?? 0,
            height:
              readNullableNumber(
                (candidate.bbox as Record<string, unknown>).height,
              ) ?? 0,
          }
        : null,
    polygon: Array.isArray(candidate.polygon)
      ? candidate.polygon.flatMap((point) => {
          if (!point || typeof point !== "object") {
            return [];
          }
          const x = readNullableNumber((point as Record<string, unknown>).x);
          const y = readNullableNumber((point as Record<string, unknown>).y);
          return x === null || y === null ? [] : [{ x, y }];
        })
      : [],
    coordinateSpace:
      typeof candidate.coordinateSpace === "string"
        ? candidate.coordinateSpace
        : null,
    geometrySource:
      candidate.geometrySource === "cell" ||
      candidate.geometrySource === "row" ||
      candidate.geometrySource === "table" ||
      candidate.geometrySource === "block-fallback"
        ? candidate.geometrySource
        : null,
  };
}

function readChunkDisplayText(
  metadata: Record<string, unknown>,
  fallbackText: string,
): string {
  return typeof metadata.rawText === "string" && metadata.rawText.trim()
    ? metadata.rawText
    : fallbackText;
}

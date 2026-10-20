import { retrievalScope } from "./retrieval-scope.js";
import { lexicalSearchableDocument } from "./eligibility.js";
import { qualifyCommunitySummary } from "./community-context.js";
import type { PrivacyMode } from "@docslurp/shared";
import type { SearchResult } from "@docslurp/shared";

import { sql } from "../db.js";
import { calibrateSearchConfidence } from "./confidence.js";
import { compressChunks } from "./contextual-compression.js";
import { mmrSelect } from "./mmr.js";
import { lostInTheMiddleReorder } from "./position-reorder.js";
import { rerankHosted } from "./hosted-rerank.js";
import { rerankBM25, type RankedChunk } from "./rerank.js";
import {
  applyRelevanceFloor,
  resolveMinScore,
  withBestRelevance,
} from "./relevance.js";
import { reciprocalRankFusion } from "./rrf.js";
import { rankingDepth, validateRetrievalControls } from "./retrieval-controls.js";
import {
  toSearchMetadataRecord,
  type SearchSessionJournal,
} from "./session.js";
import type {
  SearchAvailability,
  SearchChunk,
  SearchOptions,
  SearchResponse,
} from "../services/search.js";
import {
  applySearchControls,
  recordZeroResultDiagnostics,
} from "../services/search-controls.js";

export interface SearchSessionExecutionInput {
  query: string;
  /** Natural language after consuming explicit metadata syntax. */
  retrievalQuery?: string;
  userId: string;
  session: SearchSessionJournal;
  options: SearchOptions;
  workspaceId: string;
  availability: SearchAvailability;
  chunks: SearchChunk[];
  effectiveQuery: string;
  filters: SearchOptions["filters"];
  selfQueryReasons: string[];
  variant?: string;
  workspaceSettings?: Parameters<typeof applySearchControls>[0]["settings"];
  retrievalChain?: unknown;
  wholeCorpusFallback?: (filters?: SearchOptions["filters"]) => Promise<SearchResult[]>;
  /** Floor already applied to `chunks`; omitted: resolved from the options with nothing dropped yet. */
  relevanceFloor?: { minScore: number; dropped: number };
}

export interface SearchPostRetrievalInput {
  query: string;
  chunks: SearchChunk[];
  limit: number;
  options: Pick<
    SearchOptions,
    "useRerank" | "useMmr" | "mmrLambda" | "useContextualCompression" | "candidateDepth" | "resultOrder" | "rerankProvider" | "rerankModel"
  >;
  rerankApiKey?: string;
  rerankScope?: { orgId: string; workspaceId: string };
  openRouterApiKey?: string | null;
  privacyMode: PrivacyMode;
  session: SearchSessionJournal;
}

export interface SearchSessionRetrievalInput
  extends Omit<SearchSessionExecutionInput, "availability" | "chunks"> {
  limit: number;
  retrieveCandidateLists(): Promise<SearchChunk[][]>;
  buildAvailability(chunks: SearchChunk[]): SearchAvailability;
  rerankApiKey?: string;
  rerankScope?: { orgId: string; workspaceId: string };
  openRouterApiKey?: string | null;
  privacyMode: PrivacyMode;
}

export function searchChunkToResult(chunk: SearchChunk): SearchResult {
  return {
    text: chunk.text,
    score: chunk.score,
    ...(chunk.relevance === undefined ? {} : { relevance: chunk.relevance }),
    citation: {
      source: chunk.source,
      documentId: chunk.documentId,
      filename: chunk.filename,
      pageNumber: chunk.pageNumber,
      pageNumbers: chunk.pageNumbers,
      headingPath: chunk.headingPath,
      chunkIndex: chunk.chunkIndex,
      blockIds: chunk.blockIds,
      blockTypes: chunk.blockTypes,
      evidenceType: chunk.evidenceType,
      canonicalDocumentUri: chunk.canonicalDocumentUri,
      tableGranularity: chunk.tableGranularity,
      tableRowIndex: chunk.tableRowIndex,
      tableRowCount: chunk.tableRowCount,
      tableColumnNames: chunk.tableColumnNames,
      tableColumnTypes: chunk.tableColumnTypes,
      tableCells: chunk.tableCells,
      tableCell: chunk.tableCell,
      regionBoxes: chunk.regionBoxes,
      regions: chunk.regions,
      regionCoordinateSpace: chunk.regionCoordinateSpace,
      sourceTrace: chunk.sourceTrace ?? undefined,
      locator: chunk.locator ?? null,
    },
  };
}

export function searchResultsToChunks(results: SearchResult[]): SearchChunk[] {
  return results.map((result) => ({
    id: `${result.citation.documentId}:${result.citation.chunkIndex}`,
    documentId: result.citation.documentId,
    runId: "",
    chunkIndex: result.citation.chunkIndex,
    text: result.text,
    headingPath: result.citation.headingPath,
    pageNumber: result.citation.pageNumber ?? null,
    pageNumbers: result.citation.pageNumbers ?? [],
    tokenEstimate: 0,
    filename: result.citation.filename,
    score: result.score,
    ...(result.relevance === undefined ? {} : { relevance: result.relevance }),
    blockIds: result.citation.blockIds ?? [],
    blockTypes: result.citation.blockTypes ?? [],
    evidenceType: result.citation.evidenceType ?? null,
    canonicalDocumentUri: result.citation.canonicalDocumentUri ?? null,
    tableGranularity: result.citation.tableGranularity ?? null,
    tableRowIndex: result.citation.tableRowIndex ?? null,
    tableRowCount: result.citation.tableRowCount ?? null,
    tableColumnNames: result.citation.tableColumnNames ?? [],
    tableColumnTypes: result.citation.tableColumnTypes ?? [],
    tableCells: result.citation.tableCells ?? [],
    tableCell: result.citation.tableCell ?? null,
    regionBoxes: result.citation.regionBoxes ?? [],
    regions: result.citation.regions ?? result.citation.regionBoxes ?? [],
    regionCoordinateSpace: result.citation.regionCoordinateSpace ?? null,
    sourceTrace: result.citation.sourceTrace ?? null,
    locator: result.citation.locator ?? null,
    source: result.citation.source ?? "document",
    retrievalStage:
      result.citation.sourceTrace?.extractor === "page-index"
        ? "page-index"
        : "full-index",
  }));
}

export function fuseSearchResponses(
  responses: SearchResponse[],
  limit: number,
): SearchChunk[] {
  return fuseSearchChunkLists(
    responses.map((response) => searchResultsToChunks(response.results)),
    limit,
  );
}

export function fuseSearchChunkLists(
  chunkLists: SearchChunk[][],
  limit: number,
): SearchChunk[] {
  const fused = reciprocalRankFusion(chunkLists) ?? [];
  return fused.slice(0, limit).map((chunk, index) => ({
    ...chunk,
    score: 1 / (1 + index),
  }));
}

export async function applySearchPostRetrievalProcessing(
  input: SearchPostRetrievalInput,
): Promise<SearchChunk[]> {
  validateRetrievalControls(input.options);
  const candidates = input.chunks.slice(0, rankingDepth(input.options, input.limit));
  if (candidates.length === 0) {
    return [];
  }

  let ranked: RankedChunk[] = candidates.map((chunk) => ({
    id: chunk.id,
    text: chunk.text,
    score: chunk.score,
  }));

  if (input.options.useRerank) {
    ranked = input.options.rerankProvider === "deepinfra"
      ? await rerankHosted({ query: input.query, chunks: ranked, model: input.options.rerankModel,
          apiKey: input.rerankApiKey, scope: input.rerankScope,
          privacyMode: input.privacyMode, session: input.session })
      : rerankBM25(input.query, ranked);
  } else {
    ranked = [...ranked].sort((a, b) => b.score - a.score);
  }

  if (input.options.useContextualCompression) {
    const compressed = await compressChunks(
      input.query,
      ranked.map((chunk) => ({
        id: chunk.id,
        text: chunk.text,
        score: chunk.crossScore ?? chunk.score,
      })),
      input.openRouterApiKey ?? "",
      input.session,
      input.privacyMode,
    );

    const compressedById = new Map(
      compressed.map((chunk) => [chunk.id, chunk.text]),
    );
    ranked = ranked.map((chunk) => ({
      ...chunk,
      text: compressedById.get(chunk.id) ?? chunk.text,
    }));
  }

  const selected = input.options.useMmr
    ? mmrSelect(
        ranked.map((chunk) => ({
          id: chunk.id,
          text: chunk.text,
          score: chunk.crossScore ?? chunk.score,
        })),
        input.limit,
        input.options.mmrLambda,
      )
    : ranked.slice(0, input.limit);

  const rankById = new Map(ranked.map((chunk) => [chunk.id, chunk]));
  const selectedScores = selected.map((chunk) => ({
    id: chunk.id,
    score: rankById.get(chunk.id)?.crossScore ?? chunk.score,
  }));
  const reordered = input.options.resultOrder === "relevance"
    ? [...selectedScores].sort((a, b) => b.score - a.score)
    : lostInTheMiddleReorder(selectedScores);
  const chunkById = new Map(candidates.map((chunk) => [chunk.id, chunk]));

  return reordered
    .map((result, index) => {
      const chunk = chunkById.get(result.id);
      if (!chunk) {
        return null;
      }
      return {
        ...chunk,
        text: rankById.get(result.id)?.text ?? chunk.text,
        score: 1 / (1 + index),
      };
    })
    .filter((chunk): chunk is SearchChunk => chunk !== null);
}

export async function executeSearchSessionRetrieval(
  input: SearchSessionRetrievalInput,
): Promise<SearchResponse> {
  validateRetrievalControls(input.options);
  const candidateLists = await input.retrieveCandidateLists();
  // Fusion keeps one copy per chunk and re-scores by rank, so the raw relevance
  // measured on each branch is carried over before the floor and rerank run.
  const fusedCandidates = withBestRelevance(reciprocalRankFusion(candidateLists) ?? [], candidateLists);
  const candidateWindow = input.options.candidateDepth === undefined
    ? fusedCandidates
    : fusedCandidates.slice(0, input.options.candidateDepth);
  const floor = applyRelevanceFloor(
    candidateWindow,
    resolveMinScore(input.options.minScore),
  );
  // Explicit controls use fusion rank as the baseline score. Adapter scores are
  // from different spaces and cannot define a common relevance ordering.
  const fused = input.options.candidateDepth !== undefined || input.options.resultOrder !== undefined
    ? floor.kept.map((chunk, index) => ({ ...chunk, score: 1 / (1 + index) }))
    : floor.kept;
  input.session.recordDiagnostic("candidateSelection", {
    candidateDepth: input.options.candidateDepth ?? null,
    resultOrder: input.options.resultOrder ?? "legacy",
    adapterCounts: candidateLists.map((list) => list.length),
    fusedCount: fusedCandidates.length,
    candidateWindowCount: candidateWindow.length,
    afterFloorCount: fused.length,
    rankingDepth: rankingDepth(input.options, input.limit),
  });
  const shouldPostProcess =
    fused.length > 0 &&
    (input.options.useRerank ||
      input.options.useMmr ||
      input.options.useContextualCompression ||
      input.options.resultOrder === "prompt");
  const chunks = shouldPostProcess
    ? await applySearchPostRetrievalProcessing({
        query: input.retrievalQuery ?? input.query,
        chunks: fused,
        limit: input.limit,
        options: input.options,
        openRouterApiKey: input.openRouterApiKey,
        rerankApiKey: input.rerankApiKey,
        rerankScope: input.rerankScope,
        privacyMode: input.privacyMode,
        session: input.session,
      })
    : fused
        .slice(0, input.limit)
        .map((chunk, index) => ({ ...chunk, score: 1 / (1 + index) }));

  return finalizeSearchSessionExecution({
    query: input.query,
    retrievalQuery: input.retrievalQuery,
    userId: input.userId,
    session: input.session,
    options: input.options,
    workspaceId: input.workspaceId,
    availability: input.buildAvailability(chunks),
    chunks,
    effectiveQuery: input.effectiveQuery,
    filters: input.filters,
    selfQueryReasons: input.selfQueryReasons,
    variant: input.variant,
    workspaceSettings: input.workspaceSettings,
    retrievalChain: input.retrievalChain,
    wholeCorpusFallback: input.wholeCorpusFallback,
    relevanceFloor: { minScore: floor.minScore, dropped: floor.dropped },
  });
}

export async function finalizeSearchSessionExecution(
  input: SearchSessionExecutionInput,
): Promise<SearchResponse> {
  let results = input.chunks.map((chunk) => searchChunkToResult(chunk));
  if (input.workspaceSettings) {
    results = applySearchControls({
      query: input.retrievalQuery ?? input.query,
      results,
      settings: input.workspaceSettings,
    });
  }

  // Compression may rewrite the text; restore the scope qualification afterward.
  results = results.map((result) => result.citation.source === "community_summary"
    ? { ...result, text: qualifyCommunitySummary(result.text, { ...input.filters, ...(input.options.runId ? { runId: input.options.runId } : {}) }) }
    : result);

  if (input.options.parentRetrieval) {
    await attachParentText(results, input);
  }

  let calibratedResults = calibrateSearchConfidence(results);
  let finalResultSource: "retrieval" | "whole-corpus" | "none" =
    calibratedResults.length > 0 ? "retrieval" : "none";
  let usedWholeCorpusFallback = false;

  const relevanceFloor = input.relevanceFloor ?? {
    minScore: resolveMinScore(input.options.minScore),
    dropped: 0,
  };
  // Candidates that the floor rejected mean "nothing relevant", not "nothing
  // retrieved": handing back the whole corpus would undo the floor.
  if (
    calibratedResults.length === 0 &&
    relevanceFloor.dropped === 0 &&
    !input.options.suppressSessionLog &&
    input.wholeCorpusFallback
  ) {
    try {
      const fallbackResults = await input.wholeCorpusFallback(input.filters);
      if (fallbackResults.length > 0) {
        calibratedResults = calibrateSearchConfidence(fallbackResults);
        usedWholeCorpusFallback = calibratedResults.length > 0;
        finalResultSource = usedWholeCorpusFallback ? "whole-corpus" : "none";
      }
    } catch {
      // Search should still return zero-result diagnostics if fallback fails.
    }
  }

  const recordedZeroResultDiagnostics = calibratedResults.length === 0;
  if (recordedZeroResultDiagnostics) {
    await recordZeroResultDiagnostics({
      sessionId: input.session.sessionId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      query: input.query,
      filtersJson: toSearchMetadataRecord(input.filters),
    }).catch(() => undefined);
  }

  if (!input.options.suppressSessionLog) {
    await input.session.persist({
      userId: input.userId,
      query: input.query,
      variant: input.variant,
      results: calibratedResults,
      chunks: input.chunks,
      metadata: {
        originalQuery: input.query,
        effectiveQuery: input.effectiveQuery,
        filters: input.filters,
        options: input.options,
        workspaceId: input.workspaceId,
        selfQueryReasons: input.selfQueryReasons,
        availability: input.availability,
        retrievalChain: input.retrievalChain,
        finalization: {
          resultSource: finalResultSource,
          usedWholeCorpusFallback,
          recordedZeroResultDiagnostics,
          relevanceFloor,
          parentRetrieval: input.options.parentRetrieval ?? false,
          persistedUsageEventCount: input.session.usageEvents().length,
        },
        diagnostics: input.session.diagnostics(),
      },
    });
  }

  return {
    results: calibratedResults,
    sessionId: input.session.sessionId,
    availability: input.availability,
    relevanceFloor: {
      ...relevanceFloor,
      // Nothing to match against yet (empty or still indexing) is availability's story.
      noMatch:
        calibratedResults.length === 0 &&
        input.availability.status !== "pending" &&
        input.availability.status !== "empty",
    },
    usageEvents: input.session.usageEvents(),
  };
}

async function attachParentText(results: SearchResult[], input: SearchSessionExecutionInput): Promise<void> {
  const scope = retrievalScope({ workspaceId: input.workspaceId, filters: input.filters, runId: input.options.runId });
  results = results.filter(result => result.citation.source === "document");
  const keyMap = new Map<string, { documentId: string; pageNumber: number }>();
  for (const result of results) {
    const documentId = result.citation.documentId;
    const pageNumber = result.citation.pageNumber;
    if (!documentId || pageNumber == null) continue;
    keyMap.set(`${documentId}:${pageNumber}`, { documentId, pageNumber });
  }

  if (results.length === 0) return;

  const documentIds: string[] = [];
  const pageNumbers: number[] = [];
  for (const key of keyMap.values()) {
    documentIds.push(key.documentId);
    pageNumbers.push(key.pageNumber);
  }

  const rows = await sql<
    { document_id: string; page_number: number; text: string }[]
  >`
    select p.document_id, p.page_number, p.text
    from document_pages p
    join documents d on d.id = p.document_id
    where p.document_id = any(${sql.array(documentIds, 25)})
      and p.page_number = any(${sql.array(pageNumbers, 23)})
      and ${scope.page()}
      and ${lexicalSearchableDocument("d")}
  `;

  const lookup = new Map(
    rows.map((row) => [`${row.document_id}:${row.page_number}`, row.text]),
  );
  const missing = results.filter(result => !lookup.has(`${result.citation.documentId}:${result.citation.pageNumber}`));
  const neighborRows = missing.length ? await sql<{ document_id: string; chunk_index: number; text: string; page_numbers: number[] }[]>`
    select hit.document_id, hit.chunk_index, left(string_agg(neighbor.text, E'\n\n' order by neighbor.chunk_index), 30000) as text, array_agg(distinct neighbor.page_number) filter (where neighbor.page_number is not null) as page_numbers
    from jsonb_to_recordset(${sql.json(missing.map(result => ({ document_id: result.citation.documentId, chunk_index: result.citation.chunkIndex, page_number: result.citation.pageNumber })))}::jsonb)
      as hit(document_id text, chunk_index int, page_number int)
    join lateral (
      select c.text, c.chunk_index, c.page_number from document_chunks c
      join documents d on d.id = c.document_id
      where c.document_id = hit.document_id
        and ${scope.chunk()}
        and ${lexicalSearchableDocument("d")}
        and (case when hit.page_number is not null then c.chunk_index between
        (select min(bound.chunk_index) from document_chunks bound where bound.document_id = hit.document_id and bound.page_number between hit.page_number and hit.page_number + 1)
        and (select max(bound.chunk_index) from document_chunks bound where bound.document_id = hit.document_id and bound.page_number between hit.page_number and hit.page_number + 1)
        else c.chunk_index between hit.chunk_index - 1 and hit.chunk_index + 1 end)
      order by c.chunk_index limit 24
    ) neighbor on true
    group by hit.document_id, hit.chunk_index
  ` : [];
  const neighbors = new Map(neighborRows.map(row => [`${row.document_id}:${row.chunk_index}`, row]));
  for (const result of missing) {
    const parent = neighbors.get(`${result.citation.documentId}:${result.citation.chunkIndex}`);
    if (!parent) continue;
    result.parentText = parent.text;
    result.citation.pageNumbers = [...new Set([...(result.citation.pageNumbers ?? []), ...(parent.page_numbers ?? [])])].sort((a, b) => a - b);
  }

  for (const result of results) {
    if (result.citation.pageNumber != null) {
      const key = `${result.citation.documentId}:${result.citation.pageNumber}`;
      const parentText = lookup.get(key);
      if (parentText) {
        result.parentText = parentText;
      }
    }
  }
}

import type { SearchResult } from "@docslurp/shared";

import type { SearchChunk } from "../services/search.js";
import { qualifyCommunitySummary } from "./community-context.js";
import type { SearchFilters } from "./filters.js";

export function searchChunkToResult(chunk: SearchChunk): SearchResult {
  const stage = chunk.deferredLocator ?? (chunk.retrievalStage === "page-index" ? "page-text" : "chunk");
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
    ...(stage === "chunk" ? {} : { retrieval: { stage } }),
  };
}

/**
 * Community summaries are broader than the selected scope, so their text is
 * qualified before it leaves the server. The final response and provisional
 * stream hits both go through here.
 */
export function qualifyCommunityResults(
  results: SearchResult[],
  filters: SearchFilters | undefined,
  runId?: string,
): SearchResult[] {
  return results.map((result) => result.citation.source === "community_summary"
    ? { ...result, text: qualifyCommunitySummary(result.text, { ...filters, ...(runId ? { runId } : {}) }) }
    : result);
}

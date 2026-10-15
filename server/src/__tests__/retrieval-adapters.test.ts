import { describe, expect, it, vi } from "vitest";

import {
  createEvidenceRetrievalAdapters,
  flattenEvidenceResults,
  retrieveEvidence,
} from "../search/retrieval-adapters.js";
import type { SearchChunk } from "../services/search.js";

function chunk(id: string): SearchChunk {
  return {
    id,
    documentId: `doc-${id}`,
    runId: `run-${id}`,
    chunkIndex: 0,
    text: id,
    headingPath: [],
    pageNumber: null,
    tokenEstimate: 1,
    score: 1,
    filename: `${id}.txt`,
    pageNumbers: [],
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
    sourceTrace: null,
    source: "document",
    retrievalStage: "full-index",
  };
}

describe("retrieval adapters", () => {
  it("runs concrete evidence adapters and preserves fusion order", async () => {
    const adapters = createEvidenceRetrievalAdapters({
      vectorSearch: vi.fn(async () => [chunk("vector")]),
      textSearch: vi.fn(async () => [chunk("lexical")]),
      graphNeighborSearch: vi.fn(async () => [chunk("graph")]),
      communitySummarySearch: vi.fn(async () => [chunk("community")]),
      progressivePageSearch: vi.fn(async () => [chunk("page")]),
      completedPageSearch: vi.fn(async () => [chunk("completed-page")]),
    });

    const results = await retrieveEvidence(adapters, {
      query: "contract",
      textQuery: "contract agreement",
      queryVector: [1, 2, 3],
      userId: "user-1",
      workspaceId: "ws-1",
      options: {
        enableGraphExpansion: true,
        enableCommunityExpansion: true,
      },
    });

    expect(results.map((result) => result.adapter)).toEqual([
      "lexical",
      "graph",
      "community",
      "progressive-page",
      "completed-page",
      "vector",
    ]);
    expect(flattenEvidenceResults(results).map((list) => list[0]?.id)).toEqual([
      "vector",
      "lexical",
      "graph",
      "community",
      "page",
      "completed-page",
    ]);
  });

  it("only searches completed pages when lexical retrieval is empty", async () => {
    const completedPageSearch = vi.fn(async () => []);
    const adapters = createEvidenceRetrievalAdapters({
      vectorSearch: vi.fn(async () => []),
      textSearch: vi.fn(async () => [chunk("lexical")]),
      graphNeighborSearch: vi.fn(async () => []),
      communitySummarySearch: vi.fn(async () => []),
      progressivePageSearch: vi.fn(async () => []),
      completedPageSearch,
    });

    await retrieveEvidence(adapters, {
      query: "contract",
      textQuery: "contract",
      queryVector: null,
      userId: "user-1",
      workspaceId: "ws-1",
      options: {},
    });

    expect(completedPageSearch).toHaveBeenCalledWith(
      expect.objectContaining({ shouldSearch: false }),
    );
  });
});

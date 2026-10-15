import { describe, expect, it } from "vitest";

import { applySearchControls } from "../services/search-controls.js";

describe("applySearchControls", () => {
  const results = [
    { text: "a", score: 1, citation: { documentId: "d1", filename: "a.pdf", pageNumber: 1, pageNumbers: [], headingPath: [], chunkIndex: 0, blockIds: [], blockTypes: [], regionBoxes: [], regionCoordinateSpace: null } },
    { text: "b", score: 1, citation: { documentId: "d1", filename: "a.pdf", pageNumber: 2, pageNumbers: [], headingPath: [], chunkIndex: 1, blockIds: [], blockTypes: [], regionBoxes: [], regionCoordinateSpace: null } },
    { text: "c", score: 1, citation: { documentId: "d2", filename: "b.pdf", pageNumber: 1, pageNumbers: [], headingPath: [], chunkIndex: 0, blockIds: [], blockTypes: [], regionBoxes: [], regionCoordinateSpace: null } }
  ] as any;

  it("dedupes by filename when enabled", () => {
    const out = applySearchControls({
      query: "",
      results,
      settings: {
        workspaceId: "ws-1",
        userId: "u1",
        typoTolerance: true,
        dedupeByFilename: true,
        rankingRules: {},
        boosts: { byMime: {} },
        pinnedResults: [],
        synonyms: {},
        retrievalDefaults: {
          resultCount: 8,
          useHyDE: false,
          useRerank: true,
          useContextualCompression: false,
          useMmr: false,
          mmrLambda: 0.4,
          queryRewrite: false,
          queryDecompose: false,
          stepback: false,
          parentRetrieval: true,
          summarySeed: false,
          selfQuery: false,
          iterativeMultiHop: false,
          enableGraphExpansion: false,
          enableCommunityExpansion: false,
          graphHops: 1
        },
        chat: {
          enabled: true,
          mode: "retrieval",
          answerStyle: "balanced",
          citations: true,
          searchInstructions: null
        },
        compatSettings: {},
        rules: [],
        compatMetadata: {}
      }
    });
    expect(out.length).toBe(2);
    expect(out[0]?.citation.documentId).toBe("d1");
    expect(out[1]?.citation.documentId).toBe("d2");
  });

  it("keeps multiple chunks when every result comes from the same document", () => {
    const out = applySearchControls({
      query: "",
      results: results.slice(0, 2),
      settings: {
        workspaceId: "ws-1",
        userId: "u1",
        typoTolerance: true,
        dedupeByFilename: true,
        rankingRules: {},
        boosts: { byMime: {} },
        pinnedResults: [],
        synonyms: {},
        retrievalDefaults: {
          resultCount: 8,
          useHyDE: false,
          useRerank: true,
          useContextualCompression: false,
          useMmr: false,
          mmrLambda: 0.4,
          queryRewrite: false,
          queryDecompose: false,
          stepback: false,
          parentRetrieval: true,
          summarySeed: false,
          selfQuery: false,
          iterativeMultiHop: false,
          enableGraphExpansion: false,
          enableCommunityExpansion: false,
          graphHops: 1
        },
        chat: {
          enabled: true,
          mode: "retrieval",
          answerStyle: "balanced",
          citations: true,
          searchInstructions: null
        },
        compatSettings: {},
        rules: [],
        compatMetadata: {}
      }
    });
    expect(out.length).toBe(2);
    expect(out[0]?.citation.documentId).toBe("d1");
    expect(out[1]?.citation.documentId).toBe("d1");
  });

  it("pins results to the top when pattern matches", () => {
    const out = applySearchControls({
      query: "invoice",
      results,
      settings: {
        workspaceId: "ws-1",
        userId: "u1",
        typoTolerance: true,
        dedupeByFilename: false,
        rankingRules: {},
        boosts: { byMime: {} },
        pinnedResults: [{ queryPattern: "invoice", documentId: "d2", rank: 1 }],
        synonyms: {},
        retrievalDefaults: {
          resultCount: 8,
          useHyDE: false,
          useRerank: true,
          useContextualCompression: false,
          useMmr: false,
          mmrLambda: 0.4,
          queryRewrite: false,
          queryDecompose: false,
          stepback: false,
          parentRetrieval: true,
          summarySeed: false,
          selfQuery: false,
          iterativeMultiHop: false,
          enableGraphExpansion: false,
          enableCommunityExpansion: false,
          graphHops: 1
        },
        chat: {
          enabled: true,
          mode: "retrieval",
          answerStyle: "balanced",
          citations: true,
          searchInstructions: null
        },
        compatSettings: {},
        rules: [],
        compatMetadata: {}
      }
    });
    expect(out[0]?.citation.documentId).toBe("d2");
  });
});

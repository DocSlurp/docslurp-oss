import { defaultProjectSearchSettings } from "@docslurp/shared";
import { describe, expect, it, vi } from "vitest";

import { applySearchControls, readProjectUiSettings } from "../services/search-controls.js";

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
        projectId: "ws-1",
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
          useMmr: false,
          mmrLambda: 0.4,
          queryRewrite: false,
          queryDecompose: false,
          stepback: false,
          parentRetrieval: true,
          summarySeed: false,
          summaryTree: "off",
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
          searchInstructions: null,
          scopeDeclineThreshold: null
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
        projectId: "ws-1",
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
          useMmr: false,
          mmrLambda: 0.4,
          queryRewrite: false,
          queryDecompose: false,
          stepback: false,
          parentRetrieval: true,
          summarySeed: false,
          summaryTree: "off",
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
          searchInstructions: null,
          scopeDeclineThreshold: null
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
        projectId: "ws-1",
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
          useMmr: false,
          mmrLambda: 0.4,
          queryRewrite: false,
          queryDecompose: false,
          stepback: false,
          parentRetrieval: true,
          summarySeed: false,
          summaryTree: "off",
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
          searchInstructions: null,
          scopeDeclineThreshold: null
        },
        compatSettings: {},
        rules: [],
        compatMetadata: {}
      }
    });
    expect(out[0]?.citation.documentId).toBe("d2");
  });
});


it("does not fabricate pinned documents outside filtered candidates", () => {
  const results = applySearchControls({ query: "budget", results: [],
    settings: { ...defaultProjectSearchSettings, projectId: "w", userId: "u", pinnedResults: [{ queryPattern: "budget", documentId: "outside" }] },
  });
  expect(results).toEqual([]);
});

describe("stored project search settings", () => {
  it("fall back per field when a stored value no longer validates, keeping the rest", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const read = readProjectUiSettings({ projectUi: {
      retrievalDefaults: { resultCount: 5, rerankProvider: "a-retired-provider", rerankModel: "a/renamed-model", summaryTree: "no-such-mode" },
      chat: { mode: "no-such-mode" },
    } }, "project per-field");
    expect(read.retrievalDefaults.resultCount).toBe(5);
    expect(read.retrievalDefaults.rerankProvider).toBe(defaultProjectSearchSettings.retrievalDefaults.rerankProvider);
    expect(read.retrievalDefaults.rerankModel).toBe(defaultProjectSearchSettings.retrievalDefaults.rerankModel);
    expect(read.retrievalDefaults.summaryTree).toBe(defaultProjectSearchSettings.retrievalDefaults.summaryTree);
    expect(read.chat).toEqual(defaultProjectSearchSettings.chat);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("stored retrievalDefaults of project per-field has fields that no longer validate"));
    error.mockRestore();
  });

  it("never turn chat on from an unreadable off switch", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const enabled of ["false", 0, null, "off"]) {
      expect(readProjectUiSettings({ projectUi: { chat: { enabled } } }, `project chat-${String(enabled)}`).chat.enabled, String(enabled)).toBe(false);
    }
    expect(readProjectUiSettings({ projectUi: { chat: "garbage" } }, "project chat-garbage").chat.enabled).toBe(false);
    expect(readProjectUiSettings({ projectUi: { chat: { enabled: false } } }).chat.enabled).toBe(false);
    expect(readProjectUiSettings({ projectUi: { chat: { enabled: true } } }).chat.enabled).toBe(true);
    // The owner's scope instructions that can no longer be read: chat is off, not answering without them.
    expect(readProjectUiSettings({ projectUi: { chat: { enabled: true, searchInstructions: 42 } } }, "project chat-scope").chat.enabled).toBe(false);
    expect(readProjectUiSettings({ projectUi: { chat: { enabled: true, searchInstructions: "Only answer about contracts." } } }).chat).toMatchObject({ enabled: true, searchInstructions: "Only answer about contracts." });
    // An unreadable rerank switch stays off; a valid one is kept.
    expect(readProjectUiSettings({ projectUi: { retrievalDefaults: { useRerank: "false" } } }, "project rerank").retrievalDefaults.useRerank).toBe(false);
    expect(readProjectUiSettings({ projectUi: { retrievalDefaults: { useRerank: true, summaryTree: "no-such-mode" } } }, "project rerank-2").retrievalDefaults.useRerank).toBe(true);
    // The log names the project, once.
    expect(error).toHaveBeenCalledWith(expect.stringContaining("stored chat of project chat-false"));
    error.mockRestore();
  });

  it("read valid stored settings unchanged, and defaults when nothing is stored", () => {
    expect(readProjectUiSettings({})).toEqual({ retrievalDefaults: defaultProjectSearchSettings.retrievalDefaults, chat: defaultProjectSearchSettings.chat });
    expect(readProjectUiSettings({ projectUi: { retrievalDefaults: { resultCount: 3 } } }).retrievalDefaults.resultCount).toBe(3);
  });
});

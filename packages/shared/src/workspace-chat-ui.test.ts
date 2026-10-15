import { describe, expect, it } from "vitest";

import { partialCoverageNote, workspaceChatAvailabilitySchema } from "./workspace-chat-ui.js";

const availability = (coverage: Partial<Record<string, number>>) => workspaceChatAvailabilitySchema.parse({
  status: "partial",
  isPartial: true,
  scope: { workspaceId: "w", runId: null },
  coverage: {
    totalDocuments: 5, indexedDocuments: 2, pageIndexedDocuments: 0, searchableDocuments: 3, pageOnlyDocuments: 0,
    inProgressDocuments: 2, totalPages: 48, searchablePages: 31, indexedChunkCount: 90, queuedRuns: 0, processingRuns: 1,
    ...coverage,
  },
  resultBreakdown: { indexedResultCount: 4, pageResultCount: 0 },
  message: null,
});

describe("partialCoverageNote", () => {
  it("states searched pages, files still processing and keyword-only documents", () => {
    expect(partialCoverageNote(availability({ keywordOnlyDocuments: 1 }))).toBe(
      "Searched 31 of 48 pages · 2 files still processing · 1 keyword-only so far. Ask again once they finish for a complete answer.",
    );
  });

  it("falls back to files when page counts are unknown and accepts responses without keyword fields", () => {
    const parsed = availability({ totalPages: 0, searchablePages: 0, inProgressDocuments: 1 });
    expect(parsed.keywordOnly).toBe(false);
    expect(partialCoverageNote(parsed)).toBe(
      "Searched 3 of 5 files · 1 file still processing. Ask again once they finish for a complete answer.",
    );
  });
});

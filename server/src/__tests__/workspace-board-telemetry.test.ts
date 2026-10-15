import { describe, expect, it, vi } from "vitest";

const sqlMock = vi.fn();

vi.mock("../db.js", () => ({
  sql: Object.assign(sqlMock, {
    array: (value: unknown) => value,
    json: (value: unknown) => value,
  }),
}));

const {
  emptyWorkspaceBoardSummary,
  listWorkspaceBoardSummaries,
  mapWorkspaceBoardSummary,
  parseTelemetryAggregateInt,
} = await import("../services/workspace-board-telemetry.js");

describe("workspace board telemetry", () => {
  it("maps database aggregate rows into board summary fields", () => {
    expect(
      mapWorkspaceBoardSummary({
        workspace_id: "ws-1",
        compute_cost_cents: "1.5",
        base_fee_cost_cents: "0.5",
        total_documents: 4,
        total_pages: 240,
        source_bytes: "5000000",
        processed_pages: 180,
        completed_runs: 3,
        indexed_bytes: "16384",
        avg_completed_run_ms: 12500,
        completed_run_pages: 150,
        completed_run_ms: "600000",
        search_sessions: 7,
        total_input_tokens: "2200",
        total_output_tokens: "880",
        total_embedding_tokens: "9910",
        total_llm_cost_cents: "14",
        ingest_input_tokens: "1200",
        ingest_output_tokens: "300",
        ingest_embedding_tokens: "6400",
        ingest_cost_cents: "12",
        search_input_tokens: "1000",
        search_output_tokens: "580",
        search_embedding_tokens: "3510",
        search_cost_cents: "2",
      }),
    ).toEqual({
      searchResultCount: 0,
      zeroResultSearches: 0,
      averageSearchMs: null,
      totalCostCents: 15.5,
      recordedCostCents: 14,
      computeCostCents: 1.5,
      baseFeeCostCents: 0.5,
      totalDocuments: 4,
      totalPages: 240,
      sourceBytes: 5000000,
      processedPages: 180,
      completedRuns: 3,
      indexedBytes: 16384,
      avgCompletedRunMs: 12500,
      completedRunPages: 150,
      completedRunMs: 600000,
      // Ingest spend = recorded ingest charges + unbilled compute estimate.
      ingestTotalCostCents: 13.5,
      pagesPerMinute: 15,
      pagesPerDollar: (180 * 100) / 13.5,
      computeEstimated: true,
      searchSessions: 7,
      totalInputTokens: 2200,
      totalOutputTokens: 880,
      totalEmbeddingTokens: 9910,
      totalLlmCostCents: 14,
      ingestInputTokens: 1200,
      ingestOutputTokens: 300,
      ingestEmbeddingTokens: 6400,
      ingestCostCents: 12,
      searchInputTokens: 1000,
      searchOutputTokens: 580,
      searchEmbeddingTokens: 3510,
      searchCostCents: 2,
    });
  });

  it("keeps a parsed zero default for empty workspaces", () => {
    expect(emptyWorkspaceBoardSummary).toEqual({
      searchResultCount: 0,
      zeroResultSearches: 0,
      averageSearchMs: null,
      totalCostCents: 0,
      recordedCostCents: 0,
      computeCostCents: 0,
      baseFeeCostCents: 0,
      totalDocuments: 0,
      totalPages: 0,
      sourceBytes: 0,
      processedPages: 0,
      completedRuns: 0,
      indexedBytes: 0,
      avgCompletedRunMs: 0,
      completedRunPages: 0,
      completedRunMs: 0,
      ingestTotalCostCents: 0,
      pagesPerMinute: null,
      pagesPerDollar: null,
      computeEstimated: false,
      searchSessions: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEmbeddingTokens: 0,
      totalLlmCostCents: 0,
      ingestInputTokens: 0,
      ingestOutputTokens: 0,
      ingestEmbeddingTokens: 0,
      ingestCostCents: 0,
      searchInputTokens: 0,
      searchOutputTokens: 0,
      searchEmbeddingTokens: 0,
      searchCostCents: 0,
    });
  });

  it("rejects non-numeric aggregate values before schema parsing", () => {
    expect(() => parseTelemetryAggregateInt("not-a-number")).toThrow(
      'Expected numeric aggregate, received "not-a-number"',
    );
  });

  it("does not query when no workspace ids are requested", async () => {
    sqlMock.mockClear();

    await expect(listWorkspaceBoardSummaries([])).resolves.toEqual(new Map());
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

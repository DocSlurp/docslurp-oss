import { defaultWorkspaceSearchSettings, normalizePipelineFeatures } from "@docslurp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  embedConfiguredTexts: vi.fn(),
  recordUsageEvent: vi.fn(),
  context: vi.fn(),
}));
vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("../lib/ai.js", async (original) => ({ ...await original<typeof import("../lib/ai.js")>(), embedConfiguredTexts: mocks.embedConfiguredTexts }));
vi.mock("../lib/ai-usage.js", async (original) => ({ ...await original<typeof import("../lib/ai-usage.js")>(), recordUsageEvent: mocks.recordUsageEvent }));
vi.mock("../search/session-setup.js", async (original) => ({ ...await original<typeof import("../search/session-setup.js")>(), loadSearchWorkspaceContext: mocks.context }));

const { prefetchBatchQueryEmbeddings } = await import("../search/batch-embeddings.js");
const { embeddingCache, resetEmbeddingCacheForTests } = await import("../search/embedding-cache.js");
const { queryEmbeddingCacheKey } = await import("../search/session-planner.js");

function context(privacyMode: "standard" | "strict-privacy" = "standard") {
  const pipeline = { ...normalizePipelineFeatures(null), privacyMode };
  return { scope: { workspaceId: "w", orgId: "o" }, settings: { ...defaultWorkspaceSearchSettings, workspaceId: "w", userId: "u" }, indexing: { pipeline, indexConfigs: {} } };
}

beforeEach(() => {
  vi.resetAllMocks();
  resetEmbeddingCacheForTests();
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("SEARCH_LANCEDB_NATIVE", "");
  vi.stubEnv("SEARCH_LANCEDB_NATIVE_WORKSPACES", "w");
  mocks.recordUsageEvent.mockResolvedValue(null);
  mocks.embedConfiguredTexts.mockImplementation(async ({ values }: { values: string[] }) => ({
    embeddings: values.map((_, index) => [index, 1]), usage: { inputTokens: 5 * values.length },
  }));
});

describe("batch query embeddings", () => {
  it("embeds a batch's distinct query texts in one call, seeds the cache and records usage once", async () => {
    mocks.context.mockResolvedValue(context());
    const items = ["pump seals", "valve torque", "pump seals", "bearing wear"].map((query) => ({ query, workspaceId: "w", options: {} }));
    expect(await prefetchBatchQueryEmbeddings(items, "u")).toEqual({ prefetched: 3, calls: 1 });
    expect(mocks.embedConfiguredTexts).toHaveBeenCalledTimes(1);
    expect(mocks.embedConfiguredTexts.mock.calls[0]![0].values).toEqual(["pump seals", "valve torque", "bearing wear"]);
    expect(mocks.recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(mocks.recordUsageEvent.mock.calls[0]![0]).toMatchObject({ userId: "u", scope: { orgId: "o", workspaceId: "w" },
      usage: { metric: "embed-query", inputTokens: 15, metadata: { batch: true, batchSize: 3 } } });
    const pipeline = context().indexing.pipeline;
    expect(embeddingCache().get(queryEmbeddingCacheKey("valve torque", pipeline.embedding, "standard", "o")!)).toEqual([1, 1]);
  });

  it("skips queries that would not embed their own text, and strict-privacy workspaces", async () => {
    mocks.context.mockResolvedValue(context());
    await prefetchBatchQueryEmbeddings([
      { query: "a", workspaceId: "w", options: { useHyDE: true } },
      { query: "b", workspaceId: "w", options: { queryRewrite: true } },
      { query: "c", workspaceId: "w", options: {} },
    ], "u");
    expect(mocks.embedConfiguredTexts).not.toHaveBeenCalled();
    mocks.context.mockResolvedValue(context("strict-privacy"));
    await prefetchBatchQueryEmbeddings([{ query: "a", workspaceId: "w", options: {} }, { query: "b", workspaceId: "w", options: {} }], "u");
    expect(mocks.embedConfiguredTexts).not.toHaveBeenCalled();
    expect(mocks.recordUsageEvent).not.toHaveBeenCalled();
  });

  it("does nothing for workspaces off native search (flag off keeps per-query embeddings)", async () => {
    vi.stubEnv("SEARCH_LANCEDB_NATIVE_WORKSPACES", "other");
    mocks.context.mockResolvedValue(context());
    expect(await prefetchBatchQueryEmbeddings([{ query: "a", workspaceId: "w", options: {} }, { query: "b", workspaceId: "w", options: {} }], "u"))
      .toEqual({ prefetched: 0, calls: 0 });
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.embedConfiguredTexts).not.toHaveBeenCalled();
  });

  it("leaves the searches to embed one by one when the workspace is not readable", async () => {
    mocks.context.mockRejectedValue(new Error("Workspace not found"));
    expect(await prefetchBatchQueryEmbeddings([{ query: "a", workspaceId: "w", options: {} }, { query: "b", workspaceId: "w", options: {} }], "u"))
      .toEqual({ prefetched: 0, calls: 0 });
    expect(mocks.embedConfiguredTexts).not.toHaveBeenCalled();
  });
});

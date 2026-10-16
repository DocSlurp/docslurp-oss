import { beforeEach, describe, expect, it, vi } from "vitest";

const hybridSearch = vi.hoisted(() => vi.fn());

vi.mock("../services/search.js", () => ({ hybridSearch }));
vi.mock("../db.js", () => ({ sql: Object.assign(() => Promise.resolve([]), { begin: async () => [] }) }));
vi.mock("../services/workspaces.js", () => ({ getWorkspace: vi.fn(async () => null) }));
vi.mock("../lib/privacy.js", () => ({
  hostedApiKeyForWorkspace: vi.fn(async () => undefined),
  loadWorkspacePrivacyMode: vi.fn(async () => "standard"),
  openRouterCall: vi.fn(),
  privacyModeOf: vi.fn(() => "standard"),
}));
vi.mock("../lib/ai-usage.js", () => ({ recordUsageEvent: vi.fn() }));

const { generateGroundedSummary } = await import("../services/grounded-summaries.js");

describe("internal retrievals are not subject to the relevance floor", () => {
  beforeEach(() => {
    hybridSearch.mockReset();
    hybridSearch.mockResolvedValue({ results: [] });
  });

  it("grounded summaries retrieve with minScore 0, because their prompt is an instruction rather than a search query", async () => {
    // Persistence is not under test; only the retrieval options matter.
    await generateGroundedSummary({ userId: "user-1", workspaceId: "ws-1", query: "Summarize the key terms", documentId: "doc-1" }).catch(() => undefined);

    expect(hybridSearch).toHaveBeenCalledTimes(1);
    expect(hybridSearch.mock.calls[0]![2]).toMatchObject({ minScore: 0, filters: { workspaceId: "ws-1", documentId: "doc-1" } });
  });
});

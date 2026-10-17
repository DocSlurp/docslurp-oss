import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEmbeddingConfig } from "@docslurp/shared";
import type { SearchOptions } from "../services/search.js";
import type { SearchSessionJournal } from "../search/session.js";

const embedConfiguredText = vi.fn();
const rewriteQuery = vi.fn();
vi.mock("../lib/ai.js", () => ({
  embedConfiguredText,
  generateOpenRouterText: vi.fn(),
  SEARCH_OPENROUTER_MODEL: "test",
}));
vi.mock("../search/lancedb.js", () => ({ lanceDbVectorSearch: vi.fn() }));
vi.mock("../services/organizations.js", () => ({ getWorkspaceAccess: vi.fn() }));
vi.mock("../search/session-execution.js", () => ({}));
vi.mock("../search/query-rewrite.js", () => ({ rewriteQuery }));
vi.mock("../search/self-query.js", () => ({ deriveSelfQueryFilters: vi.fn() }));
const { prepareSearchSessionRetrievalPlan } = await import("../search/session-planner.js");

function journal(): SearchSessionJournal {
  return {
    sessionId: "test-session",
    record: vi.fn(),
    adoptUsage: vi.fn(),
    usageEvents: () => [],
    recordDiagnostic: vi.fn(),
    diagnostics: () => ({}),
    persist: async () => {},
  };
}
function prepare(query: string, options: SearchOptions = {}, synonyms: Record<string, string[]> = { ML: ["machine learning"] }) {
  const session = journal();
  return {
    session,
    promise: prepareSearchSessionRetrievalPlan({
      query, options, effectiveOptions: options, userId: "user", workspaceId: "workspace",
      workspaceSettings: { synonyms }, embedding: defaultEmbeddingConfig,
      privacyMode: "standard", session, openRouterApiKey: "test-key",
    }),
  };
}

describe("planner alias expansion at the embedding boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embedConfiguredText.mockResolvedValue({ embedding: [0.2, 0.8], usage: { inputTokens: 17 } });
  });

  it("sends aliases to embedding and lexical retrieval while recording actual token usage", async () => {
    const { session, promise } = prepare("ML requirements");
    const plan = await promise;
    expect(embedConfiguredText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      value: "ML requirements\nAliases: ML = machine learning",
      auditScope: { workspaceId: "workspace" },
    }));
    expect(plan.queryVector).toEqual([0.2, 0.8]);
    expect(plan.textQuery).toBe('"ML" "requirements" OR "machine learning" "requirements"');
    expect(session.record).toHaveBeenCalledWith(expect.objectContaining({ metric: "embed-query", inputTokens: 17 }));
  });

  it("honors scoped overrides in both branches", async () => {
    const { promise } = prepare("ML requirements", { glossary: { ml: ["maximum likelihood"] } });
    const plan = await promise;
    expect(plan.effectiveQuery).toContain("maximum likelihood");
    expect(plan.textQuery).toContain("maximum likelihood");
    expect(plan.effectiveQuery).not.toContain("machine learning");
  });

  it("preserves caller vectors without charging another embedding", async () => {
    const vector = [1, 0];
    const { session, promise } = prepare("ML requirements", { queryVector: vector });
    expect((await promise).queryVector).toBe(vector);
    expect(embedConfiguredText).not.toHaveBeenCalled();
    expect(session.record).not.toHaveBeenCalled();
  });

  it("expands the rewritten vector text while retaining original lexical terms", async () => {
    rewriteQuery.mockResolvedValue({ query: "ML methods" });
    const plan = await prepare("ML-204", { queryRewrite: true }).promise;
    expect(embedConfiguredText).toHaveBeenCalledWith(expect.objectContaining({ value: "ML methods\nAliases: ML = machine learning" }));
    expect(plan.textQuery).toBe("ML-204");
  });

  it("keeps unknown abbreviations and unrelated workspaces unchanged", async () => {
    await prepare("ML requirements", {}, {}).promise;
    expect(embedConfiguredText).toHaveBeenCalledWith(expect.objectContaining({ value: "ML requirements" }));
  });
});

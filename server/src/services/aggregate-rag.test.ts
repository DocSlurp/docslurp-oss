import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Aggregate RAG spends model credits only when the caller asked for an answer:
 * the defaults run no model-calling step, the spend guard precedes the answer
 * model, the answer is recorded as a usage event, and a workspace with chat
 * turned off never gets a generated answer.
 */
const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  hybridSearch: vi.fn(),
  getWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  generateOpenRouterDocumentText: vi.fn(),
  recordUsageEvent: vi.fn(),
  assertCanSpend: vi.fn(),
  isWorkspaceChatEnabled: vi.fn(),
}));

vi.mock("./search.js", () => ({ hybridSearch: mocks.hybridSearch }));
vi.mock("./workspaces.js", () => ({ getWorkspace: mocks.getWorkspace, listWorkspaces: mocks.listWorkspaces }));
vi.mock("./billing/spend-guard.js", () => ({ assertCanSpend: mocks.assertCanSpend }));
vi.mock("../lib/ai-usage.js", () => ({ recordUsageEvent: mocks.recordUsageEvent }));
vi.mock("../lib/privacy.js", () => ({
  hostedApiKeyForWorkspaces: async ({ apiKey }: { apiKey: string | null }) => ({ apiKey, privacyMode: "standard" }),
  openRouterCall: () => ({}),
}));
vi.mock("../lib/ai.js", () => ({
  generateOpenRouterDocumentText: mocks.generateOpenRouterDocumentText,
  resolveOpenRouterApiKey: () => "or-key",
  SEARCH_OPENROUTER_MODEL: "test/model",
}));
vi.mock("./workspace-chat.js", async (importOriginal) => ({
  apiKeyOutputCap: (await importOriginal<typeof import("./workspace-chat.js")>()).apiKeyOutputCap,
  capOutputTokens: (await importOriginal<typeof import("./workspace-chat.js")>()).capOutputTokens,
  buildFallbackAnswer: () => "fallback",
  buildNativeDocumentInputs: (citations: unknown[]) => citations.map(() => ({ context: "ctx" })),
  buildWorkspaceChatEvidenceSpans: () => [],
  isWorkspaceChatEnabled: mocks.isWorkspaceChatEnabled,
}));

const { aggregateWorkspaceRagSearch } = await import("./aggregate-rag.js");
const { aggregateWorkspaceRagSearchRequestSchema } = await import("@docslurp/shared");

const hit = {
  chunkId: "c1", documentId: "d1", score: 0.9, text: "Evidence",
  citation: { documentId: "d1", filename: "a.pdf", pageNumber: 1 },
};

function request(body: Record<string, unknown>) {
  return aggregateWorkspaceRagSearchRequestSchema.parse({ q: "who is this for?", workspaces: ["ws-1"], ...body });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.getWorkspace.mockResolvedValue({ id: "ws-1", orgId: "org-1", name: "Manuals" });
  mocks.hybridSearch.mockResolvedValue({ sessionId: "s1", availability: null, results: [hit] });
  mocks.isWorkspaceChatEnabled.mockResolvedValue(true);
  mocks.assertCanSpend.mockImplementation(async () => { mocks.calls.push("assertCanSpend"); });
  mocks.generateOpenRouterDocumentText.mockImplementation(async () => {
    mocks.calls.push("model");
    return { text: "Answer [1].", usage: { inputTokens: 10, outputTokens: 5, metadata: {} } };
  });
  mocks.recordUsageEvent.mockImplementation(async () => { mocks.calls.push("usage"); });
});

describe("aggregateWorkspaceRagSearch spend", () => {
  it("runs no model-calling step for a default request", async () => {
    const response = await aggregateWorkspaceRagSearch({ userId: "u1", request: request({}) });
    expect(response.answer).toBeNull();
    expect(response.citations).toHaveLength(1);
    expect(mocks.hybridSearch).toHaveBeenCalledWith("who is this for?", "u1", expect.objectContaining({
      queryRewrite: false, selfQuery: false, useHyDE: false, useContextualCompression: false, queryDecompose: false, stepback: false,
    }));
    expect(mocks.generateOpenRouterDocumentText).not.toHaveBeenCalled();
    expect(mocks.assertCanSpend).not.toHaveBeenCalled();
    expect(mocks.recordUsageEvent).not.toHaveBeenCalled();
  });

  it("checks spend before the answer model and records its usage with the workspace scope", async () => {
    const response = await aggregateWorkspaceRagSearch({ userId: "u1", request: request({ generateAnswer: true }) });
    expect(response.answer).toBe("Answer [1].");
    expect(mocks.calls).toEqual(["assertCanSpend", "model", "usage"]);
    expect(mocks.assertCanSpend).toHaveBeenCalledWith("org-1", "ws-1", { kind: "interactive", hold: true });
    expect(mocks.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      scope: { orgId: "org-1", workspaceIds: ["ws-1"] },
      usage: expect.objectContaining({ metric: "aggregate-rag-answer", inputTokens: 10, outputTokens: 5 }),
    }));
  });

  it("calls no model when the spend guard refuses", async () => {
    mocks.assertCanSpend.mockRejectedValueOnce(Object.assign(new Error("out of credits"), { status: 402 }));
    await expect(aggregateWorkspaceRagSearch({ userId: "u1", request: request({ generateAnswer: true }) })).rejects.toThrow("out of credits");
    expect(mocks.generateOpenRouterDocumentText).not.toHaveBeenCalled();
    expect(mocks.recordUsageEvent).not.toHaveBeenCalled();
  });

  it("returns citations only, with no spend check or model call, when chat is off in an answered workspace", async () => {
    mocks.isWorkspaceChatEnabled.mockResolvedValueOnce(false);
    const response = await aggregateWorkspaceRagSearch({ userId: "u1", request: request({ generateAnswer: true }) });
    expect(response.answer).toBeNull();
    expect(response.citations).toHaveLength(1);
    expect(response.warnings.join(" ")).toContain("chat is turned off in Manuals");
    expect(mocks.isWorkspaceChatEnabled).toHaveBeenCalledWith("ws-1", "u1");
    expect(mocks.assertCanSpend).not.toHaveBeenCalled();
    expect(mocks.generateOpenRouterDocumentText).not.toHaveBeenCalled();
    expect(mocks.recordUsageEvent).not.toHaveBeenCalled();
  });

  it("refuses an answer over workspaces from two organizations before searching, and still searches across them without one", async () => {
    mocks.getWorkspace.mockImplementation(async (id: string) => ({ id, orgId: id === "ws-1" ? "org-1" : "org-2", name: id }));
    await expect(aggregateWorkspaceRagSearch({ userId: "u1", request: request({ generateAnswer: true, workspaces: ["ws-1", "ws-2"] }) }))
      .rejects.toMatchObject({ name: "AggregateAnswerScopeError", status: 400 });
    expect(mocks.hybridSearch).not.toHaveBeenCalled();
    expect(mocks.assertCanSpend).not.toHaveBeenCalled();
    expect(mocks.generateOpenRouterDocumentText).not.toHaveBeenCalled();
    const retrieval = await aggregateWorkspaceRagSearch({ userId: "u1", request: request({ workspaces: ["ws-1", "ws-2"] }) });
    expect(retrieval.workspaces).toHaveLength(2);
    expect(retrieval.answer).toBeNull();
  });

  it("answers null with a warning, and calls no model, when no workspace is accessible", async () => {
    mocks.listWorkspaces.mockResolvedValueOnce([]);
    const response = await aggregateWorkspaceRagSearch({ userId: "u1", request: request({ generateAnswer: true, workspaces: [] }) });
    expect(response.answer).toBeNull();
    expect(response.warnings).toEqual(["No accessible workspaces matched the aggregate request."]);
    expect(mocks.generateOpenRouterDocumentText).not.toHaveBeenCalled();
  });

  it("applies the key's chat output cap to the answer", async () => {
    const apiKey = { keyId: "k", userId: "u1", orgId: "org-1", keyType: "server" as const, allowedDomains: [], scopes: ["search", "chat"], rateLimitRpm: null, rateLimitPpd: 1000, rateLimits: [], workspaceIds: [], maxOutputTokens: 500 };
    await aggregateWorkspaceRagSearch({ userId: "u1", request: request({ generateAnswer: true }), apiKey });
    expect(mocks.generateOpenRouterDocumentText).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 500 }));
    await aggregateWorkspaceRagSearch({ userId: "u1", request: request({ generateAnswer: true }) });
    expect(mocks.generateOpenRouterDocumentText).toHaveBeenLastCalledWith(expect.objectContaining({ maxOutputTokens: 800 }));
  });

  it("never searches a workspace outside the key's organization", async () => {
    const apiKey = { keyId: "k", userId: "u1", orgId: "org-2", keyType: "server" as const, allowedDomains: [], scopes: ["search", "chat"], rateLimitRpm: null, rateLimitPpd: 1000, rateLimits: [], workspaceIds: [] };
    await expect(aggregateWorkspaceRagSearch({ userId: "u1", request: request({ generateAnswer: true }), apiKey })).rejects.toThrow("Workspace not found");
    expect(mocks.hybridSearch).not.toHaveBeenCalled();
    expect(mocks.generateOpenRouterDocumentText).not.toHaveBeenCalled();
  });
});

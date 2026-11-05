import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Aggregate RAG spends model credits only when the caller asked for an answer:
 * the defaults run no model-calling step, the spend guard precedes the answer
 * model, the answer is recorded as a usage event, and a project with chat
 * turned off never gets a generated answer.
 */
const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  hybridSearch: vi.fn(),
  getProject: vi.fn(),
  listProjects: vi.fn(),
  generateOpenRouterDocumentText: vi.fn(),
  recordUsageEvent: vi.fn(),
  assertCanSpend: vi.fn(),
  isProjectChatEnabled: vi.fn(),
}));

vi.mock("./search.js", () => ({ hybridSearch: mocks.hybridSearch, ProjectNotFoundError: class extends Error { constructor() { super("Project not found"); } } }));
vi.mock("./projects.js", () => ({ getProject: mocks.getProject, listProjects: mocks.listProjects }));
vi.mock("./billing/spend-guard.js", () => ({ assertCanSpend: mocks.assertCanSpend }));
vi.mock("../lib/ai-usage.js", () => ({ recordUsageEvent: mocks.recordUsageEvent }));
vi.mock("../lib/privacy.js", () => ({
  hostedApiKeyForProjects: async ({ apiKey }: { apiKey: string | null }) => ({ apiKey, privacyMode: "standard" }),
  openRouterCall: () => ({}),
}));
vi.mock("../lib/ai.js", () => ({
  generateOpenRouterDocumentText: mocks.generateOpenRouterDocumentText,
  resolveOpenRouterApiKey: () => "or-key",
  SEARCH_OPENROUTER_MODEL: "test/model",
}));
vi.mock("./project-chat.js", async (importOriginal) => ({
  apiKeyOutputCap: (await importOriginal<typeof import("./project-chat.js")>()).apiKeyOutputCap,
  capOutputTokens: (await importOriginal<typeof import("./project-chat.js")>()).capOutputTokens,
  buildFallbackAnswer: () => "fallback",
  buildNativeDocumentInputs: (citations: unknown[]) => citations.map(() => ({ context: "ctx" })),
  buildProjectChatEvidenceSpans: () => [],
  isProjectChatEnabled: mocks.isProjectChatEnabled,
}));

const { aggregateProjectRagSearch } = await import("./aggregate-rag.js");
const { aggregateProjectRagSearchRequestSchema } = await import("@docslurp/shared");

const hit = {
  chunkId: "c1", documentId: "d1", score: 0.9, text: "Evidence",
  citation: { documentId: "d1", filename: "a.pdf", pageNumber: 1 },
};

function request(body: Record<string, unknown>) {
  return aggregateProjectRagSearchRequestSchema.parse({ q: "who is this for?", projects: ["ws-1"], ...body });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.getProject.mockResolvedValue({ id: "ws-1", orgId: "org-1", name: "Manuals" });
  mocks.hybridSearch.mockResolvedValue({ sessionId: "s1", availability: null, results: [hit] });
  mocks.isProjectChatEnabled.mockResolvedValue(true);
  mocks.assertCanSpend.mockImplementation(async () => { mocks.calls.push("assertCanSpend"); });
  mocks.generateOpenRouterDocumentText.mockImplementation(async () => {
    mocks.calls.push("model");
    return { text: "Answer [1].", usage: { inputTokens: 10, outputTokens: 5, metadata: {} } };
  });
  mocks.recordUsageEvent.mockImplementation(async () => { mocks.calls.push("usage"); });
});

describe("aggregateProjectRagSearch spend", () => {
  it("runs no model-calling step for a default request", async () => {
    const response = await aggregateProjectRagSearch({ userId: "u1", orgId: "org-1", request: request({}) });
    expect(response.answer).toBeNull();
    expect(response.citations).toHaveLength(1);
    expect(mocks.hybridSearch).toHaveBeenCalledWith("who is this for?", "u1", expect.objectContaining({
      queryRewrite: false, selfQuery: false, useHyDE: false, useContextualCompression: false, queryDecompose: false, stepback: false,
    }));
    expect(mocks.generateOpenRouterDocumentText).not.toHaveBeenCalled();
    expect(mocks.assertCanSpend).not.toHaveBeenCalled();
    expect(mocks.recordUsageEvent).not.toHaveBeenCalled();
  });

  it("checks spend before the answer model and records its usage with the project scope", async () => {
    const response = await aggregateProjectRagSearch({ userId: "u1", orgId: "org-1", request: request({ generateAnswer: true }) });
    expect(response.answer).toBe("Answer [1].");
    expect(mocks.calls).toEqual(["assertCanSpend", "model", "usage"]);
    expect(mocks.assertCanSpend).toHaveBeenCalledWith("org-1", "ws-1", { kind: "interactive", hold: true });
    expect(mocks.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      scope: { orgId: "org-1", projectIds: ["ws-1"] },
      usage: expect.objectContaining({ metric: "aggregate-rag-answer", inputTokens: 10, outputTokens: 5 }),
    }));
  });

  it("calls no model when the spend guard refuses", async () => {
    mocks.assertCanSpend.mockRejectedValueOnce(Object.assign(new Error("out of credits"), { status: 402 }));
    await expect(aggregateProjectRagSearch({ userId: "u1", orgId: "org-1", request: request({ generateAnswer: true }) })).rejects.toThrow("out of credits");
    expect(mocks.generateOpenRouterDocumentText).not.toHaveBeenCalled();
    expect(mocks.recordUsageEvent).not.toHaveBeenCalled();
  });

  it("returns citations only, with no spend check or model call, when chat is off in an answered project", async () => {
    mocks.isProjectChatEnabled.mockResolvedValueOnce(false);
    const response = await aggregateProjectRagSearch({ userId: "u1", orgId: "org-1", request: request({ generateAnswer: true }) });
    expect(response.answer).toBeNull();
    expect(response.citations).toHaveLength(1);
    expect(response.warnings.join(" ")).toContain("chat is turned off in Manuals");
    expect(mocks.isProjectChatEnabled).toHaveBeenCalledWith("ws-1", "u1");
    expect(mocks.assertCanSpend).not.toHaveBeenCalled();
    expect(mocks.generateOpenRouterDocumentText).not.toHaveBeenCalled();
    expect(mocks.recordUsageEvent).not.toHaveBeenCalled();
  });

  it("never searches a project of another of the caller's organizations, named or listed", async () => {
    mocks.getProject.mockImplementation(async (id: string) => ({ id, orgId: id === "ws-1" ? "org-1" : "org-2", name: id }));
    await expect(aggregateProjectRagSearch({ userId: "u1", orgId: "org-1", request: request({ projects: ["ws-1", "ws-2"] }) }))
      .rejects.toThrow("Project not found");
    expect(mocks.hybridSearch).not.toHaveBeenCalled();
    mocks.listProjects.mockResolvedValueOnce([
      { id: "ws-1", orgId: "org-1", name: "Mine" },
      { id: "ws-2", orgId: "org-2", name: "Other org" },
    ]);
    const retrieval = await aggregateProjectRagSearch({ userId: "u1", orgId: "org-1", request: request({ projects: [] }) });
    expect(retrieval.projects.map((project) => project.projectId)).toEqual(["ws-1"]);
    expect(mocks.hybridSearch).toHaveBeenCalledTimes(1);
  });

  it("answers null with a warning, and calls no model, when no project is accessible", async () => {
    mocks.listProjects.mockResolvedValueOnce([]);
    const response = await aggregateProjectRagSearch({ userId: "u1", orgId: "org-1", request: request({ generateAnswer: true, projects: [] }) });
    expect(response.answer).toBeNull();
    expect(response.warnings).toEqual(["No accessible projects matched the aggregate request."]);
    expect(mocks.generateOpenRouterDocumentText).not.toHaveBeenCalled();
  });

  it("applies the key's chat output cap to the answer", async () => {
    const apiKey = { keyId: "k", userId: "u1", orgId: "org-1", keyType: "server" as const, allowedDomains: [], scopes: ["search", "chat"], rateLimitRpm: null, rateLimitPpd: 1000, rateLimits: [], projectIds: [], maxOutputTokens: 500 };
    await aggregateProjectRagSearch({ userId: "u1", orgId: "org-1", request: request({ generateAnswer: true }), apiKey });
    expect(mocks.generateOpenRouterDocumentText).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 500 }));
    await aggregateProjectRagSearch({ userId: "u1", orgId: "org-1", request: request({ generateAnswer: true }) });
    expect(mocks.generateOpenRouterDocumentText).toHaveBeenLastCalledWith(expect.objectContaining({ maxOutputTokens: 800 }));
  });

  it("never searches a project outside the key's organization", async () => {
    const apiKey = { keyId: "k", userId: "u1", orgId: "org-2", keyType: "server" as const, allowedDomains: [], scopes: ["search", "chat"], rateLimitRpm: null, rateLimitPpd: 1000, rateLimits: [], projectIds: [] };
    await expect(aggregateProjectRagSearch({ userId: "u1", orgId: "org-1", request: request({ generateAnswer: true }), apiKey })).rejects.toThrow("Project not found");
    expect(mocks.hybridSearch).not.toHaveBeenCalled();
    expect(mocks.generateOpenRouterDocumentText).not.toHaveBeenCalled();
  });
  it("fails closed for a key searching an organization other than its own", async () => {
    const apiKey = { keyId: "k", userId: "u1", orgId: "org-2", keyType: "server" as const, allowedDomains: [], scopes: ["search", "chat"], rateLimitRpm: null, rateLimitPpd: 1000, rateLimits: [], projectIds: [] };
    mocks.listProjects.mockResolvedValueOnce([{ id: "ws-1", orgId: "org-1", name: "Manuals" }]);
    await expect(aggregateProjectRagSearch({ userId: "u1", orgId: "org-1", request: request({ projects: [] }), apiKey })).rejects.toThrow("Project not found");
    expect(mocks.hybridSearch).not.toHaveBeenCalled();
  });
});

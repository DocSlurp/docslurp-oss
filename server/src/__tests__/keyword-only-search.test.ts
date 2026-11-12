import { defaultProjectSearchSettings, normalizePipelineFeatures } from "@docslurp/shared";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  embedConfiguredText: vi.fn(),
  embedConfiguredTexts: vi.fn(),
  hostedApiKeyForProject: vi.fn(),
  canSpend: vi.fn(),
  settings: vi.fn(),
  hyde: vi.fn(),
  rewrite: vi.fn(),
  selfQuery: vi.fn(),
}));

vi.mock("../db.js", () => ({ sql: Object.assign(mocks.sql, { json: (v: unknown) => v, array: (v: unknown) => v }) }));
vi.mock("../lib/ai.js", async (original) => ({
  ...await original<typeof import("../lib/ai.js")>(),
  embedConfiguredText: mocks.embedConfiguredText,
  embedConfiguredTexts: mocks.embedConfiguredTexts,
  resolveOpenRouterApiKey: () => "openrouter-test-key",
}));
vi.mock("../lib/privacy.js", async (original) => ({ ...await original<typeof import("../lib/privacy.js")>(), hostedApiKeyForProject: mocks.hostedApiKeyForProject }));
vi.mock("../services/billing/spend-guard.js", async (original) => ({ ...await original<typeof import("../services/billing/spend-guard.js")>(), canSpend: mocks.canSpend }));
vi.mock("../services/search-controls.js", async (original) => ({ ...await original<typeof import("../services/search-controls.js")>(), getProjectSearchSettings: mocks.settings }));
vi.mock("../services/organizations.js", async (original) => ({
  ...await original<typeof import("../services/organizations.js")>(),
  getProjectAccess: async (projectId: string) => ({ projectId, orgId: "org-kw" }),
}));
vi.mock("../search/hyde.js", () => ({ hydeExpand: mocks.hyde }));
vi.mock("../search/query-rewrite.js", () => ({ rewriteQuery: mocks.rewrite }));
vi.mock("../search/self-query.js", () => ({ deriveSelfQueryFilters: mocks.selfQuery }));

const { clampKeywordOnly, searchIsKeywordOnly } = await import("../search/keyword-only.js");
const { prepareSearchSessionRetrievalPlan } = await import("../search/session-planner.js");
const { resolveSearchSetup } = await import("../search/session-setup.js");
const { prefetchBatchQueryEmbeddings } = await import("../search/batch-embeddings.js");
const { apiKeyScopesKeywordOnly, actorCanSearch, actorHasAnyApiKeyScope, setRequestActor } = await import("../lib/request-actor.js");
const { currentRequestKeywordOnly, requestContextMiddleware } = await import("../lib/request-context.js");
const { createChatTurnContext, runInChatTurnContext } = await import("../lib/chat-turn-context.js");
const { apiKeyCanUseWebTools } = await import("../lib/web-tool-access.js");
const { mcpManifest } = await import("../services/mcp-catalog.js");

/** Every option that could make a search call a model, all turned on. */
const everythingOn = {
  useHyDE: true, queryRewrite: true, queryDecompose: true, stepback: true, selfQuery: true,
  useContextualCompression: true, adaptiveRetrieval: true, iterativeMultiHop: true, summarySeed: true,
  enableGraphExpansion: true, enableCommunityExpansion: true, enableWebFallback: true,
  useRerank: true, rerankProvider: "deepinfra" as const, rerankModel: "Qwen/Qwen3-Reranker-0.6B" as const,
  queryVector: [0.1, 0.2],
};

const keyActor = (scopes: string[], keyType: "server" | "client" = "client") => ({
  type: "apiKey" as const, userId: "user-1",
  apiKey: { keyId: "kw", userId: "user-1", orgId: "org-kw", keyType, allowedDomains: [], scopes, rateLimitRpm: 60, rateLimitPpd: 1000, rateLimits: [], projectIds: ["ws-kw"] },
}) as never;

/** Runs `fn` inside a real request context whose actor is `actor`, as the auth middleware sets it. */
async function inRequestAs<T>(actor: unknown, fn: () => Promise<T> | T): Promise<T> {
  let result: T | undefined;
  const app = new Hono();
  app.use("*", requestContextMiddleware);
  app.get("/", async (c) => {
    setRequestActor(c, actor as never);
    result = await fn();
    return c.text("ok");
  });
  const response = await app.request("/");
  expect(response.status).toBe(200);
  return result as T;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sql.mockResolvedValue([]);
  mocks.hostedApiKeyForProject.mockImplementation(async ({ apiKey }: { apiKey?: string }) => apiKey ?? "hosted-key");
  mocks.canSpend.mockResolvedValue(true);
  mocks.embedConfiguredText.mockResolvedValue({ embedding: [1, 0], usage: { inputTokens: 3 } });
  mocks.embedConfiguredTexts.mockImplementation(async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => [1, 0]), usage: { inputTokens: 3 } }));
  vi.stubEnv("DEEPINFRA_API_KEY", "deepinfra-test-key");
});

describe("search:keyword scope", () => {
  it("is keyword-only only without full search, and is a search scope but never chat", () => {
    expect(apiKeyScopesKeywordOnly(["search:keyword"])).toBe(true);
    expect(apiKeyScopesKeywordOnly(["search:keyword", "chat"])).toBe(true);
    expect(apiKeyScopesKeywordOnly(["search", "search:keyword"])).toBe(false);
    expect(apiKeyScopesKeywordOnly(["search"])).toBe(false);
    expect(apiKeyScopesKeywordOnly(["chat"])).toBe(false);
    expect(actorCanSearch(keyActor(["search:keyword"]))).toBe(true);
    expect(actorCanSearch(keyActor(["chat"]))).toBe(false);
    expect(actorHasAnyApiKeyScope(keyActor(["search:keyword"]), ["chat"])).toBe(false);
    expect(actorHasAnyApiKeyScope(keyActor(["search:keyword"]), ["search"])).toBe(false);
  });

  it("gets no MCP tools: the MCP search tool needs full search", () => {
    expect(mcpManifest("http://mcp.internal", ["search:keyword"], "client").capabilities).toEqual([]);
    expect(mcpManifest("http://mcp.internal", ["search:keyword"], "server").capabilities).toEqual([]);
  });

  it("never unlocks web tools, for server or browser keys", () => {
    expect(apiKeyCanUseWebTools({ keyType: "server", scopes: ["search:keyword"] })).toBe(false);
    expect(apiKeyCanUseWebTools({ keyType: "client", scopes: ["search:keyword", "web"] })).toBe(false);
  });
});

describe("request flag", () => {
  it("is set for a keyword-only key and cleared for full-search keys and sessions", async () => {
    expect(await inRequestAs(keyActor(["search:keyword"]), () => currentRequestKeywordOnly())).toBe(true);
    expect(await inRequestAs(keyActor(["search:keyword"], "server"), () => currentRequestKeywordOnly())).toBe(true);
    expect(await inRequestAs(keyActor(["search"]), () => currentRequestKeywordOnly())).toBe(false);
    expect(await inRequestAs({ type: "session", userId: "user-1", sessionId: "s", user: { id: "user-1" } }, () => currentRequestKeywordOnly())).toBe(false);
    expect(currentRequestKeywordOnly()).toBe(false);
  });

  it("forces keyword-only on any search the request runs, whatever options the route passed", async () => {
    expect(await inRequestAs(keyActor(["search:keyword"]), () => searchIsKeywordOnly({}))).toBe(true);
    expect(await inRequestAs(keyActor(["search:keyword"]), () => searchIsKeywordOnly({ keywordOnly: false }))).toBe(true);
    expect(await inRequestAs(keyActor(["search"]), () => searchIsKeywordOnly({}))).toBe(false);
    expect(searchIsKeywordOnly({ keywordOnly: true })).toBe(true);
  });

  it("leaves a chat turn's retrieval to the chat scope", async () => {
    const turn = createChatTurnContext({ refundOnFailure: false });
    expect(await inRequestAs(keyActor(["search:keyword", "chat"]), () => runInChatTurnContext(turn, () => searchIsKeywordOnly({})))).toBe(false);
  });
});

describe("clampKeywordOnly", () => {
  it("turns every model-calling and vector option off, keeping the free BM25 rerank", () => {
    const clamped = clampKeywordOnly(everythingOn);
    expect(clamped).toMatchObject({
      keywordOnly: true, queryVector: undefined, useHyDE: false, queryRewrite: false, queryDecompose: false, stepback: false,
      selfQuery: false, useContextualCompression: false, adaptiveRetrieval: false, iterativeMultiHop: false, summarySeed: false,
      enableGraphExpansion: false, enableCommunityExpansion: false, enableWebFallback: false,
      useRerank: false, rerankProvider: undefined, rerankModel: undefined,
    });
    expect(clampKeywordOnly({ useRerank: true, rerankProvider: "bm25" })).toMatchObject({ useRerank: true, rerankProvider: "bm25" });
  });
});

describe("keyword-only search setup and plan", () => {
  it("withholds every model key even when the project turns HyDE and the hosted reranker on", async () => {
    mocks.settings.mockResolvedValue({ ...defaultProjectSearchSettings, projectId: "ws-kw", userId: "user-1", hyde: true, rerank: true, rerankProvider: "deepinfra", queryRewrite: true });
    vi.stubEnv("SEARCH_LANCEDB_NATIVE", "0");
    const setup = await inRequestAs(keyActor(["search:keyword"]), () => resolveSearchSetup("user-1", { filters: { projectId: "ws-kw" }, ...everythingOn }));
    expect(setup.resolvedOptions).toMatchObject({ keywordOnly: true, useHyDE: false, queryRewrite: false, useRerank: false });
    expect(setup.openRouterApiKey).toBeUndefined();
    expect(setup.rerankApiKey).toBeUndefined();
    expect(mocks.hostedApiKeyForProject).not.toHaveBeenCalled();
    expect(mocks.canSpend).not.toHaveBeenCalled();

    // The same project for a full-search key still gets its strategies.
    const full = await inRequestAs(keyActor(["search"]), () => resolveSearchSetup("user-1", { filters: { projectId: "ws-kw" }, useHyDE: true }));
    expect(full.resolvedOptions.keywordOnly).toBeFalsy();
    expect(full.openRouterApiKey).toBe("openrouter-test-key");
  });

  it("never embeds the query or runs an LLM strategy", async () => {
    const options = clampKeywordOnly({ ...everythingOn, filters: { projectId: "ws-kw" } });
    const session = { recordDiagnostic: vi.fn(), recordUsage: vi.fn(), record: vi.fn() } as never;
    const plan = await prepareSearchSessionRetrievalPlan({
      query: "pump seals", userId: "user-1", options, effectiveOptions: options, projectId: "ws-kw", orgId: "org-kw",
      projectSettings: {}, embedding: normalizePipelineFeatures(null).embedding, openRouterApiKey: "would-be-key", privacyMode: "standard", session,
    });
    await expect(plan.queryVector).resolves.toBeNull();
    expect(plan.effectiveQuery).toBe("pump seals");
    expect(mocks.embedConfiguredText).not.toHaveBeenCalled();
    expect(mocks.hyde).not.toHaveBeenCalled();
    expect(mocks.rewrite).not.toHaveBeenCalled();
    expect(mocks.selfQuery).not.toHaveBeenCalled();
  });

  it("skips the batch embedding prefetch for keyword-only searches", async () => {
    const items = ["pump seals", "valve torque", "bearing wear"].map((query) => ({ query, projectId: "ws-kw", options: {} }));
    expect(await inRequestAs(keyActor(["search:keyword"], "server"), () => prefetchBatchQueryEmbeddings(items, "user-1"))).toEqual({ prefetched: 0, calls: 0 });
    expect(await prefetchBatchQueryEmbeddings(items.map((item) => ({ ...item, options: { keywordOnly: true } })), "user-1")).toEqual({ prefetched: 0, calls: 0 });
    expect(mocks.embedConfiguredTexts).not.toHaveBeenCalled();
  });
});

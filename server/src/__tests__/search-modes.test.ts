import { defaultProjectSearchSettings, normalizePipelineFeatures } from "@docslurp/shared";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
/** The explicit search access scope every search caller passes (search/access-scope.ts). */
const TEST_SEARCH_SCOPE = { orgId: "org-kw", projectIds: "org", modeCeiling: null } as const;


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
vi.mock("../services/web/service.js", async (original) => ({ ...await original<typeof import("../services/web/service.js")>(), webCapabilityAvailable: () => true }));
vi.mock("../search/hyde.js", () => ({ hydeExpand: mocks.hyde }));
vi.mock("../search/query-rewrite.js", () => ({ rewriteQuery: mocks.rewrite }));
vi.mock("../search/self-query.js", () => ({ deriveSelfQueryFilters: mocks.selfQuery }));

const { clampToSearchMode, effectiveSearchMode } = await import("../search/search-mode.js");
const { prepareSearchSessionRetrievalPlan } = await import("../search/session-planner.js");
const { resolveSearchSetup } = await import("../search/session-setup.js");
const { prefetchBatchQueryEmbeddings } = await import("../search/batch-embeddings.js");
const { actorCanSearch, actorHasAnyApiKeyScope, setRequestActor } = await import("../lib/request-actor.js");
const { searchModeOfScopes } = await import("../lib/search-tiers.js");
const { currentRequestSearchCeiling, requestContextMiddleware } = await import("../lib/request-context.js");
const { createChatTurnContext, runInChatTurnContext } = await import("../lib/chat-turn-context.js");
const { apiKeyCanUseWebTools } = await import("../lib/web-tool-access.js");
const { mcpManifest } = await import("../services/mcp-catalog.js");
const { effectiveKeyScopes } = await import("../services/api-keys.js");
const { grantKeyScopes, normalizeOAuthScopes, oauthScopesToApiKeyScopes, parseScopes } = await import("../services/mcp-oauth.js");
const { consumeSearchModeLimit, SearchModeLimitError } = await import("../search/search-mode-limits.js");
const { resetApiRateLimitBuckets } = await import("../middleware/rate-limit.js");
const { apiKeyRateLimitRulesSchema } = await import("@docslurp/shared");

/** Every option that could make a search call a model or use vectors, all turned on. */
const everythingOn = {
  useHyDE: true, queryRewrite: true, queryDecompose: true, stepback: true, selfQuery: true,
  useContextualCompression: true, adaptiveRetrieval: true, iterativeMultiHop: true, summarySeed: true,
  enableGraphExpansion: true, enableCommunityExpansion: true, enableWebFallback: true,
  useRerank: true, rerankProvider: "deepinfra" as const, rerankModel: "Qwen/Qwen3-Reranker-0.6B" as const,
  queryVector: [0.1, 0.2],
};
/** What hybrid turns off (and keyword too). */
const modelSteps = {
  useHyDE: false, queryRewrite: false, queryDecompose: false, stepback: false, selfQuery: false,
  useContextualCompression: false, adaptiveRetrieval: false, iterativeMultiHop: false,
  enableGraphExpansion: false, enableCommunityExpansion: false, enableWebFallback: false,
  useRerank: false, rerankProvider: "bm25", rerankModel: undefined,
};

const keyActor = (scopes: string[], keyType: "server" | "client" = "client", rateLimits: unknown[] = [], keyId = "kw") => ({
  type: "apiKey" as const, userId: "user-1",
  apiKey: { keyId, userId: "user-1", orgId: "org-kw", keyType, allowedDomains: [], scopes, rateLimitRpm: 60, rateLimitPpd: 1000, rateLimits, projectIds: ["ws-kw"] },
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
  vi.stubEnv("SEARCH_LANCEDB_NATIVE", "0");
});

describe("search mode scopes", () => {
  it("map scopes to the most a key may search; several (refused on save) resolve to the narrowest", () => {
    expect(searchModeOfScopes(["search:keyword"])).toBe("keyword");
    expect(searchModeOfScopes(["search:hybrid", "chat"])).toBe("hybrid");
    expect(searchModeOfScopes(["search:deep"])).toBe("deep");
    expect(searchModeOfScopes(["search:deep", "search:keyword"])).toBe("keyword");
    expect(searchModeOfScopes(["search", "chat"])).toBeNull();
    expect(effectiveKeyScopes("server", ["search:deep", "search:hybrid", "ingest"], [])).toEqual(["search:hybrid", "ingest"]);
    expect(effectiveKeyScopes("client", ["search:deep", "search:keyword"], ["ws"])).toEqual(["search:keyword"]);
  });

  it("admit every mode to search but never to chat; the retired `search` scope admits nothing", () => {
    for (const scope of ["search:keyword", "search:hybrid", "search:deep"]) {
      expect(actorCanSearch(keyActor([scope]))).toBe(true);
      expect(actorHasAnyApiKeyScope(keyActor([scope]), ["chat"])).toBe(false);
    }
    expect(actorCanSearch(keyActor(["search"]))).toBe(false);
    expect(actorCanSearch(keyActor(["chat"]))).toBe(false);
  });

  it("unlock paid web tools only with deep search", () => {
    expect(apiKeyCanUseWebTools({ keyType: "server", scopes: ["search:deep"] })).toBe(true);
    expect(apiKeyCanUseWebTools({ keyType: "server", scopes: ["search:hybrid"] })).toBe(false);
    expect(apiKeyCanUseWebTools({ keyType: "server", scopes: ["search:keyword"] })).toBe(false);
    expect(apiKeyCanUseWebTools({ keyType: "client", scopes: ["search:hybrid", "web"] })).toBe(false);
  });

  it("give every mode the MCP search tools, and web tools only to deep server keys", () => {
    const ids = (scopes: string[], keyType = "server") => mcpManifest("http://mcp.internal", scopes, keyType).capabilities.map((tool) => tool.id);
    for (const scope of ["search:keyword", "search:hybrid"]) {
      expect(ids([scope])).toContain("search");
      expect(ids([scope])).not.toContain("webSearch");
      expect(ids([scope])).not.toContain("chat");
    }
    expect(ids(["search:deep"])).toContain("webSearch");
    expect(ids(["chat"])).not.toContain("search");
  });

  it("use the same names as OAuth scopes, reading the retired `search` as search:deep", () => {
    expect(oauthScopesToApiKeyScopes(["search:hybrid", "read"])).toEqual(["search:hybrid", "artifacts"]);
    expect(oauthScopesToApiKeyScopes(["search", "read"])).toEqual(["search:deep", "artifacts"]);
    expect(grantKeyScopes("https://x.test/mcp", ["search", "read", "chat"], "https://x.test")).toEqual(["search:deep", "read", "chat"]);
    expect(grantKeyScopes("https://x.test/mcp", ["search:keyword", "read"], "https://x.test")).toEqual(["search:keyword", "read"]);
  });

  it("grant one search mode per OAuth request: the widest asked for, which consent shows", () => {
    expect(normalizeOAuthScopes(["search:keyword", "search:deep", "read"])).toEqual(["search:deep", "read"]);
    expect(parseScopes(null)).toEqual(["search:deep", "chat", "read", "ingest"]);
    expect(parseScopes("search read")).toEqual(["search:deep", "read"]);
    expect(parseScopes("search:keyword")).toEqual(["search:keyword"]);
    expect(() => parseScopes("search:everything")).toThrow("invalid_scope");
  });
});

describe("request ceiling", () => {
  it("is the key's mode, keyword for a key without a search scope, and none for sessions", async () => {
    expect(await inRequestAs(keyActor(["search:keyword"]), () => currentRequestSearchCeiling())).toBe("keyword");
    expect(await inRequestAs(keyActor(["search:hybrid"], "server"), () => currentRequestSearchCeiling())).toBe("hybrid");
    expect(await inRequestAs(keyActor(["search:deep"]), () => currentRequestSearchCeiling())).toBe("deep");
    expect(await inRequestAs(keyActor(["chat"]), () => currentRequestSearchCeiling())).toBe("keyword");
    expect(await inRequestAs({ type: "session", userId: "user-1", sessionId: "s", user: { id: "user-1" } }, () => currentRequestSearchCeiling())).toBeNull();
    expect(currentRequestSearchCeiling()).toBeNull();
  });

  it("refuses a keyword or hybrid key outside a request context instead of searching unclamped", () => {
    const context = { set: vi.fn(), get: vi.fn() } as never;
    expect(() => setRequestActor(context, keyActor(["search:keyword"]))).toThrow(/request context/);
    expect(() => setRequestActor(context, keyActor(["search:hybrid"]))).toThrow(/request context/);
    expect(() => setRequestActor(context, keyActor(["search:deep"]))).not.toThrow();
  });

  it("caps the requested mode at the key's, whatever the route passed", async () => {
    expect(await inRequestAs(keyActor(["search:keyword"]), () => effectiveSearchMode({}))).toBe("keyword");
    expect(await inRequestAs(keyActor(["search:keyword"]), () => effectiveSearchMode({ searchMode: "deep" }))).toBe("keyword");
    expect(await inRequestAs(keyActor(["search:hybrid"]), () => effectiveSearchMode({ searchMode: "deep" }))).toBe("hybrid");
    expect(await inRequestAs(keyActor(["search:deep"]), () => effectiveSearchMode({}))).toBe("deep");
    // A request may always ask for less.
    expect(await inRequestAs(keyActor(["search:deep"]), () => effectiveSearchMode({ searchMode: "keyword" }))).toBe("keyword");
    expect(effectiveSearchMode({})).toBe("deep");
  });

  it("leaves a chat turn's retrieval to the chat scope", async () => {
    const turn = createChatTurnContext({ refundOnFailure: false });
    expect(await inRequestAs(keyActor(["search:keyword", "chat"]), () => runInChatTurnContext(turn, () => effectiveSearchMode({})))).toBe("deep");
  });
});

describe("clampToSearchMode", () => {
  it("keyword turns off vectors and every model step, keeping the free BM25 rerank", () => {
    expect(clampToSearchMode(everythingOn, "keyword")).toMatchObject({ ...modelSteps, useRerank: true, searchMode: "keyword", queryVector: undefined, summarySeed: false });
    expect(clampToSearchMode({ useRerank: true }, "keyword")).toMatchObject({ useRerank: true, rerankProvider: "bm25" });
  });

  it("hybrid keeps vectors and summary seeding but no graph, hosted rerank or LLM step; a requested rerank runs on BM25", () => {
    expect(clampToSearchMode(everythingOn, "hybrid")).toMatchObject({ ...modelSteps, useRerank: true, searchMode: "hybrid", queryVector: [0.1, 0.2], summarySeed: true });
  });

  it("deep leaves the options as they are", () => {
    expect(clampToSearchMode(everythingOn, "deep")).toEqual({ ...everythingOn, searchMode: "deep" });
  });
});

describe("search setup and plan by mode", () => {
  const hydeProject = () => mocks.settings.mockResolvedValue({ ...defaultProjectSearchSettings, projectId: "ws-kw", userId: "user-1", hyde: true, rerank: true, rerankProvider: "deepinfra", queryRewrite: true });

  it.each([["search:keyword", "keyword"], ["search:hybrid", "hybrid"]] as const)("a %s key gets no model keys even when the project turns HyDE and the hosted reranker on", async (scope, mode) => {
    hydeProject();
    const setup = await inRequestAs(keyActor([scope]), () => resolveSearchSetup("user-1", { filters: { projectId: "ws-kw" }, ...everythingOn }, TEST_SEARCH_SCOPE));
    expect(setup.resolvedOptions).toMatchObject({ searchMode: mode, useHyDE: false, queryRewrite: false, rerankProvider: "bm25" });
    expect(setup.openRouterApiKey).toBeUndefined();
    expect(setup.rerankApiKey).toBeUndefined();
    expect(mocks.hostedApiKeyForProject).not.toHaveBeenCalled();
    expect(mocks.canSpend).not.toHaveBeenCalled();
  });

  it("a deep key keeps the project's strategies", async () => {
    hydeProject();
    const full = await inRequestAs(keyActor(["search:deep"]), () => resolveSearchSetup("user-1", { filters: { projectId: "ws-kw" }, useHyDE: true }, TEST_SEARCH_SCOPE));
    expect(full.resolvedOptions.searchMode).toBe("deep");
    expect(full.openRouterApiKey).toBe("openrouter-test-key");
  });

  const plan = (mode: "keyword" | "hybrid") => {
    const options = clampToSearchMode({ ...everythingOn, queryVector: undefined, filters: { projectId: "ws-kw" } }, mode);
    const session = { recordDiagnostic: vi.fn(), recordUsage: vi.fn(), record: vi.fn() } as never;
    return prepareSearchSessionRetrievalPlan({
      query: "pump seals", userId: "user-1", options, effectiveOptions: options, projectId: "ws-kw", orgId: "org-kw",
      projectSettings: {}, embedding: normalizePipelineFeatures(null).embedding, openRouterApiKey: "would-be-key", privacyMode: "standard", session,
    });
  };

  it("keyword never embeds the query or runs an LLM strategy", async () => {
    const result = await plan("keyword");
    await expect(result.queryVector).resolves.toBeNull();
    expect(result.effectiveQuery).toBe("pump seals");
    expect(mocks.embedConfiguredText).not.toHaveBeenCalled();
    expect(mocks.hyde).not.toHaveBeenCalled();
    expect(mocks.rewrite).not.toHaveBeenCalled();
    expect(mocks.selfQuery).not.toHaveBeenCalled();
  });

  it("hybrid embeds the raw query but runs no LLM strategy", async () => {
    const result = await plan("hybrid");
    await expect(result.queryVector).resolves.toEqual([1, 0]);
    expect(result.effectiveQuery).toBe("pump seals");
    expect(mocks.hyde).not.toHaveBeenCalled();
    expect(mocks.rewrite).not.toHaveBeenCalled();
    expect(mocks.selfQuery).not.toHaveBeenCalled();
  });

  it("skips the batch embedding prefetch for a mode the key limits, so a key past its limit spends nothing", async () => {
    const items = ["pump seals", "valve torque", "bearing wear"].map((query) => ({ query, projectId: "ws-kw", scope: TEST_SEARCH_SCOPE, options: {} }));
    const limited = keyActor(["search:hybrid"], "server", [{ metric: "searches", mode: "hybrid", limit: 1, windowSeconds: 60 }], "prefetch-limited");
    expect(await inRequestAs(limited, () => prefetchBatchQueryEmbeddings(items, "user-1"))).toEqual({ prefetched: 0, calls: 0 });
    expect(mocks.embedConfiguredTexts).not.toHaveBeenCalled();
  });

  it("skips the batch embedding prefetch for keyword searches", async () => {
    const items = ["pump seals", "valve torque", "bearing wear"].map((query) => ({ query, projectId: "ws-kw", scope: TEST_SEARCH_SCOPE, options: {} }));
    expect(await inRequestAs(keyActor(["search:keyword"], "server"), () => prefetchBatchQueryEmbeddings(items, "user-1"))).toEqual({ prefetched: 0, calls: 0 });
    expect(await prefetchBatchQueryEmbeddings(items.map((item) => ({ ...item, options: { searchMode: "keyword" as const } })), "user-1")).toEqual({ prefetched: 0, calls: 0 });
    expect(mocks.embedConfiguredTexts).not.toHaveBeenCalled();
  });
});

describe("per-mode search limits", () => {
  beforeEach(() => resetApiRateLimitBuckets());
  const deepTwoPerMinute = [{ metric: "searches", mode: "deep", limit: 2, windowSeconds: 60 }];

  it("refuses the search past the key's limit for that mode, with a 429 envelope and Retry-After", async () => {
    const error = await inRequestAs(keyActor(["search:deep"], "server", deepTwoPerMinute, "limit-1"), async () => {
      await consumeSearchModeLimit("deep");
      await consumeSearchModeLimit("deep");
      return await consumeSearchModeLimit("deep").then(() => null, (caught: unknown) => caught);
    });
    expect(error).toBeInstanceOf(SearchModeLimitError);
    const response = (error as InstanceType<typeof SearchModeLimitError>).getResponse();
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "search_limit_exceeded", details: { mode: "deep", limit: 2 } } });
  });

  it("counts a keyword fan-out's queries all or none, across every window", async () => {
    const rules = [
      { metric: "searches", mode: "keyword", limit: 10, windowSeconds: 3_600 },
      { metric: "searches", mode: "keyword", limit: 5, windowSeconds: 60 },
    ];
    await inRequestAs(keyActor(["search:keyword"], "server", rules, "limit-fanout"), async () => {
      await consumeSearchModeLimit("keyword", 3);
      // 3 more would pass the hour (6 of 10) but not the minute (6 of 5): refused, and neither window counts them.
      const refused = await consumeSearchModeLimit("keyword", 3).then(() => null, (caught: unknown) => caught);
      expect(refused).toBeInstanceOf(SearchModeLimitError);
      expect((refused as InstanceType<typeof SearchModeLimitError>).rule.windowSeconds).toBe(60);
      await consumeSearchModeLimit("keyword", 2);
      await expect(consumeSearchModeLimit("keyword")).rejects.toBeInstanceOf(SearchModeLimitError);
      // A fan-out larger than the limit itself can never be admitted.
      await expect(consumeSearchModeLimit("keyword", 11)).rejects.toBeInstanceOf(SearchModeLimitError);
    });
  });

  it("counts only its own mode, so a cheaper mode keeps working", async () => {
    await inRequestAs(keyActor(["search:deep"], "server", deepTwoPerMinute, "limit-2"), async () => {
      for (let i = 0; i < 2; i++) await consumeSearchModeLimit("deep");
      await expect(consumeSearchModeLimit("deep")).rejects.toBeInstanceOf(SearchModeLimitError);
      for (let i = 0; i < 5; i++) await expect(consumeSearchModeLimit("keyword")).resolves.toBeUndefined();
    });
  });

  it("is per key, and leaves chat turns and sessions alone", async () => {
    const turn = createChatTurnContext({ refundOnFailure: false });
    await inRequestAs(keyActor(["search:deep", "chat"], "server", deepTwoPerMinute, "limit-3"), async () => {
      for (let i = 0; i < 5; i++) await runInChatTurnContext(turn, () => consumeSearchModeLimit("deep"));
      for (let i = 0; i < 2; i++) await consumeSearchModeLimit("deep");
    });
    await inRequestAs(keyActor(["search:deep"], "server", deepTwoPerMinute, "limit-4"), () => consumeSearchModeLimit("deep"));
    await inRequestAs({ type: "session", userId: "user-1", sessionId: "s", user: { id: "user-1" } }, async () => {
      for (let i = 0; i < 5; i++) await consumeSearchModeLimit("deep");
    });
  });

  it("hybridSearch counts root searches against the limit before running them", async () => {
    const { hybridSearch } = await import("../services/search.js");
    const refusal = (run: () => Promise<unknown>) => run().then(() => null, (error: unknown) => error);
    await inRequestAs(keyActor(["search:deep"], "server", [{ metric: "searches", mode: "deep", limit: 1, windowSeconds: 60 }], "limit-hybrid"), async () => {
      const first = await refusal(() => hybridSearch("pump", "user-1", { filters: { projectId: "ws-kw" } }, TEST_SEARCH_SCOPE));
      expect(first).not.toBeInstanceOf(SearchModeLimitError);
      mocks.sql.mockClear();
      expect(await refusal(() => hybridSearch("pump", "user-1", { filters: { projectId: "ws-kw" } }, TEST_SEARCH_SCOPE))).toBeInstanceOf(SearchModeLimitError);
      // Refused before setup: no database work for the refused search.
      expect(mocks.sql).not.toHaveBeenCalled();
      // A cheaper mode is counted separately.
      expect(await refusal(() => hybridSearch("pump", "user-1", { filters: { projectId: "ws-kw" }, searchMode: "keyword" }, TEST_SEARCH_SCOPE))).not.toBeInstanceOf(SearchModeLimitError);
    });
  });

  it("validates rules: searches names a mode, other metrics don't, one rule per mode and window", () => {
    expect(apiKeyRateLimitRulesSchema.safeParse([{ metric: "searches", mode: "deep", limit: 100, windowSeconds: 86400 }, { metric: "searches", mode: "keyword", limit: 100000, windowSeconds: 86400 }]).success).toBe(true);
    expect(apiKeyRateLimitRulesSchema.safeParse([{ metric: "searches", limit: 100, windowSeconds: 60 }]).success).toBe(false);
    expect(apiKeyRateLimitRulesSchema.safeParse([{ metric: "requests", mode: "deep", limit: 100, windowSeconds: 60 }]).success).toBe(false);
    expect(apiKeyRateLimitRulesSchema.safeParse([{ metric: "searches", mode: "deep", limit: 1, windowSeconds: 60 }, { metric: "searches", mode: "deep", limit: 2, windowSeconds: 60 }]).success).toBe(false);
    expect(apiKeyRateLimitRulesSchema.safeParse([{ metric: "searches", mode: "everything", limit: 1, windowSeconds: 60 }]).success).toBe(false);
  });
});

describe("fast lane: a search with nothing to retrieve", () => {
  const empty = { searchable_documents: 0, indexed_documents: 0, keyword_only_documents: 0, page_only_documents: 0 };
  const setupOf = (resolvedOptions: Record<string, unknown>, availabilityRow: Record<string, unknown> | undefined = empty) =>
    ({ availabilityRow, resolvedOptions }) as never;

  it("is a keyword or hybrid search over a whole project with no documents to serve", async () => {
    const { hasNothingToRetrieve } = await import("../services/search.js");
    expect(hasNothingToRetrieve(setupOf({ searchMode: "keyword" }))).toBe(true);
    expect(hasNothingToRetrieve(setupOf({ searchMode: "hybrid" }))).toBe(true);
  });

  it("never covers deep mode, where model strategies and sub-searches can run", async () => {
    const { hasNothingToRetrieve } = await import("../services/search.js");
    expect(hasNothingToRetrieve(setupOf({ searchMode: "deep" }))).toBe(false);
    expect(hasNothingToRetrieve(setupOf({}))).toBe(false);
  });

  it("never covers a run or document filter, which a caller could invent on a populated project", async () => {
    const { hasNothingToRetrieve } = await import("../services/search.js");
    expect(hasNothingToRetrieve(setupOf({ searchMode: "keyword", runId: "run-1" }))).toBe(false);
    expect(hasNothingToRetrieve(setupOf({ searchMode: "keyword", filters: { runId: "run-1" } }))).toBe(false);
    expect(hasNothingToRetrieve(setupOf({ searchMode: "keyword", filters: { documentId: "doc-1" } }))).toBe(false);
    expect(hasNothingToRetrieve(setupOf({ searchMode: "keyword", filters: { documentIds: ["doc-1"] } }))).toBe(false);
  });

  it("takes a main slot when anything is searchable or availability is unknown", async () => {
    const { hasNothingToRetrieve } = await import("../services/search.js");
    expect(hasNothingToRetrieve(setupOf({ searchMode: "keyword" }, { ...empty, page_only_documents: 1 }))).toBe(false);
    expect(hasNothingToRetrieve(setupOf({ searchMode: "keyword" }, { ...empty, keyword_only_documents: 2 }))).toBe(false);
    expect(hasNothingToRetrieve({ availabilityRow: undefined, resolvedOptions: { searchMode: "keyword" } } as never)).toBe(false);
  });
});

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterializationPolicy } from "@docslurp/shared";

const sqlMock = Object.assign(vi.fn(async () => []), { array: (values: unknown[]) => values });
const chatWorkspace = vi.fn();
vi.mock("../db.js", () => ({ sql: sqlMock }));
vi.mock("../lib/temporal.js", () => ({ startMaterializeWorkflow: vi.fn() }));
vi.mock("../services/search.js", () => ({ hybridSearch: vi.fn(), MissingWorkspaceScopeError: class extends Error {} }));
vi.mock("../services/workspace-chat.js", () => ({
  chatWorkspace,
  workspaceChatDisabledBody: vi.fn(async () => null),
}));
vi.mock("../services/aggregate-rag.js", () => ({ aggregateWorkspaceRagSearch: vi.fn() }));
vi.mock("../services/billing/spend-guard.js", () => ({
  assertCanSpend: vi.fn(async () => undefined),
  canSpend: vi.fn(async () => true),
}));
vi.mock("../services/workspaces.js", () => ({
  resolveWorkspaceRef: vi.fn(async () => null),
  ensureDefaultWorkspace: vi.fn(async () => ({ id: "ws-1" })),
  getWorkspace: vi.fn(),
}));

const { materializeForQuery, estimatedPageMaterializeCredits } = await import("../search/deferred/materialize-client.js");
const { runDeferredPageSearch } = await import("../search/deferred/deferred-search.js");
const { buildSearchSessionMetadata } = await import("../search/session.js");
const { getDeferredContext } = await import("../search/deferred/deferred-context.js");
const { searchRoutes } = await import("../routes/search.js");
type Deps = import("../search/deferred/materialize-client.js").MaterializeDeps;
type PageState = import("../search/deferred/materialize-client.js").PageState;

const policy: MaterializationPolicy = {
  maxPagesPerQuery: 40, maxCreditsPerQuery: 25, deadlineMs: 20000,
  allowFullIndexRequest: false, allowAgentDiscovery: true, mapRouter: "always",
};

/** In-memory ledger + fake clock; pages flip to indexed `indexAfterPolls` polls after a workflow starts. */
function fakeDeps(initial: Record<string, string>, options: { indexAfterPolls?: number; canSpend?: boolean } = {}) {
  const ledger = new Map<string, PageState>(Object.entries(initial).map(([key, state]) => [key, { state, costCredits: 0 }]));
  const started: Array<{ input: Parameters<Deps["startWorkflow"]>[0]; workflowId: string }> = [];
  let clock = 0;
  let runCount = 0;
  const pending = new Map<string, number>();
  const deps: Deps = {
    loadPageStates: vi.fn(async (pairs) => {
      const out = new Map<string, PageState>();
      for (const p of pairs) {
        const key = `${p.documentId}:${p.page}`;
        const state = ledger.get(key);
        if (state) out.set(key, state);
      }
      return out;
    }),
    canSpend: vi.fn(async () => options.canSpend ?? true),
    createRun: vi.fn(async () => `run-${++runCount}`),
    closeDedupedRun: vi.fn(async () => undefined),
    failRun: vi.fn(async () => undefined),
    startWorkflow: vi.fn(async (input, workflowId): Promise<"started" | "already-running"> => {
      started.push({ input, workflowId });
      for (const page of input.pages) pending.set(`${input.documentId}:${page}`, options.indexAfterPolls ?? 1);
      return "started";
    }),
    now: () => clock,
    sleep: vi.fn(async (ms) => {
      clock += ms;
      for (const [key, left] of [...pending]) {
        if (left <= 1) {
          ledger.set(key, { state: "indexed", costCredits: 0.5 });
          pending.delete(key);
        } else pending.set(key, left - 1);
      }
    }),
  };
  return { deps, started, ledger };
}

const base = { orgId: "org-1", userId: "user-1", workspaceId: "ws-1", sessionId: "s-1", policy };

beforeEach(() => {
  sqlMock.mockClear();
  chatWorkspace.mockReset();
});

describe("materializeForQuery", () => {
  it("is hot when every candidate page is indexed and starts no workflow", async () => {
    const { deps, started } = fakeDeps({ "d1:1": "indexed", "d1:2": "indexed" });
    const stats = await materializeForQuery({ ...base, candidates: [{ documentId: "d1", page: 1 }, { documentId: "d1", page: 2 }] }, deps);
    expect(stats).toMatchObject({ temperature: "hot", candidatePages: 2, indexedCandidatePages: 2, pendingPages: 0, stoppedBy: null });
    expect(started).toHaveLength(0);
    expect(deps.canSpend).not.toHaveBeenCalled();
    expect(deps.createRun).not.toHaveBeenCalled();
    expect(deps.loadPageStates).toHaveBeenCalledTimes(1);
  });

  it("materializes cold pages with one workflow per document, then reports ready", async () => {
    const { deps, started } = fakeDeps({}, { indexAfterPolls: 2 });
    const events: Array<[string, string, number[]]> = [];
    const stats = await materializeForQuery({
      ...base,
      candidates: [{ documentId: "d1", page: 3 }, { documentId: "d1", page: 2 }, { documentId: "d2", page: 9 }],
      onEvent: (e) => events.push([e.type, e.documentId, e.pages]),
    }, deps);
    expect(started.map((s) => s.input.documentId).sort()).toEqual(["d1", "d2"]);
    expect(started.find((s) => s.input.documentId === "d1")).toMatchObject({
      input: { pages: [2, 3], reason: "query", sessionId: "s-1" },
    });
    // The per-query credit cap is split pro-rata by page count: the documents together stay under it.
    expect(started.reduce((sum, s) => sum + s.input.maxCredits, 0)).toBeLessThanOrEqual(25 + 1e-9);
    expect(started.find((s) => s.input.documentId === "d1")!.input.maxCredits).toBeCloseTo((25 * 2) / 3);
    expect(new Set(started.map((s) => s.input.runId)).size).toBe(2);
    expect(started[0]!.workflowId).toMatch(/^materialize:d\d:/);
    expect(stats).toMatchObject({ temperature: "cold", materializedPages: 3, pendingPages: 0, stoppedBy: null, indexedCandidatePages: 0 });
    expect(stats.creditsSpent).toBeCloseTo(1.5);
    const order = events.map((e) => e[0]);
    expect(order.indexOf("page-materializing")).toBeLessThan(order.indexOf("page-ready"));
    expect(events.filter((e) => e[0] === "page-ready").flatMap((e) => e[2]).sort()).toEqual([2, 3, 9]);
  });

  it("excludes blocked-pii pages from classification", async () => {
    const { deps, started } = fakeDeps({ "d1:1": "indexed", "d1:2": "blocked-pii" });
    const stats = await materializeForQuery({ ...base, candidates: [{ documentId: "d1", page: 1 }, { documentId: "d1", page: 2 }] }, deps);
    expect(stats).toMatchObject({ temperature: "hot", candidatePages: 1 });
    expect(started).toHaveLength(0);
  });

  it("a failed workflow start fails its run, counts as pending and reports policy", async () => {
    const { deps } = fakeDeps({});
    vi.mocked(deps.startWorkflow).mockRejectedValueOnce(new Error("temporal down"));
    const diagnostics: string[] = [];
    const stats = await materializeForQuery({
      ...base, candidates: [{ documentId: "d1", page: 1 }, { documentId: "d1", page: 2 }],
      recordDiagnostic: (key) => diagnostics.push(key),
    }, deps);
    expect(deps.failRun).toHaveBeenCalledWith("run-1", "temporal down");
    expect(stats).toMatchObject({ pendingPages: 2, stoppedBy: "policy" });
    expect(diagnostics).toEqual(["deferredStartFailure"]);
  });

  it("stops polling when the client aborts", async () => {
    const { deps } = fakeDeps({}, { indexAfterPolls: 99 });
    const controller = new AbortController();
    vi.mocked(deps.sleep).mockImplementation(async () => { controller.abort(); });
    const stats = await materializeForQuery({ ...base, candidates: [{ documentId: "d1", page: 1 }], signal: controller.signal }, deps);
    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(stats.pendingPages).toBe(1);
  });

  it("estimates a materialized page at the Rich page price unless overridden", () => {
    expect(estimatedPageMaterializeCredits({ DOCSLURP_EST_PAGE_MATERIALIZE_CREDITS: "0.5" })).toBeCloseTo(0.5);
    expect(estimatedPageMaterializeCredits({})).toBeCloseTo(0.25);
  });

  it("is warm when some pages are indexed and only materializes the rest", async () => {
    const { deps, started } = fakeDeps({ "d1:1": "indexed" });
    const stats = await materializeForQuery({ ...base, candidates: [{ documentId: "d1", page: 1 }, { documentId: "d1", page: 2 }] }, deps);
    expect(stats.temperature).toBe("warm");
    expect(started[0]!.input.pages).toEqual([2]);
  });

  it("out of credits: no workflow, stoppedBy credits, never throws", async () => {
    const { deps, started } = fakeDeps({}, { canSpend: false });
    const stats = await materializeForQuery({ ...base, candidates: [{ documentId: "d1", page: 1 }] }, deps);
    expect(stats).toMatchObject({ stoppedBy: "credits", pendingPages: 1, materializedPages: 0 });
    expect(started).toHaveLength(0);
  });

  it("trims to the per-query credit cap and reports stoppedBy credits", async () => {
    const { deps, started } = fakeDeps({}, { indexAfterPolls: 1 });
    const per = estimatedPageMaterializeCredits();
    const stats = await materializeForQuery({
      ...base,
      policy: { ...policy, maxCreditsPerQuery: per * 2 },
      candidates: [1, 2, 3, 4].map((page) => ({ documentId: "d1", page })),
    }, deps);
    expect(started[0]!.input.pages).toEqual([1, 2]);
    expect(stats).toMatchObject({ stoppedBy: "credits", materializedPages: 2, pendingPages: 2 });
  });

  it("trims to maxPagesPerQuery and reports stoppedBy policy", async () => {
    const { deps, started } = fakeDeps({});
    const stats = await materializeForQuery({
      ...base, policy: { ...policy, maxPagesPerQuery: 1 },
      candidates: [1, 2, 3].map((page) => ({ documentId: "d1", page })),
    }, deps);
    expect(started[0]!.input.pages).toEqual([1]);
    expect(stats.stoppedBy).toBe("policy");
    expect(stats.pendingPages).toBe(2);
  });

  it("deadline 0 returns immediately with pending pages and stoppedBy deadline", async () => {
    const { deps, started } = fakeDeps({});
    const stats = await materializeForQuery({
      ...base, policy: { ...policy, deadlineMs: 0 },
      candidates: [{ documentId: "d1", page: 1 }, { documentId: "d1", page: 2 }],
    }, deps);
    expect(started).toHaveLength(1);
    expect(stats).toMatchObject({ stoppedBy: "deadline", pendingPages: 2, materializedPages: 0 });
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("treats an already-running workflow as success and closes the duplicate run", async () => {
    const { deps } = fakeDeps({});
    vi.mocked(deps.startWorkflow).mockResolvedValueOnce("already-running");
    await materializeForQuery({ ...base, policy: { ...policy, deadlineMs: 0 }, candidates: [{ documentId: "d1", page: 1 }] }, deps);
    expect(deps.closeDedupedRun).toHaveBeenCalledWith("run-1");
  });

  it("emits materialize-failed when a page fails", async () => {
    const { deps, ledger } = fakeDeps({});
    vi.mocked(deps.sleep).mockImplementation(async () => { ledger.set("d1:1", { state: "failed", costCredits: 0 }); });
    const events: string[] = [];
    const stats = await materializeForQuery({ ...base, candidates: [{ documentId: "d1", page: 1 }], onEvent: (e) => events.push(e.type) }, deps);
    expect(events).toEqual(["page-materializing", "materialize-failed"]);
    expect(stats.pendingPages).toBe(0);
  });

  it("a warm search adds under 25 ms with fakes", async () => {
    const candidates = Array.from({ length: 40 }, (_, i) => ({ documentId: `d${i % 4}`, page: i + 1 }));
    const { deps } = fakeDeps(Object.fromEntries(candidates.map((c) => [`${c.documentId}:${c.page}`, "indexed"])));
    const started = performance.now();
    for (let i = 0; i < 20; i++) await materializeForQuery({ ...base, candidates }, deps);
    expect((performance.now() - started) / 20).toBeLessThan(25);
  });
});

describe("runDeferredPageSearch", () => {
  const journal = () => ({
    sessionId: "s-1",
    record: vi.fn(),
    recordDiagnostic: vi.fn(),
  }) as never;
  const chunk = (id: string, documentId: string, page: number) => ({
    id, documentId, runId: "r", chunkIndex: 0, text: id, headingPath: [], pageNumber: page, pageNumbers: [page],
    tokenEstimate: 1, score: 1, filename: "f.pdf", blockIds: [], blockTypes: [], evidenceType: null,
    canonicalDocumentUri: null, tableGranularity: null, tableRowIndex: null, tableRowCount: null,
    tableColumnNames: [], tableColumnTypes: [], tableCells: [], tableCell: null, regionBoxes: [], regions: [],
    regionCoordinateSpace: null, sourceTrace: null, source: "document", retrievalStage: "full-index",
  }) as never;
  const searchArgs = (j: ReturnType<typeof journal>, extra: object = {}) => ({
    query: "warranty", textQuery: "warranty", queryVector: null, userId: "u", orgId: "o", workspaceId: "ws-1",
    options: { limit: 20 }, policy, privacyMode: "standard" as const, journal: j,
    search: { textSearch: vi.fn(async () => [chunk("c1", "d1", 21), chunk("c2", "d1", 50)]), vectorSearch: vi.fn(async () => []) },
    ...extra,
  });
  const deps = (over: object = {}) => ({
    listDeferredDocuments: vi.fn(async () => [{ id: "d1", mode: "map", pageCount: 100, indexedPages: 10 }]),
    now: () => 1_000,
    locateMap: vi.fn(async () => ({ pages: [{ documentId: "d1", page: 21, nodeTitle: "Warranty" }], routerUsed: true, confident: true })),
    listModels: vi.fn(async () => []),
    embed: vi.fn(async () => null),
    locateImages: vi.fn(async () => []),
    materialize: vi.fn(async () => ({
      temperature: "cold", candidatePages: 1, indexedCandidatePages: 0, materializedPages: 1, pendingPages: 0,
      materializeMs: 5, creditsSpent: 0.5, routerUsed: false, fallbackUsed: false, stoppedBy: null,
    })),
    canSpend: vi.fn(async () => true),
    invalidateVectors: vi.fn(),
    ...over,
  }) as never;

  it("returns null with no deferred documents in scope", async () => {
    const d = deps({ listDeferredDocuments: vi.fn(async () => []) });
    expect(await runDeferredPageSearch(searchArgs(journal()), d)).toBeNull();
  });

  it("ranks locator pages first, labels their stage, and persists stats as diagnostics", async () => {
    const j = journal();
    const result = await runDeferredPageSearch(searchArgs(j), deps());
    expect(result!.chunks.map((c) => [c.id, c.deferredLocator])).toEqual([["c1", "map-node"], ["c2", undefined]]);
    expect(result!.stats).toMatchObject({ routerUsed: true, fallbackUsed: false, temperature: "cold" });
    expect((j as { recordDiagnostic: ReturnType<typeof vi.fn> }).recordDiagnostic).toHaveBeenCalledWith("deferred", expect.objectContaining({ temperature: "cold" }));
  });

  it("hot: skips the restricted searches entirely", async () => {
    const args = searchArgs(journal());
    const d = deps({ materialize: vi.fn(async () => ({
      temperature: "hot", candidatePages: 1, indexedCandidatePages: 1, materializedPages: 0, pendingPages: 0,
      materializeMs: 0, creditsSpent: 0, routerUsed: false, fallbackUsed: false, stoppedBy: null })) });
    const result = await runDeferredPageSearch(args, d);
    expect(result!.chunks).toEqual([]);
    expect(args.search.textSearch).not.toHaveBeenCalled();
  });

  it("falls back (fallbackUsed) and records degraded when the page embedder returns null", async () => {
    const j = journal();
    const d = deps({
      listDeferredDocuments: vi.fn(async () => [{ id: "d1", mode: "visual", pageCount: 100, indexedPages: 10 }]),
      listModels: vi.fn(async () => ["llm://private/x/jina-embeddings-v5-omni-nano"]),
    });
    const result = await runDeferredPageSearch(searchArgs(j), d);
    expect(result!.stats.fallbackUsed).toBe(true);
    expect((j as { recordDiagnostic: ReturnType<typeof vi.fn> }).recordDiagnostic).toHaveBeenCalledWith("deferredDegraded", { degraded: true });
  });

  it("no embedding call when the org cannot spend: degraded", async () => {
    const j = journal();
    const embed = vi.fn(async () => new Float32Array(4));
    const d = deps({
      listDeferredDocuments: vi.fn(async () => [{ id: "d1", mode: "visual", pageCount: 100, indexedPages: 10 }]),
      listModels: vi.fn(async () => ["m"]),
      canSpend: vi.fn(async () => false),
      embed,
    });
    await runDeferredPageSearch(searchArgs(j), d);
    expect(embed).not.toHaveBeenCalled();
    expect((j as { recordDiagnostic: ReturnType<typeof vi.fn> }).recordDiagnostic).toHaveBeenCalledWith("deferredDegraded", { degraded: true });
  });

  it.each(["off", "always"] as const)("hot (router %s): one listing query, no locators, router, embedding or spend check", async (mapRouter) => {
    const d = deps({ listDeferredDocuments: vi.fn(async () => [{ id: "d1", mode: "map", pageCount: 50, indexedPages: 50 }]) }) as never as Record<string, ReturnType<typeof vi.fn>>;
    const args = searchArgs(journal(), { policy: { ...policy, mapRouter } });
    const result = await runDeferredPageSearch(args, d as never);
    expect(result).toMatchObject({ chunks: [], documentIds: ["d1"], stats: { temperature: "hot", stoppedBy: null } });
    for (const name of ["locateMap", "listModels", "embed", "locateImages", "materialize", "canSpend"]) expect(d[name]).not.toHaveBeenCalled();
    expect(d.listDeferredDocuments).toHaveBeenCalledTimes(1);
  });

  it("hot search adds under 25 ms (fakes for I/O)", async () => {
    const d = deps({ listDeferredDocuments: vi.fn(async () => [{ id: "d1", mode: "map", pageCount: 50, indexedPages: 50 }]) });
    const j = journal();
    const started = performance.now();
    for (let i = 0; i < 50; i++) await runDeferredPageSearch(searchArgs(j, { policy: { ...policy, mapRouter: "always" } }), d);
    expect((performance.now() - started) / 50).toBeLessThan(25);
  });

  it("a policy that allows no pages returns indexed results with stoppedBy policy and does no work", async () => {
    const d = deps() as never as Record<string, ReturnType<typeof vi.fn>>;
    const result = await runDeferredPageSearch(searchArgs(journal(), { policy: { ...policy, maxPagesPerQuery: 0 } }), d as never);
    expect(result!.stats.stoppedBy).toBe("policy");
    expect(d.locateMap).not.toHaveBeenCalled();
    expect(d.materialize).not.toHaveBeenCalled();
  });

  it("degrades to null (standard retrieval) when the locator throws", async () => {
    const result = await runDeferredPageSearch(searchArgs(journal()), deps({ locateMap: vi.fn(async () => { throw new Error("boom"); }) }));
    expect(result).toBeNull();
  });

  it("resolves the policy lazily: not for full scopes or hot scopes, once for a cold one (M3)", async () => {
    const resolver = vi.fn(async () => policy);
    const none = deps({ listDeferredDocuments: vi.fn(async () => []) });
    await runDeferredPageSearch(searchArgs(journal(), { policy: resolver }), none);
    const hot = deps({ listDeferredDocuments: vi.fn(async () => [{ id: "d1", mode: "map", pageCount: 5, indexedPages: 5 }]) });
    await runDeferredPageSearch(searchArgs(journal(), { policy: resolver }), hot);
    expect(resolver).not.toHaveBeenCalled();
    await runDeferredPageSearch(searchArgs(journal(), { policy: resolver }), deps());
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it.each([[10, 100, "warm"], [0, 100, "cold"]] as const)("a fail-closed policy classifies temperature from the ledger (%s/%s pages -> %s) (M9)", async (indexed, total, expected) => {
    const d = deps({ listDeferredDocuments: vi.fn(async () => [{ id: "d1", mode: "map", pageCount: total, indexedPages: indexed }]) });
    const result = await runDeferredPageSearch(searchArgs(journal(), { policy: { ...policy, maxPagesPerQuery: 0 } }), d);
    expect(result!.stats).toMatchObject({ temperature: expected, stoppedBy: "policy" });
  });

  it("with an exhausted budget still returns restricted results alongside stoppedBy", async () => {
    const d = deps({ materialize: vi.fn(async () => ({
      temperature: "warm", candidatePages: 2, indexedCandidatePages: 1, materializedPages: 0, pendingPages: 1,
      materializeMs: 1, creditsSpent: 0, routerUsed: false, fallbackUsed: false, stoppedBy: "credits" })) });
    const result = await runDeferredPageSearch(searchArgs(journal()), d);
    expect(result!.stats.stoppedBy).toBe("credits");
    expect(result!.chunks.length).toBe(2);
  });
});

describe("request policy for context-less routes", () => {
  it("applies the request's client key policy, never the server defaults", async () => {
    const { resolveSearchMaterializationPolicy } = await import("../search/deferred/request-policy.js");
    const { resolveMaterializationPolicy } = await import("../services/materialization-policy.js");
    const pipeline = { materialization: undefined } as never;
    const policy = await resolveSearchMaterializationPolicy(
      { workspacePipeline: pipeline, workspaceId: "ws-1" },
      {
        keyId: () => "key-1",
        lookupKey: vi.fn(async () => ({ keyType: "client" as const, scopes: ["search"], workspaceIds: [], materializationPolicy: { maxPagesPerQuery: 5 } })),
        resolve: resolveMaterializationPolicy,
      },
    );
    expect(policy.maxPagesPerQuery).toBe(5);
    expect(policy.allowFullIndexRequest).toBe(false);
  });

  it("narrows context-less routes by the request's capability token and fails closed on a bad one (M5)", async () => {
    process.env.SECRETS_ENCRYPTION_KEY = "a".repeat(64);
    const { resolveSearchMaterializationPolicy, resetRequestPolicyCacheForTests, FAIL_CLOSED_POLICY } = await import("../search/deferred/request-policy.js");
    const { resolveMaterializationPolicy } = await import("../services/materialization-policy.js");
    const { sealCapabilityToken, resetCapabilityKeyForTests } = await import("../lib/capability-tokens.js");
    resetCapabilityKeyForTests();
    resetRequestPolicyCacheForTests();
    // Session-issued capability: no issuer key lookup is needed.
    const token = sealCapabilityToken({
      v: 1, orgId: "org-1", workspaceIds: ["ws-1"], policy: { maxPagesPerQuery: 3 }, issuedByKeyId: "session:s1",
      exp: Math.floor(Date.now() / 1000) + 600, jti: "j", allowedOrigins: ["https://a.com"],
    } as never);
    const call = (header: string | null, origin: string | null) => resolveSearchMaterializationPolicy(
      { workspacePipeline: {} as never, workspaceId: "ws-1" },
      { keyId: () => null, capability: () => ({ header, origin }), lookupKey: vi.fn(), resolve: resolveMaterializationPolicy },
    );
    expect((await call(token, "https://a.com")).maxPagesPerQuery).toBe(3);
    expect(await call(token, "https://evil.com")).toBe(FAIL_CLOSED_POLICY);
    expect((await call(null, null)).maxPagesPerQuery).toBe(40);
  });

  it("caches the request key lookup for a minute (M3)", async () => {
    const { resolveSearchMaterializationPolicy, resetRequestPolicyCacheForTests } = await import("../search/deferred/request-policy.js");
    const { resolveMaterializationPolicy } = await import("../services/materialization-policy.js");
    resetRequestPolicyCacheForTests();
    const lookupKey = vi.fn(async () => ({ keyType: "client" as const, scopes: ["search"], workspaceIds: [], materializationPolicy: {} }));
    const callDeps = { keyId: () => "key-cache", lookupKey, resolve: resolveMaterializationPolicy };
    for (let i = 0; i < 3; i++) await resolveSearchMaterializationPolicy({ workspacePipeline: {} as never, workspaceId: "ws-1" }, callDeps as never);
    expect(lookupKey).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the request's key cannot be resolved", async () => {
    const { resolveSearchMaterializationPolicy, FAIL_CLOSED_POLICY } = await import("../search/deferred/request-policy.js");
    const policy = await resolveSearchMaterializationPolicy(
      { workspacePipeline: {} as never, workspaceId: "ws-1" },
      { keyId: () => "revoked", lookupKey: vi.fn(async () => null), resolve: vi.fn() },
    );
    expect(policy).toBe(FAIL_CLOSED_POLICY);
    expect(policy.maxPagesPerQuery).toBe(0);
  });

  it("session requests (no key) keep the server defaults", async () => {
    const { resolveSearchMaterializationPolicy } = await import("../search/deferred/request-policy.js");
    const { resolveMaterializationPolicy } = await import("../services/materialization-policy.js");
    const policy = await resolveSearchMaterializationPolicy(
      { workspacePipeline: {} as never, workspaceId: "ws-1" },
      { keyId: () => null, lookupKey: vi.fn(), resolve: resolveMaterializationPolicy },
    );
    expect(policy.maxPagesPerQuery).toBe(40);
  });
});

describe("session metadata", () => {
  it("persists deferred stats from diagnostics", () => {
    const stats = { temperature: "warm", pendingPages: 2 };
    const metadata = buildSearchSessionMetadata({
      originalQuery: "q", effectiveQuery: "q", filters: {}, options: {}, workspaceId: "ws-1", selfQueryReasons: [],
      diagnostics: { deferred: stats },
    } as never);
    expect(metadata.deferred).toEqual(stats);
    expect(buildSearchSessionMetadata({ originalQuery: "q", filters: {}, options: {}, workspaceId: "ws-1" } as never).deferred).toBeNull();
  });
});

describe("out-of-credit search over HTTP", () => {
  it("answers 200 with deferred.stoppedBy credits and the indexed results", async () => {
    const { hybridSearch } = await import("../services/search.js");
    vi.mocked(hybridSearch).mockResolvedValueOnce({
      results: [{ text: "indexed hit", score: 1, citation: { documentId: "d9", filename: "f.pdf", chunkIndex: 0, source: "document", headingPath: [] } }],
      sessionId: "s-9",
      availability: { status: "complete" },
      deferred: { temperature: "cold", candidatePages: 3, indexedCandidatePages: 0, materializedPages: 0, pendingPages: 3,
        materializeMs: 2, creditsSpent: 0, routerUsed: false, fallbackUsed: false, stoppedBy: "credits" },
    } as never);
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("sessionUser", { id: "u", email: "", name: "" }); await next(); });
    app.route("/search", searchRoutes);
    const response = await app.request("/search", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "warranty", workspaceId: "ws-1" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deferred.stoppedBy).toBe("credits");
    expect(body.results).toHaveLength(1);
  });
});

describe("GET /chat/stream deferred events", () => {
  function buildApp() {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("sessionUser", { id: "user-1", email: "u@example.com", name: "U" });
      await next();
    });
    app.route("/search", searchRoutes);
    return app;
  }

  it("emits page-materializing and page-ready before message", async () => {
    chatWorkspace.mockImplementation(async () => {
      const sink = getDeferredContext()?.onEvent;
      sink?.({ type: "page-materializing", documentId: "d1", pages: [4, 5] });
      await new Promise((resolve) => setTimeout(resolve, 5));
      sink?.({ type: "page-ready", documentId: "d1", pages: [4, 5] });
      return { id: "m1", sessionId: "chat-1", searchSessionId: "s-1", answer: "ok" };
    });
    const response = await buildApp().request("/search/chat/stream?q=hello&workspaceId=ws-1");
    expect(response.status).toBe(200);
    const text = await response.text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events).toEqual(["status", "page-materializing", "page-ready", "message", "done"]);
    expect(text).toContain('"pages":[4,5]');
  });
});

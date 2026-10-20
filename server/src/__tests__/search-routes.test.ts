import { Hono } from "hono";
import { InvalidRetrievalQueryError } from "../lib/retrieval-query-flags.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hybridSearch = vi.fn();
const chatWorkspace = vi.fn();
const workspaceChatDisabledBody = vi.fn(async (_workspaceId: string, _userId: string): Promise<{ error: string; code: "chat_disabled" } | null> => null);
const aggregateWorkspaceRagSearch = vi.fn();
const sqlMock = vi.fn();

vi.mock("../db.js", () => ({
  sql: sqlMock,
}));

vi.mock("../services/search.js", () => ({
  hybridSearch,
  MissingWorkspaceScopeError: class extends Error {},
}));

vi.mock("../services/workspace-chat.js", () => ({
  chatWorkspace,
  workspaceChatDisabledBody,
}));

vi.mock("../services/aggregate-rag.js", () => ({
  aggregateWorkspaceRagSearch,
}));

const getWorkspace = vi.fn();
const ensureDefaultWorkspace = vi.fn(async () => ({ id: "ws-default" }));
vi.mock("../services/workspaces.js", () => ({ resolveWorkspaceRef: vi.fn(async () => null),
  ensureDefaultWorkspace,
  getWorkspace,
}));

const { searchRoutes, clearSearchResponseCacheForTests } = await import("../routes/search.js");
const { publicErrorMiddleware } = await import("../lib/public-errors.js");
const { apiErrorEnvelopeSchema, PUBLIC_ERROR_MESSAGES } = await import("@docslurp/shared");

function buildApp(actor?: import("../lib/request-actor.js").RequestActor) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (actor) c.set("requestActor", actor);
    c.set("sessionUser", {
      id: "user-1",
      email: "user-1@example.com",
      name: "User One",
    });
    await next();
  });
  app.route("/search", searchRoutes);
  return app;
}

describe("searchRoutes", () => {
  let app: Hono;

  beforeEach(() => {
    app = buildApp();
    hybridSearch.mockReset();
    chatWorkspace.mockReset();
    aggregateWorkspaceRagSearch.mockReset();
    sqlMock.mockReset();
  });

  it("passes workspaceId through as a search filter on GET /search", async () => {
    hybridSearch.mockResolvedValueOnce({
      results: [],
      sessionId: "session-1",
      availability: {
        status: "partial",
        isPartial: true,
        scope: {
          workspaceId: "ws-1",
          runId: null
        },
        coverage: {
          totalDocuments: 2,
          indexedDocuments: 1,
          pageIndexedDocuments: 2,
          searchableDocuments: 2,
          pageOnlyDocuments: 1,
          inProgressDocuments: 1,
          totalPages: 8,
          searchablePages: 4,
          indexedChunkCount: 3,
          queuedRuns: 0,
          processingRuns: 1
        },
        resultBreakdown: {
          indexedResultCount: 0,
          pageResultCount: 0
        },
        message: "Search includes 2/2 searchable documents while 1 documents are still processing."
      }
    });

    const response = await app.request("/search?q=test&workspaceId=ws-1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      results: [],
      sessionId: "session-1",
      availability: {
        status: "partial",
        isPartial: true
      }
    });
    expect(hybridSearch).toHaveBeenCalledWith(
      "test",
      "user-1",
      expect.objectContaining({
        filters: expect.objectContaining({
          workspaceId: "ws-1",
        }),
      })
    );
  });

  it("rejects an invalid minScore on GET /search with 400, like POST", async () => {
    hybridSearch.mockClear();
    for (const bad of ["abc", "7", "-1"]) {
      const response = await app.request(`/search?q=test&workspaceId=ws-1&minScore=${bad}`);
      expect(response.status, bad).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request", message: expect.stringContaining("minScore") } });
    }
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it("searches the default workspace when GET /search omits workspaceId", async () => {
    hybridSearch.mockResolvedValueOnce({ results: [], sessionId: "session-default" });
    const response = await app.request("/search?q=test");

    expect(response.status).toBe(200);
    expect(ensureDefaultWorkspace).toHaveBeenCalledWith({ userId: "user-1", orgId: undefined });
    expect(hybridSearch).toHaveBeenCalledWith("test", "user-1", expect.objectContaining({
      filters: expect.objectContaining({ workspaceId: "ws-default" }),
    }));
  });

  it("passes workspaceId through as a search filter on POST /search", async () => {
    hybridSearch.mockResolvedValueOnce({
      results: [],
      sessionId: "session-2",
      availability: {
        status: "complete",
        isPartial: false,
        scope: {
          workspaceId: "ws-2",
          runId: null
        },
        coverage: {
          totalDocuments: 1,
          indexedDocuments: 1,
          pageIndexedDocuments: 1,
          searchableDocuments: 1,
          pageOnlyDocuments: 0,
          inProgressDocuments: 0,
          totalPages: 3,
          searchablePages: 3,
          indexedChunkCount: 7,
          queuedRuns: 0,
          processingRuns: 0
        },
        resultBreakdown: {
          indexedResultCount: 0,
          pageResultCount: 0
        },
        message: null
      }
    });

    const response = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: "test",
        workspaceId: "ws-2",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      results: [],
      sessionId: "session-2",
      availability: {
        status: "complete",
        isPartial: false
      }
    });
    expect(hybridSearch).toHaveBeenCalledWith(
      "test",
      "user-1",
      expect.objectContaining({
        filters: expect.objectContaining({
          workspaceId: "ws-2",
        }),
      })
    );
  });

  it("reuses a complete answer for an identical POST /search, reporting no new usage", async () => {
    process.env.SEARCH_RESPONSE_CACHE_TTL_MS = "30000";
    clearSearchResponseCacheForTests();
    try {
      hybridSearch.mockResolvedValue({
        results: [{ id: "c1" }], sessionId: "s",
        availability: { status: "complete", isPartial: false },
        usageEvents: [{ inputTokens: 6, outputTokens: 0, costCents: 0.01, metadata: { costSource: "provider" } }],
      });
      const search = async (q: string, workspaceId = "ws-2"): Promise<any> =>
        (await app.request("/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q, workspaceId }) })).json();
      const first = await search("rate limits");
      const second = await search("  rate   limits ");
      expect(hybridSearch).toHaveBeenCalledTimes(1);
      expect(first.usage.inputTokens).toBe(6);
      expect(second.results).toEqual(first.results);
      expect(second.usage).toMatchObject({ inputTokens: 0, costCents: 0 });
      expect(second.timings).toEqual({ cachedMs: 0, totalMs: 0 });
      await search("rate limits", "ws-3");
      expect(hybridSearch).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.SEARCH_RESPONSE_CACHE_TTL_MS;
      clearSearchResponseCacheForTests();
      hybridSearch.mockReset();
    }
  });

  it("searches the default workspace when POST /search omits workspaceId", async () => {
    hybridSearch.mockResolvedValueOnce({ results: [], sessionId: "session-default" });
    const response = await app.request("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: "test",
      }),
    });

    expect(response.status).toBe(200);
    expect(hybridSearch).toHaveBeenCalledWith("test", "user-1", expect.objectContaining({
      filters: expect.objectContaining({ workspaceId: "ws-default" }),
    }));
  });

  it("runs aggregate RAG search without requiring a single workspace scope", async () => {
    aggregateWorkspaceRagSearch.mockResolvedValueOnce({
      query: "who is this for?",
      answer: "The docs are for implementation teams [1].",
      citations: [],
      evidenceSpans: [],
      workspaces: [
        {
          workspaceId: "ws-1",
          workspaceName: "Product Manuals",
          sessionId: "search-1",
          availability: null,
          results: [],
          error: null,
        },
      ],
      warnings: [],
      partial: false,
      usage: {
        inputTokens: 4,
        outputTokens: 8,
        totalTokens: 12,
      },
    });

    const response = await app.request("/search/aggregate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: "who is this for?",
        maxWorkspaces: 4,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      query: "who is this for?",
      answer: "The docs are for implementation teams [1].",
      workspaces: [
        {
          workspaceId: "ws-1",
        },
      ],
    });
    expect(aggregateWorkspaceRagSearch).toHaveBeenCalledWith({
      userId: "user-1",
      request: expect.objectContaining({
        q: "who is this for?",
        maxWorkspaces: 4,
      }),
      apiKey: null,
    });
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it("forwards a verified API actor and preserves scope and workspace denials", async () => {
    const actor = { type: "apiKey" as const, userId: "user-1", apiKey: { keyId: "key", userId: "user-1", orgId: "org", keyType: "server" as const, allowedDomains: [], scopes: ["search"], rateLimitRpm: 60, rateLimitPpd: 1000, rateLimits: [], workspaceIds: ["ws-chat"] } };
    getWorkspace.mockResolvedValue({ id: "ws-chat", orgId: "org" });
    chatWorkspace.mockResolvedValue({ answer: "Supported" });
    const request = () => buildApp(actor).request("/search/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: "Question", workspaceId: "ws-chat" }) });
    expect((await request()).status).toBe(200);
    expect(chatWorkspace).toHaveBeenCalledWith(expect.objectContaining({ actor, allowAgentTools: true }));
    chatWorkspace.mockClear();
    actor.apiKey.scopes = ["ingest"];
    expect((await request()).status).toBe(403);
    expect(chatWorkspace).not.toHaveBeenCalled();
    actor.apiKey.scopes = ["search"];
    actor.apiKey.workspaceIds = ["other"];
    expect((await request()).status).toBe(404);
    expect(chatWorkspace).not.toHaveBeenCalled();
  });

  it("keeps public chat on grounded retrieval when DOCSLURP_PUBLIC_CHAT_AGENT_ENABLED is off", async () => {
    const { env } = await import("../config.js");
    const previous = env.publicChatAgentEnabled;
    env.publicChatAgentEnabled = false;
    try {
      chatWorkspace.mockResolvedValueOnce({ answer: "Supported" });
      const response = await buildApp().request("/search/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: "Question", workspaceId: "ws-chat" }) });
      expect(response.status).toBe(200);
      expect(chatWorkspace).toHaveBeenCalledWith(expect.objectContaining({ allowAgentTools: false }));
      expect(chatWorkspace.mock.calls.at(-1)?.[0]).not.toHaveProperty("allowConfiguration");
    } finally {
      env.publicChatAgentEnabled = previous;
    }
  });

  it("rejects public attempts to set the internal agent permission", async () => {
    const response = await app.request("/search/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: "Question", workspaceId: "ws-chat", allowAgentTools: true }) });
    expect(response.status).toBe(400);
    expect(chatWorkspace).not.toHaveBeenCalled();
  });

  it("requires workspaceId for chat POST and forwards it to workspace chat", async () => {
    chatWorkspace.mockResolvedValueOnce({
      id: "resp-1",
      sessionId: "chat-1",
      searchSessionId: "search-1",
      answer: "answer",
      citations: [],
      debug: {
        citations: 0,
        model: null,
        fallback: false,
        historyTurns: 0,
        mode: "retrieval",
        wholeCorpus: {
          attempted: false,
          eligible: false,
          documentCount: null,
          chunkCount: null,
          tokenEstimate: null,
          charEstimate: null,
          maxDocuments: 12,
          maxChunks: 24,
          maxTokens: 12000,
          maxChars: 60000,
          fallbackReason: null
        }
      },
    });

    const response = await app.request("/search/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: "test",
        workspaceId: "ws-chat",
      }),
    });

    expect(response.status).toBe(200);
    expect(chatWorkspace).toHaveBeenCalledWith({
      workspaceId: "ws-chat",
      userId: "user-1",
      query: "test",
      sessionId: undefined,
      model: undefined,
      actor: expect.objectContaining({ type: "session", userId: "user-1" }),
      allowAgentTools: true,
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects chat POST and chat stream with 403 when the workspace turned chat off", async () => {
    workspaceChatDisabledBody.mockResolvedValue({ error: "Chat is turned off for this workspace.", code: "chat_disabled" });
    try {
      const post = await app.request("/search/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: "test", workspaceId: "ws-chat" }),
      });
      expect(post.status).toBe(403);
      expect(await post.json()).toMatchObject({ error: { code: "chat_disabled", message: "Chat is turned off for this workspace." } });

      const stream = await app.request("/search/chat/stream?q=test&workspaceId=ws-chat");
      expect(stream.status).toBe(403);
      expect(await stream.json()).toMatchObject({ error: { code: "chat_disabled" } });
      expect(chatWorkspace).not.toHaveBeenCalled();
    } finally {
      workspaceChatDisabledBody.mockResolvedValue(null);
    }
  });

  describe("native error envelope", () => {
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    it("answers invalid search and chat bodies with invalid_request and validation issues in details", async () => {
      for (const [path, body] of [["/search", { q: "" }], ["/search", { queries: [] }], ["/search/chat", {}], ["/search/aggregate", {}]] as const) {
        const response = await post(path, body);
        expect(response.status, path).toBe(400);
        const json = await response.json();
        expect(json, path).toMatchObject({ error: { code: "invalid_request", message: expect.any(String), details: { issues: expect.any(Array) } } });
        expect(Object.keys(json), path).toEqual(["error"]);
      }
    });

    it("answers a missing q, an unparseable body and a missing feedback chunk with invalid_request", async () => {
      expect(await (await app.request("/search?workspaceId=ws-1")).json()).toMatchObject({ error: { code: "invalid_request" } });
      const unparseable = await app.request("/search/aggregate", { method: "POST", body: "{nope" });
      expect(unparseable.status).toBe(400);
      expect(await unparseable.json()).toMatchObject({ error: { code: "invalid_request" } });
      const feedback = await app.request("/search/session-1/feedback", { method: "POST", body: "{}" });
      expect(feedback.status).toBe(400);
      expect(await feedback.json()).toMatchObject({ error: { code: "invalid_request", message: "Missing clickedChunkId" } });
    });

    it("answers invalid retrieval syntax with 400 in single and batch search", async () => {
      hybridSearch.mockRejectedValueOnce(new InvalidRetrievalQueryError("Tag syntax needs search wording"));
      const single = await post("/search", { q: "tag:finance", workspaceId: "ws-1", selfQuery: true });
      expect(single.status).toBe(400);
      expect(await single.json()).toMatchObject({ error: { code: "invalid_request" } });

      hybridSearch.mockRejectedValueOnce(new InvalidRetrievalQueryError("Tag syntax needs search wording"));
      const batch = await post("/search", { queries: [{ q: "tag:finance", workspaceId: "ws-1", selfQuery: true }] });
      expect(batch.status).toBe(200);
      expect(await batch.json()).toMatchObject({ results: [{ ok: false, error: { status: 400, code: "INVALID_RETRIEVAL_QUERY" } }] });
    });

    it("keeps the envelope for thrown spend blocks and unexpected failures", async () => {
      hybridSearch.mockRejectedValueOnce(Object.assign(new Error("credits"), { statusCode: 402, code: "credit_exhausted" }));
      const blocked = await post("/search", { q: "test", workspaceId: "ws-1" });
      expect(blocked.status).toBe(402);
      expect(await blocked.json()).toMatchObject({ error: { code: "credit_exhausted" } });

      hybridSearch.mockRejectedValueOnce(new Error("postgres password=secret"));
      const failed = await post("/search", { q: "test", workspaceId: "ws-1" });
      expect(failed.status).toBe(500);
      const json = await failed.json();
      expect(json).toMatchObject({ error: { code: "internal" } });
      expect(JSON.stringify(json)).not.toMatch(/postgres|secret/);
    });

    it("stamps requestId and reviewed copy once behind the public error boundary", async () => {
      const guarded = new Hono();
      guarded.use("*", async (c, next) => { c.set("requestId", "req-env-1"); await next(); });
      guarded.use("*", publicErrorMiddleware);
      guarded.route("/", app);
      workspaceChatDisabledBody.mockResolvedValueOnce({ error: "internal wording", code: "chat_disabled" });
      const response = await guarded.request("/search/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: "test", workspaceId: "ws-chat" }) });
      expect(response.status).toBe(403);
      const json = await response.json();
      expect(apiErrorEnvelopeSchema.parse(json)).toEqual({ error: { code: "chat_disabled", message: PUBLIC_ERROR_MESSAGES.chatDisabled, requestId: "req-env-1" } });
    });
  });

  it("scopes search feedback updates to the signed-in user's session", async () => {
    sqlMock.mockResolvedValueOnce([]);

    const response = await app.request("/search/session-1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clickedChunkId: "chunk-1",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    expect(sqlMock).toHaveBeenCalledTimes(1);
    const [strings, sessionId, clickedChunkId, userId] = sqlMock.mock.calls[0]!;
    const queryText = Array.isArray(strings) ? strings.join(" ") : String(strings);
    expect(queryText).toContain("from search_sessions s");
    expect(queryText).toContain("s.user_id =");
    expect(sessionId).toBe("session-1");
    expect(clickedChunkId).toBe("chunk-1");
    expect(userId).toBe("user-1");
  });
});


describe("explicit ranking control transport", () => {
  it.each(["GET", "POST"])("forwards candidate depth and ordering on %s", async method => {
    const app = buildApp();
    hybridSearch.mockResolvedValue({ results: [], sessionId: "ranking-transport", usageEvents: [] });
    const fields = { q: "pump maintenance", candidateDepth: 50, resultOrder: "relevance", rerank: false };
    const response = method === "GET"
      ? await app.request("/search?" + new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])))
      : await app.request("/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fields) });
    expect(response.status).toBe(200);
    expect(hybridSearch).toHaveBeenLastCalledWith("pump maintenance", "user-1", expect.objectContaining({ candidateDepth: 50, resultOrder: "relevance", useRerank: false }));
  });
});

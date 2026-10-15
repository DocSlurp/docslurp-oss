import { Hono } from "hono";
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

const ensureDefaultWorkspace = vi.fn(async () => ({ id: "ws-default" }));
vi.mock("../services/workspaces.js", () => ({ resolveWorkspaceRef: vi.fn(async () => null),
  ensureDefaultWorkspace,
  getWorkspace: vi.fn(),
}));

const { searchRoutes, clearSearchResponseCacheForTests } = await import("../routes/search.js");

function buildApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
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
      expect(await post.json()).toMatchObject({ code: "chat_disabled" });

      const stream = await app.request("/search/chat/stream?q=test&workspaceId=ws-chat");
      expect(stream.status).toBe(403);
      expect(chatWorkspace).not.toHaveBeenCalled();
    } finally {
      workspaceChatDisabledBody.mockResolvedValue(null);
    }
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

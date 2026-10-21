import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ search: vi.fn(), chat: vi.fn(), access: vi.fn() }));
vi.mock("../services/search.js", () => ({ hybridSearch: mocks.search, MissingWorkspaceScopeError: class extends Error {} }));
vi.mock("../services/workspace-chat.js", () => ({ chatWorkspace: mocks.chat, workspaceChatDisabledBody: async () => null }));
vi.mock("../services/aggregate-rag.js", () => ({ aggregateWorkspaceRagSearch: vi.fn() }));
vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("../lib/request-actor.js", () => ({
  assertApiKeyWorkspaceAccess: mocks.access, getRequestActor: vi.fn(), actorHasAnyApiKeyScope: vi.fn(),
  resolveActorWorkspaceId: async (_actor: unknown, workspaceId?: string) => workspaceId ?? "default-workspace",
}));
const { searchRoutes, workspaceChatRoutes } = await import("../routes/search.js");
function app() {
  const server = new Hono();
  server.use("*", async (c, next) => { c.set("sessionUser", { id: "user", email: "", name: "" }); await next(); });
  server.route("/v1/search", searchRoutes);
  server.route("/v1/chat", workspaceChatRoutes);
  return server;
}
const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const queries = ["one", "two", "three", "four", "five"].map(q => ({ q, workspaceId: "workspace" }));
const response = (q: string) => ({ results: [{ text: q, citation: { page: 1 } }], sessionId: q, availability: { status: "complete" } });
describe("batch retrieval and canonical chat", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.access.mockResolvedValue(null); mocks.search.mockImplementation(async q => response(q)); });
  it.each([{ queries: [] }, { queries: Array(21).fill(queries[0]) }, { queries, concurrency: 0 }, { queries, concurrency: 9 },
    { queries: [queries[0], { q: 123, workspaceId: "workspace" }] }, { queries: [{ q: " ", workspaceId: "workspace" }] },
    { queries: [{ ...queries[0], limit: 101 }] }, { queries: [{ ...queries[0], tags: [] }] }])("validates the whole envelope before retrieval: %j", async body => {
    expect((await app().request("/v1/search", json(body))).status).toBe(400);
    expect(mocks.search).not.toHaveBeenCalled(); expect(mocks.access).not.toHaveBeenCalled();
  });
  it("no longer exposes a separate batch route", async () => {
    expect((await app().request("/v1/search/batch", json({ queries: [{ q: "one" }] }))).status).toBe(404);
  });
  it("rejects mixed single and batch inputs before retrieval", async () => {
    expect((await app().request("/v1/search", json({ q: "one", queries: [{ q: "two" }] }))).status).toBe(400);
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("returns recorded usage for GET, POST and every batch result", async () => {
    mocks.search.mockResolvedValue({ ...response('one'), usageEvents: [{
      inputTokens: 10, outputTokens: 2, costCents: 0.003,
      metadata: { costSource: 'estimate', prompt: 'private' },
    }] });
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12,
      costCents: 0.003, currency: 'USD', costSource: 'estimate', scope: 'retrieval' };
    for (const request of [
      app().request('/v1/search?q=one&workspaceId=workspace'),
      app().request('/v1/search', json(queries[0])),
    ]) {
      const result = await (await request).json();
      expect(result.usage).toEqual(usage);
      expect(result).not.toHaveProperty('usageEvents');
    }
    const batch = await (await app().request('/v1/search', json({ queries: queries.slice(0, 2) }))).json();
    expect(batch.results.map((item: any) => item.data.usage)).toEqual([usage, usage]);
  });
  it("rejects malformed JSON with 400", async () => {
    expect((await app().request("/v1/search", { ...json({}), body: "{" })).status).toBe(400);
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("bounds concurrency and preserves order despite out-of-order completion", async () => {
    let active = 0, maximum = 0;
    mocks.search.mockImplementation(async q => { maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, q === "one" ? 15 : 1)); active--; return response(q); });
    const result = await app().request("/v1/search", json({ queries, concurrency: 2 }));
    expect(result.status).toBe(200); const body = await result.json();
    expect(maximum).toBe(2); expect(body.results.map((r: any) => r.data.sessionId)).toEqual(queries.map(q => q.q));
    expect(mocks.search.mock.calls[0]![2]).toMatchObject({ useHyDE: undefined, useRerank: undefined, queryRewrite: undefined,
      useContextualCompression: undefined, enableGraphExpansion: undefined, enableCommunityExpansion: undefined });
  });
  it("forwards per-item filters and explicitly enabled enhancements", async () => {
    const result = await app().request("/v1/search", json({ queries: [{ ...queries[0], documentId: "doc", filenameContains: "manual", tags: "one,two", limit: 3, hyde: true }] }));
    expect(result.status).toBe(200);
    expect(mocks.search).toHaveBeenCalledWith("one", "user", expect.objectContaining({ limit: 3, useHyDE: true,
      filters: expect.objectContaining({ documentId: "doc", filenameContains: "manual", tags: ["one", "two"] }) }));
  });
  it("does not start retrieval for an already disconnected request", async () => {
    const controller = new AbortController(); controller.abort();
    const result = await app().fetch(new Request("http://local/v1/search", { ...json({ queries }), signal: controller.signal }));
    expect(result.status).toBe(200); expect(mocks.search).not.toHaveBeenCalled(); expect(mocks.access).not.toHaveBeenCalled();
  });
  it("returns independent per-item scope failures without retrieving denied workspaces", async () => {
    mocks.access.mockImplementation(async (_c, id) => id === "foreign" ? new Response(null, { status: 404 }) : id === "forbidden" ? new Response(null, { status: 403 }) : null);
    const result = await app().request("/v1/search", json({ queries: [queries[0], { q: "secret", workspaceId: "foreign" }, { q: "denied", workspaceId: "forbidden" }] }));
    expect(await result.json()).toMatchObject({ results: [{ ok: true }, { ok: false, error: { code: "WORKSPACE_NOT_FOUND", status: 404 } }, { ok: false, error: { code: "FORBIDDEN", status: 403 } }] });
    expect(mocks.search).toHaveBeenCalledOnce();
  });
  it("keeps retrieval failures isolated and sanitizes internal errors", async () => {
    mocks.search.mockImplementation(async q => { if (q === "two") throw new Error("private database credential"); return response(q); });
    const result = await app().request("/v1/search", json({ queries: queries.slice(0, 3) }));
    expect(await result.json()).toMatchObject({ results: [{ ok: true }, { ok: false, error: { status: 500, message: "We couldn’t complete that request. Please try again in a moment." } }, { ok: true }] });
  });
  it("reports shed and aborted items as 503/499, not internal failures", async () => {
    const { SearchCapacityError } = await import("../search/search-limiter.js");
    mocks.search.mockImplementation(async q => {
      if (q === "two") throw new SearchCapacityError("full", 8);
      if (q === "three") throw Object.assign(new Error("Search aborted"), { name: "AbortError" });
      return response(q);
    });
    const result = await app().request("/v1/search", json({ queries: queries.slice(0, 3) }));
    expect(await result.json()).toMatchObject({ results: [{ ok: true },
      { ok: false, error: { code: "SEARCH_UNAVAILABLE", status: 503 } },
      { ok: false, error: { code: "REQUEST_ABORTED", status: 499 } }] });
  });
  it("stops queued retrieval after request abort, preserving completed items", async () => {
    const controller = new AbortController();
    mocks.search.mockImplementation(async q => { controller.abort(); return response(q); });
    const req = new Request("http://local/v1/search", { ...json({ queries, concurrency: 1 }), signal: controller.signal });
    const result = await app().fetch(req);
    expect(mocks.search).toHaveBeenCalledOnce();
    expect(await result.json()).toMatchObject({ results: [{ ok: true }, ...queries.slice(1).map(() => ({ ok: false, error: { code: "REQUEST_ABORTED", status: 499 } }))] });
  });
  it.each(["/v1/chat", "/v1/search/chat"])("shares validated native chat at %s", async path => {
    mocks.chat.mockResolvedValue({ answer: "answer", citations: [] });
    expect((await app().request(path, json({ q: "hello", workspaceId: "workspace", sessionId: "session", model: "model" }))).status).toBe(200);
    expect(mocks.chat).toHaveBeenCalledWith({ query: "hello", workspaceId: "workspace", userId: "user", sessionId: "session", model: "model",
      actor: undefined, allowAgentTools: true, signal: expect.any(AbortSignal) });
  });
  it.each([{ q: 7, workspaceId: "workspace" }, { q: "hello", workspaceId: {} }, { q: "hello", workspaceId: "workspace", model: "x".repeat(257) },
    { q: "hello", workspaceId: "workspace", sessionId: 42 }, { q: "x".repeat(16001), workspaceId: "workspace" }])("rejects malformed chat before service calls: %j", async body => {
    expect((await app().request("/v1/chat", json(body))).status).toBe(400); expect(mocks.chat).not.toHaveBeenCalled();
  });
  it("enforces chat workspace scope before any model calls", async () => {
    mocks.access.mockResolvedValue(new Response(null, { status: 404 }));
    expect((await app().request("/v1/chat", json(queries[0]))).status).toBe(404); expect(mocks.chat).not.toHaveBeenCalled();
  });
});

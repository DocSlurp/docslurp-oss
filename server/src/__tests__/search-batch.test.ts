import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ search: vi.fn(), chat: vi.fn(), access: vi.fn() }));
vi.mock("../services/search.js", () => ({ hybridSearch: mocks.search, MissingProjectScopeError: class extends Error {}, CrossProjectScopeError: class extends Error {}, ProjectNotFoundError: class extends Error { constructor() { super("Project not found"); } }, }));
vi.mock("../services/project-chat.js", () => ({ chatProject: mocks.chat, projectChatDisabledBody: async () => null }));
vi.mock("../services/aggregate-rag.js", () => ({ aggregateProjectRagSearch: vi.fn() }));
vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("../lib/request-actor.js", () => ({
  assertApiKeyProjectAccess: mocks.access, getRequestActor: vi.fn(), actorHasAnyApiKeyScope: vi.fn(),
  resolveActorProjectId: async (_actor: unknown, projectId?: string) => projectId ?? "default-project",
}));
const { searchRoutes, projectChatRoutes } = await import("../routes/search.js");
function app() {
  const server = new Hono();
  server.use("*", async (c, next) => { c.set("sessionUser", { id: "user", email: "", name: "" }); await next(); });
  server.route("/v1/search", searchRoutes);
  server.route("/v1/chat", projectChatRoutes);
  return server;
}
const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const queries = ["one", "two", "three", "four", "five"].map(q => ({ q, project: "project" }));
const response = (q: string) => ({ results: [{ text: q, citation: { page: 1 } }], sessionId: q, availability: { status: "complete" } });
describe("batch retrieval and canonical chat", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.access.mockResolvedValue(null); mocks.search.mockImplementation(async q => response(q)); });
  it.each([{ queries: [] }, { queries: Array(21).fill(queries[0]) }, { queries, concurrency: 0 }, { queries, concurrency: 9 },
    { queries: [queries[0], { q: 123, project: "project" }] }, { queries: [{ q: " ", project: "project" }] },
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
      app().request('/v1/search?q=one&project=project'),
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
  it("returns independent per-item scope failures without retrieving denied projects", async () => {
    mocks.access.mockImplementation(async (_c, id) => id === "foreign" ? new Response(null, { status: 404 }) : id === "forbidden" ? new Response(null, { status: 403 }) : null);
    const result = await app().request("/v1/search", json({ queries: [queries[0], { q: "secret", project: "foreign" }, { q: "denied", project: "forbidden" }] }));
    expect(await result.json()).toMatchObject({ results: [{ ok: true }, { ok: false, error: { code: "PROJECT_NOT_FOUND", status: 404 } }, { ok: false, error: { code: "FORBIDDEN", status: 403 } }] });
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
  it("removes the old /v1/search/chat and /v1/search/chat/stream aliases", async () => {
    expect((await app().request("/v1/search/chat", json({ q: "hello", project: "project" }))).status).toBe(404);
    expect((await app().request("/v1/search/chat/stream?q=hello&project=project")).status).toBe(404);
    expect(mocks.chat).not.toHaveBeenCalled();
  });
  it.each(["/v1/chat"])("shares validated native chat at %s", async path => {
    mocks.chat.mockResolvedValue({ answer: "answer", citations: [] });
    expect((await app().request(path, json({ q: "hello", project: "project", sessionId: "session", model: "model" }))).status).toBe(200);
    expect(mocks.chat).toHaveBeenCalledWith({ query: "hello", projectId: "project", userId: "user", sessionId: "session", model: "model",
      actor: undefined, allowAgentTools: true, signal: expect.any(AbortSignal) });
  });
  it.each([{ q: 7, project: "project" }, { q: "hello", project: {} }, { q: "hello", project: "project", model: "x".repeat(257) },
    { q: "hello", project: "project", sessionId: 42 }, { q: "x".repeat(16001), project: "project" }])("rejects malformed chat before service calls: %j", async body => {
    expect((await app().request("/v1/chat", json(body))).status).toBe(400); expect(mocks.chat).not.toHaveBeenCalled();
  });
  it("enforces chat project scope before any model calls", async () => {
    mocks.access.mockResolvedValue(new Response(null, { status: 404 }));
    expect((await app().request("/v1/chat", json(queries[0]))).status).toBe(404); expect(mocks.chat).not.toHaveBeenCalled();
  });
  it("runs an array q as one keyword fan-out search", async () => {
    const res = await app().request("/v1/search", json({ q: ["notice period", "termination", "notice period"], project: "project" }));
    expect(res.status).toBe(200);
    expect(mocks.search).toHaveBeenCalledTimes(1);
    const [text, , options] = mocks.search.mock.calls[0]!;
    expect(text).toBe("notice period termination notice period");
    expect(options).toMatchObject({ searchMode: "keyword", keywordQueries: ["notice period", "termination", "notice period"] });
  });
  it("accepts a keyword fan-out inside a batch item", async () => {
    const res = await app().request("/v1/search", json({ queries: [{ q: ["a1", "b2"], project: "project" }, { q: "plain", project: "project" }] }));
    expect(res.status).toBe(200);
    expect(mocks.search.mock.calls.map(call => call[2].keywordQueries)).toEqual(expect.arrayContaining([["a1", "b2"], undefined]));
  });
  it.each([
    { q: ["a", "b"], mode: "hybrid" },
    { q: ["a", "b"], mode: "deep" },
    { q: [] },
    { q: Array.from({ length: 101 }, (_, i) => `term${i}`) },
    { q: ["ok", " "] },
    { q: ["x".repeat(1001)] },
    { q: Array.from({ length: 17 }, () => "y".repeat(1000)) },
    { q: Array.from({ length: 9 }, (_, i) => `"exact phrase ${i}"`) },
    { q: Array.from({ length: 9 }, (_, i) => `term -excluded${i}`) },
  ])("refuses an invalid keyword fan-out before retrieval: %#", async body => {
    expect((await app().request("/v1/search", json({ ...body, project: "project" }))).status).toBe(400);
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("caps keyword fan-out queries across a whole batch", async () => {
    const item = { q: Array.from({ length: 60 }, (_, i) => `t${i}`), project: "project" };
    expect((await app().request("/v1/search", json({ queries: [item, item] }))).status).toBe(400);
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("strips NUL bytes from keyword fan-out queries", async () => {
    expect((await app().request("/v1/search", json({ q: ["a\u0000b", "c"], project: "project" }))).status).toBe(200);
    expect(mocks.search.mock.calls[0]![2].keywordQueries).toEqual(["ab", "c"]);
  });
  it("accepts 100 keyword queries and up to 8 that need the Postgres path", async () => {
    const q = [...Array.from({ length: 92 }, (_, i) => `term${i}`), ...Array.from({ length: 8 }, (_, i) => `"phrase ${i}"`)];
    expect((await app().request("/v1/search", json({ q, project: "project", mode: "keyword" }))).status).toBe(200);
  });
});

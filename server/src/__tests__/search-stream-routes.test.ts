import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchStreamEventSchema, searchResultId } from "@docslurp/shared";

const mocks = vi.hoisted(() => ({
  search: vi.fn(), access: vi.fn(), policy: vi.fn(), cached: { value: undefined as unknown }, store: vi.fn(), ticket: vi.fn(),
  report: vi.fn(() => "Something went wrong"), actor: vi.fn(),
}));
vi.mock("../services/search.js", () => ({ hybridSearch: mocks.search, MissingProjectScopeError: class extends Error {}, CrossProjectScopeError: class extends Error {}, ProjectNotFoundError: class extends Error { constructor() { super("Project not found"); } } }));
vi.mock("../services/project-chat.js", () => ({ chatProject: vi.fn(), projectChatDisabledBody: async () => null }));
vi.mock("../services/aggregate-rag.js", () => ({ aggregateProjectRagSearch: vi.fn() }));
vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("../lib/public-errors.js", () => ({ reportPublicError: mocks.report }));
vi.mock("../search/session-setup.js", () => ({ loadProjectPipeline: async () => ({}) }));
vi.mock("../services/materialization-policy.js", () => ({ resolveMaterializationPolicy: mocks.policy }));
vi.mock("../search/response-cache.js", () => ({
  clearSearchResponseCacheForTests: vi.fn(), createCacheScopeMemo: () => ({}), primeCacheScope: vi.fn(),
  searchResponseCacheTtlMs: () => 1000, cacheableApiKeyId: () => null,
  responseCacheTicket: mocks.ticket, readCachedResponse: () => mocks.cached.value, storeResponse: mocks.store,
}));
vi.mock("../lib/request-actor.js", () => ({
  assertApiKeyProjectAccess: mocks.access, getRequestActor: mocks.actor, actorHasAnyApiKeyScope: vi.fn(),
  resolveActorProjectId: async (_actor: unknown, projectId?: string) => projectId ?? "default-project",
}));
vi.mock("../lib/search-access.js", () => ({
  authorizeActorProjectSearch: async (_actor: unknown, projectId: string) => {
    const denied = await mocks.access(undefined, projectId);
    if (denied) return { ok: false, status: denied.status };
    return { ok: true, access: { projectId, orgId: "org-1", projectOwnerUserId: "user", orgRole: "owner", projectRole: null, pipeline: {} },
      scope: { orgId: "org-1", projectIds: "org", modeCeiling: null } };
  },
}));
const { searchRoutes } = await import("../routes/search.js");
const { emitSearchStreamEvent } = await import("../search/stream-events.js");
const { currentSearchSignal } = await import("../search/query-bounds.js");

function app(user: { id: string } | null = { id: "user" }) {
  const server = new Hono();
  server.use("*", async (c, next) => { if (user) c.set("sessionUser", { ...user, email: "", name: "" }); await next(); });
  server.route("/v1/search", searchRoutes);
  return server;
}
const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const citation = (documentId: string, chunkIndex = 0) => ({ documentId, chunkIndex, source: "document" as const, page: 1 });
const result = (documentId: string) => ({ text: documentId, citation: citation(documentId), score: 1 });
const finalBody = (timings?: Record<string, number>) => ({
  results: [result("doc-a"), result("doc-b")], sessionId: "session-1", availability: { status: "complete" }, ...(timings ? { timings } : {}),
});
// Minimal fixtures: the route never inspects hit bodies, so the full result type is not built here.
const hit = (documentId: string, legRank = 0) => ({ id: searchResultId(result(documentId)), legRank, result: result(documentId) as never });

async function events(response: Response) {
  const text = await response.text();
  return text.split("\n\n").filter(Boolean).map((frame) => {
    const lines = frame.split("\n");
    const field = (name: string) => lines.find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1).trim();
    return { event: field("event")!, id: field("id")!, data: JSON.parse(field("data")!) };
  });
}

describe("search stream", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.DOCSLURP_DEFERRED_PROFILES;
    mocks.actor.mockReturnValue({ type: "api_key" });
    mocks.access.mockResolvedValue(null);
    mocks.cached.value = undefined;
    mocks.ticket.mockResolvedValue({ ticket: true });
    mocks.report.mockReturnValue("Something went wrong");
    mocks.search.mockImplementation(async () => finalBody());
  });
  afterEach(() => { delete process.env.DOCSLURP_DEFERRED_PROFILES; });

  it("emits started, sink events in order, results then done with a contiguous envelope", async () => {
    mocks.search.mockImplementation(async () => {
      emitSearchStreamEvent(() => ({ type: "search.hits", leg: "vector", hits: [hit("doc-b")], truncated: false }));
      emitSearchStreamEvent(() => ({ type: "search.hits", leg: "lexical", hits: [hit("doc-a")], truncated: false }));
      emitSearchStreamEvent(() => ({ type: "search.phase", phase: "rerank", stats: { ms: 5 } }));
      return finalBody({ totalMs: 9 });
    });
    const response = await app().request("/v1/search/stream", post({ q: "contracts", project: "p", stats: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const frames = await events(response);
    expect(frames.map((f) => f.event)).toEqual(["search.started", "search.hits", "search.hits", "search.phase", "search.results", "search.done"]);
    expect(frames.map((f) => f.data.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(frames.map((f) => f.id)).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(new Set(frames.map((f) => f.data.searchId)).size).toBe(1);
    // Hit and result bodies here are minimal fixtures; the envelope and the other events validate against the contract.
    for (const f of frames.filter((f) => !["search.hits", "search.results"].includes(f.event))) expect(searchStreamEventSchema.safeParse(f.data).success, f.event).toBe(true);
    expect(frames.map((f) => f.data.leg).filter(Boolean)).toEqual(["vector", "lexical"]);
    expect(frames[0]!.data).toMatchObject({ protocol: 1, projectId: "p", cached: false });
    expect(frames[4]!.data.ids).toEqual(["document:doc-a:0", "document:doc-b:0"]);
    expect(frames[5]!.data).toMatchObject({ sessionId: "session-1", resultCount: 2, timings: { totalMs: 9 } });
    expect(mocks.search).toHaveBeenCalledTimes(1);
  });

  it("final response equals the JSON endpoint body, and installs the sink with the effective limit and stats", async () => {
    let sink: { hitLimit?: number; stats?: boolean } = {};
    mocks.search.mockImplementation(async () => {
      emitSearchStreamEvent((s) => { sink = s; return null; });
      emitSearchStreamEvent(() => ({ type: "search.phase", phase: "plan", stats: { ms: 1 } }));
      return finalBody();
    });
    const json = await (await app().request("/v1/search", post({ q: "x", project: "p", limit: 7 }))).json();
    const frames = await events(await app().request("/v1/search/stream", post({ q: "x", project: "p", limit: 7, stats: true })));
    expect(frames.find((f) => f.event === "search.results")!.data.response).toEqual(json);
    expect(sink).toMatchObject({ hitLimit: 7, stats: true });
  });

  it("omits timings and reports stats=false to the engine unless stats is requested", async () => {
    let stats: boolean | undefined;
    mocks.search.mockImplementation(async () => {
      emitSearchStreamEvent((s) => { stats = s.stats; return { type: "search.phase", phase: "plan", stats: { ms: 1 } }; });
      return finalBody({ totalMs: 9 });
    });
    const frames = await events(await app().request("/v1/search/stream?q=x&project=p"));
    expect(stats).toBe(false);
    expect(frames.at(-1)!.data).not.toHaveProperty("timings");
    expect(frames.at(-1)!.event).toBe("search.done");
  });

  it("GET accepts the GET /v1/search parameters plus stats", async () => {
    const frames = await events(await app().request("/v1/search/stream?q=hello&project=p&limit=5&rerank=false&stats=true"));
    expect(frames.map((f) => f.event)).toEqual(["search.started", "search.results", "search.done"]);
    expect(mocks.search.mock.calls[0]![0]).toBe("hello");
    expect(mocks.search.mock.calls[0]![2]).toMatchObject({ limit: 5, useRerank: false });
  });

  it("serves a cache hit as started(cached), results, done, with no search and no hits", async () => {
    mocks.cached.value = { ...finalBody(), usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5, costCents: 1, costSource: "x" } };
    const frames = await events(await app().request("/v1/search/stream", post({ q: "x", project: "p" })));
    expect(frames.map((f) => f.event)).toEqual(["search.started", "search.results", "search.done"]);
    expect(frames[0]!.data.cached).toBe(true);
    expect(frames[1]!.data.response.usage).toMatchObject({ totalTokens: 0, costCents: 0 });
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("stores a complete streamed result in the response cache as POST does", async () => {
    await (await app().request("/v1/search/stream", post({ q: "x", project: "p" }))).text();
    expect(mocks.store).toHaveBeenCalledTimes(1);
  });

  it("answers a mid-stream failure with one public search.error and no raw text", async () => {
    mocks.search.mockImplementation(async () => {
      emitSearchStreamEvent(() => ({ type: "search.phase", phase: "plan", stats: { ms: 1 } }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("select * from secret_table failed: password=hunter2");
    });
    const text = await (await app().request("/v1/search/stream", post({ q: "x", project: "p" }))).text();
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("secret_table");
    const frames = text.split("\n\n").filter(Boolean).map((f) => JSON.parse(f.split("\n").find((l) => l.startsWith("data:"))!.slice(5)));
    expect(frames.map((f) => f.type)).toEqual(["search.started", "search.phase", "search.error"]);
    expect(frames.at(-1).error).toMatchObject({ status: 500, message: expect.not.stringContaining("hunter2") });
    expect(frames.map((f) => f.seq)).toEqual([0, 1, 2]);
    expect(mocks.report).toHaveBeenCalledTimes(1);
  });

  it("a failure before any event is the JSON endpoint's refusal, not a 200 stream", async () => {
    const { ProjectNotFoundError } = await import("../services/search.js");
    mocks.search.mockRejectedValue(new ProjectNotFoundError());
    const response = await app().request("/v1/search/stream", post({ q: "x", project: "p" }));
    const json = await app().request("/v1/search", post({ q: "x", project: "p" }));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toContain("event-stream");
    expect(await response.json()).toMatchObject({ error: { code: (await json.json()).error.code } });
  });

  it("aborts the search and stops writing when the client disconnects", async () => {
    let searchSignal: AbortSignal | undefined;
    mocks.search.mockImplementation(async () => {
      searchSignal = currentSearchSignal();
      emitSearchStreamEvent(() => ({ type: "search.phase", phase: "plan", stats: { ms: 1 } }));
      await new Promise<void>((resolve) => searchSignal!.addEventListener("abort", () => resolve()));
      emitSearchStreamEvent(() => ({ type: "search.phase", phase: "rerank", stats: { ms: 1 } }));
      return finalBody();
    });
    const response = await app().request("/v1/search/stream", post({ q: "x", project: "p" }));
    const reader = response.body!.getReader();
    await reader.read();
    expect(searchSignal?.aborted).toBe(false);
    await reader.cancel();
    await vi.waitFor(() => expect(searchSignal?.aborted).toBe(true));
  });

  describe("detaching, keepalive, ordering and observability", () => {
    const logLines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("[search-stream]"));
    const hitsEmit = () => emitSearchStreamEvent(() => ({ type: "search.hits", leg: "vector", hits: [hit("doc-a")], truncated: false }));
    const phaseEmit = () => emitSearchStreamEvent(() => ({ type: "search.phase", phase: "plan", stats: { ms: 1 } }));
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it("a disconnect after phase-only events still aborts the search (nothing delivered)", async () => {
      let signal: AbortSignal | undefined;
      mocks.search.mockImplementation(async () => {
        signal = currentSearchSignal();
        phaseEmit();
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve()));
        throw new Error("aborted");
      });
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const reader = (await app().request("/v1/search/stream", post({ q: "x", project: "p" }))).body!.getReader();
      await reader.read();
      await reader.cancel();
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      await vi.waitFor(() => expect(logLines(info)).toHaveLength(1));
      expect(logLines(info)[0]).toMatch(/outcome=aborted cached=false ttfhMs=- /);
    });

    it("a disconnect after the first search.hits lets the search finish detached, with the work completed and one detached log line", async () => {
      let signal: AbortSignal | undefined;
      let release!: () => void;
      let finished = false;
      mocks.search.mockImplementation(async () => {
        signal = currentSearchSignal();
        hitsEmit();
        await new Promise<void>((resolve) => { release = resolve; });
        emitSearchStreamEvent(() => ({ type: "search.hits", leg: "lexical", hits: [hit("doc-b")], truncated: false }));
        finished = true;
        return finalBody();
      });
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const reader = (await app().request("/v1/search/stream", post({ q: "x", project: "p" }))).body!.getReader();
      await reader.read(); // started
      await reader.read(); // the first hits
      await reader.cancel();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(signal?.aborted).toBe(false);
      release();
      await vi.waitFor(() => expect(logLines(info)).toHaveLength(1));
      expect(finished).toBe(true);
      expect(signal?.aborted).toBe(false);
      expect(logLines(info)[0]).toMatch(/sessionId=session-1 requestId=- outcome=detached cached=false ttfhMs=\d+ events=\d+ bytes=\d+ totalMs=\d+$/);
      expect(logLines(info)[0]).not.toContain("contracts");
    });

    it("a detached search is bounded by the overall timeout and a detached failure is reported once", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      process.env.SEARCH_STREAM_DETACHED_TIMEOUT_MS = "5000";
      try {
        let signal: AbortSignal | undefined;
        mocks.search.mockImplementation(async () => {
          signal = currentSearchSignal();
          hitsEmit();
          await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve()));
          throw new Error("raw boom");
        });
        vi.spyOn(console, "info").mockImplementation(() => undefined);
        const reader = (await app().request("/v1/search/stream", post({ q: "x", project: "p" }))).body!.getReader();
        await reader.read(); await reader.read();
        await reader.cancel();
        await vi.advanceTimersByTimeAsync(4000);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1500);
        expect(signal?.aborted).toBe(true);
        await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(1));
      } finally { delete process.env.SEARCH_STREAM_DETACHED_TIMEOUT_MS; }
    });

    it("writes a keepalive comment every 15 s while the search is quiet", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
      let release!: () => void;
      mocks.search.mockImplementation(async () => { phaseEmit(); await new Promise<void>((resolve) => { release = resolve; }); return finalBody(); });
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const reader = (await app().request("/v1/search/stream", post({ q: "x", project: "p" }))).body!.getReader();
      const decoder = new TextDecoder();
      const read = async () => decoder.decode((await reader.read()).value);
      expect(await read()).toContain("event: search.started");
      expect(await read()).toContain("event: search.phase");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await read()).toBe(": keepalive\n\n");
      release();
      let rest = "";
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += decoder.decode(chunk.value); }
      expect(rest).toContain("event: search.done");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("gives up on a reader that stops reading after the search settled", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      await app().request("/v1/search/stream", post({ q: "x", project: "p" })); // never read
      await vi.advanceTimersByTimeAsync(16_000);
      await vi.waitFor(() => expect(logLines(info)).toHaveLength(1));
      expect(logLines(info)[0]).toContain("outcome=aborted");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("a leg event after the outcome is decided consumes no seq", async () => {
      mocks.search.mockImplementation(async () => {
        phaseEmit();
        setTimeout(() => emitSearchStreamEvent(() => ({ type: "search.phase", phase: "rerank", stats: { ms: 1 } })), 30);
        throw new Error("leg failed");
      });
      const frames = await events(await app().request("/v1/search/stream", post({ q: "x", project: "p" })));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(frames.map((f) => f.event)).toEqual(["search.started", "search.phase", "search.error"]);
      expect(frames.map((f) => f.data.seq)).toEqual([0, 1, 2]);
    });

    it("sends an SSE retry of 24 h on done and error frames only", async () => {
      const okText = await (await app().request("/v1/search/stream", post({ q: "x", project: "p" }))).text();
      expect(okText.match(/retry: 86400000/g)).toHaveLength(1);
      expect(okText.split("\n\n").find((f) => f.includes("search.done"))).toContain("retry: 86400000");
      mocks.search.mockImplementation(async () => { phaseEmit(); throw new Error("x"); });
      const errText = await (await app().request("/v1/search/stream", post({ q: "x", project: "p" }))).text();
      expect(errText.split("\n\n").find((f) => f.includes("search.error"))).toContain("retry: 86400000");
      expect(errText.match(/retry:/g)).toHaveLength(1);
    });

    it("logs one line per stream for done and error outcomes, without query text", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      await (await app().request("/v1/search/stream", post({ q: "secret query", project: "p" }))).text();
      mocks.search.mockImplementation(async () => { phaseEmit(); throw new Error("x"); });
      await (await app().request("/v1/search/stream", post({ q: "secret query", project: "p" }))).text();
      await vi.waitFor(() => expect(logLines(info)).toHaveLength(2));
      const [done, error] = logLines(info);
      expect(done).toMatch(/^\[search-stream\] searchId=\S+ sessionId=session-1 requestId=- outcome=done cached=false ttfhMs=- events=3 bytes=\d+ totalMs=\d+$/);
      expect(error).toMatch(/outcome=error cached=false ttfhMs=- events=3 /);
      expect(logLines(info).join()).not.toContain("secret");
    });

    it("a throw while building search.results becomes a public search.error", async () => {
      mocks.search.mockImplementation(async () => ({ ...finalBody(), results: [{ text: "x" }] }));
      const text = await (await app().request("/v1/search/stream", post({ q: "x", project: "p" }))).text();
      expect(text).toContain("event: search.error");
      expect(text).not.toContain("citation");
    });

    it("elapsedMs counts from the start of the request", async () => {
      mocks.ticket.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); return { ticket: true }; });
      const frames = await events(await app().request("/v1/search/stream", post({ q: "x", project: "p" })));
      expect(frames[0]!.data.elapsedMs).toBeGreaterThanOrEqual(35);
    });
  });

  describe("cookie GET guard", () => {
    it("refuses a cross-site cookie GET before any search work, and allows same-origin and API-key GETs", async () => {
      mocks.actor.mockReturnValue({ type: "session" });
      const cross = await app().request("http://api.test/v1/search/stream?q=x&project=p", { headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } });
      expect(cross.status).toBe(403);
      const bare = await app().request("http://api.test/v1/search/stream?q=x&project=p");
      expect(bare.status).toBe(403);
      expect(mocks.search).not.toHaveBeenCalled();
      expect(mocks.ticket).not.toHaveBeenCalled();
      const same = await app().request("http://api.test/v1/search/stream?q=x&project=p", { headers: { "Sec-Fetch-Site": "same-origin" } });
      expect(same.status).toBe(200);
      await same.text();
      mocks.actor.mockReturnValue({ type: "api_key" });
      const key = await app().request("http://api.test/v1/search/stream?q=x&project=p");
      expect(key.status).toBe(200);
      await key.text();
      expect(mocks.search).toHaveBeenCalledTimes(2);
    });
  });

  describe("refusals happen before the stream opens", () => {
    const notStream = (response: Response) => expect(response.headers.get("content-type") ?? "").not.toContain("event-stream");

    it("401 without a session", async () => {
      for (const request of [app(null).request("/v1/search/stream?q=x&project=p"), app(null).request("/v1/search/stream", post({ q: "x", project: "p" }))]) {
        const response = await request;
        expect(response.status).toBe(401); notStream(response);
      }
      expect(mocks.search).not.toHaveBeenCalled();
    });

    it("403 for a key without search scope, search never called", async () => {
      mocks.access.mockResolvedValue(new Response(null, { status: 403 }));
      for (const request of [app().request("/v1/search/stream?q=x&project=p"), app().request("/v1/search/stream", post({ q: "x", project: "p" }))]) {
        const response = await request;
        expect(response.status).toBe(403); notStream(response);
        expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
      }
      expect(mocks.search).not.toHaveBeenCalled();
    });

    it("another tenant's project is refused exactly as /v1/search refuses it, search never called", async () => {
      mocks.access.mockResolvedValue(new Response(null, { status: 404 }));
      const streamed = await app().request("/v1/search/stream", post({ q: "x", project: "someone-elses" }));
      const plain = await app().request("/v1/search", post({ q: "x", project: "someone-elses" }));
      expect(streamed.status).toBe(404); notStream(streamed);
      expect(await streamed.json()).toEqual(await plain.json());
      expect(mocks.search).not.toHaveBeenCalled();
      expect(mocks.ticket).not.toHaveBeenCalled();
    });

    it("rejects an invalid capability before the stream opens", async () => {
      process.env.DOCSLURP_DEFERRED_PROFILES = "1";
      mocks.policy.mockResolvedValue({ error: "capability_invalid" });
      const response = await app().request("/v1/search/stream", post({ q: "x", project: "p" }, { "X-DocSlurp-Capability": "bad" }));
      expect(response.status).toBe(401); notStream(response);
      mocks.policy.mockResolvedValue({ error: "capability_scope" });
      const scoped = await app().request("/v1/search/stream?q=x&project=p", { headers: { "X-DocSlurp-Capability": "other" } });
      expect(scoped.status).toBe(403); notStream(scoped);
      expect(mocks.search).not.toHaveBeenCalled();
    });

    it("400 for a queries batch, mixed forms, invalid input and a bad stats flag", async () => {
      const bodies = [{ queries: [{ q: "x" }] }, { q: "x", queries: [{ q: "y" }] }, { q: " " }, { q: "x", limit: 101 }, { q: "x", stats: "yes" }, { q: "x", bogus: 1 }];
      for (const body of bodies) {
        const response = await app().request("/v1/search/stream", post(body));
        expect(response.status, JSON.stringify(body)).toBe(400); notStream(response);
      }
      expect((await app().request("/v1/search/stream?q=x&stats=maybe")).status).toBe(400);
      expect((await app().request("/v1/search/stream")).status).toBe(400);
      expect((await app().request("/v1/search/stream", { ...post({}), body: "{" })).status).toBe(400);
      expect(mocks.search).not.toHaveBeenCalled();
      expect(mocks.access).not.toHaveBeenCalled();
    });
  });
});

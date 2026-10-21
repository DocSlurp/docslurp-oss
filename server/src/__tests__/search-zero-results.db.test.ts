import postgres from "postgres";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * search_zero_results.session_id references search_sessions. A zero-hit search
 * once inserted its diagnostics before its own session row existed, so every
 * insert failed the foreign key (23503) and was silently dropped. These checks
 * run zero-hit searches on each path against a migrated Postgres, where the
 * constraint is enforced, and require a diagnostics row tied to a persisted session.
 */

const { lanceDbVectorSearch, reported } = vi.hoisted(() => ({
  lanceDbVectorSearch: vi.fn<typeof import("../search/lancedb.js").lanceDbVectorSearch>().mockResolvedValue([]),
  reported: [] as unknown[],
}));
vi.mock("../search/lancedb.js", () => ({ lanceDbVectorSearch }));
vi.mock("../lib/ai.js", async (original) => ({
  ...await original<typeof import("../lib/ai.js")>(),
  resolveOpenRouterApiKey: () => undefined,
  // Routes embed the query; a fixed local vector keeps them off any provider.
  embedConfiguredText: async () => ({ embedding: [1, 0, 0], usage: { inputTokens: 0 } }),
  generateOpenRouterText: () => { throw new Error("Unexpected inference"); },
}));
vi.mock("../lib/public-errors.js", async (original) => ({
  ...await original<typeof import("../lib/public-errors.js")>(),
  reportPublicError: (error: unknown) => { reported.push(error); return "error"; },
}));
vi.mock("../lib/request-actor.js", async (original) => ({
  ...await original<typeof import("../lib/request-actor.js")>(),
  assertApiKeyWorkspaceAccess: async () => null,
  getRequestActor: () => ({ type: "session", userId: "u" }),
  resolveActorWorkspaceId: async (_actor: unknown, workspaceId?: string) => workspaceId ?? "w",
}));

let sql: postgres.Sql;
let stop: () => Promise<void>;
let search: typeof import("../services/search.js");
let routes: typeof import("../routes/search.js");
let chatContext: typeof import("../lib/chat-agent-context.js");

const options = {
  queryVector: [1, 0, 0], limit: 5, minScore: 0, useRerank: false, queryRewrite: false, selfQuery: false,
  parentRetrieval: false, useContextualCompression: false, useHyDE: false, stepback: false,
  iterativeMultiHop: false, enableGraphExpansion: false, enableCommunityExpansion: false,
};
// A tag nothing carries: retrieval and the whole-corpus fallback both come back empty.
const zeroHitFilters = { workspaceId: "w", tags: ["nothing-has-this-tag"] };
const zeroHitBody = { workspaceId: "w", tags: "nothing-has-this-tag", hyde: false, rerank: false, mmr: false,
  parentRetrieval: false, compression: false, queryRewrite: false, queryDecompose: false, stepback: false,
  selfQuery: false, iterativeMultiHop: false, graphExpansion: false, communityExpansion: false };

function app() {
  const server = new Hono();
  server.use("*", async (c, next) => { c.set("sessionUser", { id: "u", email: "", name: "" }); await next(); });
  server.route("/v1/search", routes.searchRoutes);
  return server;
}
const post = (body: unknown) => app().request("/v1/search", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

async function zeroResultRows() {
  return sql<{ session_id: string; workspace_id: string; persisted: boolean; chat_session_id: string | null }[]>`
    select z.session_id, z.workspace_id, s.id is not null as persisted, s.metadata ->> 'chatSessionId' as chat_session_id
    from search_zero_results z left join search_sessions s on s.id = z.session_id
    order by z.created_at`;
}

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'zero@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Org', 'zero', 'u')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'Zero')`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline) values ('r', 'o', 'u', 'w', 'bulk-upload', 'completed', 'completed', '{}')`;
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
    values ('d', 'o', 'u', 'w', 'r', 'manual.txt', 'text/plain', 'd', 'completed')`;
  await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, token_estimate)
    values ('d-chunk', 'd', 'r', 'u', 0, 'The pump manual covers maintenance intervals.', 10)`;
  search = await import("../services/search.js");
  routes = await import("../routes/search.js");
  chatContext = await import("../lib/chat-agent-context.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
beforeEach(async () => {
  await sql`delete from search_zero_results`;
  await sql`delete from search_sessions`;
  routes.clearSearchResponseCacheForTests();
  reported.length = 0;
  vi.unstubAllEnvs();
});

describe("zero-result diagnostics reference a persisted search session", () => {
  // Synchronous session writes (write-behind follows native search, which is on by default).
  beforeEach(() => { vi.stubEnv("SEARCH_SESSION_WRITE_BEHIND", "0"); });
  it("single search", async () => {
    const response = await search.hybridSearch("maintenance", "u", { ...options, filters: zeroHitFilters });
    expect(response.results).toEqual([]);
      expect(await zeroResultRows()).toEqual([
      { session_id: response.sessionId, workspace_id: "w", persisted: true, chat_session_id: null },
    ]);
    expect(reported).toEqual([]);
  });

  it("child searches that suppress their session row record nothing themselves", async () => {
    const response = await search.hybridSearch("maintenance", "u", {
      ...options, filters: zeroHitFilters, suppressSessionLog: true, rootSessionId: crypto.randomUUID(),
    });
    expect(response.results).toEqual([]);
      expect(await zeroResultRows()).toEqual([]);
    expect(reported).toEqual([]);
  });

  it("batch search", async () => {
    const result = await post({ queries: [{ q: "maintenance", ...zeroHitBody }, { q: "intervals", ...zeroHitBody }] });
    const body = await result.json() as { results: Array<{ ok: boolean; data: { sessionId: string; results: unknown[] } }> };
    expect(body.results.map((item) => [item.ok, item.data.results.length])).toEqual([[true, 0], [true, 0]]);
      const rows = await zeroResultRows();
    expect(rows.map((row) => row.session_id).sort()).toEqual(body.results.map((item) => item.data.sessionId).sort());
    expect(rows.every((row) => row.persisted)).toBe(true);
    expect(reported).toEqual([]);
  });

  it("cached search response", async () => {
    vi.stubEnv("SEARCH_RESPONSE_CACHE_TTL_MS", "60000");
    const first = await (await post({ q: "maintenance", ...zeroHitBody })).json() as { sessionId: string; results: unknown[]; availability: { status: string } };
    const second = await (await post({ q: "maintenance", ...zeroHitBody })).json() as { sessionId: string; results: unknown[]; timings?: { cachedMs?: number } };
    expect(first.availability.status).toBe("complete");
    expect([first.results, second.results]).toEqual([[], []]);
    // The replay serves the first session; it writes no new session or diagnostics row.
    expect(second.timings?.cachedMs).toBe(0);
    expect(second.sessionId).toBe(first.sessionId);
      expect(await zeroResultRows()).toEqual([
      { session_id: first.sessionId, workspace_id: "w", persisted: true, chat_session_id: null },
    ]);
    expect(reported).toEqual([]);
  });

  it("chat agent search tool call", async () => {
    // The chat agent dispatches its search tool in-process to the search route
    // inside the chat turn's context.
    const result = await chatContext.runInChatAgentContext("chat-turn", () => post({ q: "maintenance", ...zeroHitBody }));
    const body = await result.json() as { sessionId: string; results: unknown[] };
    expect(body.results).toEqual([]);
      expect(await zeroResultRows()).toEqual([
      { session_id: body.sessionId, workspace_id: "w", persisted: true, chat_session_id: "chat-turn" },
    ]);
    expect(reported).toEqual([]);
  });

  it("is readable as soon as the search returns", async () => {
    // GET /v1/search/diagnostics?sessionId= is called with the id a zero-hit
    // search just returned, so the row must exist before the response does.
    const response = await search.hybridSearch("maintenance", "u", { ...options, filters: zeroHitFilters });
    expect(await zeroResultRows()).toEqual([
      { session_id: response.sessionId, workspace_id: "w", persisted: true, chat_session_id: null },
    ]);
  });

  it("a session id reused across polling attempts keeps one row", async () => {
    // The workspace search stream and chat's pending-index retry rerun the
    // search under one root session id; analytics count sessions, not attempts.
    const rootSessionId = crypto.randomUUID();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await search.hybridSearch("maintenance", "u", { ...options, filters: zeroHitFilters, rootSessionId });
    }
    expect(await zeroResultRows()).toEqual([
      { session_id: rootSessionId, workspace_id: "w", persisted: true, chat_session_id: null },
    ]);
  });

  it("a reused session whose later attempt finds results drops its zero-result row", async () => {
    const rootSessionId = crypto.randomUUID();
    await search.hybridSearch("maintenance", "u", { ...options, filters: zeroHitFilters, rootSessionId });
    expect(await zeroResultRows()).toHaveLength(1);
    const found = await search.hybridSearch("maintenance", "u", { ...options, filters: { workspaceId: "w" }, rootSessionId });
    expect(found.results.length).toBeGreaterThan(0);
    expect(found.sessionId).toBe(rootSessionId);
    expect(await zeroResultRows()).toEqual([]);
  });

  it("a failed diagnostics insert never fails the search", async () => {
    await sql`alter table search_zero_results add constraint reject_all check (false) not valid`;
    try {
      const response = await search.hybridSearch("maintenance", "u", { ...options, filters: zeroHitFilters });
      expect(response.results).toEqual([]);
          expect(reported).toHaveLength(1);
      expect(await sql`select id from search_sessions where id = ${response.sessionId}`).toHaveLength(1);
    } finally {
      await sql`alter table search_zero_results drop constraint reject_all`;
    }
  });
});

describe("write-behind session writes (SEARCH_SESSION_WRITE_BEHIND)", () => {
  beforeEach(() => { vi.stubEnv("SEARCH_SESSION_WRITE_BEHIND", "1"); });

  it("answers before its rows commit, and a reader that awaits the session sees them", async () => {
    const session = await import("../search/session.js");
    const response = await search.hybridSearch("maintenance", "u", { ...options, filters: zeroHitFilters });
    expect(response.results).toEqual([]);
    await session.awaitSearchSessionWrites(response.sessionId);
    expect(await zeroResultRows()).toEqual([
      { session_id: response.sessionId, workspace_id: "w", persisted: true, chat_session_id: null },
    ]);
    expect(reported).toEqual([]);
  });

  it("commits billed usage before it answers; only the session rows wait", async () => {
    const session = await import("../search/session.js");
    const journal = session.createSearchSessionJournal({ scope: { workspaceId: "w", orgId: "o" }, writeBehind: true });
    journal.record({ provider: "openrouter", model: "test/embed", metric: "embed-query", inputTokens: 7, costCents: 0.01 });
    let release!: () => void;
    // Hold the background queue so the session row cannot commit first.
    await journal.afterWrites(() => new Promise<void>((resolve) => { release = resolve; }));
    const persisted = journal.persist({
      userId: "u", query: "maintenance", results: [], chunks: [],
      metadata: { originalQuery: "maintenance", workspaceId: "w", filters: {}, options: {} } as never,
    });
    await persisted;
    const usage = await sql<{ input_tokens: number; workspace_id: string }[]>`
      select input_tokens, workspace_id from usage_events where metadata ->> 'sessionId' = ${journal.sessionId}`;
    expect(usage).toEqual([{ input_tokens: 7, workspace_id: "w" }]);
    expect(await sql`select id from search_sessions where id = ${journal.sessionId}`).toEqual([]);
    release();
    await session.drainSearchSessionWrites();
    expect(await sql`select id from search_sessions where id = ${journal.sessionId}`).toHaveLength(1);
    // The snapshot's own flush did not write the event again.
    expect(await sql`select id from usage_events where metadata ->> 'sessionId' = ${journal.sessionId}`).toHaveLength(1);
    expect(reported).toEqual([]);
  });

  it("waits for its own writes once the backlog is full (SEARCH_WRITE_BEHIND_MAX_PENDING)", async () => {
    vi.stubEnv("SEARCH_WRITE_BEHIND_MAX_PENDING", "0");
    const response = await search.hybridSearch("maintenance", "u", { ...options, filters: zeroHitFilters });
    // No await on the session: backpressure made the search commit before answering.
    expect(await zeroResultRows()).toEqual([
      { session_id: response.sessionId, workspace_id: "w", persisted: true, chat_session_id: null },
    ]);
    expect(reported).toEqual([]);
  });

  it("records a click sent right after the answer", async () => {
    const session = await import("../search/session.js");
    const response = await search.hybridSearch("maintenance", "u", { ...options, filters: { workspaceId: "w" } });
    expect(response.results.length).toBeGreaterThan(0);
    const clicked = await app().request(`/v1/search/${response.sessionId}/feedback`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clickedChunkId: "d-chunk" }),
    });
    expect(clicked.status).toBe(200);
    await session.drainSearchSessionWrites();
    const [row] = await sql<{ clicked: boolean }[]>`select clicked from search_session_results where session_id = ${response.sessionId} and chunk_id = 'd-chunk'`;
    expect(row?.clicked).toBe(true);
  });

  it("keeps a reused session id's attempts in order", async () => {
    const session = await import("../search/session.js");
    const rootSessionId = crypto.randomUUID();
    // Three zero-hit attempts, one that finds results, all queued before any write commits.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await search.hybridSearch("maintenance", "u", { ...options, filters: zeroHitFilters, rootSessionId });
    }
    const found = await search.hybridSearch("maintenance", "u", { ...options, filters: { workspaceId: "w" }, rootSessionId });
    expect(found.results.length).toBeGreaterThan(0);
    await session.drainSearchSessionWrites();
    // The latest attempt decides: results found, so no zero-result row remains.
    expect(await zeroResultRows()).toEqual([]);
    const [row] = await sql<{ result_count: number }[]>`select result_count from search_sessions where id = ${rootSessionId}`;
    expect(row?.result_count).toBe(found.results.length);
    expect(reported).toEqual([]);
  });
});

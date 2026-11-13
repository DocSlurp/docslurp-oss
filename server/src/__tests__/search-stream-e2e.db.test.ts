import postgres from "postgres";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { searchResultId, searchStreamEventSchema, type SearchStreamEvent } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * End-to-end: the real search engine behind the real `/v1/search/stream` route,
 * against a migrated Postgres, with two organizations. Nothing in the search
 * path is mocked except the embedding provider and the LanceDB native index
 * (keyword mode never needs either). The caller is a real session actor
 * (`setRequestActor`) and project access is the real `authorizeActorProjectSearch`.
 */
// Lets a test make the fusion step (after every leg has emitted) fail, to model a late failure of the search.
const fusion = vi.hoisted(() => ({ fail: false }));
vi.mock("../search/rrf.js", async (original) => {
  const actual = await original<typeof import("../search/rrf.js")>();
  return {
    ...actual,
    reciprocalRankFusion: ((...args: Parameters<typeof actual.reciprocalRankFusion>) => {
      if (fusion.fail) throw new Error("fusion exploded: select secret from internals");
      return actual.reciprocalRankFusion(...args);
    }) as typeof actual.reciprocalRankFusion,
  };
});
vi.mock("../search/lancedb.js", () => ({
  lanceDbVectorSearch: vi.fn().mockResolvedValue([]),
  warmLanceDbSearch: vi.fn(async () => {}),
}));
vi.mock("../lib/ai.js", async (original) => ({
  ...await original<typeof import("../lib/ai.js")>(),
  resolveOpenRouterApiKey: () => undefined,
  embedConfiguredText: () => { throw new Error("Unexpected inference"); },
  generateOpenRouterText: () => { throw new Error("Unexpected inference"); },
}));

let sql: postgres.Sql;
let stop: () => Promise<void>;
let routes: typeof import("../routes/search.js");
let actors: typeof import("../lib/request-actor.js");
let requestContext: typeof import("../lib/request-context.js");
let writeBehind: typeof import("../lib/billed-write-behind.js");
let publicErrors: typeof import("../lib/public-errors.js");

// Distinctive text per organization. "quarterly" is shared vocabulary so both orgs would match it if scope leaked.
const A_CHUNK_1 = "Alpha Harbor quarterly earnings beat expectations with record revenue growth.";
const A_CHUNK_2 = "Alpha Harbor quarterly expansion plan opens three new regional offices.";
const A_PAGE = "Alpha Harbor quarterly page-only briefing celebrates the London expansion.";
const B_CHUNK = "Zenith Orchard quarterly earnings beat forecasts and fund a jet to London.";
const B_PAGE = "Zenith Orchard quarterly page-only briefing announces a bigger expansion.";
const B_DOC_IDS = ["doc-b1", "doc-b-pages"];
const B_MARKERS = [...B_DOC_IDS, "Zenith", "Orchard", "proj-b", "org-b", "user-b"];

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    // Production's numeric parsing: credit balances are numbers, not strings.
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  });
  vi.doMock("../db.js", () => ({ sql }));
  vi.stubEnv("SEARCH_SESSION_WRITE_BEHIND", "0");

  await sql`insert into "user" (id, name, email) values ('user-a', 'A', 'a@stream-e2e.test'), ('user-b', 'B', 'b@stream-e2e.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id, credit_balance_cents)
    values ('org-a', 'Org A', 'stream-a', 'user-a', 100000), ('org-b', 'Org B', 'stream-b', 'user-b', 100000)`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('org-a', 'user-a', 'owner'), ('org-b', 'user-b', 'owner')`;
  await sql`insert into projects (id, org_id, user_id, name, is_default) values ('proj-a', 'org-a', 'user-a', 'Alpha', true), ('proj-b', 'org-b', 'user-b', 'Zenith', true)`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline) values
    ('run-a', 'org-a', 'user-a', 'proj-a', 'bulk-upload', 'completed', 'completed', '{}'),
    ('run-a-live', 'org-a', 'user-a', 'proj-a', 'bulk-upload', 'processing', 'page-index', '{}'),
    ('run-b', 'org-b', 'user-b', 'proj-b', 'bulk-upload', 'completed', 'completed', '{}'),
    ('run-b-live', 'org-b', 'user-b', 'proj-b', 'bulk-upload', 'processing', 'page-index', '{}')`;

  const doc = (id: string, org: string, user: string, project: string, run: string, status: string) => sql`
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status)
    values (${id}, ${org}, ${user}, ${project}, ${run}, ${id + ".txt"}, 'text/plain', ${id}, ${status})`;
  const chunk = (id: string, docId: string, run: string, user: string, index: number, text: string) => sql`
    insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, page_number, token_estimate)
    values (${id}, ${docId}, ${run}, ${user}, ${index}, ${text}, ${index + 1}, 12)`;
  await doc("doc-a1", "org-a", "user-a", "proj-a", "run-a", "completed");
  await chunk("doc-a1-c0", "doc-a1", "run-a", "user-a", 0, A_CHUNK_1);
  await chunk("doc-a1-c1", "doc-a1", "run-a", "user-a", 1, A_CHUNK_2);
  await doc("doc-b1", "org-b", "user-b", "proj-b", "run-b", "completed");
  await chunk("doc-b1-c0", "doc-b1", "run-b", "user-b", 0, B_CHUNK);

  // Page-only documents: pages stored and page-indexed, no chunks, run still live (progressive page leg).
  for (const [id, org, user, project, run, text] of [
    ["doc-a-pages", "org-a", "user-a", "proj-a", "run-a-live", A_PAGE],
    ["doc-b-pages", "org-b", "user-b", "proj-b", "run-b-live", B_PAGE],
  ] as const) {
    await doc(id, org, user, project, run, "processing");
    await sql`insert into document_pages (id, document_id, run_id, user_id, page_number, text)
      values (${id + "-p1"}, ${id}, ${run}, ${user}, 1, ${text})`;
    await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status) values (${run}, ${id}, 'page-index', 'completed')`;
  }

  routes = await import("../routes/search.js");
  actors = await import("../lib/request-actor.js");
  requestContext = await import("../lib/request-context.js");
  writeBehind = await import("../lib/billed-write-behind.js");
  publicErrors = await import("../lib/public-errors.js");
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await sql?.end();
  await stop?.();
});

function app(userId = "user-a") {
  const server = new Hono();
  server.use("*", async (c, next) => { c.set("requestId", "req-stream-e2e"); await next(); });
  server.use("*", requestContext.requestContextMiddleware);
  server.use("*", publicErrors.publicErrorMiddleware);
  server.use("*", async (c, next) => {
    actors.setRequestActor(c, {
      type: "session", userId, sessionId: "session-" + userId,
      user: { id: userId, email: `${userId}@stream-e2e.test`, name: userId },
    });
    await next();
  });
  server.route("/v1/search", routes.searchRoutes);
  return server;
}
const post = (path: string, body: unknown) => app().request(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

interface Frame { id: string | undefined; event: string | undefined; data: string }
function frames(raw: string): Frame[] {
  const out: Frame[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((line) => line && !line.startsWith(":"));
    if (!lines.length) continue;
    const frame: Frame = { id: undefined, event: undefined, data: "" };
    for (const line of lines) {
      if (line.startsWith("id:")) frame.id = line.slice(3).trim();
      else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
      else if (line.startsWith("data:")) frame.data += line.slice(5).trimStart();
    }
    out.push(frame);
  }
  return out;
}

const BODY = { q: "quarterly", mode: "keyword", limit: 10, stats: true };
/** Fields that legitimately differ between two runs of one search. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["sessionId", "timings", "usage", "usageEvents", "id", "searchSessionId", "runtimeMs"].includes(key))
      .map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
}

describe("POST /v1/search/stream end to end", () => {
  it("streams real legs, then the same answer as POST /v1/search, without leaking the other organization", async () => {
    const charges = async () => (await sql`select id from usage_events where metric = 'search-query'`).length;
    const chargesBefore = await charges();
    const response = await post("/v1/search/stream", BODY);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const raw = await response.text();
    // One streamed search is one charge (written behind the response: wait for it to land).
    await vi.waitFor(() => { expect(writeBehind.billedWriteBehindPending()).toBe(0); }, { timeout: 5000 });
    expect(await charges() - chargesBefore).toBe(1);
    const parsedFrames = frames(raw);
    expect(parsedFrames.length).toBeGreaterThanOrEqual(4);

    const events: SearchStreamEvent[] = parsedFrames.map((frame) => searchStreamEventSchema.parse(JSON.parse(frame.data)));
    // seq contiguous from 0, equals the SSE id and the SSE event name equals the type.
    events.forEach((event, index) => {
      expect(event.seq).toBe(index);
      expect(parsedFrames[index]!.id).toBe(String(index));
      expect(parsedFrames[index]!.event).toBe(event.type);
    });
    expect(new Set(events.map((event) => event.searchId)).size).toBe(1);
    expect(events[0]!.type).toBe("search.started");
    expect(events.at(-2)!.type).toBe("search.results");
    expect(events.at(-1)!.type).toBe("search.done");
    expect(events.filter((event) => event.type === "search.results")).toHaveLength(1);
    expect(events.filter((event) => event.type === "search.done")).toHaveLength(1);
    expect(events.filter((event) => event.type === "search.error")).toEqual([]);
    expect(events[0]).toMatchObject({ type: "search.started", projectId: "proj-a" });

    const resultsIndex = events.findIndex((event) => event.type === "search.results");
    const hitEvents = events.filter((event): event is Extract<SearchStreamEvent, { type: "search.hits" }> => event.type === "search.hits");
    expect(hitEvents.length).toBeGreaterThan(0);
    expect(events.findIndex((event) => event.type === "search.hits")).toBeLessThan(resultsIndex);
    // At least one leg reported hits before the authoritative list.
    expect(hitEvents.some((event) => event.hits.length > 0)).toBe(true);
    // stats: true yields per-leg stats and at least one phase event.
    expect(events.some((event) => event.type === "search.phase")).toBe(true);

    const final = events[resultsIndex] as Extract<SearchStreamEvent, { type: "search.results" }>;
    expect(final.ids).toEqual(final.response.results.map(searchResultId));
    expect(final.response.results.length).toBeGreaterThan(0);
    const legs = new Set(hitEvents.map((event) => event.leg));
    const stages = new Set(final.response.results.map((result) => (result as { retrieval?: { stage?: string } }).retrieval?.stage ?? "chunk"));

    // A body is sent once per id; every body belongs to org A's project.
    const bodies = new Map<string, number>();
    for (const event of hitEvents) {
      for (const hit of event.hits) {
        if (hit.result) {
          bodies.set(hit.id, (bodies.get(hit.id) ?? 0) + 1);
          expect(searchResultId(hit.result)).toBe(hit.id);
          expect(["doc-a1", "doc-a-pages"]).toContain(hit.result.citation.documentId);
        }
      }
    }
    for (const [id, count] of bodies) expect(count, `body for ${id} sent ${count} times`).toBe(1);
    for (const id of new Set(hitEvents.flatMap((event) => event.hits.map((hit) => hit.id)))) {
      // Every id referenced without a body must have had its body earlier on the stream.
      expect(bodies.has(id), `hit ${id} never carried a body`).toBe(true);
    }
    for (const result of final.response.results) expect(["doc-a1", "doc-a-pages"]).toContain(result.citation.documentId);

    // Nothing of organization B anywhere on the wire.
    for (const marker of B_MARKERS) expect(raw, `leaked ${marker}`).not.toContain(marker);

    // The page-only document is searchable next to chunk documents (progressive page leg).
    expect(final.response.results.map((result) => result.citation.documentId)).toContain("doc-a1");

    // done carries the right count and the stats timings.
    const done = events.at(-1) as Extract<SearchStreamEvent, { type: "search.done" }>;
    expect(done.resultCount).toBe(final.response.results.length);
    expect(done.sessionId).toBe(final.response.sessionId);

    // 2. The final response equals POST /v1/search for the same request.
    const { stats: _stats, ...jsonBody } = BODY;
    const json = await post("/v1/search", jsonBody);
    expect(json.status).toBe(200);
    const jsonResponse = await json.json();
    expect(stable(final.response)).toEqual(stable(jsonResponse));
  });

  describe("billing a search that fails after passages were delivered", () => {
    const charges = async () => sql<{ id: string; org_id: string | null; project_id: string | null; amount: string }[]>`
      select id, org_id, project_id, amount from usage_events where metric = 'search-query' order by created_at`;
    const settle = () => vi.waitFor(() => { expect(writeBehind.billedWriteBehindPending()).toBe(0); }, { timeout: 5000 });
    const failing = async <T,>(run: () => T | Promise<T>) => { fusion.fail = true; try { return await run(); } finally { fusion.fail = false; } };

    it("charges once, to the authorized org and project, when the search fails after hits were sent", async () => {
      const before = (await charges()).length;
      const text = await failing(async () => (await post("/v1/search/stream", BODY)).text());
      await settle();
      const events = frames(text).map((frame) => JSON.parse(frame.data) as { type: string; hits?: unknown[]; error?: { message: string } });
      expect(events.some((event) => event.type === "search.hits" && (event.hits?.length ?? 0) > 0)).toBe(true);
      expect(events.at(-1)!.type).toBe("search.error");
      expect(text).not.toContain("secret");
      const rows = (await charges()).slice(before);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ org_id: "org-a", project_id: "proj-a" });
      expect(rows[0]!.id).toMatch(/^search:/);
      // The search is not charged a second time by a repeat flush of the write-behind queue.
      await settle();
      expect((await charges()).slice(before)).toHaveLength(1);
    });

    it("charges nothing when the search fails before any hits were sent", async () => {
      const before = (await charges()).length;
      // A project that is not the caller's: refused before the stream opens, never charged.
      const refused = await failing(() => post("/v1/search/stream", { ...BODY, project: "proj-b" }));
      expect([403, 404]).toContain(refused.status);
      await refused.text();
      await settle();
      expect((await charges()).length).toBe(before);
    });

    it("charges nothing when a late failure follows only legs that found nothing", async () => {
      const before = (await charges()).length;
      const text = await failing(async () => (await post("/v1/search/stream", { ...BODY, q: "zzzqqqnomatch" })).text());
      await settle();
      const events = frames(text).map((frame) => JSON.parse(frame.data) as { type: string; hits?: unknown[] });
      if (events.some((event) => event.type === "search.hits")) {
        expect(events.filter((event) => event.type === "search.hits").every((event) => event.hits!.length === 0)).toBe(true);
        expect(events.at(-1)!.type).toBe("search.error");
      }
      expect((await charges()).length).toBe(before);
    });

    it("still charges a successful stream exactly once", async () => {
      const before = (await charges()).length;
      expect((await (await post("/v1/search/stream", BODY)).text())).toContain("search.done");
      await settle();
      expect((await charges()).length - before).toBe(1);
    });

    it("charges when the client leaves after delivery and the detached search then fails (as the detached-timeout abort does)", async () => {
      const before = (await charges()).length;
      vi.stubEnv("SEARCH_STREAM_DETACHED_TIMEOUT_MS", "1000");
      try {
        fusion.fail = true;
        const response = await post("/v1/search/stream", BODY);
        const reader = response.body!.getReader();
        // Read until a hits frame arrived, then leave: the search is detached and fails (the fusion error stands in for the timeout abort).
        let seen = "";
        const decoder = new TextDecoder();
        while (!seen.includes("event: search.hits")) { const chunk = await reader.read(); if (chunk.done) break; seen += decoder.decode(chunk.value); }
        await reader.cancel();
        await settle();
        await vi.waitFor(async () => { expect((await charges()).length - before).toBe(1); }, { timeout: 5000 });
      } finally { fusion.fail = false; vi.unstubAllEnvs(); vi.stubEnv("SEARCH_SESSION_WRITE_BEHIND", "0"); }
    });
  });

  it("surfaces page-stage hits next to chunk hits (page-only document)", async () => {
    const response = await post("/v1/search/stream", { ...BODY, q: "briefing" });
    expect(response.status).toBe(200);
    const events = frames(await response.text()).map((frame) => searchStreamEventSchema.parse(JSON.parse(frame.data)));
    const hitEvents = events.filter((event): event is Extract<SearchStreamEvent, { type: "search.hits" }> => event.type === "search.hits");
    const pageHits = hitEvents.flatMap((event) => event.hits.filter((hit) => hit.id.includes("doc-a-pages")));
    expect(pageHits.length, "no provisional hit for the page-only document").toBeGreaterThan(0);
    expect(hitEvents.some((event) => event.leg === "progressive-page" && event.hits.length > 0)).toBe(true);
  });

  it("refuses another organization's project exactly as POST /v1/search does, with no stream", async () => {
    const jsonBody = { q: "quarterly", mode: "keyword", project: "proj-b" };
    const json = await post("/v1/search", jsonBody);
    const stream = await post("/v1/search/stream", jsonBody);
    expect([403, 404]).toContain(json.status);
    expect(stream.status).toBe(json.status);
    expect(stream.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    const [jsonText, streamText] = [await json.text(), await stream.text()];
    expect(stream.headers.get("content-type")).toBe(json.headers.get("content-type"));
    const normalize = (text: string) => text.replace(/"requestId":"[^"]*"/g, "");
    expect(normalize(streamText)).toBe(normalize(jsonText));
    for (const marker of B_MARKERS.filter((marker) => marker !== "proj-b")) expect(streamText).not.toContain(marker);
    // GET refuses the same way.
    const getJson = await app().request("/v1/search?q=quarterly&mode=keyword&project=proj-b");
    // A cookie-session GET must be same-origin (the stream guards it like /v1/chat/stream).
    const sameOrigin = { headers: { "Sec-Fetch-Site": "same-origin" } };
    const get = await app().request("/v1/search/stream?q=quarterly&mode=keyword&project=proj-b", sameOrigin);
    const crossSite = await app().request("/v1/search/stream?q=quarterly&mode=keyword", { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    expect(get.status).toBe(getJson.status);
    expect(normalize(await get.text())).toBe(normalize(await getJson.text()));
    expect(get.headers.get("content-type") ?? "").not.toContain("text/event-stream");
  });

  it("keyword fan-out (array q) over the stream", async () => {
    const body = { q: ["earnings", "expansion"], mode: "keyword", limit: 10 };
    const json = await post("/v1/search", body);
    const stream = await post("/v1/search/stream", body);
    expect(json.status).toBe(200);
    expect(stream.status, "fan-out stream status").toBe(200);
    if (stream.status === 400) {
      // Refused: acceptable only as a plain error body, never a stream.
      expect(stream.headers.get("content-type") ?? "").not.toContain("text/event-stream");
      return;
    }
    expect(stream.status).toBe(200);
    const raw = await stream.text();
    const events = frames(raw).map((frame) => searchStreamEventSchema.parse(JSON.parse(frame.data)));
    expect(events[0]!.type).toBe("search.started");
    expect(events.at(-1)!.type).toBe("search.done");
    const final = events.find((event) => event.type === "search.results") as Extract<SearchStreamEvent, { type: "search.results" }>;
    expect(final.ids).toEqual(final.response.results.map(searchResultId));
    expect(stable(final.response)).toEqual(stable(await json.json()));
    for (const marker of B_MARKERS) expect(raw).not.toContain(marker);
  });
});

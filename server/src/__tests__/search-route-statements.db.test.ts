import postgres from "postgres";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Statement counts of a warm search through the real route against a migrated Postgres, and the negative tests that
 * keep the per-request access memos honest: access is read on every request, and a memo never serves another
 * user, project or request. Counts are statements, not time. Embeddings and LanceDB are not reached (keyword mode).
 */
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
const statements: string[] = [];
let routes: typeof import("../routes/search.js");
let actors: typeof import("../lib/request-actor.js");
let requestContext: typeof import("../lib/request-context.js");
let publicErrors: typeof import("../lib/public-errors.js");
let setup: typeof import("../search/session-setup.js");
let session: typeof import("../search/session.js");
let behind: typeof import("../lib/billed-write-behind.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    debug: (_connection, query) => { statements.push(String(query)); },
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  });
  vi.doMock("../db.js", () => ({ sql }));
  vi.stubEnv("SEARCH_SESSION_WRITE_BEHIND", "0");
  vi.stubEnv("SEARCH_RESPONSE_CACHE_TTL_MS", "0");

  await sql`insert into "user" (id, name, email) values ('user-a', 'A', 'a@stmts.test'), ('user-b', 'B', 'b@stmts.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id, credit_balance_cents)
    values ('org-a', 'Org A', 'stmts-a', 'user-a', 100000), ('org-b', 'Org B', 'stmts-b', 'user-b', 100000)`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('org-a', 'user-a', 'owner'), ('org-b', 'user-b', 'owner')`;
  await sql`insert into projects (id, org_id, user_id, name, is_default) values
    ('00000000-0000-4000-8000-0000000000a1', 'org-a', 'user-a', 'Alpha', true), ('00000000-0000-4000-8000-0000000000a2', 'org-a', 'user-a', 'Alpha Two', false), ('00000000-0000-4000-8000-0000000000b1', 'org-b', 'user-b', 'Zenith', true)`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline) values
    ('run-a', 'org-a', 'user-a', '00000000-0000-4000-8000-0000000000a1', 'bulk-upload', 'completed', 'completed', '{}'),
    ('run-b', 'org-b', 'user-b', '00000000-0000-4000-8000-0000000000b1', 'bulk-upload', 'completed', 'completed', '{}')`;
  for (const [id, org, user, project, run, text] of [
    ["doc-a1", "org-a", "user-a", "00000000-0000-4000-8000-0000000000a1", "run-a", "Alpha Harbor quarterly earnings beat expectations."],
    ["doc-b1", "org-b", "user-b", "00000000-0000-4000-8000-0000000000b1", "run-b", "Zenith Orchard quarterly earnings beat forecasts."],
  ] as const) {
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status)
      values (${id}, ${org}, ${user}, ${project}, ${run}, ${id + ".txt"}, 'text/plain', ${id}, 'completed')`;
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, page_number, token_estimate)
      values (${id + "-c0"}, ${id}, ${run}, ${user}, 0, ${text}, 1, 12)`;
  }
  routes = await import("../routes/search.js");
  actors = await import("../lib/request-actor.js");
  requestContext = await import("../lib/request-context.js");
  publicErrors = await import("../lib/public-errors.js");
  setup = await import("../search/session-setup.js");
  session = await import("../search/session.js");
  behind = await import("../lib/billed-write-behind.js");
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await sql?.end();
  await stop?.();
});

beforeEach(() => { statements.length = 0; });

function app(userId = "user-a") {
  const server = new Hono();
  server.use("*", async (c, next) => { c.set("requestId", "req-stmts"); await next(); });
  server.use("*", requestContext.requestContextMiddleware);
  server.use("*", publicErrors.publicErrorMiddleware);
  server.use("*", async (c, next) => {
    actors.setRequestActor(c, { type: "session", userId, sessionId: "session-" + userId, user: { id: userId, email: `${userId}@stmts.test`, name: userId } });
    await next();
  });
  server.route("/v1/search", routes.searchRoutes);
  return server;
}
const post = (body: unknown, userId?: string) => app(userId).request("/v1/search", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
async function settled() {
  await session.drainSearchSessionWrites();
  await vi.waitFor(() => { expect(behind.billedWriteBehindPending()).toBe(0); }, { timeout: 5000 });
}
/** Reads that decide who may see a project (the access function, or the membership and default-project lookups). */
const accessReads = () => statements.filter((s) => /docslurp_project_access/.test(s)).length;
const projectResolution = () => statements.filter((s) => /from org_memberships om\s+where om\.org_id|select id from projects where org_id|insert into projects|from organizations o\s+join org_memberships/.test(s)).length;
const projectRecordReads = () => statements.filter((s) => /coalesce\(cs\.document_count/.test(s)).length;
/** Statements that are not retrieval (Postgres lexical and page legs run once per keyword query by design here; LanceDB serves them in production). */
const overhead = () => reads().filter((s) => !/document_chunks|document_pages|statement_timeout/.test(s)).length;
const reads = () => statements.filter((s) => !/^\s*(begin|commit|insert|delete|update|with recorded|savepoint|release)/i.test(s));

describe("warm search statement counts through the route", () => {
  const warm = async (body: unknown) => { await post(body); await settled(); statements.length = 0; };

  it("a keyword search with an explicit project reads access three times (reference, route, engine), never loads the project record, writes nothing to resolve it", async () => {
    await warm({ q: "quarterly", mode: "keyword", project: "00000000-0000-4000-8000-0000000000a1" });
    const response = await post({ q: "quarterly", mode: "keyword", project: "00000000-0000-4000-8000-0000000000a1" });
    expect(response.status).toBe(200);
    await settled();
    if (process.env.DUMP) console.info(statements.map((x) => x.replace(/\s+/g, " ").slice(0, 110)).join("\n"));
    console.info(`[statements] keyword explicit total=${statements.length} reads=${reads().length} access=${accessReads()}`);
    // The explicit reference lookup, the route's own decision, then the engine's scoped read (access, settings and pipeline in one statement).
    expect(accessReads()).toBe(3);
    expect(projectRecordReads()).toBe(0);
    expect(statements.filter((s) => /insert into projects/.test(s))).toHaveLength(0);
    expect(reads().length).toBeLessThanOrEqual(8);
  });

  it("an omitted project resolves the default with reads only (no project record, no insert)", async () => {
    await warm({ q: "quarterly", mode: "keyword" });
    const response = await post({ q: "quarterly", mode: "keyword" });
    expect(response.status).toBe(200);
    await settled();
    console.info(`[statements] keyword default total=${statements.length} reads=${reads().length} access=${accessReads()} resolution=${projectResolution()}`);
    expect(accessReads()).toBe(2);
    expect(projectRecordReads()).toBe(0);
    expect(statements.filter((s) => /insert into projects/.test(s))).toHaveLength(0);
    expect(reads().length).toBeLessThanOrEqual(9);
  });

  it("a keyword fan-out of 20 adds no per-query access, settings or availability statements", async () => {
    const one = async () => { await post({ q: "quarterly", mode: "keyword", project: "00000000-0000-4000-8000-0000000000a1" }); await settled(); const n = overhead(); statements.length = 0; return n; };
    await one();
    const single = await one();
    const q = Array.from({ length: 20 }, (_, i) => `quarterly term${i}`);
    const response = await post({ q, mode: "keyword", project: "00000000-0000-4000-8000-0000000000a1" });
    expect(response.status).toBe(200);
    await settled();
    console.info(`[statements] fanout20 single=${single} fanout=${overhead()} retrievalIncluded=${reads().length} access=${accessReads()}`);
    expect(accessReads()).toBe(3);
    // Everything that is not retrieval is fixed per search: the fan-out adds none.
    expect(overhead()).toBeLessThanOrEqual(single + 1); // the one extra is result hydration of the wider answer
  });

  it("a batch of 20 for one project resolves and loads the project once, not once per query", { timeout: 30_000 }, async () => {
    const queries = (project?: string) => Array.from({ length: 20 }, (_, i) => ({ q: `quarterly b${i}`, mode: "keyword", ...(project ? { project } : {}) }));
    await post({ queries: queries("00000000-0000-4000-8000-0000000000a1") }); await settled(); statements.length = 0;
    const response = await post({ queries: queries("00000000-0000-4000-8000-0000000000a1") });
    expect(response.status).toBe(200);
    const body = await response.json() as { results: Array<{ ok: boolean }> };
    expect(body.results.every((item) => item.ok)).toBe(true);
    await settled();
    console.info(`[statements] batch20 explicit total=${statements.length} reads=${reads().length} access=${accessReads()}`);
    // One reference lookup, one route decision for the project and one engine read for the whole batch.
    expect(accessReads()).toBe(3);
    statements.length = 0;
    const defaulted = await post({ queries: queries() });
    expect((await defaulted.json() as { results: Array<{ ok: boolean }> }).results.every((item) => item.ok)).toBe(true);
    await settled();
    console.info(`[statements] batch20 default total=${statements.length} reads=${reads().length} access=${accessReads()} resolution=${projectResolution()}`);
    expect(accessReads()).toBe(2);
    expect(projectResolution()).toBeLessThanOrEqual(3);
    expect(projectRecordReads()).toBe(0);
  });
});

describe("access is decided on every request", () => {
  it("refuses the next request once the member is removed, and a forbidden batch item, while the allowed one answers", async () => {
    await sql`insert into "user" (id, name, email) values ('user-c', 'C', 'c@stmts.test') on conflict do nothing`;
    await sql`insert into org_memberships (org_id, user_id, role) values ('org-a', 'user-c', 'member') on conflict do nothing`;
    await sql`insert into project_members (project_id, user_id, role) values ('00000000-0000-4000-8000-0000000000a2', 'user-c', 'viewer') on conflict do nothing`;
    const search = (userId: string) => post({ q: "quarterly", mode: "keyword", project: "00000000-0000-4000-8000-0000000000a2" }, userId);
    expect((await search("user-c")).status).toBe(200);
    await settled();
    await sql`delete from project_members where project_id = '00000000-0000-4000-8000-0000000000a2' and user_id = 'user-c'`;
    expect((await search("user-c")).status).toBe(404);
    // Removed from the organization entirely.
    await sql`delete from org_memberships where org_id = 'org-a' and user_id = 'user-c'`;
    expect((await post({ q: "quarterly", mode: "keyword", project: "00000000-0000-4000-8000-0000000000a1" }, "user-c")).status).toBe(404);

    const mixed = await post({ queries: [
      { q: "quarterly", mode: "keyword", project: "00000000-0000-4000-8000-0000000000a1" },
      { q: "quarterly", mode: "keyword", project: "00000000-0000-4000-8000-0000000000b1" },
      { q: "quarterly", mode: "keyword", project: "00000000-0000-4000-8000-0000000000a1" },
    ] });
    expect(mixed.status).toBe(200);
    const body = await mixed.json() as { results: Array<{ ok: boolean; error?: { code: string }; data?: { results: Array<{ citation: { documentId: string } }> } }> };
    expect(body.results.map((item) => item.ok)).toEqual([true, false, true]);
    expect(body.results[1]!.error?.code).toBe("PROJECT_NOT_FOUND");
    expect(JSON.stringify(body)).not.toMatch(/Zenith|doc-b1/);
    await settled();
  });
});

describe("the per-request project context memo", () => {
  const scope = (orgId: string) => ({ orgId, projectIds: "org" as const, modeCeiling: null });

  it("shares one read inside a request scope and never outside it", async () => {
    statements.length = 0;
    await setup.loadSearchProjectContext("00000000-0000-4000-8000-0000000000a1", "user-a", scope("org-a"));
    await setup.loadSearchProjectContext("00000000-0000-4000-8000-0000000000a1", "user-a", scope("org-a"));
    expect(accessReads()).toBe(2);
    statements.length = 0;
    await setup.withSearchRequestMemo(async () => {
      await setup.loadSearchProjectContext("00000000-0000-4000-8000-0000000000a1", "user-a", scope("org-a"));
      await setup.loadSearchProjectContext("00000000-0000-4000-8000-0000000000a1", "user-a", scope("org-a"));
    });
    expect(accessReads()).toBe(1);
  });

  it("never serves another user, project, organization scope or strictness from a memoized read", async () => {
    await setup.withSearchRequestMemo(async () => {
      const first = await setup.loadSearchProjectContext("00000000-0000-4000-8000-0000000000a1", "user-a", scope("org-a"));
      expect(first.scope).toEqual({ projectId: "00000000-0000-4000-8000-0000000000a1", orgId: "org-a" });
      // Another user of the same project: refused, not served from user-a's read.
      await expect(setup.loadSearchProjectContext("00000000-0000-4000-8000-0000000000a1", "user-b", scope("org-a"))).rejects.toBeInstanceOf(setup.ProjectNotFoundError);
      // Another project the user cannot read.
      await expect(setup.loadSearchProjectContext("00000000-0000-4000-8000-0000000000b1", "user-a", scope("org-a"))).rejects.toBeInstanceOf(setup.ProjectNotFoundError);
      // The right project under another organization's scope.
      await expect(setup.loadSearchProjectContext("00000000-0000-4000-8000-0000000000a1", "user-a", scope("org-b"))).rejects.toBeInstanceOf(setup.ProjectNotFoundError);
      // A narrower project list.
      await expect(setup.loadSearchProjectContext("00000000-0000-4000-8000-0000000000a1", "user-a", { orgId: "org-a", projectIds: ["00000000-0000-4000-8000-0000000000a2"], modeCeiling: null })).rejects.toBeInstanceOf(setup.ProjectNotFoundError);
      // Strict and lenient settings are separate entries.
      statements.length = 0;
      await setup.loadSearchProjectContext("00000000-0000-4000-8000-0000000000a1", "user-a", scope("org-a"), { strictSettings: true });
      expect(accessReads()).toBe(1);
      // A refusal is not kept: it is asked again (and refused again).
      statements.length = 0;
      await expect(setup.loadSearchProjectContext("00000000-0000-4000-8000-0000000000b1", "user-a", scope("org-a"))).rejects.toBeInstanceOf(setup.ProjectNotFoundError);
      expect(accessReads()).toBe(1);
    });
  });

  it("hands each search its own copy, and a later request reads access again", async () => {
    await setup.withSearchRequestMemo(async () => {
      const first = await setup.loadSearchProjectContext("00000000-0000-4000-8000-0000000000a1", "user-a", scope("org-a"));
      first.settings.typoTolerance = !first.settings.typoTolerance;
      first.scope.orgId = "tampered";
      const second = await setup.loadSearchProjectContext("00000000-0000-4000-8000-0000000000a1", "user-a", scope("org-a"));
      expect(second.scope.orgId).toBe("org-a");
      expect(second.settings.typoTolerance).not.toBe(first.settings.typoTolerance);
    });
    statements.length = 0;
    await setup.withSearchRequestMemo(() => setup.loadSearchProjectContext("00000000-0000-4000-8000-0000000000a1", "user-a", scope("org-a")));
    expect(accessReads()).toBe(1);
  });
});

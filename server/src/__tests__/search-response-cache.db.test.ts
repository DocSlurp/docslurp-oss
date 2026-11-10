import postgres from "postgres";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * The POST /v1/search response cache against the real auth middleware, API key
 * validation, project access checks and a migrated Postgres. Only retrieval
 * itself is a stand-in: each answer names the caller and project it was
 * produced for, and every call is counted, so a cached answer reaching the
 * wrong caller (or a strict-privacy answer being cached at all) is visible.
 */

const sqlConnection = vi.hoisted(() => ({ current: null as ReturnType<typeof postgres> | null }));
vi.mock("../db.js", () => ({ get sql() { return sqlConnection.current; } }));
vi.mock("../lib/auth.js", () => ({ auth: { api: { getSession: async () => null } }, appDbPool: null }));
vi.mock("../lib/request-actor.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/request-actor.js")>(),
  // The signed-in browser: `docslurp-test-session=<userId>`.
  resolveBetterAuthSessionActor: async (headers: Headers) => {
    const userId = headers.get("cookie")?.match(/docslurp-test-session=([a-z]+)/)?.[1];
    return userId ? { type: "session", userId, sessionId: `sess-${userId}`, user: { id: userId, email: `${userId}@example.test`, name: userId } } : null;
  },
}));
const notifyHint = vi.hoisted(() => vi.fn());
vi.mock("../search/eligibility-hint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../search/eligibility-hint.js")>();
  return { ...actual, notifySearchEligibilityChanged: async (...args: Parameters<typeof actual.notifySearchEligibilityChanged>) => {
    notifyHint(args[1]);
    return actual.notifySearchEligibilityChanged(...args);
  } };
});
const hybridSearch = vi.hoisted(() => vi.fn());
vi.mock("../services/search.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/search.js")>(),
  hybridSearch,
}));

let stopDb: () => Promise<void>;
let sql: postgres.Sql;
let app: Hono;
let apiKeys: typeof import("../services/api-keys.js");
let routes: typeof import("../routes/search.js");
const keys: Record<string, { id: string; raw: string }> = {};
let defaultProjectA = "";
// Project references that are not UUIDs resolve as slugs, so fixtures use real ids.
const WS = { std: crypto.randomUUID(), local: crypto.randomUUID(), strict: crypto.randomUUID(), carol: crypto.randomUUID() };

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stopDb = database.stop;
  sql = postgres(database.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql;
  sqlConnection.current = sql;
  for (const user of ["alice", "bob", "carol"]) {
    await sql`insert into "user" (id, name, email) values (${user}, ${user}, ${`${user}@example.test`})`;
  }
  for (const org of ["a", "c"]) {
    await sql`insert into organizations (id, name, slug, created_by_user_id) values (${`org-${org}`}, ${`Org ${org}`}, ${`cache-org-${org}`}, ${org === "a" ? "alice" : "carol"})`;
  }
  await sql`insert into org_memberships (org_id, user_id, role) values ('org-a', 'alice', 'owner'), ('org-a', 'bob', 'admin'), ('org-c', 'carol', 'owner')`;
  await sql`insert into projects (id, org_id, user_id, name, pipeline) values
    (${WS.std}, 'org-a', 'alice', 'Standard', '{}'),
    (${WS.local}, 'org-a', 'alice', 'Local', ${sql.json({ privacyMode: "local-only" })}),
    (${WS.strict}, 'org-a', 'alice', 'Strict', ${sql.json({ privacyMode: "strict-privacy" })}),
    (${WS.carol}, 'org-c', 'carol', 'Carol', '{}')`;

  hybridSearch.mockImplementation(async (_q: string, userId: string, options: { filters?: { projectId?: string } }) => ({
    results: [{ id: `hit-for-${userId}-in-${options.filters?.projectId}` }],
    sessionId: crypto.randomUUID(),
    availability: { status: "complete", isPartial: false, scope: { projectId: options.filters?.projectId, runId: null } },
  }));

  apiKeys = await import("../services/api-keys.js");
  routes = await import("../routes/search.js");
  const { ensureDefaultProject } = await import("../services/projects.js");
  defaultProjectA = (await ensureDefaultProject({ userId: "alice", orgId: "org-a" })).id;
  for (const [name, userId, orgId] of [["a1", "alice", "org-a"], ["a2", "alice", "org-a"], ["c1", "carol", "org-c"]] as const) {
    const created = await apiKeys.createApiKey(userId, `cache ${name}`, { orgId });
    keys[name] = { id: created.key.id, raw: created.rawKey };
  }

  const { requestContextMiddleware } = await import("../lib/request-context.js");
  const { sessionAuth } = await import("../middleware/session-auth.js");
  app = new Hono();
  app.use("*", requestContextMiddleware);
  app.use("/v1/*", sessionAuth);
  app.route("/v1/search", routes.searchRoutes);
}, 120_000);

afterAll(async () => { await sql?.end(); await stopDb?.(); });

beforeEach(async () => {
  vi.stubEnv("SEARCH_RESPONSE_CACHE_TTL_MS", "60000");
  // A loaded CI runner must not turn a slow in-process Postgres lookup into a skipped cache.
  vi.stubEnv("SEARCH_RESPONSE_CACHE_LOOKUP_TIMEOUT_MS", "10000");
  routes.clearSearchResponseCacheForTests();
  hybridSearch.mockClear();
  await sql`update projects set pipeline = '{}' where id in (${WS.std}, ${defaultProjectA})`;
});

type Caller = { key: keyof typeof keys } | { session: string };
async function post(caller: Caller, body: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if ("key" in caller) headers.Authorization = `Bearer ${keys[caller.key]!.raw}`;
  else headers.cookie = `docslurp-test-session=${caller.session}`;
  const response = await app.request("/v1/search", { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() };
}
const cachedReplay = (json: any) => json?.timings?.cachedMs === 0;

describe("search response cache privacy", () => {
  it("caches a standard project's identical search", async () => {
    const first = await post({ key: "a1" }, { q: "pump", project: WS.std });
    const second = await post({ key: "a1" }, { q: "pump", project: WS.std });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(hybridSearch).toHaveBeenCalledTimes(1);
    expect(cachedReplay(second.json)).toBe(true);
    expect(second.json.results).toEqual(first.json.results);
  });

  it("keeps caching local-only projects, like the embedding and vector caches", async () => {
    await post({ key: "a1" }, { q: "pump", project: WS.local });
    await post({ key: "a1" }, { q: "pump", project: WS.local });
    expect(hybridSearch).toHaveBeenCalledTimes(1);
  });

  it("never caches a strict-privacy project: both identical requests run retrieval", async () => {
    const first = await post({ key: "a1" }, { q: "pump", project: WS.strict });
    const second = await post({ key: "a1" }, { q: "pump", project: WS.strict });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(hybridSearch).toHaveBeenCalledTimes(2);
    expect(cachedReplay(second.json)).toBe(false);
    // A session caller is held to the same rule.
    await post({ session: "alice" }, { q: "pump", project: WS.strict });
    await post({ session: "alice" }, { q: "pump", project: WS.strict });
    expect(hybridSearch).toHaveBeenCalledTimes(4);
  });

  it("never caches the strict item of a batch that mixes projects", async () => {
    const batch = { queries: [{ q: "pump", project: WS.std }, { q: "pump", project: WS.strict }] };
    const first = await post({ key: "a1" }, batch);
    const second = await post({ key: "a1" }, batch);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(hybridSearch).toHaveBeenCalledTimes(3);
    expect(second.json.results.map((item: any) => cachedReplay(item.data))).toEqual([true, false]);
    const strictCalls = hybridSearch.mock.calls.filter(([, , options]) => options.filters.projectId === WS.strict);
    expect(strictCalls).toHaveLength(2);
  });

  it("never caches the default project when it is strict-privacy and the request names none", async () => {
    await sql`update projects set pipeline = ${sql.json({ privacyMode: "strict-privacy" })} where id = ${defaultProjectA}`;
    await post({ key: "a1" }, { q: "pump" });
    await post({ key: "a1" }, { q: "pump" });
    expect(hybridSearch).toHaveBeenCalledTimes(2);
    expect(hybridSearch.mock.calls.every(([, , options]) => options.filters.projectId === defaultProjectA)).toBe(true);
  });

  it("stops serving a cached answer once the project becomes strict-privacy", async () => {
    await post({ key: "a1" }, { q: "pump", project: WS.std });
    await sql`update projects set pipeline = ${sql.json({ privacyMode: "strict-privacy" })} where id = ${WS.std}`;
    const after = await post({ key: "a1" }, { q: "pump", project: WS.std });
    expect(hybridSearch).toHaveBeenCalledTimes(2);
    expect(cachedReplay(after.json)).toBe(false);
  });

  it("stores nothing when the project turns strict-privacy during a slow search, even after it turns back", async () => {
    const original = hybridSearch.getMockImplementation()!;
    hybridSearch.mockImplementationOnce(async (...args: unknown[]) => {
      // The search is in flight while the owner switches the project to strict-privacy.
      await sql`update projects set pipeline = ${sql.json({ privacyMode: "strict-privacy" })} where id = ${WS.std}`;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return (original as (...a: unknown[]) => unknown)(...args);
    });
    const during = await post({ key: "a1" }, { q: "slow", project: WS.std });
    expect(during.status).toBe(200);
    // Back to standard within the TTL: nothing was stored, so retrieval runs again.
    await sql`update projects set pipeline = '{}' where id = ${WS.std}`;
    const after = await post({ key: "a1" }, { q: "slow", project: WS.std });
    expect(cachedReplay(after.json)).toBe(false);
    expect(hybridSearch).toHaveBeenCalledTimes(2);
  });

  it("stores nothing when the project is invalidated during a slow search", async () => {
    const { invalidateSearchProject } = await import("../search/eligible-documents.js");
    const original = hybridSearch.getMockImplementation()!;
    hybridSearch.mockImplementationOnce(async (...args: unknown[]) => {
      // A settings or document change lands (search_eligibility hint) while the search runs.
      invalidateSearchProject(WS.std);
      return (original as (...a: unknown[]) => unknown)(...args);
    });
    await post({ key: "a1" }, { q: "raced", project: WS.std });
    const after = await post({ key: "a1" }, { q: "raced", project: WS.std });
    expect(cachedReplay(after.json)).toBe(false);
    expect(hybridSearch).toHaveBeenCalledTimes(2);
  });

  it("emits the invalidation hint when project settings or search settings change", async () => {
    const { updateProject } = await import("../services/projects.js");
    const { getProjectSearchSettings, upsertProjectSearchSettings } = await import("../services/search-controls.js");
    notifyHint.mockClear();
    expect(await updateProject(WS.local, "alice", { name: "Local renamed" })).not.toBeNull();
    expect(notifyHint).toHaveBeenLastCalledWith([WS.local]);
    notifyHint.mockClear();
    await upsertProjectSearchSettings(await getProjectSearchSettings(WS.local, "alice"));
    expect(notifyHint).toHaveBeenLastCalledWith([WS.local]);
  });

  it("drops cached answers when a search_eligibility hint names the project", async () => {
    const { handleSearchEligibilityHint } = await import("../search/eligible-documents.js");
    await post({ key: "a1" }, { q: "pump", project: WS.std });
    await post({ key: "a1" }, { q: "pump", project: WS.local });
    handleSearchEligibilityHint(JSON.stringify({ projectIds: [WS.std] }));
    expect(cachedReplay((await post({ key: "a1" }, { q: "pump", project: WS.std })).json)).toBe(false);
    expect(cachedReplay((await post({ key: "a1" }, { q: "pump", project: WS.local })).json)).toBe(true);
    expect(hybridSearch).toHaveBeenCalledTimes(3);
  });
});

describe("search response cache isolation", () => {
  it("never serves one caller's cached answer to another key, user or organization with an identical body", async () => {
    const body = { q: "pump", project: WS.std };
    await post({ key: "a1" }, body);
    expect(hybridSearch).toHaveBeenCalledTimes(1);

    // Same user and org, another key.
    const otherKey = await post({ key: "a2" }, body);
    expect(cachedReplay(otherKey.json)).toBe(false);
    expect(hybridSearch).toHaveBeenCalledTimes(2);
    // Same user through a browser session instead of a key.
    const session = await post({ session: "alice" }, body);
    expect(cachedReplay(session.json)).toBe(false);
    expect(hybridSearch).toHaveBeenCalledTimes(3);
    // Another user in the same org.
    const bob = await post({ session: "bob" }, body);
    expect(cachedReplay(bob.json)).toBe(false);
    expect(bob.json.results).toEqual([{ id: `hit-for-bob-in-${WS.std}` }]);
    expect(hybridSearch).toHaveBeenCalledTimes(4);
    // Another organization: refused outright, by key and by session.
    expect((await post({ key: "c1" }, body)).status).toBe(404);
    expect((await post({ session: "carol" }, body)).status).toBe(404);
    expect(hybridSearch).toHaveBeenCalledTimes(4);
    // Identical body with no project: each org's own default, never the other's answer.
    const aliceDefault = await post({ key: "a1" }, { q: "pump" });
    const carolDefault = await post({ key: "c1" }, { q: "pump" });
    expect(cachedReplay(carolDefault.json)).toBe(false);
    expect(carolDefault.json.results).not.toEqual(aliceDefault.json.results);
    expect(hybridSearch).toHaveBeenCalledTimes(6);
  });

  it("keys on every result-affecting field", async () => {
    await post({ key: "a1" }, { q: "pump", project: WS.std });
    for (const extra of [{ tags: "x" }, { limit: 3 }, { rerank: true }, { minScore: 0.5 }, { documentId: "d" }, { runId: "r" }, { mimeTypes: "text/plain" }]) {
      const response = await post({ key: "a1" }, { q: "pump", project: WS.std, ...extra });
      expect(cachedReplay(response.json)).toBe(false);
    }
    expect(hybridSearch).toHaveBeenCalledTimes(8);
  });

  it("refuses a revoked key even while its cached answer is fresh", async () => {
    const created = await apiKeys.createApiKey("alice", "cache revoked", { orgId: "org-a" });
    keys.revoked = { id: created.key.id, raw: created.rawKey };
    const body = { q: "pump", project: WS.std };
    expect((await post({ key: "revoked" }, body)).status).toBe(200);
    expect(cachedReplay((await post({ key: "revoked" }, body)).json)).toBe(true);
    await apiKeys.revokeApiKey(created.key.id, "alice");
    const refused = await post({ key: "revoked" }, body);
    expect(refused.status).toBe(401);
    expect(refused.json.results).toBeUndefined();
    expect(hybridSearch).toHaveBeenCalledTimes(1);
  });

  it("refuses a key whose scopes or project allowlist no longer cover the cached search", async () => {
    const created = await apiKeys.createApiKey("alice", "cache narrowed", { orgId: "org-a" });
    keys.narrowed = { id: created.key.id, raw: created.rawKey };
    const body = { q: "pump", project: WS.std };
    await post({ key: "narrowed" }, body);
    expect(cachedReplay((await post({ key: "narrowed" }, body)).json)).toBe(true);

    await sql`update api_keys set scopes = ${sql.array(["chat"])} where id = ${created.key.id}`;
    const noScope = await post({ key: "narrowed" }, body);
    expect(noScope.status).toBe(403);
    expect(noScope.json.results).toBeUndefined();

    await sql`update api_keys set scopes = ${sql.array(["search"])}, project_ids = ${sql.array([WS.strict])} where id = ${created.key.id}`;
    const outsideAllowlist = await post({ key: "narrowed" }, body);
    expect(outsideAllowlist.status).toBe(404);
    expect(outsideAllowlist.json.results).toBeUndefined();
    expect(hybridSearch).toHaveBeenCalledTimes(1);
  });

  it("refuses a user removed from the organization even while their cached answer is fresh", async () => {
    const body = { q: "pump", project: WS.std };
    await post({ session: "bob" }, body);
    expect(cachedReplay((await post({ session: "bob" }, body)).json)).toBe(true);
    await sql`delete from org_memberships where org_id = 'org-a' and user_id = 'bob'`;
    try {
      const removed = await post({ session: "bob" }, body);
      expect(removed.status).toBe(404);
      expect(removed.json.results).toBeUndefined();
      expect(hybridSearch).toHaveBeenCalledTimes(1);
    } finally {
      await sql`insert into org_memberships (org_id, user_id, role) values ('org-a', 'bob', 'admin')`;
    }
  });
});

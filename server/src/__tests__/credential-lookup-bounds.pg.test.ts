import postgres from "postgres";
import pg from "pg";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Real PostgreSQL: route-auth credential lookups (API keys and OAuth tokens) run
 * on their own small pool, with statement_timeout and read-only as startup
 * parameters, so each lookup is one round trip that Postgres itself bounds. When
 * the database stalls on the lookup tables, route auth answers 503 within its
 * bounds (acquisition, then statement_timeout), the lookups hold at most the
 * lookup pool's connections, and sign-in (Better Auth's pool) and the request
 * pool are served at once. Needs a migrated, disposable loopback TEST_DATABASE_URL.
 */
const url = process.env.TEST_DATABASE_URL;
const LOOKUP_POOL_MAX = 2;
const KEY = "dslp_priv_bounds_000000000000000000000000000";

describe.skipIf(!url)("credential lookups under a database stall (real PostgreSQL)", () => {
  let sql: postgres.Sql;
  let authPool: pg.Pool;
  let lookup: import("../lib/auth-lookup-pool.js").AuthLookupSql;
  let app: Hono;

  beforeAll(async () => {
    if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Requires a loopback TEST_DATABASE_URL");
    sql = postgres(url, { max: 2, prepare: false, onnotice: () => {} });
    authPool = new pg.Pool({ connectionString: url, max: 3 });
    const pool = await vi.importActual<typeof import("../lib/auth-lookup-pool.js")>("../lib/auth-lookup-pool.js");
    lookup = pool.createAuthLookupSql(url, LOOKUP_POOL_MAX);
    vi.doMock("../db.js", () => ({ sql }));
    vi.doMock("../lib/auth.js", () => ({ appDbPool: authPool, auth: { api: { getSession: async () => null } } }));
    // The real lookup pool (startup parameters and all), pointed at the test database.
    vi.doMock("../lib/auth-lookup-pool.js", () => ({ ...pool, authLookupSql: () => lookup, authLookupPoolMax: () => LOOKUP_POOL_MAX }));
    await sql`insert into "user" (id, name, email) values ('bu', 'B', 'bounds@example.test') on conflict do nothing`;
    await sql`insert into organizations (id, name, slug, created_by_user_id) values ('bo', 'B', 'bounds', 'bu') on conflict do nothing`;
    await sql`insert into org_memberships (org_id, user_id, role) values ('bo', 'bu', 'owner') on conflict do nothing`;
    await sql`insert into api_keys (id, user_id, org_id, key_hash, name, key_type, scopes)
      values ('bk', 'bu', 'bo', ${createHash("sha256").update(KEY).digest("hex")}, 'b', 'server', ${sql.array(["chat"])}) on conflict do nothing`;
    const { requestContextMiddleware } = await import("../lib/request-context.js");
    const { mcpAuth } = await import("../middleware/mcp-auth.js");
    const { apiKeyAuth } = await import("../middleware/api-key-auth.js");
    app = new Hono();
    app.use("*", requestContextMiddleware);
    app.use("/v1/mcp", mcpAuth);
    app.post("/v1/mcp", (c) => c.text("ok"));
    app.use("/v1/whoami", apiKeyAuth);
    app.get("/v1/whoami", (c) => c.text("ok"));
  }, 120_000);
  afterAll(async () => { await lookup?.end(); await sql?.end(); await authPool?.end(); });

  it("bounds and confines every lookup by startup parameters, not per-lookup statements", async () => {
    const [timeout] = await lookup`show statement_timeout`;
    const [readOnly] = await lookup`show default_transaction_read_only`;
    expect(timeout).toEqual({ statement_timeout: "3s" });
    expect(readOnly).toEqual({ default_transaction_read_only: "on" });
    // Postgres itself cancels a long statement at 3 s (57014), and refuses writes.
    const started = Date.now();
    await expect(lookup`select pg_sleep(10)`).rejects.toMatchObject({ code: "57014" });
    expect(Date.now() - started).toBeLessThan(4_500);
    await expect(lookup`update api_keys set name = name where id = 'bk'`).rejects.toMatchObject({ code: "25006" });
  }, 20_000);

  it("answers route auth 503 within its bounds and leaves sign-in and requests unstarved", async () => {
    // A stall: both lookup tables are locked, so every key and token lookup's statement blocks.
    const holder = await sql.reserve();
    await holder`begin`;
    await holder`lock table mcp_oauth_tokens, api_keys in access exclusive mode`;
    try {
      const started = Date.now();
      const timed = (request: Promise<Response> | Response) => Promise.resolve(request)
        .then((response) => ({ status: response.status, retryAfter: response.headers.get("Retry-After"), ms: Date.now() - started }));
      const requests = [
        ...Array.from({ length: 3 }, (_, i) => timed(app.request("/v1/mcp", {
          method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer dsmcp_${"x".repeat(40)}${i}` }, body: "{}",
        }))),
        ...Array.from({ length: 3 }, () => timed(app.request("/v1/whoami", { headers: { Authorization: `Bearer ${KEY}` } }))),
      ];
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Mid-stall: lookups hold only the lookup pool's connections.
      const [{ count }] = await sql`select count(*)::int as count from pg_stat_activity where application_name = 'docslurp-auth-lookup'`;
      expect(count).toBeLessThanOrEqual(LOOKUP_POOL_MAX);
      const signInStarted = Date.now();
      await authPool.query("select 1 as ok");
      await sql`select 1`;
      expect(Date.now() - signInStarted).toBeLessThan(500);
      const outcomes = await Promise.all(requests);
      // Acquisition is bounded (5 s) and the statement by statement_timeout (3 s): every request ends as a
      // retryable 503 within acquisition plus execution.
      for (const outcome of outcomes) {
        expect(outcome.status).toBe(503);
        expect(outcome.retryAfter).toBeTruthy();
        expect(outcome.ms).toBeLessThan(8_500);
      }
    } finally {
      await holder`rollback`;
      holder.release();
    }
    // The stall ends: the pool is healthy and the key authenticates.
    expect((await app.request("/v1/whoami", { headers: { Authorization: `Bearer ${KEY}` } })).status).toBe(200);
  }, 30_000);
});

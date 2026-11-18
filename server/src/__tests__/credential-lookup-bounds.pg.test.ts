import postgres from "postgres";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Real PostgreSQL: credential lookups on the shared auth pool (Better Auth's)
 * stay bounded when the database stalls. A held lock blocks the token lookup's
 * statement; with the lookups' share of the pool saturated, route auth still
 * answers 503 within its bounds (acquisition, then a database-side
 * statement_timeout), and a sign-in query on the same pool is served at once
 * (lookups may hold at most half of it). Needs a migrated, disposable loopback TEST_DATABASE_URL.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("credential lookups under a database stall (real PostgreSQL)", () => {
  let sql: postgres.Sql;
  let authPool: pg.Pool;
  let app: Hono;

  beforeAll(async () => {
    if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Requires a loopback TEST_DATABASE_URL");
    sql = postgres(url, { max: 2, prepare: false, onnotice: () => {} });
    // The auth pool, small so a handful of lookups saturates it.
    authPool = new pg.Pool({ connectionString: url, max: 3 });
    vi.doMock("../db.js", () => ({ sql }));
    vi.doMock("../lib/auth.js", () => ({ appDbPool: authPool, auth: { api: { getSession: async () => null } } }));
    const { requestContextMiddleware } = await import("../lib/request-context.js");
    const { mcpAuth } = await import("../middleware/mcp-auth.js");
    app = new Hono();
    app.use("*", requestContextMiddleware);
    app.use("/v1/mcp", mcpAuth);
    app.post("/v1/mcp", (c) => c.text("ok"));
  }, 120_000);
  afterAll(async () => { await sql?.end(); await authPool?.end(); });

  it("answers route auth 503 within its bounds, and does not starve sign-in beyond them", async () => {
    // A stall: the token table is locked, so every token lookup's statement blocks.
    const holder = await sql.reserve();
    await holder`begin`;
    await holder`lock table mcp_oauth_tokens in access exclusive mode`;
    try {
      const started = Date.now();
      const requests = Array.from({ length: 6 }, (_, i) => Promise.resolve(app.request("/v1/mcp", {
        method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer dsmcp_${"x".repeat(40)}${i}` }, body: "{}",
      })).then((response: Response) => ({ status: response.status, retryAfter: response.headers.get("Retry-After"), ms: Date.now() - started })));
      // A sign-in on the same pool while the lookups hold every connection.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const signInStarted = Date.now();
      const signIn = authPool.query("select 1 as ok").then(() => Date.now() - signInStarted);
      const outcomes = await Promise.all(requests);
      // Acquisition is bounded (5 s) and the statement by statement_timeout (3 s), so every request ends
      // within acquisition + execution (8.5 s), as a retryable 503.
      for (const outcome of outcomes) {
        expect(outcome.status).toBe(503);
        expect(outcome.retryAfter).toBeTruthy();
        expect(outcome.ms).toBeLessThan(8_500);
      }
      // Lookups hold at most half the auth pool, so the sign-in gets a connection at once, mid-stall.
      expect(await signIn).toBeLessThan(1_500);
    } finally {
      await holder`rollback`;
      holder.release();
    }
  }, 30_000);
});

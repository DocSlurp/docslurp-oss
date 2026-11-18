import postgres from "postgres";
import pg from "pg";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Real PostgreSQL: the dedicated credential-lookup pool itself (test-setup.ts
 * routes it to each suite's transport everywhere else). API-key, MCP (`dsmcp_`)
 * and CLI (`dscli_`) lookups through it return exactly what the same lookups
 * return on an ordinary request-pool connection; refused and hostile tokens
 * resolve to nothing; its connections are read-only; and 200 concurrent lookups
 * on its 4 connections all complete and leave every slot free. Needs a migrated,
 * disposable loopback TEST_DATABASE_URL.
 */
const url = process.env.TEST_DATABASE_URL;
const POOL_MAX = 4;
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const KEYS = {
  live: "dslp_priv_pool_live_00000000000000000000000000",
  revoked: "dslp_priv_pool_revoked_000000000000000000000",
  allowlisted: "dslp_priv_pool_allowlist_0000000000000000000",
};

describe.skipIf(!url)("the credential-lookup pool (real PostgreSQL)", () => {
  let lookupPool: import("../lib/auth-lookup-pool.js").AuthLookupSql;
  let requestPool: postgres.Sql;
  let authPool: pg.Pool;
  const target: { current: unknown } = { current: null };
  let keys: typeof import("../services/api-keys.js");
  let oauth: typeof import("../services/mcp-oauth.js");
  let bounded: typeof import("../lib/bounded-lookup.js");
  const tokens = { mcp: "", cli: "" };

  beforeAll(async () => {
    if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Requires a loopback TEST_DATABASE_URL");
    const pool = await vi.importActual<typeof import("../lib/auth-lookup-pool.js")>("../lib/auth-lookup-pool.js");
    const { numericType } = await vi.importActual<typeof import("../lib/api-pool.js")>("../lib/api-pool.js");
    lookupPool = pool.createAuthLookupSql(url, POOL_MAX);
    // An ordinary request-pool connection (the same type parsing, no startup bounds): the reference results.
    requestPool = postgres(url, { max: 4, prepare: false, types: { numeric: numericType }, onnotice: () => {} });
    authPool = new pg.Pool({ connectionString: url, max: 2 });
    target.current = lookupPool;
    vi.doMock("../db.js", () => ({ sql: requestPool }));
    vi.doMock("../lib/auth.js", () => ({ appDbPool: authPool, auth: { api: { getSession: async () => null } } }));
    vi.doMock("../lib/auth-lookup-pool.js", () => ({ ...pool, authLookupSql: () => target.current, authLookupPoolMax: () => POOL_MAX }));
    keys = await import("../services/api-keys.js");
    oauth = await import("../services/mcp-oauth.js");
    bounded = await import("../lib/bounded-lookup.js");

    await requestPool`insert into "user" (id, name, email) values ('pu', 'P', 'pool@example.test') on conflict do nothing`;
    await requestPool`insert into organizations (id, name, slug, created_by_user_id) values ('po', 'P', 'pool', 'pu') on conflict do nothing`;
    await requestPool`insert into org_memberships (org_id, user_id, role) values ('po', 'pu', 'owner') on conflict do nothing`;
    const key = (id: string, raw: string, extra: { revoked?: boolean; ipAllowlist?: string[] } = {}) => requestPool`
      insert into api_keys (id, user_id, org_id, key_hash, name, key_type, scopes, ip_allowlist, revoked_at)
      values (${id}, 'pu', 'po', ${hash(raw)}, ${id}, 'server', ${requestPool.array(["chat", "search:deep"])}, ${requestPool.array(extra.ipAllowlist ?? [])},
        ${extra.revoked ? new Date() : null}) on conflict (id) do nothing`;
    await key("pk-live", KEYS.live);
    await key("pk-revoked", KEYS.revoked, { revoked: true });
    await key("pk-allowlisted", KEYS.allowlisted, { ipAllowlist: ["10.0.0.0/8"] });
    // Real OAuth grants and tokens, made as the service makes them: an MCP grant and a first-party CLI grant.
    const client = await authPool.connect();
    try {
      await client.query("INSERT INTO mcp_oauth_clients(id,name,redirect_uris) VALUES('pool-mcp-client','Pool MCP','[]'::jsonb) ON CONFLICT DO NOTHING");
      const mcpGrant = await oauth.createGrant(client, { clientId: "pool-mcp-client", userId: "pu", orgId: "po", resource: oauth.mcpResource(""), scopes: ["search"], url: "" });
      tokens.mcp = (await oauth.issueTokens(client, mcpGrant, "mcp")).access_token;
      const cliGrant = await oauth.createGrant(client, { clientId: "docslurp-cli", userId: "pu", orgId: "po", resource: oauth.apiResource(""), scopes: ["search"], url: "" });
      tokens.cli = (await oauth.issueTokens(client, cliGrant, "api")).access_token;
    } finally {
      client.release();
    }
  }, 120_000);
  afterAll(async () => { await lookupPool?.end(); await requestPool?.end(); await authPool?.end(); });

  /** The same lookup through the dedicated pool and through a request-pool connection. */
  async function bothPools<T>(lookup: () => Promise<T>): Promise<{ dedicated: T; reference: T }> {
    target.current = lookupPool;
    const dedicated = await lookup();
    target.current = requestPool;
    try {
      return { dedicated, reference: await lookup() };
    } finally {
      target.current = lookupPool;
    }
  }

  it("returns exactly the request pool's results for API keys, dsmcp_ and dscli_ tokens", async () => {
    const apiKey = await bothPools(() => keys.validateApiKey(KEYS.live, { ip: "203.0.113.7" }, { recordUsage: false }));
    expect(apiKey.dedicated).toMatchObject({ keyId: "pk-live", orgId: "po", userId: "pu", keyType: "server" });
    expect(apiKey.dedicated).toEqual(apiKey.reference);
    const mcp = await bothPools(() => oauth.validateMcpToken(tokens.mcp, oauth.mcpResource(""), { ip: "203.0.113.7" }));
    expect(mcp.dedicated).toMatchObject({ orgId: "po", userId: "pu", oauth: { audience: "mcp" } });
    expect(mcp.dedicated).toEqual(mcp.reference);
    const cli = await bothPools(() => oauth.validateOAuthApiToken(tokens.cli, { ip: "203.0.113.7" }));
    expect(cli.dedicated).toMatchObject({ orgId: "po", userId: "pu", oauth: { audience: "api" } });
    expect(cli.dedicated).toEqual(cli.reference);
  });

  it("resolves revoked, unknown and hostile credentials to nothing, and refuses a key used off its allowlist", async () => {
    const hostile = "' or '1'='1";
    for (const lookup of [
      () => keys.validateApiKey(KEYS.revoked, {}, { recordUsage: false }),
      () => keys.validateApiKey("dslp_priv_pool_unknown_00000000000000000000", {}, { recordUsage: false }),
      () => keys.validateApiKey(`dslp_priv_${hostile}`, {}, { recordUsage: false }),
      () => oauth.validateMcpToken(`dsmcp_${hostile}`, oauth.mcpResource("")),
      () => oauth.validateMcpToken("dsmcp_pool_unknown_0000000000000000000000", oauth.mcpResource("")),
      // The right token for another resource (audience) is not this resource's.
      () => oauth.validateMcpToken(tokens.mcp, "https://elsewhere.example/v1/mcp"),
      () => oauth.validateOAuthApiToken(`dscli_${hostile}`),
      () => oauth.validateOAuthApiToken("dscli_pool_unknown_0000000000000000000000"),
    ]) {
      const { dedicated, reference } = await bothPools(lookup);
      expect(dedicated).toBeNull();
      expect(reference).toBeNull();
    }
    // A server key with an IP allowlist, from outside it: refused (as on the request pool).
    await expect(keys.validateApiKey(KEYS.allowlisted, { ip: "203.0.113.7" }, { recordUsage: false })).rejects.toBeInstanceOf(keys.ApiKeyIpNotAllowedError);
    expect(await keys.validateApiKey(KEYS.allowlisted, { ip: "10.1.2.3" }, { recordUsage: false })).toMatchObject({ keyId: "pk-allowlisted" });
  });

  it("is read-only: a write through it fails with 25006", async () => {
    await expect(lookupPool`update api_keys set name = name where id = 'pk-live'`).rejects.toMatchObject({ code: "25006" });
  });

  it("completes 200 concurrent lookups on its 4 connections and leaves every slot free", async () => {
    let peak = 0;
    const sampler = setInterval(() => {
      void requestPool<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where application_name = 'docslurp-auth-lookup'`
        .then(([row]) => { peak = Math.max(peak, row!.n); }, () => {});
    }, 5);
    try {
      const results = await Promise.all(Array.from({ length: 200 }, () => keys.validateApiKey(KEYS.live, {}, { recordUsage: false })));
      expect(results.every((result) => result?.keyId === "pk-live")).toBe(true);
    } finally {
      clearInterval(sampler);
    }
    expect(bounded.lookupSlotsInUse()).toBe(0);
    // The lookups ran on the dedicated pool's connections, never more of them than it has.
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(POOL_MAX);
  });
});

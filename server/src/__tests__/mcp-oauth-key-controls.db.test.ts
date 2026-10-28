import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

// OAuth resources and config.apiUrl derive from the public URL, read at import time; pin it
// before any import so a developer's .env (dotenv never overrides set values) cannot change it.
vi.hoisted(() => {
  for (const name of ["MCP_PUBLIC_URL", "API_URL", "APP_URL", "BETTER_AUTH_URL"]) process.env[name] = "http://localhost:4321";
});

let sql: postgres.Sql;
let stop: () => Promise<void>;
let oauth: typeof import("../services/mcp-oauth.js");
const resource = "https://example.test/v1/mcp";
const context = { ip: "203.0.113.7" };

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/auth.js", () => ({ auth: { api: { getSession: async () => null } }, appDbPool: {
    query: async (query: string, parameters: string[]) => ({ rows: await sql.unsafe(query, parameters) }),
  } }));
  oauth = await import("../services/mcp-oauth.js");
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'oauth-controls@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Org', 'oauth-controls', 'u'), ('other', 'Other', 'oauth-other', 'u')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner'), ('other', 'u', 'owner')`;
  await sql`insert into api_keys (id, user_id, org_id, key_hash, name, key_type, scopes, rate_limit_ppd)
    values ('key', 'u', 'o', 'unexported-key-hash', 'OAuth', 'server', ${sql.array(["search", "chat"])}, 10000)`;
  await sql`insert into mcp_oauth_clients (id, name, redirect_uris) values ('client', 'Client', '[]')`;
  await sql`insert into mcp_oauth_grants (id, client_id, user_id, org_id, resource, scopes, api_key_id)
    values ('grant', 'client', 'u', 'o', ${resource}, '["search", "chat"]', 'key')`;
  await sql`insert into mcp_oauth_tokens (hash, grant_id, kind, expires_at)
    values (${oauth.oauthHash("dsmcp_test")}, 'grant', 'access', now() + interval '1 hour')`;
  await sql`insert into mcp_oauth_tokens (hash, grant_id, kind, expires_at)
    values (${oauth.oauthHash("dscli_test")}, 'grant', 'access', now() + interval '1 hour')`;
}, 120_000);

beforeEach(async () => {
  await sql`update api_keys set expires_at = now() + interval '1 hour', revoked_at = null,
    scopes = ${sql.array(["search", "chat"])}, rate_limit_rpm = 3, rate_limit_ppd = 17,
    ip_allowlist = ${sql.array(["203.0.113.0/24"])}, max_output_tokens = 2000 where id = 'key'`;
  await sql`update mcp_oauth_grants set org_id = 'o', revoked_at = null where id = 'grant'`;
});
afterAll(async () => { await sql?.end(); await stop?.(); });

describe.each(["mcp", "api"])("%s OAuth linked-key controls", (audience) => {
  beforeEach(async () => {
    await sql`update mcp_oauth_grants set client_id = ${audience === "mcp" ? "client" : "docslurp-cli"},
      resource = ${audience === "mcp" ? resource : oauth.apiResource("")} where id = 'grant'`;
  });
  const validate = (ip: string | null = context.ip) => audience === "mcp"
    ? oauth.validateMcpToken("dsmcp_test", resource, { ip })
    : oauth.validateOAuthApiToken("dscli_test", { ip });

  it("applies the live linked key's output cap and later changes", async () => {
    expect(await validate()).toMatchObject({ keyId: "key", maxOutputTokens: 2000 });
    await sql`update api_keys set max_output_tokens = 1000 where id = 'key'`;
    expect(await validate()).toMatchObject({ maxOutputTokens: 1000 });
  });

  it("refuses wrong and unknown IPs even though the access token is live", async () => {
    expect(await validate()).not.toBeNull();
    expect(await validate("198.51.100.1")).toBeNull();
    expect(await validate(null)).toBeNull();
    expect(await (audience === "mcp" ? oauth.validateMcpToken("dsmcp_test", resource) : oauth.validateOAuthApiToken("dscli_test"))).toBeNull();
  });

  it("refuses key expiry and revocation before token expiry", async () => {
    await sql`update api_keys set expires_at = now() - interval '1 second' where id = 'key'`;
    expect(await validate()).toBeNull();
    await sql`update api_keys set expires_at = null, revoked_at = now() where id = 'key'`;
    expect(await validate()).toBeNull();
  });

  it("refuses a key/grant tenant mismatch and wrong resource", async () => {
    await sql`update mcp_oauth_grants set org_id = 'other' where id = 'grant'`;
    expect(await validate()).toBeNull();
    expect(await oauth.validateMcpToken("dsmcp_test", "https://other.test/v1/mcp")).toBeNull();
  });

  it("keeps live scope narrowing and rate caps without fallback permissions", async () => {
    expect(await validate()).toMatchObject({ scopes: ["search", "chat"], rateLimitRpm: 3, rateLimitPpd: 17 });
    await sql`update api_keys set scopes = ${sql.array([])} where id = 'key'`;
    expect(await validate()).toMatchObject({ scopes: [], rateLimitRpm: 3, rateLimitPpd: 17 });
  });
});

it("passes trusted REST request IP context through actor resolution", async () => {
  await sql`update mcp_oauth_grants set client_id = 'docslurp-cli', resource = ${oauth.apiResource("")} where id = 'grant'`;
  const { resolveApiKeyActor } = await import("../lib/request-actor.js");
  expect(await resolveApiKeyActor("Bearer dscli_test", context)).toMatchObject({ apiKey: { maxOutputTokens: 2000, scopes: ["search", "chat"] } });
  expect(await resolveApiKeyActor("Bearer dscli_test", { ip: "198.51.100.1" })).toBeNull();
  expect(await resolveApiKeyActor("Bearer dscli_test")).toBeNull();
});

import { serve } from "@hono/node-server";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * The full MCP authorization flow with the official MCP client SDK over Streamable
 * HTTP, against the real OAuth routes, MCP endpoint and a migrated Postgres:
 * discovery → dynamic registration → authorize with PKCE → consent → token →
 * tool calls → refresh rotation → revocation. Only the signed-in browser session
 * and the document backend behind the tools are stand-ins.
 */

const SESSION_COOKIE = "docslurp-test-session=owner";
const dispatched = vi.hoisted(() => [] as Array<{ path: string; body: unknown; keyId: string; scopes: string[] }>);
const pool = vi.hoisted(() => ({ current: null as Pool | null }));

vi.mock("../lib/auth.js", () => ({
  auth: { api: { getSession: async () => null } },
  get appDbPool() { return pool.current; },
}));
vi.mock("../lib/request-actor.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/request-actor.js")>(),
  // The browser session that approves consent; everything after it is real.
  resolveBetterAuthSessionActor: async (headers: Headers) => headers.get("cookie")?.includes(SESSION_COOKIE)
    ? { type: "session", userId: "owner", sessionId: "sess", user: { id: "owner" } }
    : null,
}));
vi.mock("../middleware/rate-limit.js", () => ({ enforceAuthenticatedApiRateLimit: async () => null }));
vi.mock("../services/mcp-tools.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/mcp-tools.js")>(),
  // The document backend: record which identity reached it and answer like the adapters.
  createMcpDispatcher: (actor: { apiKey: { keyId: string; scopes: string[] } }) => async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    dispatched.push({ path, body, keyId: actor.apiKey.keyId, scopes: actor.apiKey.scopes });
    if (path === "/tools/search") return Response.json({ results: [{ text: "Renewal is annual.", citation: { filename: "contract.pdf", pageNumber: 2 } }] });
    if (path === "/tools/chat") return Response.json({ answer: "Renewal is annual [1].", citations: [{ filename: "contract.pdf", pageNumber: 2 }] });
    return Response.json({ error: "Not found" }, { status: 404 });
  },
}));

let stopDb: () => Promise<void>;
let server: ReturnType<typeof serve>;
let origin = "";
let endpoint: URL;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stopDb = pg.stop;
  const { Pool } = await import("pg");
  // The PGlite socket serves one connection at a time.
  pool.current = new Pool({ connectionString: pg.url, max: 1 });
  await pool.current.query(`insert into "user"(id, name, email) values ('owner', 'Owner', 'owner@example.test')`);
  await pool.current.query(`insert into "session"(id, "expiresAt", token, "userId") values ('sess', now() + interval '1 day', 'session-token', 'owner')`);
  await pool.current.query(`insert into organizations(id, name, slug, created_by_user_id) values ('org', 'Org', 'org', 'owner')`);
  await pool.current.query(`insert into org_memberships(org_id, user_id, role) values ('org', 'owner', 'owner')`);

  const { mcpOAuthMetadataRoutes, mcpOAuthRoutes } = await import("../routes/mcp-oauth.js");
  const { mcpRoutes } = await import("../routes/mcp.js");
  const app = new Hono().route("/", mcpOAuthMetadataRoutes).route("/oauth/mcp", mcpOAuthRoutes).route("/v1/mcp", mcpRoutes);
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  endpoint = new URL("/v1/mcp", origin);
}, 120_000);

afterAll(async () => {
  if (server) {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await pool.current?.end();
  await stopDb?.();
});

beforeEach(() => {
  // The canonical origin is configuration, never the request's Host header.
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("MCP_PUBLIC_URL", origin);
  dispatched.length = 0;
});

/** An MCP client's credential store, with the user's browser played by fetch. */
class TestOAuthProvider implements OAuthClientProvider {
  client?: StoredOAuthClientInformation;
  stored?: StoredOAuthTokens;
  verifier?: string;
  callback?: URLSearchParams;
  discovery?: OAuthDiscoveryState;
  authorizationUrls: URL[] = [];
  constructor(private readonly scope = "search") {}
  get redirectUrl() { return "http://127.0.0.1:53682/callback"; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "DocSlurp MCP SDK test", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: this.scope };
  }
  state() { return "state-123"; }
  clientInformation() { return this.client; }
  saveClientInformation(info: StoredOAuthClientInformation) { this.client = info; }
  tokens() { return this.stored; }
  saveTokens(tokens: StoredOAuthTokens) { this.stored = tokens; }
  saveDiscoveryState(state: OAuthDiscoveryState) { this.discovery = state; }
  discoveryState() { return this.discovery; }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() { return this.verifier!; }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "tokens") this.stored = undefined;
    if (scope === "all" || scope === "client") this.client = undefined;
    if (scope === "all" || scope === "discovery") this.discovery = undefined;
  }
  async redirectToAuthorization(url: URL) {
    this.authorizationUrls.push(url);
    // The browser: the signed-in user opens the authorize URL, sees consent and allows.
    const start = await fetch(url, { redirect: "manual", headers: { cookie: SESSION_COOKIE } });
    expect(start.status).toBe(302);
    const consent = new URL(start.headers.get("location")!, origin);
    const requestId = consent.searchParams.get("request");
    expect(requestId).toBeTruthy();
    const decision = await fetch(new URL("/oauth/mcp/authorize", origin), {
      method: "POST", redirect: "manual",
      headers: { cookie: SESSION_COOKIE, origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request: requestId!, decision: "allow", orgId: "org" }),
    });
    expect(decision.status).toBe(303);
    const back = new URL(decision.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(this.redirectUrl);
    this.callback = back.searchParams;
  }
}

async function connect(provider: TestOAuthProvider) {
  const client = new Client({ name: "docslurp-oauth-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: provider }));
  return client;
}

/** First connection: discovery, registration, consent, then code exchange. */
async function authorize(provider: TestOAuthProvider) {
  const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: provider });
  const first = new Client({ name: "docslurp-oauth-test", version: "1" });
  await expect(first.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
  expect(provider.callback?.get("state")).toBe("state-123");
  expect(provider.callback?.get("iss")).toBe(origin);
  await transport.finishAuth(provider.callback!);
  await first.close().catch(() => {});
}

const tokenRows = async () => (await pool.current!.query<{ kind: string; consumed_at: Date | null }>("select kind, consumed_at from mcp_oauth_tokens order by expires_at")).rows;

describe("MCP OAuth with the official MCP client SDK", () => {
  it("advertises discovery metadata the client can follow", async () => {
    const challenge = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/v1/mcp", scope="search chat read ingest"`);
    const resource = await (await fetch(`${origin}/.well-known/oauth-protected-resource/v1/mcp`)).json();
    expect(resource).toMatchObject({ resource: `${origin}/v1/mcp`, authorization_servers: [origin], bearer_methods_supported: ["header"] });
    const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
    expect(metadata).toMatchObject({ issuer: origin, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true });
    // No standalone SSE stream: 405 without asking for credentials.
    const listen = await fetch(endpoint, { headers: { accept: "text/event-stream" } });
    expect(listen.status).toBe(405);
    expect(listen.headers.get("www-authenticate")).toBeNull();
  });

  it("authorizes, calls tools under the granted scope, rotates refresh tokens and honours revocation", async () => {
    const provider = new TestOAuthProvider();
    await authorize(provider);

    // Registration, PKCE and the audience-bound request reached the server as the spec requires.
    const authorizeUrl = provider.authorizationUrls[0]!;
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("resource")).toBe(`${origin}/v1/mcp`);
    expect(provider.client?.client_id).toBeTruthy();
    expect(provider.stored?.access_token).toMatch(/^dsmcp_/);
    expect(provider.stored?.refresh_token).toMatch(/^dsmcpr_/);
    // The 401 challenge's scope is authoritative for the client (MCP authorization, scope selection).
    expect(provider.stored?.scope).toBe("search chat read ingest");
    // Hashed at rest: no raw token is stored.
    const hashes = (await pool.current!.query<{ hash: string }>("select hash from mcp_oauth_tokens")).rows.map((row) => row.hash);
    expect(hashes).not.toContain(provider.stored!.access_token);
    expect(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);

    const client = await connect(provider);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["search", "chat", "listWorkspaces", "upload"]));
    expect(tools.find((tool) => tool.name === "search")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const search = await client.callTool({ name: "search", arguments: { q: "renewal" } });
    expect(search.isError).toBe(false);
    expect(search.structuredContent).toMatchObject({ results: [{ citation: { filename: "contract.pdf", pageNumber: 2 } }] });
    const chat = await client.callTool({ name: "chat", arguments: { q: "When does it renew?" } });
    expect(chat.structuredContent).toMatchObject({ answer: "Renewal is annual [1]." });
    const grant = (await pool.current!.query<{ api_key_id: string }>("select api_key_id from mcp_oauth_grants")).rows[0]!;
    expect(dispatched.map((call) => call.path)).toEqual(["/tools/search", "/tools/chat"]);
    expect(dispatched.every((call) => call.keyId === grant.api_key_id && call.scopes.join(" ") === "search chat read ingest")).toBe(true);

    // The access token expires: the SDK refreshes on 401 and retries transparently.
    const before = { ...provider.stored! };
    await pool.current!.query("update mcp_oauth_tokens set expires_at = now() - interval '1 second' where kind = 'access'");
    const afterRefresh = await client.callTool({ name: "search", arguments: { q: "renewal" } });
    expect(afterRefresh.isError).toBe(false);
    expect(provider.stored!.access_token).not.toBe(before.access_token);
    expect(provider.stored!.refresh_token).not.toBe(before.refresh_token);
    expect((await tokenRows()).filter((row) => row.kind === "refresh" && row.consumed_at)).toHaveLength(1);
    await client.close();

    // The user revokes: the token stops working with an RFC 6750 invalid_token challenge.
    const revoke = await fetch(`${origin}/oauth/mcp/revoke`, { method: "POST", body: new URLSearchParams({ token: provider.stored!.refresh_token!, client_id: provider.client!.client_id }) });
    expect(revoke.status).toBe(200);
    const refused = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${provider.stored!.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(refused.status).toBe(401);
    const challenge = refused.headers.get("www-authenticate")!;
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/v1/mcp"`);
    // A revoked grant cannot be refreshed either; the client must re-authorize.
    const refresh = await fetch(`${origin}/oauth/mcp/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: provider.stored!.refresh_token!, client_id: provider.client!.client_id, resource: `${origin}/v1/mcp` }) });
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("re-authorizes through the browser when the stored refresh token is dead instead of looping", async () => {
    const provider = new TestOAuthProvider("search");
    await authorize(provider);
    await pool.current!.query("update mcp_oauth_grants set revoked_at = now()");
    await pool.current!.query("update mcp_oauth_tokens set expires_at = now() - interval '1 second' where kind = 'access'");
    // 401 → refresh → invalid_grant → the SDK drops the tokens and starts a new authorization.
    const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: provider });
    const client = new Client({ name: "docslurp-oauth-test", version: "1" });
    await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.authorizationUrls).toHaveLength(2);
    await transport.finishAuth(provider.callback!);
    const reconnected = await connect(provider);
    expect((await reconnected.callTool({ name: "search", arguments: { q: "renewal" } })).isError).toBe(false);
    await reconnected.close();
  });

  it("refuses a racing duplicate refresh without revoking, but revokes the grant on a later replay", async () => {
    const provider = new TestOAuthProvider("search");
    await authorize(provider);
    const clientId = provider.client!.client_id;
    const refresh = (token: string) => fetch(`${origin}/oauth/mcp/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId }) });
    const original = provider.stored!.refresh_token!;
    const rotated = await refresh(original);
    expect(rotated.status).toBe(200);
    const next = await rotated.json() as { refresh_token: string; access_token: string };

    // Two processes sharing a credential store both refresh: the loser is refused, the winner keeps working.
    const duplicate = await refresh(original);
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ error: "invalid_grant" });
    const grantState = async () => (await pool.current!.query<{ revoked_at: Date | null }>("select g.revoked_at from mcp_oauth_grants g join mcp_oauth_clients c on c.id = g.client_id where c.id = $1", [clientId])).rows[0]!.revoked_at;
    expect(await grantState()).toBeNull();

    // Past the leeway, presenting a rotated token is treated as theft (OAuth 2.1 §4.3.1).
    await pool.current!.query("update mcp_oauth_tokens set consumed_at = now() - interval '5 minutes' where consumed_at is not null");
    expect((await refresh(original)).status).toBe(400);
    expect(await grantState()).not.toBeNull();
    expect((await refresh(next.refresh_token)).status).toBe(400);
  });
});

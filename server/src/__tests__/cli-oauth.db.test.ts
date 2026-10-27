import { serve } from "@hono/node-server";
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * The first-party CLI OAuth flows (docslurp login) against the real OAuth
 * routes, REST auth middleware and a migrated Postgres: authorization code
 * with PKCE and loopback redirect, the device authorization grant (RFC 8628),
 * REST-audience tokens on /v1 with mapped scopes, and every negative case the
 * identity boundary requires. Only the browser session and the default
 * workspace lookup are stand-ins.
 */

const pool = vi.hoisted(() => ({ current: null as Pool | null }));
vi.mock("../lib/auth.js", () => ({
  auth: { api: { getSession: async () => null } },
  get appDbPool() { return pool.current; },
}));
vi.mock("../lib/request-actor.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/request-actor.js")>(),
  // The signed-in browser: `docslurp-test-session=<userId>`.
  resolveBetterAuthSessionActor: async (headers: Headers) => {
    const userId = headers.get("cookie")?.match(/docslurp-test-session=([a-z]+)/)?.[1];
    return userId ? { type: "session", userId, sessionId: `sess-${userId}`, user: { id: userId, email: `${userId}@example.test`, name: userId } } : null;
  },
}));
vi.mock("../middleware/rate-limit.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../middleware/rate-limit.js")>(),
  enforceAuthenticatedApiRateLimit: async () => null,
}));
vi.mock("../services/workspaces.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/workspaces.js")>(),
  findDefaultWorkspace: async ({ orgId }: { orgId: string }) => ({ id: `ws-${orgId}`, name: `Default ${orgId}`, slug: "default", orgId }),
}));

let stopDb: () => Promise<void>;
let server: ReturnType<typeof serve>;
let origin = "";
let api: string;
let mcp: string;
let requestActor: typeof import("../lib/request-actor.js");
let oauth: typeof import("../services/mcp-oauth.js");

const CLIENT = "docslurp-cli";
const REDIRECT = "http://127.0.0.1:53999/callback";
const cookie = (user: string) => `docslurp-test-session=${user}`;
const q = (sqlText: string, params: unknown[] = []) => pool.current!.query(sqlText, params);

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stopDb = pg.stop;
  const { Pool } = await import("pg");
  pool.current = new Pool({ connectionString: pg.url, max: 1 });
  for (const user of ["owner", "other"]) {
    await q(`insert into "user"(id, name, email) values ($1, $1, $1 || '@example.test')`, [user]);
    await q(`insert into "session"(id, "expiresAt", token, "userId") values ('sess-' || $1, now() + interval '1 day', 'tok-' || $1, $1)`, [user]);
    await q(`insert into organizations(id, name, slug, created_by_user_id) values ('org-' || $1, 'Org ' || $1, 'org-' || $1, $1)`, [user]);
    await q(`insert into org_memberships(org_id, user_id, role) values ('org-' || $1, $1, 'owner')`, [user]);
  }

  requestActor = await import("../lib/request-actor.js");
  oauth = await import("../services/mcp-oauth.js");
  const { mcpOAuthMetadataRoutes, mcpOAuthRoutes } = await import("../routes/mcp-oauth.js");
  const { mcpRoutes } = await import("../routes/mcp.js");
  const { sessionAuth } = await import("../middleware/session-auth.js");
  const { whoamiRoutes } = await import("../routes/whoami.js");
  const { uploadsRoutes } = await import("../routes/uploads.js");
  const { workspacesRoutes } = await import("../routes/workspaces.js");
  const app = new Hono();
  app.use("/v1/*", sessionAuth);
  app.route("/", mcpOAuthMetadataRoutes).route("/oauth/mcp", mcpOAuthRoutes)
    .route("/v1/whoami", whoamiRoutes).route("/v1/uploads", uploadsRoutes)
    .route("/v1/workspaces", workspacesRoutes).route("/v1/mcp", mcpRoutes);
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api = `${origin}/v1`;
  mcp = `${origin}/v1/mcp`;
}, 120_000);

afterAll(async () => {
  if (server) {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await pool.current?.end();
  await stopDb?.();
});

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("MCP_PUBLIC_URL", origin);
  await q("delete from mcp_oauth_device_attempts");
});

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

const form = (values: Record<string, string>) => new URLSearchParams(values);

async function token(values: Record<string, string>) {
  const response = await fetch(`${origin}/oauth/mcp/token`, { method: "POST", body: form({ client_id: CLIENT, resource: api, ...values }) });
  return { status: response.status, body: await response.json() as Record<string, string> };
}

/** Authorize + consent as `user`, returning the loopback callback parameters. */
async function authorize(options: { user?: string; scope?: string; org?: string; redirect?: string; resource?: string; clientId?: string } = {}) {
  const user = options.user ?? "owner";
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("base64url");
  const params = new URLSearchParams({
    client_id: options.clientId ?? CLIENT, redirect_uri: options.redirect ?? REDIRECT, response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256", resource: options.resource ?? api,
    scope: options.scope ?? "search read", state,
  });
  const start = await fetch(`${origin}/oauth/mcp/authorize?${params}`, { headers: { cookie: cookie(user) }, redirect: "manual" });
  const location = start.headers.get("location") ?? "";
  const requestId = new URL(location, origin).searchParams.get("request");
  if (!requestId) return { start, verifier, state, callback: null as URLSearchParams | null };
  const decision = await fetch(`${origin}/oauth/mcp/authorize`, {
    method: "POST", redirect: "manual",
    headers: { cookie: cookie(user), origin },
    body: form({ request: requestId, decision: "allow", orgId: options.org ?? `org-${user}` }),
  });
  const callbackUrl = new URL(decision.headers.get("location") ?? "/", origin);
  const callback = callbackUrl.searchParams.has("code") ? callbackUrl.searchParams : null;
  return { start, verifier, state, callback };
}

async function login(options: Parameters<typeof authorize>[0] = {}) {
  const { verifier, callback } = await authorize(options);
  const exchanged = await token({ grant_type: "authorization_code", code: callback!.get("code")!, redirect_uri: options.redirect ?? REDIRECT, code_verifier: verifier });
  expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
  return exchanged.body;
}

const whoami = (access: string) => fetch(`${api}/whoami`, { headers: { authorization: `Bearer ${access}` } });

describe("authorization code flow for the CLI", () => {
  it("issues REST-audience tokens bound to the user and org, with state and issuer echoed", async () => {
    const { verifier, state, callback } = await authorize({ scope: "search read" });
    expect(callback!.get("state")).toBe(state);
    expect(callback!.get("iss")).toBe(origin);
    const issued = await token({ grant_type: "authorization_code", code: callback!.get("code")!, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(issued.status).toBe(200);
    expect(issued.body.access_token.startsWith("dscli_")).toBe(true);
    expect(issued.body.refresh_token.startsWith("dsclir_")).toBe(true);
    expect(issued.body.expires_in).toBe(900);
    const me = await whoami(issued.body.access_token);
    expect(me.status).toBe(200);
    const body = await me.json() as Record<string, any>;
    expect(body.user).toMatchObject({ id: "owner", email: "owner@example.test" });
    expect(body.organization).toMatchObject({ id: "org-owner" });
    expect(body.defaultWorkspace).toMatchObject({ id: "ws-org-owner" });
    expect(body.credential).toMatchObject({ type: "oauth", client: "DocSlurp CLI", scopes: ["search", "read"], apiKeyScopes: ["search", "artifacts"] });
    expect(Date.parse(body.credential.expiresAt)).toBeGreaterThan(Date.now());
    expect(JSON.stringify(body)).not.toContain(issued.body.access_token);
  });

  it("refuses a PKCE verifier mismatch", async () => {
    const { callback } = await authorize();
    const result = await token({ grant_type: "authorization_code", code: callback!.get("code")!, redirect_uri: REDIRECT, code_verifier: pkce().verifier });
    expect(result).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
  });

  it("refuses a redirect to a non-loopback host, before any consent", async () => {
    for (const redirect of ["https://attacker.example/callback", "http://attacker.example/callback", "http://127.0.0.1.attacker.example/callback", "http://127.0.0.1:5000/other"]) {
      const { start, callback } = await authorize({ redirect });
      expect(start.status, redirect).toBe(400);
      expect(callback).toBeNull();
    }
  });

  it("refuses code reuse and revokes the grant it minted", async () => {
    const { verifier, callback } = await authorize();
    const code = callback!.get("code")!;
    const first = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(first.status).toBe(200);
    const second = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(second).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect((await whoami(first.body.access_token)).status).toBe(401);
  });

  it("rotates refresh tokens, and a replayed refresh token revokes the whole grant", async () => {
    const issued = await login();
    const rotated = await token({ grant_type: "refresh_token", refresh_token: issued.refresh_token });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(issued.refresh_token);
    // Past the client-race leeway, the old refresh token is a theft signal.
    await q("update mcp_oauth_tokens set consumed_at = now() - interval '5 minutes' where hash = $1", [oauth.oauthHash(issued.refresh_token)]);
    const replay = await token({ grant_type: "refresh_token", refresh_token: issued.refresh_token });
    expect(replay).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect((await whoami(rotated.body.access_token)).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: rotated.body.refresh_token })).status).toBe(400);
  });

  it("refuses a revoked grant (RFC 7009 revocation, as `docslurp logout` does)", async () => {
    const issued = await login();
    const revoked = await fetch(`${origin}/oauth/mcp/revoke`, { method: "POST", body: form({ token: issued.refresh_token, client_id: CLIENT }) });
    expect(revoked.status).toBe(200);
    expect((await whoami(issued.access_token)).status).toBe(401);
    expect(await token({ grant_type: "refresh_token", refresh_token: issued.refresh_token })).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
  });

  it("refuses an expired access token with 401 invalid_token, on /v1 and on compat routes", async () => {
    const issued = await login();
    await q("update mcp_oauth_tokens set expires_at = now() - interval '1 second' where hash = $1", [oauth.oauthHash(issued.access_token)]);
    const rest = await whoami(issued.access_token);
    expect(rest.status).toBe(401);
    expect(rest.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const { apiKeyAuth } = await import("../middleware/api-key-auth.js");
    const compat = new Hono().use("*", apiKeyAuth).get("/", (c) => c.text("ok"));
    const refused = await compat.request("/", { headers: { authorization: `Bearer ${issued.access_token}` } });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("binds a token to its own user and org, and drops it when membership ends", async () => {
    const owner = await login({ user: "owner" });
    const other = await login({ user: "other" });
    const ownerMe = await (await whoami(owner.access_token)).json() as Record<string, any>;
    const otherMe = await (await whoami(other.access_token)).json() as Record<string, any>;
    expect(ownerMe.organization.id).toBe("org-owner");
    expect(otherMe.organization.id).toBe("org-other");
    // `other` cannot approve a grant into an organization it does not belong to.
    const { callback } = await authorize({ user: "other", org: "org-owner" });
    expect(callback).toBeNull();
    // Leaving the organization invalidates the token at once.
    await q("insert into org_memberships(org_id, user_id, role) values ('org-owner', 'other', 'member')");
    const joined = await login({ user: "other", org: "org-owner" });
    expect((await whoami(joined.access_token)).status).toBe(200);
    await q("delete from org_memberships where org_id = 'org-owner' and user_id = 'other'");
    expect((await whoami(joined.access_token)).status).toBe(401);
  });

  it("never accepts an MCP-audience token on the REST API", async () => {
    const registered = await (await fetch(`${origin}/oauth/mcp/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Some MCP client", redirect_uris: ["http://127.0.0.1/callback"] }),
    })).json() as { client_id: string };
    const { verifier, callback } = await authorize({ clientId: registered.client_id, resource: mcp, scope: "search" });
    const issued = await fetch(`${origin}/oauth/mcp/token`, { method: "POST", body: form({ client_id: registered.client_id, resource: mcp, grant_type: "authorization_code", code: callback!.get("code")!, redirect_uri: REDIRECT, code_verifier: verifier }) });
    const tokens = await issued.json() as Record<string, string>;
    expect(tokens.access_token.startsWith("dsmcp_")).toBe(true);
    expect((await whoami(tokens.access_token)).status).toBe(401);
  });

  it("refuses the REST audience to a dynamically registered client", async () => {
    const registered = await (await fetch(`${origin}/oauth/mcp/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "DocSlurp CLI", redirect_uris: ["http://127.0.0.1/callback"] }),
    })).json() as { client_id: string };
    const { start, callback } = await authorize({ clientId: registered.client_id, resource: api });
    expect(start.status).toBe(400);
    expect(callback).toBeNull();
    const device = await fetch(`${origin}/oauth/mcp/device_authorization`, { method: "POST", body: form({ client_id: registered.client_id, resource: mcp, scope: "search" }) });
    expect(device.status).toBe(401);
  });
});

describe("delegated tokens are never platform admins", () => {
  it("an MCP-audience or CLI token of an admin user has no admin or chat eval access", async () => {
    vi.stubEnv("ADMIN_EMAILS", "owner@example.test");
    await q(`update "user" set "emailVerified" = true where id = 'owner'`);
    try {
      const { chatEvalAccess } = await import("../lib/chat-model-policy.js");
      const keyRow = (await q("select id from mcp_oauth_grants where user_id = 'owner' limit 1")).rows[0];
      expect(keyRow).toBeTruthy();
      // Control: a plain server key of the same user is an admin.
      const plain = { type: "apiKey" as const, userId: "owner", apiKey: { keyId: "k", userId: "owner", orgId: "org-owner", keyType: "server" as const, allowedDomains: [], scopes: ["search"], rateLimitRpm: null, rateLimitPpd: 1, rateLimits: [], workspaceIds: [] } };
      expect(await requestActor.isPlatformAdminActor(plain)).toBe(true);

      const registered = await (await fetch(`${origin}/oauth/mcp/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Admin MCP", redirect_uris: ["http://127.0.0.1/callback"] }) })).json() as { client_id: string };
      const { verifier, callback } = await authorize({ clientId: registered.client_id, resource: mcp, scope: "search chat" });
      const tokens = await (await fetch(`${origin}/oauth/mcp/token`, { method: "POST", body: form({ client_id: registered.client_id, resource: mcp, grant_type: "authorization_code", code: callback!.get("code")!, redirect_uri: REDIRECT, code_verifier: verifier }) })).json() as Record<string, string>;
      const mcpKey = await oauth.validateMcpToken(tokens.access_token, mcp);
      expect(mcpKey?.oauth?.audience).toBe("mcp");
      const mcpActor = { type: "apiKey" as const, userId: "owner", apiKey: mcpKey! };
      expect(await requestActor.isPlatformAdminActor(mcpActor)).toBe(false);
      expect(await chatEvalAccess(mcpActor, "ws-org-owner")).toBe(false);

      const cli = await login({ scope: "search chat" });
      const cliActor = await requestActor.resolveApiKeyActor(`Bearer ${cli.access_token}`);
      expect(await requestActor.isPlatformAdminActor(cliActor!)).toBe(false);
      expect(await chatEvalAccess(cliActor!, "ws-org-owner")).toBe(false);
    } finally {
      await q(`update "user" set "emailVerified" = false where id = 'owner'`);
    }
  });
});

describe("scope mapping on the REST API", () => {
  it("CLI tokens need the web scope for paid web tools; MCP tokens keep search", async () => {
    const { apiKeyCanUseWebTools } = await import("../lib/web-tool-access.js");
    const searchOnly = await requestActor.resolveApiKeyActor(`Bearer ${(await login({ scope: "search" })).access_token}`);
    expect(apiKeyCanUseWebTools(searchOnly!.apiKey)).toBe(false);
    const withWeb = await requestActor.resolveApiKeyActor(`Bearer ${(await login({ scope: "search web" })).access_token}`);
    expect(apiKeyCanUseWebTools(withWeb!.apiKey)).toBe(true);
    expect(apiKeyCanUseWebTools(withWeb!.apiKey, true)).toBe(false);
    expect(apiKeyCanUseWebTools({ scopes: ["search"], keyType: "server", oauth: { audience: "mcp" } })).toBe(true);
  });

  it("maps OAuth scopes to API-key scopes and never to settings or organization scopes", () => {
    expect(oauth.oauthScopesToApiKeyScopes(["search", "chat", "read", "ingest"]).sort()).toEqual(["artifacts", "chat", "ingest", "search"]);
    expect(oauth.oauthScopesToApiKeyScopes(["read"])).toEqual(["artifacts"]);
    expect(oauth.oauthScopesToApiKeyScopes(["workspaces:manage", "organizations:manage", "admin"])).toEqual([]);
    expect(oauth.oauthScopesToApiKeyScopes(["web"])).toEqual(["web"]);
  });

  it("a read token cannot upload", async () => {
    const issued = await login({ scope: "read" });
    const upload = await fetch(`${api}/uploads/bulk`, { method: "POST", headers: { authorization: `Bearer ${issued.access_token}` }, body: new FormData() });
    expect(upload.status).toBe(403);
    // Control: the same request with ingest gets past the scope check (and fails on the empty body).
    const ingest = await login({ scope: "ingest" });
    const allowed = await fetch(`${api}/uploads/bulk`, { method: "POST", headers: { authorization: `Bearer ${ingest.access_token}` }, body: new FormData() });
    expect([401, 403]).not.toContain(allowed.status);
    const tools = await (await fetch(`${mcp}/tools`, { headers: { authorization: `Bearer ${issued.access_token}` } })).json() as { tools?: Array<{ id: string }> };
    expect((tools.tools ?? []).map((tool) => tool.id)).not.toContain("upload");
  });

  it("an ingest token cannot change workspace settings", async () => {
    const issued = await login({ scope: "search read ingest chat" });
    const headers = { authorization: `Bearer ${issued.access_token}`, "content-type": "application/json" };
    const patch = await fetch(`${api}/workspaces/ws-org-owner`, { method: "PATCH", headers, body: JSON.stringify({ name: "renamed" }) });
    expect(patch.status).toBe(403);
    const apply = await fetch(`${api}/workspaces/ws-org-owner/ingest-report/apply`, { method: "POST", headers, body: JSON.stringify({ recommendationId: "x" }) });
    expect([400, 403]).toContain(apply.status);
    expect(apply.status).not.toBe(200);
  });

  it("a CLI token is never a first-party app session and never reaches the settings tools", async () => {
    const issued = await login({ scope: "search read ingest chat" });
    const actor = await requestActor.resolveApiKeyActor(`Bearer ${issued.access_token}`);
    expect(actor?.type).toBe("apiKey");
    expect(actor && "sessionId" in actor).toBe(false);
    expect(actor?.apiKey.scopes).not.toContain("workspaces:manage");
    expect(await requestActor.isPlatformAdminActor(actor!)).toBe(false);
    const tools = await (await fetch(`${mcp}/tools`, { headers: { authorization: `Bearer ${issued.access_token}` } })).json() as { tools?: Array<{ id: string }> };
    const names = (tools.tools ?? []).map((tool) => tool.id);
    expect(names).toContain("search");
    expect(names).not.toContain("proposeWorkspaceSettings");
    const call = await fetch(`${mcp}/tools/proposeWorkspaceSettings`, { method: "POST", headers: { authorization: `Bearer ${issued.access_token}`, "content-type": "application/json" }, body: "{}" });
    expect(call.status).not.toBe(200);
    // Session-only settings routes ignore the bearer token entirely.
    const proposals = await fetch(`${api}/workspaces/ws-org-owner/settings-proposals/apply`, { method: "POST", headers: { authorization: `Bearer ${issued.access_token}`, "content-type": "application/json" }, body: "{}" });
    expect(proposals.status).not.toBe(200);
  });
});

async function startDevice(scope = "search read") {
  const response = await fetch(`${origin}/oauth/mcp/device_authorization`, { method: "POST", body: form({ client_id: CLIENT, resource: api, scope }) });
  expect(response.status).toBe(200);
  return await response.json() as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; interval: number; expires_in: number };
}

const verify = (user: string, values: Record<string, string>) => fetch(`${origin}/oauth/mcp/device`, {
  method: "POST", headers: { cookie: cookie(user), origin }, body: form(values),
});
const poll = (deviceCode: string) => token({ grant_type: oauth.DEVICE_CODE_GRANT_TYPE, device_code: deviceCode });
const allowNextPoll = (deviceCode: string) => q("update mcp_oauth_device_codes set last_polled_at = now() - interval '1 hour' where device_code_hash = $1", [oauth.oauthHash(deviceCode)]);

describe("device authorization grant", () => {
  it("issues short, unambiguous user codes", () => {
    for (let i = 0; i < 200; i++) {
      const code = oauth.generateUserCode();
      expect(code).toMatch(/^[CDFGHJKMNPRTVWXY3479]{4}-[CDFGHJKMNPRTVWXY3479]{4}$/);
      expect(code).not.toMatch(/[0OQ1IL5S2Z8B6AEU]/);
    }
    expect(oauth.normalizeUserCode("wdjb mjht")).toBeNull();
    expect(oauth.normalizeUserCode("cdfg-hjkm")).toBe("CDFGHJKM");
  });

  it("completes with authorization_pending, slow_down and one-time approval", async () => {
    const started = await startDevice();
    expect(started.verification_uri).toBe(`${origin}/oauth/mcp/device`);
    // No one-click link with the code filled in: the user must type it (anti-phishing).
    expect(started.verification_uri_complete).toBeUndefined();
    expect(await poll(started.device_code)).toMatchObject({ status: 400, body: { error: "authorization_pending" } });
    expect(await poll(started.device_code)).toMatchObject({ status: 400, body: { error: "slow_down" } });
    const interval = (await q("select interval_seconds from mcp_oauth_device_codes where device_code_hash = $1", [oauth.oauthHash(started.device_code)])).rows[0].interval_seconds;
    expect(interval).toBe(started.interval + 5);

    // Signed-out visitors get a sign-in link that returns to the page; a code in the query is never prefilled.
    const crafted = `${started.verification_uri}?user_code=${encodeURIComponent(started.user_code)}`;
    const signedOut = await fetch(crafted);
    expect(signedOut.status).toBe(403);
    expect(await signedOut.text()).toContain(`/app/mcp/authorize?authorize=${encodeURIComponent("/oauth/mcp/device")}`);
    const opened = await fetch(crafted, { headers: { cookie: cookie("owner") } });
    expect(opened.headers.get("x-frame-options")).toBe("DENY");
    // same-origin, so the browser sends a real Origin on the form POST (no-referrer sends `Origin: null`).
    expect(opened.headers.get("referrer-policy")).toBe("same-origin");
    expect(await opened.text()).not.toContain(started.user_code);

    const confirm = await verify("owner", { action: "lookup", user_code: started.user_code.toLowerCase() });
    const page = await confirm.text();
    expect(confirm.status).toBe(200);
    expect(page).toContain("DocSlurp CLI");
    expect(page).toContain(started.user_code);
    expect(page).toContain("Read document text");
    expect(page).toMatch(/Requested (just now|\d+ minutes? ago)/);
    expect(page).toContain("from IP");
    expect((await verify("owner", { action: "approve", user_code: started.user_code, orgId: "org-owner" })).status).toBe(200);

    // A second approval (by anyone) is refused and counts as a failed attempt.
    expect((await verify("other", { action: "approve", user_code: started.user_code, orgId: "org-other" })).status).toBe(400);

    await allowNextPoll(started.device_code);
    const issued = await poll(started.device_code);
    expect(issued.status).toBe(200);
    expect(issued.body.access_token.startsWith("dscli_")).toBe(true);
    const me = await (await whoami(issued.body.access_token)).json() as Record<string, any>;
    expect(me.organization.id).toBe("org-owner");
    expect(me.credential.scopes).toEqual(["search", "read"]);

    // Redeeming the device code again revokes the grant it produced.
    await allowNextPoll(started.device_code);
    expect(await poll(started.device_code)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect((await whoami(issued.body.access_token)).status).toBe(401);
  });

  it("answers expired_token for an expired device code and refuses to approve it", async () => {
    const started = await startDevice();
    await q("update mcp_oauth_device_codes set expires_at = now() - interval '1 second' where device_code_hash = $1", [oauth.oauthHash(started.device_code)]);
    expect((await verify("owner", { action: "approve", user_code: started.user_code, orgId: "org-owner" })).status).toBe(400);
    expect(await poll(started.device_code)).toMatchObject({ status: 400, body: { error: "expired_token" } });
  });

  it("refuses a wrong code and a wrong client, and access_denied after a denial", async () => {
    const started = await startDevice();
    const wrong = await verify("owner", { action: "lookup", user_code: "CDFG-HJKM" === started.user_code ? "HJKM-CDFG" : "CDFG-HJKM" });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("not recognised");
    expect((await fetch(`${origin}/oauth/mcp/token`, { method: "POST", body: form({ client_id: "someone-else", resource: api, grant_type: oauth.DEVICE_CODE_GRANT_TYPE, device_code: started.device_code }) })).status).toBe(400);
    expect((await verify("owner", { action: "deny", user_code: started.user_code })).status).toBe(200);
    expect(await poll(started.device_code)).toMatchObject({ status: 400, body: { error: "access_denied" } });
  });

  it("locks a user out after repeated wrong codes, even for a correct code", async () => {
    const started = await startDevice();
    let last: Response | null = null;
    for (let i = 0; i < 5; i++) last = await verify("owner", { action: "lookup", user_code: `CDFG-${["HJKM", "HJKN", "HJKP", "HJKR", "HJKT"][i]}` });
    expect(last!.status).toBe(429);
    const correct = await verify("owner", { action: "approve", user_code: started.user_code, orgId: "org-owner" });
    expect(correct.status).toBe(429);
    expect(await poll(started.device_code)).toMatchObject({ status: 400, body: { error: "authorization_pending" } });
    // The lockout is per user: another account is unaffected.
    expect((await verify("other", { action: "lookup", user_code: started.user_code })).status).toBe(200);
  });

  it("requires the canonical Origin on verification posts, explaining a null or missing Origin", async () => {
    const started = await startDevice();
    for (const headers of [{ origin: "https://attacker.example" }, { origin: "null" }, {}] as Array<Record<string, string>>) {
      const refused = await fetch(`${origin}/oauth/mcp/device`, { method: "POST", headers: { cookie: cookie("owner"), ...headers }, body: form({ action: "approve", user_code: started.user_code, orgId: "org-owner" }) });
      expect(refused.status, JSON.stringify(headers)).toBe(403);
      const text = await refused.text();
      expect(text).toContain("Request refused");
      if (headers.origin !== "https://attacker.example") expect(text).toContain("did not say which site sent this form");
    }
    expect(await poll(started.device_code)).toMatchObject({ status: 400, body: { error: "authorization_pending" } });
    // The same POST from the page's own origin goes through.
    expect((await verify("owner", { action: "approve", user_code: started.user_code, orgId: "org-owner" })).status).toBe(200);
  });

  it("caps a device grant at search and read unless the approver opts in", async () => {
    const capped = await startDevice("search read chat ingest web");
    const confirm = await (await verify("owner", { action: "lookup", user_code: capped.user_code })).text();
    expect(confirm).toContain('name="optIn" value="chat"');
    expect(confirm).toContain('name="optIn" value="ingest"');
    expect(confirm).not.toMatch(/name="optIn"[^>]*checked/);
    expect((await verify("owner", { action: "approve", user_code: capped.user_code, orgId: "org-owner" })).status).toBe(200);
    await allowNextPoll(capped.device_code);
    const cappedTokens = await poll(capped.device_code);
    expect(cappedTokens.body.scope).toBe("search read");

    const opted = await startDevice("search read chat ingest");
    const body = new URLSearchParams({ action: "approve", user_code: opted.user_code, orgId: "org-owner" });
    body.append("optIn", "chat");
    body.append("optIn", "admin");
    expect((await fetch(`${origin}/oauth/mcp/device`, { method: "POST", headers: { cookie: cookie("owner"), origin }, body })).status).toBe(200);
    await allowNextPoll(opted.device_code);
    const optedTokens = await poll(opted.device_code);
    expect(optedTokens.body.scope).toBe("search read chat");
    const me = await (await whoami(optedTokens.body.access_token)).json() as Record<string, any>;
    expect(me.credential.apiKeyScopes.sort()).toEqual(["artifacts", "chat", "search"]);
  });

  it("counts concurrent wrong codes atomically against the lockout", async () => {
    const guesses = Array.from({ length: 12 }, (_, i) => verify("owner", { action: "lookup", user_code: `CDFG-${"HJKMNPRTVWXY"[i]}HJK` }));
    const statuses = (await Promise.all(guesses)).map((response) => response.status);
    const recorded = (await q("select count(*)::int as n from mcp_oauth_device_attempts where user_id = 'owner'")).rows[0].n;
    expect(recorded).toBe(5);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(7);
  });
});

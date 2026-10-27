import { Hono, type Context } from "hono";
import { appDbPool } from "../lib/auth.js";
import { resolveBetterAuthSessionActor } from "../lib/request-actor.js";
import { getConsentRequest, MCP_SCOPES, mcpOrigin, mcpResource, validRedirect, redirectMatches, parseScopes, transaction, oauthHash, pkceChallenge, issueTokens, secret, randomUUID, cleanupExpiredOAuthRequests, logTokenRejection, REFRESH_REUSE_LEEWAY_SECONDS } from "../services/mcp-oauth.js";
export const mcpOAuthMetadataRoutes = new Hono();
const resourceMetadata = (url: string) => ({ resource: mcpResource(url), authorization_servers: [mcpOrigin(url)], scopes_supported: MCP_SCOPES, bearer_methods_supported: ["header"], resource_name: "DocSlurp MCP" });
for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/v1/mcp"])
  mcpOAuthMetadataRoutes.get(path, c => c.json(resourceMetadata(c.req.url)));
mcpOAuthMetadataRoutes.get("/.well-known/oauth-authorization-server", c => {
  const origin = mcpOrigin(c.req.url);
  return c.json({ issuer: origin, authorization_endpoint: `${origin}/oauth/mcp/authorize`, token_endpoint: `${origin}/oauth/mcp/token`, registration_endpoint: `${origin}/oauth/mcp/register`, revocation_endpoint: `${origin}/oauth/mcp/revoke`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: MCP_SCOPES, authorization_response_iss_parameter_supported: true });
});
export const mcpOAuthRoutes = new Hono();
mcpOAuthRoutes.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); c.header("Pragma", "no-cache"); await next(); });
mcpOAuthRoutes.post("/register", async (c) => {
  if (Number(c.req.header("content-length") ?? 0) > 16384)
    return c.json({ error: "invalid_client_metadata" }, 400);
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  }
  catch {
    return c.json({ error: "invalid_client_metadata" }, 400);
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.redirect_uris) || !body.redirect_uris.length || body.redirect_uris.length > 5 || !body.redirect_uris.every(validRedirect) || (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") || (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || body.grant_types.some(x => !["authorization_code", "refresh_token"].includes(String(x))))) || (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.some(x => x !== "code"))))
    return c.json({ error: "invalid_client_metadata" }, 400);
  await cleanupExpiredOAuthRequests();
  const id = randomUUID(), name = typeof body.client_name === "string" ? body.client_name.slice(0, 120) : "MCP client";
  await appDbPool.query("INSERT INTO mcp_oauth_clients(id,name,redirect_uris) VALUES($1,$2,$3::jsonb)", [id, name, JSON.stringify(body.redirect_uris)]);
  return c.json({ client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: body.redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, 201);
});
// Dynamically registered redirect URIs are not trusted, so request errors are
// shown here rather than redirected to the client (RFC 9700 §4.11.2). A browser
// gets the consent page's explanation; other callers get the OAuth JSON error.
function authorizeError(c: Context, error: string, description: string) {
  if (c.req.header("accept")?.includes("text/html"))
    return c.redirect(`/app/mcp/authorize?${new URLSearchParams({ error, error_description: description })}`);
  return c.json({ error, error_description: description }, 400);
}
mcpOAuthRoutes.get("/authorize", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const client = (await appDbPool.query("SELECT * FROM mcp_oauth_clients WHERE id=$1", [params.get("client_id")])).rows[0];
  const redirect = params.get("redirect_uri"), challenge = params.get("code_challenge");
  if (!client || !redirect || !validRedirect(redirect) || !redirectMatches(client.redirect_uris, redirect))
    return authorizeError(c, "invalid_request", "Unknown client_id or unregistered redirect_uri");
  if (params.get("response_type") !== "code")
    return authorizeError(c, "unsupported_response_type", "Only response_type=code is supported");
  if (params.get("code_challenge_method") !== "S256" || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
    return authorizeError(c, "invalid_request", "PKCE with code_challenge_method=S256 is required");
  // RFC 8707: the token is always audience-bound to this MCP server. An omitted
  // resource defaults to it; any other resource is refused.
  const resource = params.get("resource") ?? mcpResource(c.req.url);
  if (resource !== mcpResource(c.req.url))
    return authorizeError(c, "invalid_target", `resource must be ${mcpResource(c.req.url)}`);
  if ((params.get("state")?.length ?? 0) > 2048)
    return authorizeError(c, "invalid_request", "state is too long");
  let scopes: string[];
  try {
    scopes = parseScopes(params.get("scope"));
  }
  catch {
    return authorizeError(c, "invalid_scope", `Supported scopes: ${MCP_SCOPES.join(" ")}`);
  }
  const actor = await resolveBetterAuthSessionActor(c.req.raw.headers);
  if (!actor)
    return c.redirect(`/app/mcp/authorize?authorize=${encodeURIComponent(new URL(c.req.url).pathname + new URL(c.req.url).search)}`);
  const id = secret("consent");
  await appDbPool.query(`INSERT INTO mcp_oauth_requests(id,client_id,user_id,session_id,redirect_uri,resource,scopes,challenge,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,now()+interval '10 minutes')`, [id, client.id, actor.userId, actor.sessionId, redirect, resource, JSON.stringify(scopes), challenge, params.get("state")]);
  return c.redirect(`/app/mcp/authorize?request=${encodeURIComponent(id)}`);
});
// The consent page's view of a pending request. Only the signed-in user's own,
// session-bound, unexpired, unconsumed request is returned (never the PKCE challenge).
mcpOAuthRoutes.get("/consent/:id", async (c) => {
  const actor = await resolveBetterAuthSessionActor(c.req.raw.headers);
  if (!actor)
    return c.json({ error: "Unauthorized" }, 401);
  c.header("Cache-Control", "no-store");
  const request = await getConsentRequest(c.req.param("id"), actor.userId, actor.sessionId);
  if (!request)
    return c.json({ error: "Not found" }, 404);
  return c.json({ id: request.id, client_name: request.client_name, redirect_uri: request.redirect_uri, scopes: request.scopes, expires_at: new Date(request.expires_at).toISOString() });
});
mcpOAuthRoutes.post("/authorize", async (c) => {
  if (c.req.header("origin") !== mcpOrigin(c.req.url))
    return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.parseBody();
  // A failed decision returns to the consent page, which explains an expired,
  // used or signed-out request instead of leaving the browser on a JSON error.
  const requestId = typeof body.request === "string" ? body.request : "";
  const consentPage = (extra = "") => c.redirect(`/app/mcp/authorize?request=${encodeURIComponent(requestId)}${extra}`, 303);
  const actor = await resolveBetterAuthSessionActor(c.req.raw.headers);
  if (!actor)
    return consentPage();
  const result = await transaction(async (db) => {
    const { rows } = await db.query(`SELECT * FROM mcp_oauth_requests WHERE id=$1 AND user_id=$2 AND session_id=$3 AND expires_at>now() AND consumed_at IS NULL FOR UPDATE`, [requestId, actor.userId, actor.sessionId]);
    const request = rows[0];
    if (!request)
      return null;
    const orgId = typeof body.orgId === "string" && body.orgId.length <= 200 ? body.orgId : null;
    // Check the chosen organization before consuming, so a bad form post leaves the request usable.
    if (body.decision === "allow" && !(await db.query("SELECT 1 FROM org_memberships WHERE org_id=$1 AND user_id=$2", [orgId, actor.userId])).rowCount)
      return { redirect: null, retry: "organization" };
    await db.query("UPDATE mcp_oauth_requests SET consumed_at=now() WHERE id=$1", [request.id]);
    const redirect = new URL(request.redirect_uri);
    if (request.state !== null)
      redirect.searchParams.set("state", request.state);
    redirect.searchParams.set("iss", mcpOrigin(c.req.url));
    if (body.decision !== "allow") {
      redirect.searchParams.set("error", "access_denied");
      return { redirect: redirect.href };
    }
    const grant = randomUUID(), code = secret("dsmcpc"), keyId = randomUUID();
    // This unexported identity lets existing usage/operation foreign keys stay valid.
    // No raw server key is returned or persisted; only a random unguessable hash.
    const clientName = (await db.query("SELECT name FROM mcp_oauth_clients WHERE id=$1", [request.client_id])).rows[0]?.name ?? "MCP client";
    await db.query(`INSERT INTO api_keys(id,user_id,org_id,key_hash,name,key_type,allowed_domains,scopes,rate_limit_rpm,rate_limit_ppd)
      VALUES($1,$2,$3,$4,$5,'server',ARRAY[]::text[],$6::text[],NULL,10000)`,
      [keyId, actor.userId, orgId, oauthHash(secret("internal")), `OAuth: ${clientName}`, request.scopes]);
    await db.query(`INSERT INTO mcp_oauth_grants(id,client_id,user_id,org_id,resource,scopes,api_key_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, [grant, request.client_id, actor.userId, orgId, request.resource, JSON.stringify(request.scopes), keyId]);
    await db.query(`INSERT INTO mcp_oauth_tokens(hash,grant_id,kind,redirect_uri,challenge,expires_at) VALUES($1,$2,'code',$3,$4,now()+interval '2 minutes')`, [oauthHash(code), grant, request.redirect_uri, request.challenge]);
    redirect.searchParams.set("code", code);
    return { redirect: redirect.href };
  });
  if (!result)
    return consentPage();
  return result.redirect ? c.redirect(result.redirect, 303) : consentPage(`&error=${result.retry}`);
});
type TokenFailure = { error: "invalid_grant" | "invalid_scope"; description: string; reason: string; grantId?: string };
const tokenFailure = (reason: string, description: string, grantId?: string, error: TokenFailure["error"] = "invalid_grant"): TokenFailure => ({ error, description, reason, grantId });
mcpOAuthRoutes.post("/token", async (c) => {
  const body = await c.req.parseBody();
  const reject = (status: 400 | 401, error: string, description: string, reason: string, grantId?: string) => {
    logTokenRejection(reason, { grantType: body.grant_type, clientId: body.client_id, grantId });
    return c.json({ error, error_description: description }, status);
  };
  if (body.grant_type !== "authorization_code" && body.grant_type !== "refresh_token")
    return reject(400, "unsupported_grant_type", "Supported grant types: authorization_code, refresh_token", "unsupported_grant_type");
  if (typeof body.client_id !== "string" || !body.client_id)
    return reject(400, "invalid_request", "client_id is required for public clients", "missing_client_id");
  // RFC 8707: an omitted resource means this MCP server; a different one is refused
  // before any lookup, so tokens are never minted for another audience.
  const resource = body.resource === undefined ? mcpResource(c.req.url) : body.resource;
  if (resource !== mcpResource(c.req.url))
    return reject(400, "invalid_target", `resource must be ${mcpResource(c.req.url)}`, "invalid_target");
  const raw = body.grant_type === "authorization_code" ? body.code : body.refresh_token;
  if (typeof raw !== "string" || !raw || raw.length > 200)
    return reject(400, "invalid_request", body.grant_type === "authorization_code" ? "code is required" : "refresh_token is required", "missing_credential");
  const result = await transaction(async (db): Promise<TokenFailure | Record<string, unknown>> => {
    const { rows } = await db.query(`SELECT t.*, g.client_id,g.user_id,g.org_id,g.resource,g.scopes,g.revoked_at,g.api_key_id, (t.consumed_at > now() - $2::int * interval '1 second') AS recently_consumed FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.id=t.grant_id WHERE t.hash=$1 FOR UPDATE OF t,g`, [oauthHash(raw), REFRESH_REUSE_LEEWAY_SECONDS]);
    const token = rows[0];
    const kind = body.grant_type === "authorization_code" ? "code" : "refresh";
    if (!token) return tokenFailure("unknown_token", "The grant is unknown or has expired. Start a new authorization.");
    if (token.kind !== kind) return tokenFailure("wrong_token_kind", "The presented credential is not valid for this grant type.", token.grant_id);
    if (token.client_id !== body.client_id) return tokenFailure("client_mismatch", "The grant was issued to a different client.", token.grant_id);
    if (token.resource !== resource) return tokenFailure("resource_mismatch", "The grant was issued for a different resource. Start a new authorization.", token.grant_id);
    if (token.revoked_at) return tokenFailure("grant_revoked", "The grant was revoked. Start a new authorization.", token.grant_id);
    if (new Date(token.expires_at).getTime() <= Date.now()) return tokenFailure("expired", "The grant has expired. Start a new authorization.", token.grant_id);
    if (!(await db.query("SELECT 1 FROM api_keys WHERE id=$1 AND user_id=$2 AND org_id=$3 AND revoked_at IS NULL AND key_type='server'", [token.api_key_id, token.user_id, token.org_id])).rowCount)
      return tokenFailure("key_revoked", "The grant was revoked. Start a new authorization.", token.grant_id);
    if (token.consumed_at) {
      // Replay of a rotated refresh token or a used code (OAuth 2.1 §4.3.1, RFC 9700 §4.14.2).
      // A duplicate refresh within a few seconds is a client race (two processes
      // sharing a credential store, or a retried request), not theft: refuse it
      // without revoking the newer tokens the first request already issued.
      if (kind === "refresh" && token.recently_consumed)
        return tokenFailure("refresh_reused_within_leeway", "This refresh token was just rotated. Use the newest refresh token.", token.grant_id);
      await db.query("UPDATE mcp_oauth_grants SET revoked_at=now() WHERE id=$1", [token.grant_id]);
      await db.query("UPDATE api_keys SET revoked_at=now() WHERE id=$1", [token.api_key_id]);
      return tokenFailure(kind === "code" ? "code_replayed" : "refresh_replayed", "The credential was already used; the grant has been revoked. Start a new authorization.", token.grant_id);
    }
    if (kind === "code" && token.redirect_uri !== body.redirect_uri)
      return tokenFailure("redirect_mismatch", "redirect_uri does not match the authorization request.", token.grant_id);
    if (kind === "code" && (typeof body.code_verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier) || token.challenge !== pkceChallenge(body.code_verifier)))
      return tokenFailure("pkce_mismatch", "code_verifier does not match the code_challenge.", token.grant_id);
    if (body.scope !== undefined && (typeof body.scope !== "string" || [...new Set(body.scope.split(/\s+/).filter(Boolean))].sort().join(" ") !== [...token.scopes].sort().join(" ")))
      return tokenFailure("scope_changed", `Scope must match the granted scope: ${token.scopes.join(" ")}`, token.grant_id, "invalid_scope");
    if (!(await db.query("SELECT 1 FROM org_memberships WHERE org_id=$1 AND user_id=$2", [token.org_id, token.user_id])).rowCount)
      return tokenFailure("membership_removed", "The user no longer belongs to the authorized organization.", token.grant_id);
    await db.query("UPDATE mcp_oauth_tokens SET consumed_at=now() WHERE hash=$1", [token.hash]);
    return { ...await issueTokens(db, token.grant_id), scope: token.scopes.join(" ") };
  });
  if ("reason" in result && typeof result.reason === "string") {
    const failure = result as TokenFailure;
    return reject(400, failure.error, failure.description, failure.reason, failure.grantId);
  }
  return c.json(result);
});
mcpOAuthRoutes.post("/revoke", async (c) => {
  const body = await c.req.parseBody();
  if (typeof body.token === "string" && typeof body.client_id === "string")
    await appDbPool.query(`UPDATE mcp_oauth_grants SET revoked_at=now() WHERE id IN (SELECT g.id FROM mcp_oauth_grants g JOIN mcp_oauth_tokens t ON t.grant_id=g.id WHERE t.hash=$1 AND g.client_id=$2)`, [oauthHash(body.token), body.client_id]);
  if (typeof body.token === "string" && typeof body.client_id === "string") await appDbPool.query(`UPDATE api_keys SET revoked_at=now() WHERE id IN (SELECT g.api_key_id FROM mcp_oauth_grants g JOIN mcp_oauth_tokens t ON t.grant_id=g.id WHERE t.hash=$1 AND g.client_id=$2 AND g.revoked_at IS NOT NULL)`, [oauthHash(body.token), body.client_id]);
  return c.body(null, 200);
});
mcpOAuthRoutes.get("/grants", async (c) => {
  const actor = await resolveBetterAuthSessionActor(c.req.raw.headers);
  if (!actor)
    return c.json({ error: "Unauthorized" }, 401);
  return c.json({ grants: (await appDbPool.query(`SELECT g.id,g.org_id,g.scopes,g.created_at,c.name AS client_name FROM mcp_oauth_grants g JOIN mcp_oauth_clients c ON c.id=g.client_id WHERE g.user_id=$1 AND g.revoked_at IS NULL ORDER BY g.created_at DESC`, [actor.userId])).rows });
});
mcpOAuthRoutes.post("/grants/:id/revoke", async (c) => {
  if (c.req.header("origin") !== mcpOrigin(c.req.url))
    return c.json({ error: "Forbidden" }, 403);
  const actor = await resolveBetterAuthSessionActor(c.req.raw.headers);
  if (!actor)
    return c.json({ error: "Unauthorized" }, 401);
  await appDbPool.query("UPDATE mcp_oauth_grants SET revoked_at=now() WHERE id=$1 AND user_id=$2", [c.req.param("id"), actor.userId]);
  await appDbPool.query("UPDATE api_keys SET revoked_at=now() WHERE id IN (SELECT api_key_id FROM mcp_oauth_grants WHERE id=$1 AND user_id=$2 AND revoked_at IS NOT NULL)", [c.req.param("id"), actor.userId]);
  return c.json({ revoked: true });
});

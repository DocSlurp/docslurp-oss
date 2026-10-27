import { Hono, type Context } from "hono";
import { appDbPool } from "../lib/auth.js";
import { resolveBetterAuthSessionActor } from "../lib/request-actor.js";
import { getConsentRequest, MCP_SCOPES, mcpOrigin, mcpResource, apiResource, allowedResources, allowedScopes, createGrant, validRedirect, redirectMatches, parseScopes, transaction, oauthHash, pkceChallenge, issueTokens, secret, randomUUID, cleanupExpiredOAuthRequests, logTokenRejection, REFRESH_REUSE_LEEWAY_SECONDS, DEVICE_CODE_GRANT_TYPE, DEVICE_CODE_TTL_SECONDS, DEVICE_POLL_INTERVAL_SECONDS, generateUserCode, OAUTH_TOKEN_PREFIX } from "../services/mcp-oauth.js";
import { deviceVerificationRoutes } from "./mcp-oauth-device.js";
import { requestIp } from "../lib/request-context.js";
export const mcpOAuthMetadataRoutes = new Hono();
const resourceMetadata = (url: string) => ({ resource: mcpResource(url), authorization_servers: [mcpOrigin(url)], scopes_supported: MCP_SCOPES, bearer_methods_supported: ["header"], resource_name: "DocSlurp MCP" });
for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/v1/mcp"])
  mcpOAuthMetadataRoutes.get(path, c => c.json(resourceMetadata(c.req.url)));
// RFC 9728 metadata for the REST API audience (first-party clients only).
mcpOAuthMetadataRoutes.get("/.well-known/oauth-protected-resource/v1", c => c.json({ resource: apiResource(c.req.url), authorization_servers: [mcpOrigin(c.req.url)], scopes_supported: MCP_SCOPES, bearer_methods_supported: ["header"], resource_name: "DocSlurp API" }));
mcpOAuthMetadataRoutes.get("/.well-known/oauth-authorization-server", c => {
  const origin = mcpOrigin(c.req.url);
  return c.json({ issuer: origin, authorization_endpoint: `${origin}/oauth/mcp/authorize`, token_endpoint: `${origin}/oauth/mcp/token`, registration_endpoint: `${origin}/oauth/mcp/register`, revocation_endpoint: `${origin}/oauth/mcp/revoke`, device_authorization_endpoint: `${origin}/oauth/mcp/device_authorization`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token", DEVICE_CODE_GRANT_TYPE], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: MCP_SCOPES, authorization_response_iss_parameter_supported: true });
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
  // RFC 8707: the token is always audience-bound. An omitted resource means
  // this MCP server. Only a first-party client (the DocSlurp CLI) may ask for
  // the REST API; any other resource is refused.
  const resource = params.get("resource") ?? mcpResource(c.req.url);
  if (!allowedResources(c.req.url, client).includes(resource))
    return authorizeError(c, "invalid_target", `resource must be ${mcpResource(c.req.url)}`);
  if ((params.get("state")?.length ?? 0) > 2048)
    return authorizeError(c, "invalid_request", "state is too long");
  let scopes: string[];
  try {
    scopes = parseScopes(params.get("scope"), allowedScopes(client));
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
  return c.json({ id: request.id, client_name: request.client_name, redirect_uri: request.redirect_uri, resource: request.resource, scopes: request.scopes, expires_at: new Date(request.expires_at).toISOString() });
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
    const code = secret("dsmcpc");
    const grant = await createGrant(db, { clientId: request.client_id, userId: actor.userId, orgId: orgId!, resource: request.resource, scopes: request.scopes, url: c.req.url });
    await db.query(`INSERT INTO mcp_oauth_tokens(hash,grant_id,kind,redirect_uri,challenge,expires_at) VALUES($1,$2,'code',$3,$4,now()+interval '2 minutes')`, [oauthHash(code), grant, request.redirect_uri, request.challenge]);
    redirect.searchParams.set("code", code);
    return { redirect: redirect.href };
  });
  if (!result)
    return consentPage();
  return result.redirect ? c.redirect(result.redirect, 303) : consentPage(`&error=${result.retry}`);
});
type TokenFailure = { error: "invalid_grant" | "invalid_scope" | "authorization_pending" | "slow_down" | "expired_token" | "access_denied"; description: string; reason: string; grantId?: string };
const audienceOf = (resource: string, url: string): keyof typeof OAUTH_TOKEN_PREFIX => resource === apiResource(url) ? "api" : "mcp";
const tokenFailure = (reason: string, description: string, grantId?: string, error: TokenFailure["error"] = "invalid_grant"): TokenFailure => ({ error, description, reason, grantId });
mcpOAuthRoutes.post("/token", async (c) => {
  const body = await c.req.parseBody();
  const reject = (status: 400 | 401, error: string, description: string, reason: string, grantId?: string) => {
    logTokenRejection(reason, { grantType: body.grant_type, clientId: body.client_id, grantId });
    return c.json({ error, error_description: description }, status);
  };
  if (body.grant_type !== "authorization_code" && body.grant_type !== "refresh_token" && body.grant_type !== DEVICE_CODE_GRANT_TYPE)
    return reject(400, "unsupported_grant_type", `Supported grant types: authorization_code, refresh_token, ${DEVICE_CODE_GRANT_TYPE}`, "unsupported_grant_type");
  if (typeof body.client_id !== "string" || !body.client_id)
    return reject(400, "invalid_request", "client_id is required for public clients", "missing_client_id");
  // RFC 8707: an omitted resource means this MCP server; anything but a known
  // audience is refused before any lookup, and each grant below must match the
  // audience it was issued for, so tokens are never minted for another audience.
  const resource = body.resource === undefined ? mcpResource(c.req.url) : body.resource;
  if (resource !== mcpResource(c.req.url) && resource !== apiResource(c.req.url))
    return reject(400, "invalid_target", `resource must be ${mcpResource(c.req.url)}`, "invalid_target");
  if (body.grant_type === DEVICE_CODE_GRANT_TYPE) {
    const deviceCode = body.device_code;
    if (typeof deviceCode !== "string" || !deviceCode || deviceCode.length > 200)
      return reject(400, "invalid_request", "device_code is required", "missing_credential");
    const result = await redeemDeviceCode(deviceCode, body.client_id, resource, c.req.url);
    if ("reason" in result && typeof result.reason === "string") {
      const failure = result as TokenFailure;
      // Pending and slow_down are expected polling answers, not rejections worth a warning.
      if (failure.error !== "authorization_pending") logTokenRejection(failure.reason, { grantType: body.grant_type, clientId: body.client_id, grantId: failure.grantId });
      return c.json({ error: failure.error, error_description: failure.description }, 400);
    }
    return c.json(result);
  }
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
    return { ...await issueTokens(db, token.grant_id, audienceOf(token.resource, c.req.url)), scope: token.scopes.join(" ") };
  });
  if ("reason" in result && typeof result.reason === "string") {
    const failure = result as TokenFailure;
    return reject(400, failure.error, failure.description, failure.reason, failure.grantId);
  }
  return c.json(result);
});
/**
 * RFC 8628 §3.5 polling. The device code is single-use: once redeemed, any
 * further presentation revokes the grant (as a replayed authorization code
 * does). Polling faster than the interval answers slow_down and adds 5 s.
 */
async function redeemDeviceCode(deviceCode: string, clientId: string, resource: string, url: string): Promise<TokenFailure | Record<string, unknown>> {
  return await transaction(async (db): Promise<TokenFailure | Record<string, unknown>> => {
    const { rows } = await db.query(`SELECT d.*, (d.expires_at <= now()) AS expired,
        (d.last_polled_at IS NOT NULL AND d.last_polled_at > now() - d.interval_seconds * interval '1 second') AS too_fast,
        g.revoked_at AS grant_revoked_at, g.api_key_id, g.user_id AS grant_user_id, g.org_id, g.scopes AS grant_scopes
      FROM mcp_oauth_device_codes d LEFT JOIN mcp_oauth_grants g ON g.id=d.grant_id
      WHERE d.device_code_hash=$1 FOR UPDATE OF d`, [oauthHash(deviceCode)]);
    const row = rows[0];
    if (!row) return tokenFailure("unknown_token", "The device code is unknown or has expired. Start a new login.");
    if (row.client_id !== clientId) return tokenFailure("client_mismatch", "The device code was issued to a different client.");
    if (row.resource !== resource) return tokenFailure("resource_mismatch", "The device code was issued for a different resource. Start a new login.");
    if (row.consumed_at) {
      if (row.grant_id) {
        await db.query("UPDATE mcp_oauth_grants SET revoked_at=now() WHERE id=$1", [row.grant_id]);
        if (row.api_key_id) await db.query("UPDATE api_keys SET revoked_at=now() WHERE id=$1", [row.api_key_id]);
      }
      return tokenFailure("device_code_replayed", "The device code was already used; the grant has been revoked. Start a new login.", row.grant_id ?? undefined);
    }
    if (row.expired) return tokenFailure("expired", "The device code has expired. Start a new login.", undefined, "expired_token");
    if (row.denied_at) {
      await db.query("UPDATE mcp_oauth_device_codes SET consumed_at=now() WHERE device_code_hash=$1", [row.device_code_hash]);
      return tokenFailure("access_denied", "The request was denied.", undefined, "access_denied");
    }
    if (row.too_fast) {
      await db.query("UPDATE mcp_oauth_device_codes SET interval_seconds=least(interval_seconds+5, 60), last_polled_at=now() WHERE device_code_hash=$1", [row.device_code_hash]);
      return tokenFailure("slow_down", "Polling too fast; wait the interval plus 5 seconds.", undefined, "slow_down");
    }
    await db.query("UPDATE mcp_oauth_device_codes SET last_polled_at=now() WHERE device_code_hash=$1", [row.device_code_hash]);
    if (!row.approved_at || !row.grant_id) return tokenFailure("pending", "The user has not approved the request yet.", undefined, "authorization_pending");
    if (row.grant_revoked_at) return tokenFailure("grant_revoked", "The grant was revoked. Start a new login.", row.grant_id);
    if (!(await db.query("SELECT 1 FROM api_keys WHERE id=$1 AND user_id=$2 AND org_id=$3 AND revoked_at IS NULL AND key_type='server'", [row.api_key_id, row.grant_user_id, row.org_id])).rowCount)
      return tokenFailure("key_revoked", "The grant was revoked. Start a new login.", row.grant_id);
    if (!(await db.query("SELECT 1 FROM org_memberships WHERE org_id=$1 AND user_id=$2", [row.org_id, row.grant_user_id])).rowCount)
      return tokenFailure("membership_removed", "The user no longer belongs to the authorized organization.", row.grant_id);
    await db.query("UPDATE mcp_oauth_device_codes SET consumed_at=now() WHERE device_code_hash=$1", [row.device_code_hash]);
    return { ...await issueTokens(db, row.grant_id, audienceOf(row.resource, url)), scope: (row.grant_scopes as string[]).join(" ") };
  });
}

/**
 * RFC 8628 §3.1 device authorization request. Only first-party clients (the
 * DocSlurp CLI) may use it: a dynamically registered client names itself, and
 * a device code shown on a page the attacker controls is a phishing lure.
 */
mcpOAuthRoutes.post("/device_authorization", async (c) => {
  const body = await c.req.parseBody();
  const clientId = typeof body.client_id === "string" ? body.client_id : "";
  const client = clientId ? (await appDbPool.query("SELECT * FROM mcp_oauth_clients WHERE id=$1", [clientId])).rows[0] : null;
  if (!client || client.first_party !== true)
    return c.json({ error: "invalid_client", error_description: "Device authorization is limited to first-party clients" }, 401);
  const resource = typeof body.resource === "string" ? body.resource : mcpResource(c.req.url);
  if (!allowedResources(c.req.url, client).includes(resource))
    return c.json({ error: "invalid_target", error_description: `resource must be ${apiResource(c.req.url)} or ${mcpResource(c.req.url)}` }, 400);
  let scopes: string[];
  try {
    scopes = parseScopes(typeof body.scope === "string" ? body.scope : null, allowedScopes(client));
  } catch {
    return c.json({ error: "invalid_scope", error_description: `Supported scopes: ${MCP_SCOPES.join(" ")}` }, 400);
  }
  await cleanupExpiredOAuthRequests();
  const deviceCode = secret(`${OAUTH_TOKEN_PREFIX[audienceOf(resource, c.req.url)]}d`);
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = generateUserCode();
    try {
      await appDbPool.query(`INSERT INTO mcp_oauth_device_codes(device_code_hash,user_code_hash,client_id,resource,scopes,interval_seconds,expires_at,requester_ip)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,now()+$7::int*interval '1 second',$8)`,
        [oauthHash(deviceCode), oauthHash(userCode.replace("-", "")), client.id, resource, JSON.stringify(scopes), DEVICE_POLL_INTERVAL_SECONDS, DEVICE_CODE_TTL_SECONDS, requestIp(c)]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") continue; // user code collision: draw again
      throw error;
    }
    // No verification_uri_complete (RFC 8628 §3.3.1 makes it optional): a link
    // with the code filled in is exactly what a phisher would send a victim.
    // The user must type the code their own terminal shows.
    return c.json({
      device_code: deviceCode, user_code: userCode,
      verification_uri: `${mcpOrigin(c.req.url)}/oauth/mcp/device`,
      expires_in: DEVICE_CODE_TTL_SECONDS, interval: DEVICE_POLL_INTERVAL_SECONDS,
    });
  }
  return c.json({ error: "temporarily_unavailable" }, 503);
});
mcpOAuthRoutes.route("/device", deviceVerificationRoutes);
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

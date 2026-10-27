import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { appDbPool } from "../lib/auth.js";
import { parseApiKeyRateLimits, type ValidatedKey } from "./api-keys.js";

export const MCP_SCOPES = ["search", "chat", "read", "ingest", "web"] as const;
export const oauthHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const pkceChallenge = (value: string) => createHash("sha256").update(value).digest("base64url");
const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

export { mcpOrigin, mcpResource } from '../lib/mcp-origin.js';
import { mcpOrigin, mcpResource } from '../lib/mcp-origin.js';

/**
 * The REST API resource (RFC 8707) for first-party clients such as the
 * DocSlurp CLI. A token for it is accepted on /v1/* (including /v1/mcp, a
 * sub-resource) with scopes mapped by {@link oauthScopesToApiKeyScopes}. MCP
 * tokens (resource /v1/mcp) are never accepted on the REST API.
 */
export const apiResource = (url: string) => `${mcpOrigin(url)}/v1`;

/** The DocSlurp CLI: a public native client (RFC 8252), seeded by migration 0089. */
export const CLI_CLIENT_ID = "docslurp-cli";

/** Access token prefix per audience; refresh and device codes add `r` / `d`. */
export const OAUTH_TOKEN_PREFIX = { mcp: "dsmcp", api: "dscli" } as const;

/**
 * OAuth scope -> API-key scopes for REST-audience tokens. Never maps to
 * `workspaces:manage`, `organizations:*` or `web`, so an OAuth token cannot
 * change workspace settings, manage an organization or hold client-key web
 * access, whatever it was granted.
 *
 * - search -> search (passages, suggestions, read-only workspace listing)
 * - chat   -> chat (generated answers on the owner's credits)
 * - read   -> artifacts (document text, pages, files, runs and exports)
 * - ingest -> ingest (uploads, URL ingest, reprocess, document retag/delete)
 * - web    -> web (paid web search, fetch, map, crawl). REST-audience tokens
 *   need it explicitly; `search` alone does not unlock web tools for them.
 */
export const OAUTH_TO_API_KEY_SCOPES: Readonly<Record<typeof MCP_SCOPES[number], readonly string[]>> = {
  search: ["search"],
  chat: ["chat"],
  read: ["artifacts"],
  ingest: ["ingest"],
  web: ["web"],
};

export function oauthScopesToApiKeyScopes(scopes: readonly string[]): string[] {
  const mapped = new Set<string>();
  for (const scope of scopes) {
    const target = OAUTH_TO_API_KEY_SCOPES[scope as typeof MCP_SCOPES[number]];
    // An unknown scope maps to nothing (fail closed), never to a default set.
    if (target) for (const value of target) mapped.add(value);
  }
  return [...mapped];
}

/** The audiences a client may request: every client gets MCP; only first-party clients get the REST API. */
export function allowedResources(url: string, client: { first_party?: boolean | null }): string[] {
  return client.first_party === true ? [mcpResource(url), apiResource(url)] : [mcpResource(url)];
}

/** The key scopes stored on a grant's internal key: raw scopes for MCP (unchanged), mapped scopes for the REST API. */
export function grantKeyScopes(resource: string, scopes: readonly string[], url: string): string[] {
  return resource === apiResource(url) ? oauthScopesToApiKeyScopes(scopes) : [...scopes];
}

export function validRedirect(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const secure = url.protocol === "https:";
    const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return !url.hash && !url.username && !url.password && (secure || loopback);
  } catch {
    return false;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Exact redirect URI matching (OAuth 2.1 §4.1.1), except that a loopback
 * redirect may use any port (RFC 8252 §7.3): native clients bind an ephemeral
 * port at request time. Scheme, host, path and query must still match exactly.
 */
export function redirectMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let target: URL;
  try { target = new URL(requested); } catch { return false; }
  if (target.protocol !== "http:" || !LOOPBACK_HOSTS.has(target.hostname)) return false;
  return registered.some((value) => {
    try {
      const candidate = new URL(value);
      return candidate.protocol === "http:" && candidate.hostname === target.hostname
        && candidate.pathname === target.pathname && candidate.search === target.search
        && !target.username && !target.password && !target.hash;
    } catch {
      return false;
    }
  });
}

/** Seconds during which a just-rotated refresh token is refused without revoking the grant. */
export const REFRESH_REUSE_LEEWAY_SECONDS = 30;

/** Token endpoint failures are logged by reason only: never the token, verifier or code. */
export function logTokenRejection(reason: string, details: { grantType: unknown; clientId?: unknown; grantId?: string }) {
  const client = typeof details.clientId === "string" ? details.clientId.slice(0, 64) : "-";
  console.warn(`[mcp-oauth] token_rejected reason=${reason} grant_type=${String(details.grantType).slice(0, 32)} client=${client}${details.grantId ? ` grant=${details.grantId}` : ""}`);
}

export function parseScopes(value: string | null): string[] {
  const scopes = [...new Set((value ?? MCP_SCOPES.join(" ")).split(/\s+/).filter(Boolean))];
  if (!scopes.length || scopes.some(scope => !MCP_SCOPES.includes(scope as typeof MCP_SCOPES[number]))) {
    throw new Error("invalid_scope");
  }
  return scopes;
}

export async function transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await appDbPool.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

export async function issueTokens(db: PoolClient, grantId: string, audience: keyof typeof OAUTH_TOKEN_PREFIX = "mcp") {
  const prefix = OAUTH_TOKEN_PREFIX[audience];
  const access = secret(prefix);
  const refresh = secret(`${prefix}r`);
  await db.query(`
    INSERT INTO mcp_oauth_tokens(hash,grant_id,kind,expires_at)
    VALUES ($1,$3,'access',now()+interval '15 minutes'),
           ($2,$3,'refresh',now()+interval '30 days')
  `, [oauthHash(access), oauthHash(refresh), grantId]);
  return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 900 };
}

export async function validateMcpToken(raw: string, resource: string): Promise<ValidatedKey | null> {
  const { rows } = await appDbPool.query(`
    SELECT g.*, t.expires_at AS token_expires_at, c.name AS client_name,
           k.rate_limits AS key_rate_limits, k.workspace_ids AS key_workspace_ids FROM mcp_oauth_tokens t
    JOIN mcp_oauth_grants g ON g.id=t.grant_id
    JOIN mcp_oauth_clients c ON c.id=g.client_id
    JOIN org_memberships m ON m.org_id=g.org_id AND m.user_id=g.user_id
    JOIN api_keys k ON k.id=g.api_key_id AND k.user_id=g.user_id AND k.org_id=g.org_id
    WHERE t.hash=$1 AND t.kind='access' AND t.expires_at>now()
      AND t.consumed_at IS NULL AND g.revoked_at IS NULL AND g.resource=$2
      AND k.revoked_at IS NULL AND k.key_type='server'
  `, [oauthHash(raw), resource]);
  const row = rows[0];
  if (!row) return null;
  return {
    keyId: row.api_key_id, userId: row.user_id, orgId: row.org_id,
    keyType: "server", allowedDomains: [], scopes: row.scopes,
    rateLimitRpm: null, rateLimitPpd: 10000, rateLimits: parseApiKeyRateLimits(row.key_rate_limits),
    workspaceIds: Array.isArray(row.key_workspace_ids) ? row.key_workspace_ids : [],
    // Delegated tokens are never platform admins and never app sessions (see request-actor.ts).
    oauth: {
      grantId: row.id, clientId: row.client_id, clientName: row.client_name, resource, audience: "mcp",
      grantedScopes: Array.isArray(row.scopes) ? row.scopes : [], expiresAt: new Date(row.token_expires_at).toISOString(),
    },
  };
}

/**
 * A REST-audience (`dscli_`) access token as an API-key identity. The grant's
 * user must still belong to its organization, the grant and its internal key
 * must be live, and the token must be unexpired. Scopes are the mapped key
 * scopes, so every existing API-key scope check applies unchanged.
 */
export async function validateOAuthApiToken(raw: string): Promise<ValidatedKey | null> {
  if (!raw.startsWith(`${OAUTH_TOKEN_PREFIX.api}_`) || raw.length > 200) return null;
  const resource = apiResource("");
  const { rows } = await appDbPool.query(`
    SELECT g.*, t.expires_at AS token_expires_at, c.name AS client_name, c.first_party,
           k.rate_limits AS key_rate_limits, k.workspace_ids AS key_workspace_ids
    FROM mcp_oauth_tokens t
    JOIN mcp_oauth_grants g ON g.id=t.grant_id
    JOIN mcp_oauth_clients c ON c.id=g.client_id
    JOIN org_memberships m ON m.org_id=g.org_id AND m.user_id=g.user_id
    JOIN api_keys k ON k.id=g.api_key_id AND k.user_id=g.user_id AND k.org_id=g.org_id
    WHERE t.hash=$1 AND t.kind='access' AND t.expires_at>now()
      AND t.consumed_at IS NULL AND g.revoked_at IS NULL AND g.resource=$2
      AND k.revoked_at IS NULL AND k.key_type='server'
  `, [oauthHash(raw), resource]);
  const row = rows[0];
  // Defense in depth: only a first-party client can hold the REST audience.
  if (!row || row.first_party !== true) return null;
  const grantedScopes: string[] = Array.isArray(row.scopes) ? row.scopes : [];
  return {
    keyId: row.api_key_id, userId: row.user_id, orgId: row.org_id,
    keyType: "server", allowedDomains: [], scopes: oauthScopesToApiKeyScopes(grantedScopes),
    rateLimitRpm: null, rateLimitPpd: 10000, rateLimits: parseApiKeyRateLimits(row.key_rate_limits),
    workspaceIds: Array.isArray(row.key_workspace_ids) ? row.key_workspace_ids : [],
    oauth: {
      grantId: row.id, clientId: row.client_id, clientName: row.client_name, resource, audience: "api",
      grantedScopes, expiresAt: new Date(row.token_expires_at).toISOString(),
    },
  };
}

/**
 * Creates a grant and its unexported internal key identity (so usage and
 * operation foreign keys stay valid). No raw server key is returned or
 * persisted; only a random unguessable hash.
 */
export async function createGrant(db: PoolClient, args: { clientId: string; userId: string; orgId: string; resource: string; scopes: string[]; url: string }): Promise<string> {
  const grant = randomUUID(), keyId = randomUUID();
  const clientName = (await db.query("SELECT name FROM mcp_oauth_clients WHERE id=$1", [args.clientId])).rows[0]?.name ?? "MCP client";
  await db.query(`INSERT INTO api_keys(id,user_id,org_id,key_hash,name,key_type,allowed_domains,scopes,rate_limit_rpm,rate_limit_ppd)
    VALUES($1,$2,$3,$4,$5,'server',ARRAY[]::text[],$6::text[],NULL,10000)`,
    [keyId, args.userId, args.orgId, oauthHash(secret("internal")), `OAuth: ${clientName}`, grantKeyScopes(args.resource, args.scopes, args.url)]);
  await db.query(`INSERT INTO mcp_oauth_grants(id,client_id,user_id,org_id,resource,scopes,api_key_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [grant, args.clientId, args.userId, args.orgId, args.resource, JSON.stringify(args.scopes), keyId]);
  return grant;
}

// ---------------------------------------------------------------------------
// Device authorization grant (RFC 8628)

export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const DEVICE_CODE_TTL_SECONDS = 600;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
/** Failed user-code entries a signed-in user may make per window before lockout. */
export const DEVICE_MAX_FAILED_ATTEMPTS = 5;
export const DEVICE_ATTEMPT_WINDOW_MINUTES = 15;
/**
 * RFC 8628 §6.1: base-20 consonants, no vowels (no accidental words) and no
 * look-alikes (0/O/Q, 1/I/L, 5/S, 2/Z, 8/B, 6/G-adjacent digits are absent). 8 characters is
 * 20^8 ≈ 2.6e10 codes; with the lockout below a user gets 5 guesses per 15 minutes.
 */
export const USER_CODE_ALPHABET = "CDFGHJKMNPRTVWXY3479";
export const USER_CODE_LENGTH = 8;

export function generateUserCode(): string {
  const bytes = randomBytes(USER_CODE_LENGTH * 2);
  let code = "";
  // Rejection sampling keeps the distribution uniform (256 is not a multiple of 20).
  for (let i = 0; code.length < USER_CODE_LENGTH; i++) {
    const byte = i < bytes.length ? bytes[i]! : randomBytes(1)[0]!;
    if (byte < 240) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Uppercases and strips separators; anything outside the alphabet makes the code invalid. */
export function normalizeUserCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 32) return null;
  const compact = value.toUpperCase().replace(/[\s-]/g, "");
  if (compact.length !== USER_CODE_LENGTH) return null;
  for (const char of compact) if (!USER_CODE_ALPHABET.includes(char)) return null;
  return compact;
}

export const formatUserCode = (normalized: string) => `${normalized.slice(0, 4)}-${normalized.slice(4)}`;

/** Wrong-code budgets per window. Any one exhausted refuses every lookup, approval and denial. */
export const DEVICE_MAX_FAILED_ATTEMPTS_PER_IP = 20;
export const DEVICE_MAX_FAILED_ATTEMPTS_GLOBAL = 500;

/**
 * True when this user, this IP or the deployment as a whole has used up its
 * failed user-code entries for the window. Call inside the transaction that
 * also records a miss, after {@link lockDeviceAttempts}, so concurrent guesses
 * by one user cannot all pass the check before any is counted.
 */
export async function deviceAttemptsExhausted(db: Pick<PoolClient, "query">, userId: string, ip: string | null = null): Promise<boolean> {
  const { rows } = await db.query(`
    SELECT count(*) FILTER (WHERE user_id=$1)::int AS by_user,
           count(*) FILTER (WHERE $2::text IS NOT NULL AND ip=$2)::int AS by_ip,
           count(*)::int AS total
    FROM mcp_oauth_device_attempts WHERE created_at > now() - $3::int * interval '1 minute'
  `, [userId, ip, DEVICE_ATTEMPT_WINDOW_MINUTES]);
  const row = rows[0] ?? { by_user: 0, by_ip: 0, total: 0 };
  return row.by_user >= DEVICE_MAX_FAILED_ATTEMPTS || row.by_ip >= DEVICE_MAX_FAILED_ATTEMPTS_PER_IP || row.total >= DEVICE_MAX_FAILED_ATTEMPTS_GLOBAL;
}

/** Serializes one user's device-code checks (transaction-scoped advisory lock). */
export async function lockDeviceAttempts(db: Pick<PoolClient, "query">, userId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('mcp_oauth_device_attempts:' || $1))", [userId]);
}

export async function recordDeviceAttemptFailure(db: Pick<PoolClient, "query">, userId: string, ip: string | null = null): Promise<void> {
  await db.query("INSERT INTO mcp_oauth_device_attempts(user_id, ip) VALUES($1, $2)", [userId, ip]);
}

/**
 * Scopes a device approval grants without an explicit opt-in on the page.
 * A device request is started by whoever holds the terminal, not by the
 * approving user, so `chat` and `ingest` (credits, uploads, deletes) are
 * granted only when the user ticks them.
 */
export const DEVICE_BASE_SCOPES = ["search", "read"] as const;

export function deviceGrantScopes(requested: readonly string[], optedIn: readonly string[]): string[] {
  return requested.filter((scope) => (DEVICE_BASE_SCOPES as readonly string[]).includes(scope) || optedIn.includes(scope));
}

/** A pending device request by user code: unexpired, undecided and unconsumed. */
export async function findPendingDeviceRequest(db: Pick<PoolClient, "query">, normalizedUserCode: string, forUpdate = false) {
  const { rows } = await db.query(`
    SELECT d.*, c.name AS client_name, c.first_party FROM mcp_oauth_device_codes d
    JOIN mcp_oauth_clients c ON c.id=d.client_id
    WHERE d.user_code_hash=$1 AND d.expires_at>now()
      AND d.approved_at IS NULL AND d.denied_at IS NULL AND d.consumed_at IS NULL
    ${forUpdate ? "FOR UPDATE OF d" : ""}
  `, [oauthHash(normalizedUserCode)]);
  return rows[0] ?? null;
}

export async function getConsentRequest(id: string, userId: string, sessionId: string) {
  const { rows } = await appDbPool.query(`
    SELECT r.*, c.name AS client_name FROM mcp_oauth_requests r
    JOIN mcp_oauth_clients c ON c.id=r.client_id
    WHERE r.id=$1 AND r.user_id=$2 AND r.session_id=$3
      AND r.expires_at>now() AND r.consumed_at IS NULL
  `, [id, userId, sessionId]);
  return rows[0] ?? null;
}

// Bounded opportunistic cleanup. Retain token replay markers through expiry.
export async function cleanupExpiredOAuthRequests() {
  await appDbPool.query(`DELETE FROM mcp_oauth_clients WHERE id IN (
    SELECT c.id FROM mcp_oauth_clients c WHERE c.created_at < now()-interval '30 days' AND NOT c.first_party
    AND NOT EXISTS (SELECT 1 FROM mcp_oauth_grants g WHERE g.client_id=c.id)
    AND NOT EXISTS (SELECT 1 FROM mcp_oauth_requests r WHERE r.client_id=c.id AND r.expires_at>now())
    LIMIT 100
  )`);
  await appDbPool.query(`DELETE FROM mcp_oauth_requests WHERE id IN (
    SELECT id FROM mcp_oauth_requests WHERE expires_at < now() ORDER BY expires_at LIMIT 100
  )`);
  await appDbPool.query(`DELETE FROM mcp_oauth_device_codes WHERE device_code_hash IN (
    SELECT device_code_hash FROM mcp_oauth_device_codes WHERE expires_at < now()-interval '1 day' ORDER BY expires_at LIMIT 100
  )`);
  await appDbPool.query(`DELETE FROM mcp_oauth_device_attempts WHERE id IN (
    SELECT id FROM mcp_oauth_device_attempts WHERE created_at < now()-interval '1 day' ORDER BY created_at LIMIT 100
  )`);
  await appDbPool.query(`DELETE FROM mcp_oauth_tokens WHERE hash IN (
    SELECT hash FROM mcp_oauth_tokens WHERE expires_at < now()-interval '30 days' ORDER BY expires_at LIMIT 100
  )`);
}
export { randomUUID, secret };

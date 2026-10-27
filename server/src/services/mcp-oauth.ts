import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { appDbPool } from "../lib/auth.js";
import { effectiveMaxOutputTokens, ipAllowed, parseApiKeyRateLimits, type ValidatedKey } from "./api-keys.js";

export const MCP_SCOPES = ["search", "chat", "read", "ingest"] as const;
export const oauthHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const pkceChallenge = (value: string) => createHash("sha256").update(value).digest("base64url");
const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

export { mcpOrigin, mcpResource } from '../lib/mcp-origin.js';

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

export async function issueTokens(db: PoolClient, grantId: string) {
  const access = secret("dsmcp");
  const refresh = secret("dsmcpr");
  await db.query(`
    INSERT INTO mcp_oauth_tokens(hash,grant_id,kind,expires_at)
    VALUES ($1,$3,'access',now()+interval '15 minutes'),
           ($2,$3,'refresh',now()+interval '30 days')
  `, [oauthHash(access), oauthHash(refresh), grantId]);
  return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 900 };
}

export async function validateMcpToken(raw: string, resource: string, requestContext?: { ip?: string | null }): Promise<ValidatedKey | null> {
  const { rows } = await appDbPool.query(`
    SELECT g.*, k.ip_allowlist AS key_ip_allowlist, k.max_output_tokens AS key_max_output_tokens,
           k.rate_limits AS key_rate_limits, k.workspace_ids AS key_workspace_ids FROM mcp_oauth_tokens t
    JOIN mcp_oauth_grants g ON g.id=t.grant_id
    JOIN org_memberships m ON m.org_id=g.org_id AND m.user_id=g.user_id
    JOIN api_keys k ON k.id=g.api_key_id AND k.user_id=g.user_id AND k.org_id=g.org_id
    WHERE t.hash=$1 AND t.kind='access' AND t.expires_at>now()
      AND t.consumed_at IS NULL AND g.revoked_at IS NULL AND g.resource=$2
      AND k.revoked_at IS NULL AND k.key_type='server'
      AND (k.expires_at IS NULL OR k.expires_at > now())
  `, [oauthHash(raw), resource]);
  const row = rows[0];
  if (!row) return null;
  const allowlist: string[] = row.key_ip_allowlist ?? [];
  if (allowlist.length && !ipAllowed(requestContext?.ip, allowlist)) return null;
  return {
    keyId: row.api_key_id, userId: row.user_id, orgId: row.org_id,
    keyType: "server", allowedDomains: [], scopes: row.scopes,
    rateLimitRpm: null, rateLimitPpd: 10000, rateLimits: parseApiKeyRateLimits(row.key_rate_limits),
    workspaceIds: Array.isArray(row.key_workspace_ids) ? row.key_workspace_ids : [],
    maxOutputTokens: effectiveMaxOutputTokens("server", row.key_max_output_tokens),
  };
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
    SELECT c.id FROM mcp_oauth_clients c WHERE c.created_at < now()-interval '30 days'
    AND NOT EXISTS (SELECT 1 FROM mcp_oauth_grants g WHERE g.client_id=c.id)
    AND NOT EXISTS (SELECT 1 FROM mcp_oauth_requests r WHERE r.client_id=c.id AND r.expires_at>now())
    LIMIT 100
  )`);
  await appDbPool.query(`DELETE FROM mcp_oauth_requests WHERE id IN (
    SELECT id FROM mcp_oauth_requests WHERE expires_at < now() ORDER BY expires_at LIMIT 100
  )`);
  await appDbPool.query(`DELETE FROM mcp_oauth_tokens WHERE hash IN (
    SELECT hash FROM mcp_oauth_tokens WHERE expires_at < now()-interval '30 days' ORDER BY expires_at LIMIT 100
  )`);
}
export { randomUUID, secret };

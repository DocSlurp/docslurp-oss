import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { appDbPool } from "../lib/auth.js";
import { parseApiKeyRateLimits, type ValidatedKey } from "./api-keys.js";

export const MCP_SCOPES = ["search", "read", "ingest"] as const;
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

export async function validateMcpToken(raw: string, resource: string): Promise<ValidatedKey | null> {
  const { rows } = await appDbPool.query(`
    SELECT g.*, k.rate_limits AS key_rate_limits, k.workspace_ids AS key_workspace_ids FROM mcp_oauth_tokens t
    JOIN mcp_oauth_grants g ON g.id=t.grant_id
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
    rateLimitRpm: 120, rateLimitPpd: 10000, rateLimits: parseApiKeyRateLimits(row.key_rate_limits),
    workspaceIds: Array.isArray(row.key_workspace_ids) ? row.key_workspace_ids : [],
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

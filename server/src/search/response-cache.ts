import { privacyModeBypassesCaches } from "../lib/cache-privacy.js";
import { loadWorkspacePrivacyModeForCache, strictestPrivacyMode } from "../lib/privacy.js";
import { getWorkspaceAccess } from "../services/organizations.js";

/**
 * Identical searches repeat constantly (type-ahead, popular questions), so a
 * complete answer is reused for a short window instead of re-running
 * embedding, vector and text retrieval. SEARCH_RESPONSE_CACHE_TTL_MS=0 disables it.
 *
 * Tenant boundary (every rule fails closed: when in doubt, no cache):
 * - The route authenticates the caller and checks the API key's scopes and
 *   workspace allowlist before it asks for a key, so a revoked or narrowed key
 *   is refused before any cached answer is read.
 * - `responseCacheKey` re-checks workspace access for the user (and the
 *   request's key allowlist) and reads each workspace's privacy mode on every
 *   request. A workspace that is strict-privacy, missing, unreachable or whose
 *   mode cannot be read yields no key: nothing is read or written.
 * - The key holds the resolved organizations, the user, the API key id, the
 *   resolved workspace ids and the whole normalized request (filters,
 *   retrieval options, raw workspace and org references), so an answer never
 *   crosses callers, keys, tenants, workspaces or options.
 */
export type CachedSearchResponse = unknown;

const SEARCH_CACHE_MAX = 500;
const searchCache = new Map<string, { at: number; data: CachedSearchResponse }>();

export function searchResponseCacheTtlMs(): number {
  const value = Number.parseInt(process.env.SEARCH_RESPONSE_CACHE_TTL_MS ?? "", 10);
  if (Number.isFinite(value) && value >= 0) return value;
  return process.env.NODE_ENV === "test" ? 0 : 30_000;
}

export function clearSearchResponseCacheForTests(): void {
  searchCache.clear();
}

/**
 * The cache key for one request, or null when this request must neither read
 * nor write the cache (strict-privacy, unresolvable privacy or access, no scope).
 */
export async function responseCacheKey(args: {
  userId: string;
  apiKeyId: string | null;
  workspaceIds: readonly string[];
  request: Record<string, unknown>;
}): Promise<string | null> {
  const workspaceIds = [...new Set(args.workspaceIds.map((id) => id.trim()))].sort();
  if (!args.userId.trim() || workspaceIds.length === 0 || workspaceIds.some((id) => !id)) return null;
  try {
    const scopes = await Promise.all(workspaceIds.map(async (workspaceId) => {
      const [access, privacyMode] = await Promise.all([
        getWorkspaceAccess(workspaceId, args.userId),
        loadWorkspacePrivacyModeForCache(workspaceId),
      ]);
      return access && access.workspaceId === workspaceId && access.orgId && privacyMode ? { orgId: access.orgId, privacyMode } : null;
    }));
    const resolved = scopes.filter((scope): scope is NonNullable<typeof scope> => scope !== null);
    if (resolved.length !== workspaceIds.length) return null;
    if (privacyModeBypassesCaches(strictestPrivacyMode(resolved.map((scope) => scope.privacyMode)))) return null;
    const orgIds = [...new Set(resolved.map((scope) => scope.orgId))].sort();
    return JSON.stringify([orgIds, args.userId, args.apiKeyId, workspaceIds, args.request]);
  } catch {
    return null;
  }
}

export function readCachedResponse(key: string, ttlMs: number): CachedSearchResponse | undefined {
  const cached = searchCache.get(key);
  if (!cached) return undefined;
  if (Date.now() - cached.at >= ttlMs) {
    searchCache.delete(key);
    return undefined;
  }
  // Refresh recency: the map's insertion order is the eviction order.
  searchCache.delete(key);
  searchCache.set(key, cached);
  return cached.data;
}

export function writeCachedResponse(key: string, data: CachedSearchResponse): void {
  searchCache.set(key, { at: Date.now(), data });
  if (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value!);
}

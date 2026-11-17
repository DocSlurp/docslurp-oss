import { createHash } from "node:crypto";
import type { PrivacyMode } from "@docslurp/shared";
import { privacyModeBypassesCaches } from "../lib/cache-privacy.js";
import { privacyModeOf } from "../lib/privacy.js";
import { getProjectAccessWithPipeline } from "../services/organizations.js";
import { ensureInvalidationListener, onSearchProjectInvalidated } from "./eligible-documents.js";

/**
 * Identical searches repeat constantly (type-ahead, popular questions), so a
 * complete answer is reused for a short window instead of re-running
 * embedding, vector and text retrieval. SEARCH_RESPONSE_CACHE_TTL_MS=0 disables it.
 *
 * Tenant boundary (every rule fails closed: when in doubt, no cache):
 * - The route authenticates the caller and checks the API key's scopes and
 *   project allowlist before it asks for a ticket, so a revoked or narrowed
 *   key is refused before any cached answer is read.
 * - `responseCacheTicket` re-checks project access for the user (and the
 *   request's key allowlist) and reads each project's privacy mode with one
 *   query per project, memoized only within one request or batch. A project
 *   that is strict-privacy, missing or unreachable, or a lookup that fails or
 *   exceeds the lookup timeout, yields no ticket: nothing is read or written.
 * - `storeResponse` repeats that lookup unmemoized just before writing, and
 *   skips the write if the project was invalidated while the search ran, so a
 *   project made strict-privacy mid-search never gets an entry.
 * - The key is a SHA-256 of the resolved organizations, the user, the API key
 *   id, the resolved project ids and the exact request (filters, retrieval
 *   options, the query as sent), so answers never cross callers, keys,
 *   tenants, projects or options.
 * - One bounded LRU (entry and byte caps) shared by every organization; the
 *   organizations are part of the key and are checked again on read, so an
 *   answer is only ever served to the organizations it was computed for.
 *   Oversized answers are not kept.
 * - Settings, pipeline and document changes drop a project's entries through
 *   the search invalidation hints (eligible-documents.ts); answers are otherwise
 *   at most one TTL old.
 */

type ScopeEntry = { orgId: string; privacyMode: PrivacyMode };
/** Access and privacy lookups shared by the searches of one request or batch; never reused across requests. */
export type CacheScopeMemo = Map<string, Promise<ScopeEntry | null>>;
export function createCacheScopeMemo(): CacheScopeMemo {
  return new Map();
}

/**
 * Seeds the memo with the access read the route itself made for this request
 * (lib/search-access.ts: the same docslurp_project_access query, key
 * allowlist and pipeline), so issuing the ticket does not repeat it. Only a
 * granted read is primed; `storeResponse` still re-reads access and privacy
 * unmemoized before writing, so a project made strict-privacy or unshared
 * while the search ran never gets an entry.
 */
export function primeCacheScope(memo: CacheScopeMemo, userId: string, access: { projectId: string; orgId: string; pipeline: unknown }): void {
  if (!access.orgId) return;
  memo.set(JSON.stringify([userId, access.projectId]), Promise.resolve({ orgId: access.orgId, privacyMode: privacyModeOf(access.pipeline) }));
}

export interface ResponseCacheTicket {
  readonly key: string;
  readonly orgKey: string;
  readonly userId: string;
  readonly projectIds: readonly string[];
  /** Invalidation generation of each project when the ticket was issued. */
  readonly generations: readonly number[];
}

type Entry = { at: number; data: unknown; bytes: number; orgKey: string; projectIds: readonly string[] };

/** Access and privacy lookups slower than this skip the cache (SEARCH_RESPONSE_CACHE_LOOKUP_TIMEOUT_MS, default 250). */
function keyResolutionTimeoutMs(): number {
  const value = Number.parseInt(process.env.SEARCH_RESPONSE_CACHE_LOOKUP_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : 250;
}
const defaultLimits = {
  maxEntries: 500,
  maxBytes: 32 * 1024 * 1024,
  maxEntryBytes: 1024 * 1024,
};
let limits = { ...defaultLimits };
/** Every cached answer; the map's insertion order is its eviction order (LRU). */
const entries = new Map<string, Entry>();
let totalBytes = 0;
const generations = new Map<string, number>();

onSearchProjectInvalidated({
  invalidate: invalidateSearchResponseCacheProject,
  active: () => entries.size > 0,
});

export function searchResponseCacheTtlMs(): number {
  const value = Number.parseInt(process.env.SEARCH_RESPONSE_CACHE_TTL_MS ?? "", 10);
  if (Number.isFinite(value) && value >= 0) return value;
  return process.env.NODE_ENV === "test" ? 0 : 30_000;
}

export function clearSearchResponseCacheForTests(): void {
  entries.clear();
  generations.clear();
  totalBytes = 0;
  limits = { ...defaultLimits };
}

export function configureSearchResponseCacheLimitsForTests(next: Partial<typeof defaultLimits>): void {
  limits = { ...limits, ...next };
}

export function searchResponseCacheStatsForTests(): { entries: number; bytes: number } {
  return { entries: entries.size, bytes: totalBytes };
}

/** Drops every cached answer that read the project, and fails in-flight writes for it. */
export function invalidateSearchResponseCacheProject(projectId: string): void {
  generations.set(projectId, (generations.get(projectId) ?? 0) + 1);
  for (const [key, entry] of entries) {
    if (entry.projectIds.includes(projectId)) removeEntry(key);
  }
}

async function lookupScope(projectId: string, userId: string): Promise<ScopeEntry | null> {
  try {
    const access = await getProjectAccessWithPipeline(projectId, userId);
    if (!access || access.projectId !== projectId || !access.orgId) return null;
    return { orgId: access.orgId, privacyMode: privacyModeOf(access.pipeline) };
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([promise.catch(() => null), timeout]).finally(() => clearTimeout(timer));
}

/** Organizations of a cacheable scope, or null (strict-privacy, unresolved, no access). */
async function cacheableScope(projectIds: readonly string[], userId: string, memo?: CacheScopeMemo): Promise<string[] | null> {
  const scopes = await Promise.all(projectIds.map((projectId) => {
    const memoKey = JSON.stringify([userId, projectId]);
    let lookup = memo?.get(memoKey);
    if (!lookup) {
      lookup = lookupScope(projectId, userId);
      memo?.set(memoKey, lookup);
    }
    return lookup;
  }));
  const resolved = scopes.filter((scope): scope is ScopeEntry => scope !== null);
  if (resolved.length !== projectIds.length) return null;
  if (resolved.some((scope) => privacyModeBypassesCaches(scope.privacyMode))) return null;
  return [...new Set(resolved.map((scope) => scope.orgId))].sort();
}

function normalizeProjectIds(projectIds: readonly string[]): string[] | null {
  const ids = [...new Set(projectIds.map((id) => id.trim()))].sort();
  return ids.length === 0 || ids.some((id) => !id) ? null : ids;
}

/**
 * The API key id a cache key may use: the authenticated actor's key (null for
 * a session), cross-checked with the request context. Undefined, meaning do
 * not cache, when the caller is unknown or the two disagree.
 */
export function cacheableApiKeyId(actorApiKeyId: string | null | undefined, contextApiKeyId: string | null): string | null | undefined {
  if (actorApiKeyId === undefined) return undefined;
  if (contextApiKeyId !== null && contextApiKeyId !== actorApiKeyId) return undefined;
  return actorApiKeyId;
}

/**
 * The cache ticket for one request, or null when this request must neither
 * read nor write the cache (strict-privacy, unresolvable or slow privacy or
 * access lookups, empty caller or scope).
 */
export async function responseCacheTicket(args: {
  userId: string;
  apiKeyId: string | null;
  projectIds: readonly string[];
  request: Record<string, unknown>;
  memo?: CacheScopeMemo;
}): Promise<ResponseCacheTicket | null> {
  const projectIds = normalizeProjectIds(args.projectIds);
  if (!args.userId.trim() || !projectIds) return null;
  const startGenerations = projectIds.map((id) => generations.get(id) ?? 0);
  const orgIds = await withTimeout(cacheableScope(projectIds, args.userId, args.memo), keyResolutionTimeoutMs());
  if (!orgIds || orgIds.length === 0) return null;
  const key = createHash("sha256")
    .update(JSON.stringify([orgIds, args.userId, args.apiKeyId, projectIds, args.request]))
    .digest("hex");
  return { key, orgKey: orgIds.join(","), userId: args.userId, projectIds, generations: startGenerations };
}

export function readCachedResponse(ticket: ResponseCacheTicket, ttlMs: number): unknown {
  const cached = entries.get(ticket.key);
  // The key already hashes the organizations; the stored org key is compared too, so an answer never leaves them.
  if (!cached || cached.orgKey !== ticket.orgKey) return undefined;
  if (Date.now() - cached.at >= ttlMs) {
    removeEntry(ticket.key);
    return undefined;
  }
  // Refresh recency: the map's insertion order is the eviction order.
  entries.delete(ticket.key);
  entries.set(ticket.key, cached);
  return cached.data;
}

/**
 * Stores a complete answer under its ticket. `scopeProjectId` is the
 * project the answer reports it searched; a single-project ticket requires
 * it to match exactly. Before writing, access and privacy are read again
 * (unmemoized) and the projects must not have been invalidated since the
 * ticket was issued. Returns whether the answer was stored.
 */
export async function storeResponse(ticket: ResponseCacheTicket, data: unknown, scopeProjectId: string | null | undefined): Promise<boolean> {
  const scopeMatches = ticket.projectIds.length === 1
    ? scopeProjectId === ticket.projectIds[0]
    : scopeProjectId === undefined || scopeProjectId === null || ticket.projectIds.includes(scopeProjectId);
  if (!scopeMatches) return false;
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(data) ?? "", "utf8");
  } catch {
    return false;
  }
  if (bytes > limits.maxEntryBytes || bytes > limits.maxBytes) return false;
  const changed = () => ticket.projectIds.some((id, index) => (generations.get(id) ?? 0) !== ticket.generations[index]);
  if (changed()) return false;
  const orgIds = await withTimeout(cacheableScope(ticket.projectIds, ticket.userId), keyResolutionTimeoutMs());
  if (!orgIds || orgIds.join(",") !== ticket.orgKey || changed()) return false;

  removeEntry(ticket.key);
  entries.set(ticket.key, { at: Date.now(), data, bytes, orgKey: ticket.orgKey, projectIds: ticket.projectIds });
  totalBytes += bytes;
  ensureInvalidationListener();
  while (entries.size > limits.maxEntries || totalBytes > limits.maxBytes) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    removeEntry(oldest);
  }
  return true;
}

function removeEntry(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  totalBytes -= entry.bytes;
}

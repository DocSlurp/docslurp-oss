import { createHash } from "node:crypto";
import type { PrivacyMode } from "@docslurp/shared";
import { privacyModeBypassesCaches } from "../lib/cache-privacy.js";
import { privacyModeOf } from "../lib/privacy.js";
import { getWorkspaceAccessWithPipeline } from "../services/organizations.js";
import { ensureInvalidationListener, onSearchWorkspaceInvalidated } from "./eligible-documents.js";

/**
 * Identical searches repeat constantly (type-ahead, popular questions), so a
 * complete answer is reused for a short window instead of re-running
 * embedding, vector and text retrieval. SEARCH_RESPONSE_CACHE_TTL_MS=0 disables it.
 *
 * Tenant boundary (every rule fails closed: when in doubt, no cache):
 * - The route authenticates the caller and checks the API key's scopes and
 *   workspace allowlist before it asks for a ticket, so a revoked or narrowed
 *   key is refused before any cached answer is read.
 * - `responseCacheTicket` re-checks workspace access for the user (and the
 *   request's key allowlist) and reads each workspace's privacy mode with one
 *   query per workspace, memoized only within one request or batch. A workspace
 *   that is strict-privacy, missing or unreachable, or a lookup that fails or
 *   exceeds the lookup timeout, yields no ticket: nothing is read or written.
 * - `storeResponse` repeats that lookup unmemoized just before writing, and
 *   skips the write if the workspace was invalidated while the search ran, so a
 *   workspace made strict-privacy mid-search never gets an entry.
 * - The key is a SHA-256 of the resolved organizations, the user, the API key
 *   id, the resolved workspace ids and the exact request (filters, retrieval
 *   options, the query as sent), so answers never cross callers, keys,
 *   tenants, workspaces or options.
 * - Entries are partitioned by organization with per-organization entry and
 *   byte caps; global pressure evicts from the largest organization, so one
 *   tenant cannot push out another's entries. Oversized answers are not kept.
 * - Settings, pipeline and document changes drop a workspace's entries through
 *   the search invalidation hints (eligible-documents.ts); answers are otherwise
 *   at most one TTL old.
 */

type ScopeEntry = { orgId: string; privacyMode: PrivacyMode };
/** Access and privacy lookups shared by the searches of one request or batch; never reused across requests. */
export type CacheScopeMemo = Map<string, Promise<ScopeEntry | null>>;
export function createCacheScopeMemo(): CacheScopeMemo {
  return new Map();
}

export interface ResponseCacheTicket {
  readonly key: string;
  readonly orgKey: string;
  readonly userId: string;
  readonly workspaceIds: readonly string[];
  /** Invalidation generation of each workspace when the ticket was issued. */
  readonly generations: readonly number[];
}

type Entry = { at: number; data: unknown; bytes: number; workspaceIds: readonly string[] };

/** Access and privacy lookups slower than this skip the cache (SEARCH_RESPONSE_CACHE_LOOKUP_TIMEOUT_MS, default 250). */
function keyResolutionTimeoutMs(): number {
  const value = Number.parseInt(process.env.SEARCH_RESPONSE_CACHE_LOOKUP_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : 250;
}
const defaultLimits = {
  maxEntries: 500,
  maxBytes: 32 * 1024 * 1024,
  perOrgMaxEntries: 100,
  perOrgMaxBytes: 8 * 1024 * 1024,
  maxEntryBytes: 1024 * 1024,
};
let limits = { ...defaultLimits };
/** Entries per organization key; each map's insertion order is its eviction order. */
const partitions = new Map<string, Map<string, Entry>>();
const partitionBytes = new Map<string, number>();
let totalEntries = 0;
let totalBytes = 0;
const generations = new Map<string, number>();

onSearchWorkspaceInvalidated({
  invalidate: invalidateSearchResponseCacheWorkspace,
  active: () => totalEntries > 0,
});

export function searchResponseCacheTtlMs(): number {
  const value = Number.parseInt(process.env.SEARCH_RESPONSE_CACHE_TTL_MS ?? "", 10);
  if (Number.isFinite(value) && value >= 0) return value;
  return process.env.NODE_ENV === "test" ? 0 : 30_000;
}

export function clearSearchResponseCacheForTests(): void {
  partitions.clear();
  partitionBytes.clear();
  generations.clear();
  totalEntries = 0;
  totalBytes = 0;
  limits = { ...defaultLimits };
}

export function configureSearchResponseCacheLimitsForTests(next: Partial<typeof defaultLimits>): void {
  limits = { ...limits, ...next };
}

export function searchResponseCacheStatsForTests(): { entries: number; bytes: number; byOrg: Record<string, number> } {
  return { entries: totalEntries, bytes: totalBytes, byOrg: Object.fromEntries([...partitions].map(([org, entries]) => [org, entries.size])) };
}

/** Drops every cached answer that read the workspace, and fails in-flight writes for it. */
export function invalidateSearchResponseCacheWorkspace(workspaceId: string): void {
  generations.set(workspaceId, (generations.get(workspaceId) ?? 0) + 1);
  for (const [orgKey, entries] of partitions) {
    for (const [key, entry] of entries) {
      if (entry.workspaceIds.includes(workspaceId)) removeEntry(orgKey, key);
    }
  }
}

async function lookupScope(workspaceId: string, userId: string): Promise<ScopeEntry | null> {
  try {
    const access = await getWorkspaceAccessWithPipeline(workspaceId, userId);
    if (!access || access.workspaceId !== workspaceId || !access.orgId) return null;
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
async function cacheableScope(workspaceIds: readonly string[], userId: string, memo?: CacheScopeMemo): Promise<string[] | null> {
  const scopes = await Promise.all(workspaceIds.map((workspaceId) => {
    const memoKey = JSON.stringify([userId, workspaceId]);
    let lookup = memo?.get(memoKey);
    if (!lookup) {
      lookup = lookupScope(workspaceId, userId);
      memo?.set(memoKey, lookup);
    }
    return lookup;
  }));
  const resolved = scopes.filter((scope): scope is ScopeEntry => scope !== null);
  if (resolved.length !== workspaceIds.length) return null;
  if (resolved.some((scope) => privacyModeBypassesCaches(scope.privacyMode))) return null;
  return [...new Set(resolved.map((scope) => scope.orgId))].sort();
}

function normalizeWorkspaceIds(workspaceIds: readonly string[]): string[] | null {
  const ids = [...new Set(workspaceIds.map((id) => id.trim()))].sort();
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
  workspaceIds: readonly string[];
  request: Record<string, unknown>;
  memo?: CacheScopeMemo;
}): Promise<ResponseCacheTicket | null> {
  const workspaceIds = normalizeWorkspaceIds(args.workspaceIds);
  if (!args.userId.trim() || !workspaceIds) return null;
  const startGenerations = workspaceIds.map((id) => generations.get(id) ?? 0);
  const orgIds = await withTimeout(cacheableScope(workspaceIds, args.userId, args.memo), keyResolutionTimeoutMs());
  if (!orgIds || orgIds.length === 0) return null;
  const key = createHash("sha256")
    .update(JSON.stringify([orgIds, args.userId, args.apiKeyId, workspaceIds, args.request]))
    .digest("hex");
  return { key, orgKey: orgIds.join(","), userId: args.userId, workspaceIds, generations: startGenerations };
}

export function readCachedResponse(ticket: ResponseCacheTicket, ttlMs: number): unknown {
  const entries = partitions.get(ticket.orgKey);
  const cached = entries?.get(ticket.key);
  if (!entries || !cached) return undefined;
  if (Date.now() - cached.at >= ttlMs) {
    removeEntry(ticket.orgKey, ticket.key);
    return undefined;
  }
  // Refresh recency: the map's insertion order is the eviction order.
  entries.delete(ticket.key);
  entries.set(ticket.key, cached);
  return cached.data;
}

/**
 * Stores a complete answer under its ticket. `scopeWorkspaceId` is the
 * workspace the answer reports it searched; a single-workspace ticket requires
 * it to match exactly. Before writing, access and privacy are read again
 * (unmemoized) and the workspaces must not have been invalidated since the
 * ticket was issued. Returns whether the answer was stored.
 */
export async function storeResponse(ticket: ResponseCacheTicket, data: unknown, scopeWorkspaceId: string | null | undefined): Promise<boolean> {
  const scopeMatches = ticket.workspaceIds.length === 1
    ? scopeWorkspaceId === ticket.workspaceIds[0]
    : scopeWorkspaceId === undefined || scopeWorkspaceId === null || ticket.workspaceIds.includes(scopeWorkspaceId);
  if (!scopeMatches) return false;
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(data) ?? "", "utf8");
  } catch {
    return false;
  }
  if (bytes > limits.maxEntryBytes || bytes > limits.perOrgMaxBytes || bytes > limits.maxBytes) return false;
  const changed = () => ticket.workspaceIds.some((id, index) => (generations.get(id) ?? 0) !== ticket.generations[index]);
  if (changed()) return false;
  const orgIds = await withTimeout(cacheableScope(ticket.workspaceIds, ticket.userId), keyResolutionTimeoutMs());
  if (!orgIds || orgIds.join(",") !== ticket.orgKey || changed()) return false;

  removeEntry(ticket.orgKey, ticket.key);
  let entries = partitions.get(ticket.orgKey);
  if (!entries) {
    entries = new Map();
    partitions.set(ticket.orgKey, entries);
  }
  entries.set(ticket.key, { at: Date.now(), data, bytes, workspaceIds: ticket.workspaceIds });
  partitionBytes.set(ticket.orgKey, (partitionBytes.get(ticket.orgKey) ?? 0) + bytes);
  totalEntries += 1;
  totalBytes += bytes;
  ensureInvalidationListener();
  evict(ticket.orgKey);
  return true;
}

function removeEntry(orgKey: string, key: string): void {
  const entries = partitions.get(orgKey);
  const entry = entries?.get(key);
  if (!entries || !entry) return;
  entries.delete(key);
  totalEntries -= 1;
  totalBytes -= entry.bytes;
  if (entries.size === 0) {
    partitions.delete(orgKey);
    partitionBytes.delete(orgKey);
  } else {
    partitionBytes.set(orgKey, (partitionBytes.get(orgKey) ?? 0) - entry.bytes);
  }
}

function evictOldest(orgKey: string): void {
  const oldest = partitions.get(orgKey)?.keys().next().value;
  if (oldest !== undefined) removeEntry(orgKey, oldest);
}

/** An organization first trims to its own caps; global pressure then evicts from the largest organization. */
function evict(orgKey: string): void {
  while ((partitions.get(orgKey)?.size ?? 0) > limits.perOrgMaxEntries || (partitionBytes.get(orgKey) ?? 0) > limits.perOrgMaxBytes) {
    evictOldest(orgKey);
  }
  while (totalEntries > limits.maxEntries || totalBytes > limits.maxBytes) {
    let largest: string | null = null;
    for (const [candidate, entries] of partitions) {
      if (largest === null) { largest = candidate; continue; }
      const bytes = partitionBytes.get(candidate) ?? 0;
      const best = partitionBytes.get(largest) ?? 0;
      if (bytes > best || (bytes === best && entries.size > (partitions.get(largest)?.size ?? 0))) largest = candidate;
    }
    if (largest === null) return;
    evictOldest(largest);
  }
}

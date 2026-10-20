import { createHash } from "node:crypto";

import { envInt, TtlLruCache } from "./ttl-lru.js";

/**
 * Query-embedding cache. Follow-up and repeated searches re-embed the same
 * text; a hit skips the provider call entirely.
 *
 * Entries are keyed per organization, so one tenant's searches can never be
 * observed (even as a latency difference) by another. The key also carries
 * everything that changes the vector: provider, runtime, endpoint, model,
 * dimensions, normalization, and the query text. Text is only trimmed and
 * whitespace-collapsed (never lowercased: many models are case-sensitive) and
 * is stored as a hash, so the cache holds no readable query text.
 *
 * Env: SEARCH_EMBEDDING_CACHE_MAX_ENTRIES (default 1000; 0 disables) and
 * SEARCH_EMBEDDING_CACHE_TTL_SECONDS (default 3600).
 */
export interface EmbeddingCacheIdentity {
  orgId: string;
  provider: string;
  runtime: string;
  model: string;
  modelUri?: string | null;
  baseUrl?: string | null;
  dimensions: number;
  requestedDimensions?: number | null;
  normalize: boolean;
}

export function normalizeEmbeddingQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

export function embeddingCacheKey(identity: EmbeddingCacheIdentity, query: string): string {
  return createHash("sha256").update(JSON.stringify([
    identity.orgId, identity.provider, identity.runtime, identity.model, identity.modelUri ?? null,
    identity.baseUrl ?? null, identity.dimensions, identity.requestedDimensions ?? null, identity.normalize,
    normalizeEmbeddingQuery(query),
  ])).digest("hex");
}

export function createEmbeddingCache(env: NodeJS.ProcessEnv = process.env, now?: () => number): TtlLruCache<number[]> {
  return new TtlLruCache<number[]>(
    envInt("SEARCH_EMBEDDING_CACHE_MAX_ENTRIES", 1000, env),
    envInt("SEARCH_EMBEDDING_CACHE_TTL_SECONDS", 3600, env) * 1000,
    now,
  );
}

let shared: TtlLruCache<number[]> | undefined;

export function embeddingCache(): TtlLruCache<number[]> {
  return shared ??= createEmbeddingCache();
}

export function resetEmbeddingCacheForTests(): void {
  shared = undefined;
}

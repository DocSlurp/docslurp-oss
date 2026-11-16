import { createHash } from "node:crypto";
import { requireOrgId } from "@docslurp/shared";

import { envInt, OrgPartitionedTtlLru } from "./ttl-lru.js";

/**
 * Vector-result cache, off by default. The key includes the org, every
 * storage target, each target's table version and every query parameter that
 * can change the hit list, so a new table version (any write) is a new key and
 * a stale hit list cannot be served. Entries never cross organizations, and
 * each organization has its own share of the cache (OrgPartitionedTtlLru), so
 * one tenant's volume cannot evict another's entries.
 *
 * Env: SEARCH_RESULT_CACHE_MAX_ENTRIES (default 0 = off),
 * SEARCH_RESULT_CACHE_MAX_ENTRIES_PER_ORG (default a quarter of the total) and
 * SEARCH_RESULT_CACHE_TTL_SECONDS (default 30).
 */
export interface ResultCacheKeyInput {
  orgId: string;
  /** One entry per storage target: uri, table name, version and its document scope. */
  targets: Array<{ uri: string; name: string; version: number; documentIds?: string[] }>;
  queryVector: number[];
  limit: number;
  refineFactor?: string;
  embeddingModel?: string;
  /** Per-target tuning that shapes results (ANN ef). */
  tuning: Array<{ ef?: number; refineFactor?: number }>;
  /** Anything else that changes the cached value (selected columns, extra filters). */
  variant?: string;
}

export function hashVector(vector: number[]): string {
  const bytes = Buffer.from(new Float64Array(vector).buffer);
  return createHash("sha256").update(bytes).digest("hex");
}

export function resultCacheKey(input: ResultCacheKeyInput): string {
  const orgId = requireOrgId(input.orgId, "vector-result cache key");
  return createHash("sha256").update(JSON.stringify([
    "vector-result/v1", orgId,
    input.targets.map((target) => [target.uri, target.name, target.version,
      target.documentIds ? [...new Set(target.documentIds)].sort() : null]),
    hashVector(input.queryVector), input.queryVector.length, input.limit, input.refineFactor ?? null,
    input.embeddingModel ?? null, input.tuning, ...(input.variant ? [input.variant] : []),
  ])).digest("hex");
}

export function createResultCache<V>(env: NodeJS.ProcessEnv = process.env, now?: () => number): OrgPartitionedTtlLru<V> {
  const maxEntries = envInt("SEARCH_RESULT_CACHE_MAX_ENTRIES", 0, env);
  return new OrgPartitionedTtlLru<V>(
    maxEntries,
    envInt("SEARCH_RESULT_CACHE_TTL_SECONDS", 30, env) * 1000,
    envInt("SEARCH_RESULT_CACHE_MAX_ENTRIES_PER_ORG", Math.max(1, Math.floor(maxEntries / 4)), env),
    now,
  );
}

let shared: OrgPartitionedTtlLru<unknown> | undefined;

export function resultCache<V>(): OrgPartitionedTtlLru<V> {
  return (shared ??= createResultCache<unknown>()) as OrgPartitionedTtlLru<V>;
}

export function resetResultCacheForTests(): void {
  shared = undefined;
}

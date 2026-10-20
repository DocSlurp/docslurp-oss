import { createHash } from "node:crypto";

import { envInt, TtlLruCache } from "./ttl-lru.js";

/**
 * Vector-result cache, off by default. The key includes the org, every
 * storage target, each target's table version and every query parameter that
 * can change the hit list, so a new table version (any write) is a new key and
 * a stale hit list cannot be served. Entries never cross organizations.
 *
 * Env: SEARCH_RESULT_CACHE_MAX_ENTRIES (default 0 = off) and
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
}

export function hashVector(vector: number[]): string {
  const bytes = Buffer.from(new Float64Array(vector).buffer);
  return createHash("sha256").update(bytes).digest("hex");
}

export function resultCacheKey(input: ResultCacheKeyInput): string {
  return createHash("sha256").update(JSON.stringify([
    input.orgId,
    input.targets.map((target) => [target.uri, target.name, target.version,
      target.documentIds ? [...new Set(target.documentIds)].sort() : null]),
    hashVector(input.queryVector), input.queryVector.length, input.limit, input.refineFactor ?? null,
    input.embeddingModel ?? null, input.tuning,
  ])).digest("hex");
}

export function createResultCache<V>(env: NodeJS.ProcessEnv = process.env, now?: () => number): TtlLruCache<V> {
  return new TtlLruCache<V>(
    envInt("SEARCH_RESULT_CACHE_MAX_ENTRIES", 0, env),
    envInt("SEARCH_RESULT_CACHE_TTL_SECONDS", 30, env) * 1000,
    now,
  );
}

let shared: TtlLruCache<unknown> | undefined;

export function resultCache<V>(): TtlLruCache<V> {
  return (shared ??= createResultCache<unknown>()) as TtlLruCache<V>;
}

export function resetResultCacheForTests(): void {
  shared = undefined;
}

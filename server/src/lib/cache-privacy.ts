import type { PrivacyMode } from "@docslurp/shared";

/**
 * Whether a privacy mode keeps a workspace's queries and results out of every
 * shared in-memory cache: the query-embedding cache, the LanceDB result cache
 * and the search response cache. One predicate, so the caches never disagree.
 * A missing mode is not an answer: callers that cannot resolve it skip the cache.
 */
export function privacyModeBypassesCaches(mode: PrivacyMode): boolean {
  return mode === "strict-privacy";
}

import { setOpenRouterProviderPolicyResolver, type OpenRouterProviderPolicy } from "@docslurp/shared";

import { sql } from "../db.js";
import { currentRequestOrgId, currentRequestUserId } from "./request-context.js";

/** Short enough that a changed setting applies within the minute on every instance. */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { allow: boolean; at: number }>();

async function cached(key: string, load: () => Promise<boolean>): Promise<boolean> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.allow;
  const allow = await load();
  if (cache.size > 5_000) cache.clear();
  cache.set(key, { allow, at: Date.now() });
  return allow;
}

/** Drops cached policy after an org changes its setting (this instance; others expire within the TTL). */
export function forgetProviderPolicy(orgId: string): void {
  cache.delete(`org:${orgId}`);
  for (const key of cache.keys()) if (key.startsWith("user:")) cache.delete(key);
}

/**
 * The request's China-provider policy. A request that resolved its org (an API
 * key, or a workspace) uses that org's setting. A session request without one
 * is restricted when any of the user's organizations turned the providers off,
 * so a restricted org's work never reaches them by default.
 */
export async function requestProviderPolicy(): Promise<OpenRouterProviderPolicy | undefined> {
  const orgId = currentRequestOrgId();
  if (orgId) {
    return { allowChinaProviders: await cached(`org:${orgId}`, async () => {
      const [row] = await sql<{ allow: boolean }[]>`select allow_china_providers as allow from organizations where id = ${orgId}`;
      return row?.allow !== false;
    }) };
  }
  const userId = currentRequestUserId();
  if (!userId) return undefined;
  return { allowChinaProviders: await cached(`user:${userId}`, async () => {
    const [row] = await sql<{ allow: boolean | null }[]>`
      select bool_and(o.allow_china_providers) as allow
      from org_memberships m join organizations o on o.id = m.org_id
      where m.user_id = ${userId}`;
    return row?.allow !== false;
  }) };
}

export function registerProviderPolicy(): void {
  setOpenRouterProviderPolicyResolver(requestProviderPolicy);
}

import { setOpenRouterProviderPolicyResolver, type OpenRouterProviderPolicy } from "@docslurp/shared";

import { sql } from "../db.js";
import { currentProviderPolicyProjectIds, currentRequestOrgId, currentRequestUserId } from "./request-context.js";

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
  for (const key of cache.keys()) if (key.startsWith("user:") || key.startsWith("ws:")) cache.delete(key);
}

/** Drops cached policy after a project changes its setting. */
export function forgetProjectProviderPolicy(projectId: string): void {
  cache.delete(`ws:${projectId}`);
}

/** The org's setting; a missing org is restricted. */
async function orgAllows(orgId: string): Promise<boolean> {
  return await cached(`org:${orgId}`, async () => {
    const [row] = await sql<{ allow: boolean }[]>`select allow_china_providers as allow from organizations where id = ${orgId}`;
    return row?.allow === true;
  });
}

/** The project's own setting AND its organization's; a missing project or org is restricted. */
async function projectAllows(projectId: string): Promise<boolean> {
  return await cached(`ws:${projectId}`, async () => {
    const [row] = await sql<{ allow: boolean | null }[]>`
      select w.allow_china_providers and coalesce(o.allow_china_providers, false) as allow
      from projects w left join organizations o on o.id = w.org_id
      where w.id = ${projectId}`;
    return row?.allow === true;
  });
}

/**
 * The request's China-provider policy: allowed only when the request's org (API key or resolved project)
 * and every project whose content the request sends to a hosted call (`noteProviderPolicyProject`) allow
 * it. A project can narrow its org's setting, never widen it. A session request without an org or project
 * is restricted when any of the user's organizations turned the providers off. A request with no user, org or
 * project (startup and background tasks) is restricted: unknown scope fails closed.
 */
export async function requestProviderPolicy(): Promise<OpenRouterProviderPolicy> {
  const orgId = currentRequestOrgId();
  const projectIds = currentProviderPolicyProjectIds();
  if (orgId || projectIds.length) {
    const checks = await Promise.all([
      ...(orgId ? [orgAllows(orgId)] : []),
      ...projectIds.map((id) => projectAllows(id)),
    ]);
    return { allowChinaProviders: checks.every(Boolean) };
  }
  const userId = currentRequestUserId();
  if (!userId) return { allowChinaProviders: false };
  return { allowChinaProviders: await cached(`user:${userId}`, async () => {
    const [row] = await sql<{ allow: boolean | null }[]>`
      select bool_and(o.allow_china_providers) as allow
      from org_memberships m join organizations o on o.id = m.org_id
      where m.user_id = ${userId}`;
    return row?.allow === true;
  }) };
}

export function registerProviderPolicy(): void {
  setOpenRouterProviderPolicyResolver(requestProviderPolicy);
}

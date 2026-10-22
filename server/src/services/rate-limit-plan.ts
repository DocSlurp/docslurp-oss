import { isBillingExemptOrg } from "@docslurp/shared";

import { sql } from "../db.js";

/**
 * Which per-category rate-limit table (free or paid) an API key or signed-in
 * user gets, from the organization's billing state rather than anything the
 * caller controls: funded organizations (ever bought credits, migration 0068)
 * get the paid table, starter organizations the free table. Billing-exempt
 * (house) organizations are paid. A session is paid when any organization the
 * user belongs to is. Lookups are cached per process for PLAN_CACHE_TTL_MS with
 * single-flight refreshes; a failed lookup keeps the last known value, or free.
 */
export type PlanRateLimitProfile = "free" | "paid";

const PLAN_CACHE_TTL_MS = 60_000;

type FundingRow = { id: string; funded: boolean | null };

const cache = new Map<string, { profile: PlanRateLimitProfile; expiresAt: number; pending?: Promise<PlanRateLimitProfile> }>();

export function isPaidRateLimitOrg(row: FundingRow): boolean {
  return isBillingExemptOrg(row.id) || row.funded === true;
}

async function cached(key: string, now: number, load: () => Promise<PlanRateLimitProfile>): Promise<PlanRateLimitProfile> {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > now) return entry.profile;
  if (entry?.pending) return await entry.pending;
  const pending = load();
  cache.set(key, { profile: entry?.profile ?? "free", expiresAt: 0, pending });
  try {
    const profile = await pending;
    cache.set(key, { profile, expiresAt: now + PLAN_CACHE_TTL_MS });
    return profile;
  } catch (error) {
    const fallback = entry?.profile ?? "free";
    // Retry soon rather than hammering a failing database on every request.
    cache.set(key, { profile: fallback, expiresAt: now + 5_000 });
    console.error("[rate-limit] plan lookup failed; using", fallback, "limits:", error instanceof Error ? error.message : String(error));
    return fallback;
  }
}

function planColumns() {
  return sql`o.id, o.funded_at is not null as funded`;
}

export async function orgRateLimitProfile(orgId: string, now = Date.now()): Promise<PlanRateLimitProfile> {
  if (isBillingExemptOrg(orgId)) return "paid";
  return await cached(`org:${orgId}`, now, async () => {
    const rows = await sql<FundingRow[]>`select ${planColumns()} from organizations o where o.id = ${orgId}`;
    return rows[0] && isPaidRateLimitOrg(rows[0]) ? "paid" : "free";
  });
}

export async function userRateLimitProfile(userId: string, now = Date.now()): Promise<PlanRateLimitProfile> {
  return await cached(`user:${userId}`, now, async () => {
    const rows = await sql<FundingRow[]>`
      select ${planColumns()}
      from org_memberships om join organizations o on o.id = om.org_id
      where om.user_id = ${userId}
    `;
    return rows.some(isPaidRateLimitOrg) ? "paid" : "free";
  });
}

export function resetRateLimitPlanCache(): void {
  cache.clear();
}

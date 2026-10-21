import { getPlan, isBillingExemptOrg } from "@docslurp/shared";

import { sql } from "../db.js";
import { PAST_DUE_GRACE_DAYS } from "./billing/webhooks.js";

/**
 * Which per-category rate-limit table (free or paid) an API key or signed-in
 * user gets, from the organization's billing state rather than anything the
 * caller controls.
 *
 * An organization is paid while its plan is not Free and its subscription
 * has not lapsed: a past-due subscription keeps paid limits for the same grace
 * period as its worker ceiling (PAST_DUE_GRACE_DAYS), then drops to Free.
 * Billing-exempt (house) organizations are paid. A session is paid when any
 * organization the user belongs to is. Lookups are cached per process for
 * PLAN_CACHE_TTL_MS with single-flight refreshes; a failed lookup keeps the
 * last known value, or Free.
 */
export type PlanRateLimitProfile = "free" | "paid";

const PLAN_CACHE_TTL_MS = 60_000;
const LAPSED_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired"]);

type PlanRow = { id: string; plan_id: string | null; subscription_status: string | null; past_due_expired: boolean | null };

const cache = new Map<string, { profile: PlanRateLimitProfile; expiresAt: number; pending?: Promise<PlanRateLimitProfile> }>();

export function isPaidRateLimitOrg(row: PlanRow): boolean {
  if (isBillingExemptOrg(row.id)) return true;
  if (getPlan(row.plan_id).id === "free") return false;
  const status = row.subscription_status ?? "none";
  if (LAPSED_STATUSES.has(status)) return false;
  return !(status === "past_due" && row.past_due_expired === true);
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
  return sql`
  o.id, o.plan_id, o.subscription_status,
  (o.past_due_since is not null and o.past_due_since < now() - make_interval(days => ${PAST_DUE_GRACE_DAYS})) as past_due_expired
  `;
}

export async function orgRateLimitProfile(orgId: string, now = Date.now()): Promise<PlanRateLimitProfile> {
  if (isBillingExemptOrg(orgId)) return "paid";
  return await cached(`org:${orgId}`, now, async () => {
    const rows = await sql<PlanRow[]>`select ${planColumns()} from organizations o where o.id = ${orgId}`;
    return rows[0] && isPaidRateLimitOrg(rows[0]) ? "paid" : "free";
  });
}

export async function userRateLimitProfile(userId: string, now = Date.now()): Promise<PlanRateLimitProfile> {
  return await cached(`user:${userId}`, now, async () => {
    const rows = await sql<PlanRow[]>`
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

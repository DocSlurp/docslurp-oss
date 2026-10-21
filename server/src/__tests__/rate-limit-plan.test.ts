import { beforeEach, describe, expect, it, vi } from "vitest";

// Query results in order; the column-list fragment is not a query.
const { sql, results } = vi.hoisted(() => {
  const results: Array<unknown[] | Error> = [];
  const sql = vi.fn((strings: TemplateStringsArray) => {
    if (!strings.join("").includes("from")) return { fragment: true };
    const next = results.shift() ?? [];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return { sql, results };
});
vi.mock("../db.js", () => ({ sql }));
vi.mock("../services/billing/webhooks.js", () => ({ PAST_DUE_GRACE_DAYS: 7 }));

const { isPaidRateLimitOrg, orgRateLimitProfile, resetRateLimitPlanCache, userRateLimitProfile } = await import("../services/rate-limit-plan.js");

const row = (overrides: Partial<{ id: string; plan_id: string | null; subscription_status: string | null; past_due_expired: boolean | null }> = {}) => ({
  id: "org-1", plan_id: "silver", subscription_status: "active", past_due_expired: false, ...overrides,
});

describe("plan-based rate-limit profile", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    sql.mockClear();
    results.length = 0;
    resetRateLimitPlanCache();
  });

  it("is paid for a live paid plan, within the past-due grace and for house orgs", () => {
    expect(isPaidRateLimitOrg(row())).toBe(true);
    expect(isPaidRateLimitOrg(row({ subscription_status: "trialing" }))).toBe(true);
    expect(isPaidRateLimitOrg(row({ subscription_status: "past_due", past_due_expired: false }))).toBe(true);
    expect(isPaidRateLimitOrg(row({ subscription_status: "none", plan_id: "gold" }))).toBe(true);
    vi.stubEnv("BILLING_EXEMPT_ORG_IDS", "org-house");
    expect(isPaidRateLimitOrg(row({ id: "org-house", plan_id: "free", subscription_status: "none" }))).toBe(true);
  });

  it("is free on the Free plan, unknown plans, lapsed subscriptions and past the grace", () => {
    expect(isPaidRateLimitOrg(row({ plan_id: "free" }))).toBe(false);
    expect(isPaidRateLimitOrg(row({ plan_id: "enterprise-typo" }))).toBe(false);
    expect(isPaidRateLimitOrg(row({ plan_id: null }))).toBe(false);
    for (const status of ["canceled", "unpaid", "incomplete_expired"]) expect(isPaidRateLimitOrg(row({ subscription_status: status }))).toBe(false);
    expect(isPaidRateLimitOrg(row({ subscription_status: "past_due", past_due_expired: true }))).toBe(false);
  });

  it("reads the org once per cache window and refreshes after it", async () => {
    results.push([row()], [row({ plan_id: "free" })]);
    expect(await orgRateLimitProfile("org-1", 1_000)).toBe("paid");
    expect(await orgRateLimitProfile("org-1", 30_000)).toBe("paid");
    expect(sql.mock.calls.filter(([strings]) => strings.join("").includes("from organizations o where"))).toHaveLength(1);
    expect(await orgRateLimitProfile("org-1", 62_000)).toBe("free");
  });

  it("is paid for a session when any of the user's organizations is paid", async () => {
    results.push([row({ id: "personal", plan_id: "free" }), row({ id: "team" })]);
    expect(await userRateLimitProfile("user-1", 1_000)).toBe("paid");
    results.push([row({ id: "personal", plan_id: "free" })]);
    expect(await userRateLimitProfile("user-2", 1_000)).toBe("free");
  });

  it("keeps the last known profile, or Free, when the lookup fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    results.push(new Error("db down"));
    expect(await orgRateLimitProfile("org-new", 1_000)).toBe("free");
    results.push([row({ id: "org-known" })]);
    expect(await orgRateLimitProfile("org-known", 1_000)).toBe("paid");
    results.push(new Error("db down"));
    expect(await orgRateLimitProfile("org-known", 70_000)).toBe("paid");
    error.mockRestore();
  });
});

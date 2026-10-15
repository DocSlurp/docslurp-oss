import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = Object.assign(vi.fn(), { begin: vi.fn() });
vi.mock("../db.js", () => ({ sql: sqlMock }));

const {
  assertCanSpend,
  canSpend,
  spendAwareErrorHandler,
  spendBlockReason,
  SpendBlockedError,
} = await import("../services/billing/spend-guard.js");
const { resolveChatCreditReserveConfig } = await import("@docslurp/shared");

// Defaults: $3 reserve/overdraft on paid plans, $1 on Free, 5-credit holds.
const config = resolveChatCreditReserveConfig({});

const status = (overrides: Partial<Parameters<typeof spendBlockReason>[0] & object> = {}) => ({
  orgId: "org-1",
  planId: "free",
  available: 10,
  reserved: 0,
  workspaceBudgetPaused: false,
  orgBudgetPaused: false,
  workspaceInOrg: true,
  ...overrides,
});

describe("spend admission rule", () => {
  const noReserve = resolveChatCreditReserveConfig({ CHAT_CREDIT_RESERVE_CREDITS: "0", CHAT_CREDIT_RESERVE_FREE_CREDITS: "0" });

  it("allows spend while available credits exceed reservations and nothing is paused", () => {
    expect(spendBlockReason(status(), "job", noReserve)).toBeNull();
    expect(spendBlockReason(status({ available: 0.01 }), "job", noReserve)).toBeNull();
  });

  it("blocks at zero or negative available credits, counting reservations", () => {
    expect(spendBlockReason(status({ available: 0 }), "job", noReserve)?.code).toBe("credit_exhausted");
    expect(spendBlockReason(status({ available: -4 }), "job", noReserve)?.code).toBe("credit_exhausted");
    expect(spendBlockReason(status({ available: 2, reserved: 2 }), "job", noReserve)?.code).toBe("credit_exhausted");
  });

  it("keeps the chat reserve away from jobs: $1 on Free, $3 on paid plans", () => {
    expect(config).toMatchObject({ freeReserveCredits: 100, paidReserveCredits: 300, freeOverdraftCredits: 100, paidOverdraftCredits: 300 });
    expect(spendBlockReason(status({ available: 100 }), "job", config)?.code).toBe("credit_exhausted");
    expect(spendBlockReason(status({ available: 100.5 }), "job", config)).toBeNull();
    expect(spendBlockReason(status({ available: 150, reserved: 50 }), "job", config)?.code).toBe("credit_exhausted");
    expect(spendBlockReason(status({ planId: "gold", available: 300 }), "job", config)?.code).toBe("credit_exhausted");
    expect(spendBlockReason(status({ planId: "gold", available: 301 }), "job", config)).toBeNull();
  });

  it("lets interactive spend ignore leases and carry a balance down to the overdraft allowance", () => {
    // Every credit leased by running ingestion: chat still works.
    expect(spendBlockReason(status({ available: 40, reserved: 40, hasCreditGrants: true }), "interactive", config)).toBeNull();
    // Leases count toward the overdraft floor once chat has spent credits jobs still hold.
    expect(spendBlockReason(status({ available: 0, reserved: 99, hasCreditGrants: true }), "interactive", config)).toBeNull();
    expect(spendBlockReason(status({ available: 0, reserved: 100, hasCreditGrants: true }), "interactive", config)?.code).toBe("credit_exhausted");
    expect(spendBlockReason(status({ available: -99, hasCreditGrants: true }), "interactive", config)).toBeNull();
    expect(spendBlockReason(status({ available: -100, hasCreditGrants: true }), "interactive", config)?.code).toBe("credit_exhausted");
    expect(spendBlockReason(status({ planId: "silver", available: -299, hasCreditGrants: true }), "interactive", config)).toBeNull();
    expect(spendBlockReason(status({ planId: "silver", available: -300, hasCreditGrants: true }), "interactive", config)?.code).toBe("credit_exhausted");
  });

  it("gives orgs that never received credits no overdraft", () => {
    expect(spendBlockReason(status({ available: 0, hasCreditGrants: false }), "interactive", config)?.code).toBe("credit_exhausted");
    expect(spendBlockReason(status({ available: 0.5, hasCreditGrants: false }), "interactive", config)).toBeNull();
  });

  it("keeps budget caps and entitlement as hard stops for interactive spend", () => {
    expect(spendBlockReason(status({ workspaceBudgetPaused: true, hasCreditGrants: true }), "interactive", config)?.code).toBe("workspace_budget_paused");
    expect(spendBlockReason(status({ orgBudgetPaused: true, hasCreditGrants: true }), "interactive", config)?.code).toBe("org_budget_paused");
    expect(spendBlockReason(status({ workspaceInOrg: false, hasCreditGrants: true }), "interactive", config)?.code).toBe("plan_not_entitled");
  });

  it("never credit-gates house orgs, but still honours their budget caps", () => {
    process.env.BILLING_EXEMPT_ORG_IDS = " org-house , org-other ";
    try {
      expect(spendBlockReason(status({ orgId: "org-house", available: -4 }))).toBeNull();
      expect(spendBlockReason(status({ orgId: "org-house", available: -4000 }), "interactive")).toBeNull();
      expect(spendBlockReason(status({ orgId: "org-1", available: -4 }))?.code).toBe("credit_exhausted");
      expect(spendBlockReason(status({ orgId: "org-house", available: -4, orgBudgetPaused: true }))?.code).toBe("org_budget_paused");
    } finally {
      delete process.env.BILLING_EXEMPT_ORG_IDS;
    }
  });

  it("blocks budget-paused workspaces and orgs, and workspaces outside a billing org", () => {
    expect(spendBlockReason(status({ workspaceBudgetPaused: true }))?.code).toBe("workspace_budget_paused");
    expect(spendBlockReason(status({ orgBudgetPaused: true }))?.code).toBe("org_budget_paused");
    expect(spendBlockReason(status({ workspaceInOrg: false }))?.code).toBe("plan_not_entitled");
    expect(spendBlockReason(null)?.code).toBe("plan_not_entitled");
  });
});

describe("assertCanSpend", () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  const row = (overrides: Record<string, unknown> = {}) => ({
    org_id: "org-1", plan_id: "free", available: "500", reserved: "0",
    workspace_budget_paused: false, org_budget_paused: false, workspace_in_org: true, has_credit_grants: true, ...overrides,
  });

  it("reads org_spend_status for the workspace and throws a 402 when blocked", async () => {
    sqlMock.mockResolvedValueOnce([row()]);
    await expect(assertCanSpend(null, "ws-1")).resolves.toBeUndefined();
    const [strings, ...values] = sqlMock.mock.calls[0]!;
    expect((strings as string[]).join("?")).toContain("org_spend_status");
    expect(values).toEqual([null, "ws-1", 0]);

    sqlMock.mockResolvedValueOnce([row({ available: "-0.25" })]);
    await expect(assertCanSpend("org-1", "ws-1")).rejects.toMatchObject({ statusCode: 402, code: "credit_exhausted" });
    // Within the chat reserve: jobs are refused.
    sqlMock.mockResolvedValueOnce([row({ available: "80" })]);
    await expect(assertCanSpend("org-1", "ws-1")).rejects.toMatchObject({ code: "credit_exhausted" });
    sqlMock.mockResolvedValueOnce([]);
    await expect(assertCanSpend(null, "ws-unknown")).rejects.toMatchObject({ code: "plan_not_entitled" });
  });

  it("passes interactive spend without a lock when comfortably above zero", async () => {
    sqlMock.mockResolvedValueOnce([row({ available: "106" })]);
    await expect(assertCanSpend(null, "ws-1", { kind: "interactive" })).resolves.toBeUndefined();
    expect(sqlMock.begin).not.toHaveBeenCalled();
  });

  it("near zero, admits interactive spend through admit_interactive_spend with a hold", async () => {
    sqlMock.begin.mockReset();
    const tx = vi.fn();
    sqlMock.begin.mockImplementation(async (fn: (client: unknown) => unknown) => await fn(tx));
    sqlMock.mockResolvedValueOnce([row({ available: "-40" })]);
    tx.mockResolvedValueOnce([{ admitted: true, available: "-40", held: "10" }]);
    await expect(assertCanSpend(null, "ws-1", { kind: "interactive" })).resolves.toBeUndefined();
    const [strings, ...values] = tx.mock.calls[0]!;
    expect((strings as string[]).join("?")).toContain("admit_interactive_spend");
    expect(values).toEqual(["org-1", "ws-1", 100, 5, 120]);

    // Refused once holds of concurrent chats use up the allowance.
    sqlMock.mockResolvedValueOnce([row({ available: "-40" })]);
    tx.mockResolvedValueOnce([{ admitted: false, available: "-40", held: "60" }]);
    await expect(assertCanSpend(null, "ws-1", { kind: "interactive" })).rejects.toMatchObject({ statusCode: 402, code: "credit_exhausted" });

    // A pre-check takes no hold.
    sqlMock.mockResolvedValueOnce([row({ available: "-40" })]);
    tx.mockResolvedValueOnce([{ admitted: true, available: "-40", held: "0" }]);
    await expect(assertCanSpend(null, "ws-1", { kind: "interactive", hold: false })).resolves.toBeUndefined();
    expect(tx.mock.calls[2]!.slice(1)).toEqual(["org-1", "ws-1", 100, 0, 120]);
  });

  it("has a non-throwing form for paths that degrade", async () => {
    sqlMock.mockResolvedValueOnce([row({ org_budget_paused: true })]);
    expect(await canSpend("org-1", "ws-1")).toBe(false);
    sqlMock.mockResolvedValueOnce([row()]);
    expect(await canSpend("org-1", "ws-1")).toBe(true);
  });

  it("maps a blocked spend to a JSON 402 through the error handler", async () => {
    const app = new Hono().get("/", () => {
      throw new SpendBlockedError("Out of credits", "credit_exhausted");
    });
    app.onError(spendAwareErrorHandler);
    const response = await app.request("/");
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: "This feature is temporarily unavailable. Please try again later.", code: "credit_exhausted" });
  });
});

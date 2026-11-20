import { describe, expect, it } from "vitest";

import { resolveChatCreditReserveConfig } from "../chat-reserve.js";
import { spendGuardsSkipped, spendRuleCode, type SpendRuleStatus } from "../spend-rule.js";

// Funded reserve 300, starter reserve 20, overdrafts the same, running-job floor -25.
const config = resolveChatCreditReserveConfig({});
const status = (over: Partial<SpendRuleStatus> = {}): SpendRuleStatus => ({
  orgId: "org", funded: true, hasCreditGrants: true, available: 1000, reserved: 0,
  projectInOrg: true, projectBudgetPaused: false, orgBudgetPaused: false, ...over,
});

describe("spend rule", () => {
  it.each(["job", "interactive", "running"] as const)("%s: entitlement, then project budget, then organization budget, before credits", kind => {
    expect(spendRuleCode(null, kind, config)).toBe("plan_not_entitled");
    expect(spendRuleCode(undefined, kind, config)).toBe("plan_not_entitled");
    const everything = { projectInOrg: false, projectBudgetPaused: true, orgBudgetPaused: true, available: -1000 };
    expect(spendRuleCode(status(everything), kind, config)).toBe("plan_not_entitled");
    expect(spendRuleCode(status({ ...everything, projectInOrg: true }), kind, config)).toBe("project_budget_paused");
    expect(spendRuleCode(status({ ...everything, projectInOrg: true, projectBudgetPaused: false }), kind, config)).toBe("org_budget_paused");
    expect(spendRuleCode(status({ available: -1000 }), kind, config)).toBe("credit_exhausted");
    expect(spendRuleCode(status(), kind, config)).toBeNull();
  });

  it("a job leaves the chat reserve and other runs' reservations untouched", () => {
    expect(spendRuleCode(status({ available: 300.01 }), "job", config)).toBeNull();
    expect(spendRuleCode(status({ available: 300 }), "job", config)).toBe("credit_exhausted");
    expect(spendRuleCode(status({ available: 310, reserved: 10 }), "job", config)).toBe("credit_exhausted");
    // Starter organizations keep a smaller reserve.
    expect(spendRuleCode(status({ funded: false, available: 20.01 }), "job", config)).toBeNull();
    expect(spendRuleCode(status({ funded: false, available: 20 }), "job", config)).toBe("credit_exhausted");
  });

  it("interactive spend may go below zero, only for organizations that received credits", () => {
    expect(spendRuleCode(status({ available: -299.99 }), "interactive", config)).toBeNull();
    expect(spendRuleCode(status({ available: -300 }), "interactive", config)).toBe("credit_exhausted");
    expect(spendRuleCode(status({ available: 5, reserved: 310 }), "interactive", config)).toBe("credit_exhausted");
    expect(spendRuleCode(status({ hasCreditGrants: false, available: 0.01 }), "interactive", config)).toBeNull();
    expect(spendRuleCode(status({ hasCreditGrants: false, available: 0 }), "interactive", config)).toBe("credit_exhausted");
  });

  it("running work may finish down to the running-job floor and ignores reservations", () => {
    expect(spendRuleCode(status({ available: -25 }), "running", config)).toBeNull();
    expect(spendRuleCode(status({ available: -25.01 }), "running", config)).toBe("credit_exhausted");
    expect(spendRuleCode(status({ available: 0, reserved: 500 }), "running", config)).toBeNull();
    // A row read without `funded` gets no overdraft.
    expect(spendRuleCode(status({ funded: undefined, available: -0.01 }), "running", config)).toBe("credit_exhausted");
    expect(spendRuleCode(status({ funded: null, available: -25 }), "running", config)).toBeNull();
  });

  it("a billing-exempt organization is never refused for credits, but budgets and entitlement still stop it", () => {
    const previous = process.env.BILLING_EXEMPT_ORG_IDS;
    process.env.BILLING_EXEMPT_ORG_IDS = "house";
    try {
      for (const kind of ["job", "interactive", "running"] as const) {
        expect(spendRuleCode(status({ orgId: "house", available: -1000 }), kind, config)).toBeNull();
        expect(spendRuleCode(status({ orgId: "house", orgBudgetPaused: true }), kind, config)).toBe("org_budget_paused");
        expect(spendRuleCode(status({ orgId: "house", projectInOrg: false }), kind, config)).toBe("plan_not_entitled");
        expect(spendRuleCode(status({ orgId: "org", available: -1000 }), kind, config)).toBe("credit_exhausted");
      }
    } finally {
      if (previous === undefined) delete process.env.BILLING_EXEMPT_ORG_IDS;
      else process.env.BILLING_EXEMPT_ORG_IDS = previous;
    }
  });
});

describe("the switch that skips the spend rule", () => {
  it("is on only in local development, and can be turned off there", () => {
    expect(spendGuardsSkipped({ NODE_ENV: "development" })).toBe(true);
    expect(spendGuardsSkipped({ NODE_ENV: "development", SKIP_RUN_BUDGET_GUARDS_IN_DEV: "false" })).toBe(false);
    expect(spendGuardsSkipped({ NODE_ENV: "production" })).toBe(false);
    expect(spendGuardsSkipped({ NODE_ENV: "production", SKIP_RUN_BUDGET_GUARDS_IN_DEV: "true" })).toBe(false);
    expect(spendGuardsSkipped({ NODE_ENV: "test" })).toBe(false);
    expect(spendGuardsSkipped({})).toBe(false);
  });
});

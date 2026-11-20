import type { Sql } from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setChatReserveConfig } from "../db/chat-reserve.js";
import { orgSpendBlock, runSpendHeadroom } from "../db/spend-check.js";

type Row = Record<string, unknown>;
/** A client that answers every query with `rows` and records the values it was given. */
function client(rows: Row[]) {
  const values: unknown[][] = [];
  const sql = ((_strings: TemplateStringsArray, ...args: unknown[]) => { values.push(args); return Promise.resolve(rows); }) as unknown as Sql<Record<string, unknown>>;
  return { sql, values };
}
const row = (over: Row = {}): Row => ({
  funded: true, available: 100, leased: 0, project_in_org: true, org_budget_paused: false, project_budget_paused: false, ...over,
});
const scope = { orgId: "org-a", projectId: "project-a", runId: "run-a" };
const headroom = async (rows: Row[]) => runSpendHeadroom(client(rows).sql, scope);

afterEach(() => { vi.unstubAllEnvs(); setChatReserveConfig(null); });

describe("a run's spend headroom", () => {
  it("is available credits minus other runs' leases minus the running-job floor (-25)", async () => {
    const spend = await headroom([row({ available: 100, leased: 40 })]);
    expect(spend).toMatchObject({ allowed: true, headroom: 85, exempt: false });
    expect(spend.covers(85)).toBe(true);
    expect(spend.covers(85.01)).toBe(false);
  });

  it("reads the status of the organization, project and run it was asked about", async () => {
    const { sql, values } = client([row()]);
    await runSpendHeadroom(sql, scope);
    expect(values).toEqual([["org-a", "run-a", "org-a", "project-a"]]);
  });

  it("covers nothing without a status row, outside the organization, or over a budget", async () => {
    for (const rows of [[], [row({ project_in_org: false })], [row({ org_budget_paused: true })], [row({ project_budget_paused: true })]]) {
      const spend = await headroom(rows);
      expect(spend.allowed).toBe(false);
      expect(spend.covers(0)).toBe(false);
    }
  });

  it("covers nothing when the balance, the leases or the amount is not a number", async () => {
    expect((await headroom([row({ available: "not a number" })])).covers(1)).toBe(false);
    expect((await headroom([row({ leased: undefined })])).covers(1)).toBe(false);
    expect((await headroom([row()])).covers(Number.NaN)).toBe(false);
  });

  it("never refuses a billing-exempt organization for credits, but budgets and entitlement still stop it", async () => {
    vi.stubEnv("BILLING_EXEMPT_ORG_IDS", "org-a");
    expect((await headroom([row({ available: -1000 })])).covers(500)).toBe(true);
    expect((await headroom([row({ org_budget_paused: true })])).covers(0)).toBe(false);
    expect((await headroom([row({ project_in_org: false })])).covers(0)).toBe(false);
    expect((await headroom([])).covers(0)).toBe(false);
  });
});

describe("the ungated spend block for running work", () => {
  it("refuses a missing row, a project outside the organization, a budget stop and a balance below the floor", async () => {
    const block = (rows: Row[]) => orgSpendBlock(client(rows).sql, { orgId: "org-a", projectId: "project-a" });
    expect(await block([])).toBe("plan_not_entitled");
    expect(await block([row({ project_in_org: false })])).toBe("plan_not_entitled");
    expect(await block([row({ project_budget_paused: true })])).toBe("project_budget_paused");
    expect(await block([row({ org_budget_paused: true })])).toBe("org_budget_paused");
    expect(await block([row({ available: -25.01 })])).toBe("credit_exhausted");
    expect(await block([row({ available: "garbage" })])).toBe("credit_exhausted");
    expect(await block([row({ available: -25 })])).toBeNull();
  });
});

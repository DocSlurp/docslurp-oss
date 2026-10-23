import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ reserve: vi.fn(), customer: vi.fn(), create: vi.fn(), retrieve: vi.fn(), mirror: vi.fn(), audit: vi.fn() }));
vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(), { reserve: m.reserve }) }));
vi.mock("../services/billing/customers.js", () => ({ ensureStripeCustomer: m.customer }));
vi.mock("../services/billing/webhooks.js", () => ({ mirrorStripeCreditGrant: m.mirror }));
vi.mock("../services/audit-log.js", () => ({ appendAuditLog: m.audit }));
vi.mock("../services/billing/stripe-client.js", async () => ({ ...await vi.importActual("../services/billing/stripe-client.js"), getStripe: () => ({ billing: { creditGrants: { create: m.create, retrieve: m.retrieve } } }) }));
const { issueAdminCredit } = await import("../services/billing/admin-credits.js");
const input = { requestId: "2a5f1819-67d3-4966-b926-5e319c39a0da", orgId: "org", amountCents: 10000, reason: "Acceptance test" };
let receipt: Record<string, unknown> | undefined;
let orgExists = true;
const release = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); receipt = undefined; orgExists = true;
  m.reserve.mockResolvedValue(Object.assign(vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join("?");
    if (statement.includes("select * from admin_credit_requests")) return receipt ? [receipt] : [];
    if (statement.includes("select id from organizations")) return orgExists ? [{ id: "org" }] : [];
    if (statement.includes("insert into admin_credit_requests")) {
      receipt = { request_id: values[0], org_id: values[1], actor_user_id: values[2], amount_cents: values[3], reason: values[4], stripe_customer_id: values[5], stripe_grant_id: null, completed_at: null, created_at: new Date() }; return [receipt];
    }
    if (statement.includes("set stripe_grant_id")) receipt!.stripe_grant_id = values[0];
    if (statement.includes("set completed_at")) receipt!.completed_at = new Date();
    return [];
  }), { release }));
  m.customer.mockResolvedValue("cus_test"); m.create.mockResolvedValue({ id: "credgr_test" });
  m.retrieve.mockResolvedValue({ id: "credgr_test" }); m.mirror.mockResolvedValue(undefined); m.audit.mockResolvedValue(undefined);
});
describe("durable administrative credit issuance", () => {
  it("creates a free promotional grant, mirrors and audits; completed replay creates nothing", async () => {
    expect((await issueAdminCredit(input, "admin")).stripeGrantId).toBe("credgr_test");
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ category: "promotional", amount: { type: "monetary", monetary: { currency: "usd", value: 10000 } } }), { idempotencyKey: `admin-credit:${input.requestId}` });
    await issueAdminCredit(input, "admin");
    expect(m.create).toHaveBeenCalledTimes(1); expect(m.mirror).toHaveBeenCalledTimes(1); expect(m.audit).toHaveBeenCalledTimes(2);
  });
  it("rejects changed payload and actor", async () => {
    await issueAdminCredit(input, "admin");
    for (const changed of [{ amountCents: 5000 }, { orgId: "other" }, { reason: "Changed" }]) await expect(issueAdminCredit({ ...input, ...changed }, "admin")).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(issueAdminCredit(input, "other-admin")).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(m.create).toHaveBeenCalledTimes(1);
  });
  it("uses the same provider key after timeout", async () => {
    m.create.mockRejectedValueOnce(new Error("timeout"));
    await expect(issueAdminCredit(input, "admin")).rejects.toThrow("timeout");
    await issueAdminCredit(input, "admin");
    expect(m.create.mock.calls.map(call => call[1])).toEqual([{ idempotencyKey: `admin-credit:${input.requestId}` }, { idempotencyKey: `admin-credit:${input.requestId}` }]);
  });
  it("retrieves saved grant after local failure without creating another", async () => {
    m.mirror.mockRejectedValueOnce(new Error("database down"));
    await expect(issueAdminCredit(input, "admin")).rejects.toThrow("database down");
    await issueAdminCredit(input, "admin");
    expect(m.create).toHaveBeenCalledTimes(1); expect(m.retrieve).toHaveBeenCalledWith("credgr_test");
  });
  it("blocks old uncertain requests", async () => {
    m.create.mockRejectedValueOnce(new Error("timeout"));
    await expect(issueAdminCredit(input, "admin")).rejects.toThrow();
    receipt!.created_at = new Date(Date.now() - 21 * 3600000);
    await expect(issueAdminCredit(input, "admin")).rejects.toMatchObject({ code: "credit_reconciliation_required" });
    expect(m.create).toHaveBeenCalledTimes(1);
  });
  it("rejects unknown organization before Stripe mutation", async () => {
    orgExists = false;
    await expect(issueAdminCredit(input, "admin")).rejects.toMatchObject({ code: "organization_not_found" });
    expect(m.customer).not.toHaveBeenCalled(); expect(m.create).not.toHaveBeenCalled(); expect(release).toHaveBeenCalled();
  });
});

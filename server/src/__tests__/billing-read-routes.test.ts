import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { withTestSession } from "./helpers/session-app.js";

const listOrganizations = vi.fn();
const getAvailableCredits = vi.fn(async () => ({ includedRemaining: 0, prepaid: 1_250, available: 1_250 }));
const getBillingOverview = vi.fn(async () => ({ creditBalanceCents: 1_250 }));
const listCreditLedger = vi.fn(async () => []);

vi.mock("../services/organizations.js", () => ({ listOrganizations }));
vi.mock("../services/billing/retained-storage.js", () => ({ getRetainedVersionStorage: vi.fn(async () => null) }));
vi.mock("../services/audit-log.js", () => ({ appendAuditLog: vi.fn() }));
vi.mock("../services/billing.js", () => ({
  BillingNotConfiguredError: class extends Error {},
  BillingRequestError: class extends Error {},
  attachPaymentMethod: vi.fn(),
  createPortalSession: vi.fn(),
  createSetupIntent: vi.fn(),
  createTopUpCheckout: vi.fn(),
  detachPaymentMethod: vi.fn(),
  getAutoRechargeSettings: vi.fn(),
  getAvailableCredits,
  getBillingOverview,
  getIngestJobCosts: vi.fn(),
  getRunCostBreakdown: vi.fn(),
  getUsageBreakdown: vi.fn(),
  listCreditLedger,
  listInvoices: vi.fn(),
  listPaymentMethods: vi.fn(),
  updateAutoRechargeSettings: vi.fn(),
}));

const { billingRoutes } = await import("../routes/billing.js");

function buildApp() {
  return withTestSession(new Hono(), { id: "user-1" }).route("/v1/billing", billingRoutes);
}

describe("billing reads for an org the caller does not belong to", () => {
  beforeEach(() => {
    listOrganizations.mockReset();
    listOrganizations.mockResolvedValue([{ id: "org-own", isPersonal: true }]);
    getAvailableCredits.mockClear();
  });

  it.each(["/balance", "/overview", "/ledger"])("returns 404 from %s, without reading the foreign balance", async (path) => {
    const response = await buildApp().request(`/v1/billing${path}?orgId=org-foreign`);

    expect(response.status).toBe(404);
    expect(getAvailableCredits).not.toHaveBeenCalled();
  });

  it("returns the balance for the caller's own org", async () => {
    const response = await buildApp().request("/v1/billing/balance?orgId=org-own");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ creditBalanceCents: 1_250, orgId: "org-own" });
  });
});

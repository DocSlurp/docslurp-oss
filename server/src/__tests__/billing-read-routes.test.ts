import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { withTestSession } from "./helpers/session-app.js";

const listOrganizations = vi.fn();
const getAvailableCredits = vi.fn(async () => ({ includedRemaining: 0, prepaid: 1_250, available: 1_250 }));
const getBillingOverview = vi.fn(async () => ({ creditBalanceCents: 1_250 }));
const listCreditLedger = vi.fn(async () => []);
const getIngestJobCosts = vi.fn(async () => ({ total: 2, costs: [
  { runId: "r1", documentId: "d1", inputTokens: 10, outputTokens: 5, totalTokens: 15, costCents: 0.42, model: "openai/gpt-6-luna", provider: "openrouter", stage: "vision-extract", createdAt: "t" },
  { runId: "r1", documentId: "d1", inputTokens: 3, outputTokens: 1, totalTokens: 4, costCents: 0.01, model: "qwen/qwen3.5-flash-02-23", provider: "openrouter", stage: "document-summary", createdAt: "t" },
] }));
const getRunCostBreakdown = vi.fn(async () => ({
  totalTokens: 19, totalCostCents: 0.43,
  byStage: [{ stage: "vision-extract", tokens: 15, costCents: 0.42 }],
  byModel: [{ model: "openai/gpt-6-luna", tokens: 15, costCents: 0.42 }, { model: "qwen/qwen3.5-flash-02-23", tokens: 4, costCents: 0.01 }],
}));
const runChargedCredits = vi.fn(async () => 12);

vi.mock("../services/organizations.js", () => ({ listOrganizations }));
vi.mock("../services/usage-attribution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/usage-attribution.js")>()),
  runChargedCredits,
}));
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
  getIngestJobCosts,
  getRunCostBreakdown,
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

describe("estimate card", () => {
  it("is gone: prices are quoted by the server, never shipped to clients", async () => {
    const response = await buildApp().request("/v1/billing/estimate-card");
    expect(response.status).toBe(404);
    expect(listOrganizations).not.toHaveBeenCalled();
  });
});

describe("customer usage views carry no backend models or provider cost", () => {
  const BACKEND = /openai\/|qwen\/|openrouter|luna|costCents|totalCostCents/;
  beforeEach(() => {
    listOrganizations.mockReset();
    listOrganizations.mockResolvedValue([{ id: "org-own", isPersonal: true }]);
  });

  it("maps usage rows to a neutral category, without model, provider or provider cost", async () => {
    const response = await buildApp().request("/v1/billing/usage/jobs?orgId=org-own&runId=r1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.costs.map((row: { category: string; stage: string }) => [row.stage, row.category])).toEqual([["vision-extract", "processing"], ["document-summary", "processing"]]);
    expect(JSON.stringify(body)).not.toMatch(BACKEND);
  });

  it("shows the run's charged credits and tokens by stage and category in the cost breakdown", async () => {
    const response = await buildApp().request("/v1/billing/usage/run/r1/cost-breakdown?orgId=org-own");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      totalTokens: 19, credits: 12,
      byStage: [{ stage: "vision-extract", tokens: 15 }],
      byCategory: [{ category: "processing", tokens: 19 }],
    });
    expect(JSON.stringify(body)).not.toMatch(BACKEND);
  });
});

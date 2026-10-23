import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ issue: vi.fn(), query: vi.fn() }));
vi.mock("../services/billing/admin-credits.js", () => ({ issueAdminCredit: mocks.issue }));
vi.mock("../db.js", () => ({ sql: mocks.query }));
vi.mock("../lib/request-actor.js", () => ({ getRequestActor: (c: { get: (key: string) => unknown }) => c.get("requestActor") }));
const { adminBillingRoutes } = await import("../routes/admin-billing.js");
const { BillingRequestError } = await import("../services/billing/stripe-client.js");
const body = { requestId: "2a5f1819-67d3-4966-b926-5e319c39a0da", orgId: "other-org", amountCents: 10000, reason: "Acceptance testing" };
function as(actor: unknown) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("requestActor", actor as never); await next(); });
  app.route("/admin", adminBillingRoutes);
  return app;
}
const admin = { type: "session", userId: "platform-admin", user: { isAdmin: true } };
const post = (value: unknown = body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
beforeEach(() => { vi.clearAllMocks(); });
describe("platform administrator credit boundary", () => {
  it.each([
    { type: "session", userId: "org-owner", user: { isAdmin: false } },
    { type: "session", userId: "org-admin", user: {} },
    { type: "apiKey", userId: "platform-admin", user: { isAdmin: true } },
  ])("rejects non-platform session and API key actors", async actor => {
    expect((await as(actor).request("/admin/credits", post())).status).toBe(403);
    expect((await as(actor).request("/admin/organizations")).status).toBe(403);
    expect(mocks.issue).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("allows platform admin to explicitly credit another organization", async () => {
    mocks.issue.mockResolvedValue({ completed: true, stripeGrantId: "credgr_test" });
    const response = await as(admin).request("/admin/credits", post());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.issue).toHaveBeenCalledWith(body, "platform-admin");
  });
  it.each([0, -1, 10001, 1.5])("rejects invalid amount %s", async amountCents => {
    expect((await as(admin).request("/admin/credits", post({ ...body, amountCents }))).status).toBe(400);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("reports changed replay payload as conflict", async () => {
    mocks.issue.mockRejectedValue(new BillingRequestError("Request changed", "idempotency_conflict"));
    expect((await as(admin).request("/admin/credits", post())).status).toBe(409);
  });
  it("returns retryable error on Stripe outage", async () => {
    mocks.issue.mockRejectedValue(new Error("provider timeout"));
    expect((await as(admin).request("/admin/credits", post())).status).toBe(502);
  });
  it("rejects malformed JSON", async () => {
    expect((await as(admin).request("/admin/credits", { method: "POST", body: "{" })).status).toBe(400);
  });
});

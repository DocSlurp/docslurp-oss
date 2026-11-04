import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTestSession } from "./helpers/session-app.js";

vi.mock("../services/organizations.js", () => ({ ensurePersonalOrganization: vi.fn(async () => ({ id: "personal-org" })) }));

vi.mock("../services/webhooks.js", () => ({
  WebhookScopeError: class WebhookScopeError extends Error {},
  WebhookForbiddenError: class WebhookForbiddenError extends Error {},
  createWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  listWebhookDeliveries: vi.fn(),
  listWebhooks: vi.fn(),
  replayWebhookDelivery: vi.fn(),
  rotateWebhookSecret: vi.fn(),
  sendTestWebhook: vi.fn(),
  updateWebhook: vi.fn()
}));

vi.mock("../services/audit-log.js", () => ({
  appendAuditLog: vi.fn()
}));

vi.mock("../lib/request-context.js", () => ({
  requestIp: vi.fn(() => "127.0.0.1"),
  requestUserAgent: vi.fn(() => "vitest")
}));

const { webhooksRoutes } = await import("../routes/webhooks.js");
const {
  createWebhook,
  listWebhookDeliveries,
  replayWebhookDelivery,
  sendTestWebhook,
  WebhookForbiddenError,
  WebhookScopeError
} = await import("../services/webhooks.js");

function buildApp() {
  const app = withTestSession(new Hono(), {
    id: "demo-user"
  });
  app.route("/webhooks", webhooksRoutes);
  return app;
}

describe("webhooksRoutes", () => {
  let app: Hono;

  beforeEach(() => {
    app = buildApp();
    vi.mocked(listWebhookDeliveries).mockReset();
    vi.mocked(replayWebhookDelivery).mockReset();
    vi.mocked(sendTestWebhook).mockReset();
  });

  it("lists delivery history", async () => {
    vi.mocked(listWebhookDeliveries).mockResolvedValue([
      {
        id: "delivery-1",
        webhookId: "webhook-1",
        userId: "demo-user",
        eventType: "run.completed",
        targetUrl: "https://example.com/hook",
        payload: { event: "run.completed" },
        responseStatus: 200,
        responseBody: "ok",
        delivered: true,
        error: null,
        replayOfDeliveryId: null,
        createdAt: "2026-03-07T12:00:00.000Z"
      }
    ]);

    const response = await app.request("/webhooks/deliveries?limit=25");
    expect(response.status).toBe(200);
    expect(listWebhookDeliveries).toHaveBeenCalledWith({
      userId: "demo-user",
      webhookId: undefined,
      limit: 25
    });
  });

  it("returns the recorded test delivery", async () => {
    vi.mocked(sendTestWebhook).mockResolvedValue({
      id: "delivery-1",
      webhookId: "webhook-1",
      userId: "demo-user",
      eventType: "run.completed",
      targetUrl: "https://example.com/hook",
      payload: { event: "run.completed", test: true },
      responseStatus: 202,
      responseBody: "accepted",
      delivered: true,
      error: null,
      replayOfDeliveryId: null,
      createdAt: "2026-03-07T12:00:00.000Z"
    });

    const response = await app.request("/webhooks/webhook-1/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "run.completed" })
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.delivery.eventType).toBe("run.completed");
  });

  it("returns 404 when replaying an unknown delivery", async () => {
    vi.mocked(replayWebhookDelivery).mockResolvedValue(null);

    const response = await app.request("/webhooks/deliveries/missing/replay", {
      method: "POST"
    });

    expect(response.status).toBe(404);
  });

  describe("creating a webhook", () => {
    const create = (body: Record<string, unknown>) => app.request("/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook", secret: "s".repeat(16), ...body })
    });

    it("files it under the named organization (or the personal one) for the signed-in user", async () => {
      vi.mocked(createWebhook).mockReset().mockResolvedValue({ id: "wh", secret: "x" } as never);
      expect((await create({ orgId: "team", workspaceId: "ws-1" })).status).toBe(201);
      expect(createWebhook).toHaveBeenLastCalledWith(expect.objectContaining({ userId: "demo-user", orgId: "team", workspaceId: "ws-1" }));
      await create({});
      expect(createWebhook).toHaveBeenLastCalledWith(expect.objectContaining({ userId: "demo-user", orgId: "personal-org" }));
    });

    it("answers 403 when a member asks for an organization-wide webhook, and 404 for an organization or workspace it cannot see", async () => {
      vi.mocked(createWebhook).mockReset().mockRejectedValueOnce(new WebhookForbiddenError("Organization admin access required"));
      expect((await create({ orgId: "team" })).status).toBe(403);
      vi.mocked(createWebhook).mockRejectedValueOnce(new WebhookScopeError("Organization not found"));
      expect((await create({ orgId: "foreign" })).status).toBe(404);
    });
  });
});

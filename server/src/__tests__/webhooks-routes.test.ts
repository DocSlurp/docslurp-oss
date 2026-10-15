import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTestSession } from "./helpers/session-app.js";

vi.mock("../services/webhooks.js", () => ({
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
  listWebhookDeliveries,
  replayWebhookDelivery,
  sendTestWebhook
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
});

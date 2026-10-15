import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/notifications.js", () => ({
  getNotificationPreferences: vi.fn(),
  listNotificationInbox: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn(),
  updateNotificationPreferences: vi.fn()
}));

vi.mock("../services/workspaces.js", () => ({
  resolveWorkspaceRef: vi.fn(async () => null),
  getWorkspace: vi.fn(async (id: string) => ({ id, orgId: "org-1", userId: "user-1" })),
}));

const { listNotificationInbox, markAllNotificationsRead, markNotificationRead } = await import("../services/notifications.js");
const { notificationsRoutes } = await import("../routes/notifications.js");
const { Hono } = await import("hono");

describe("notificationsRoutes", () => {
  const app = new Hono();

  app.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-1", email: "user-1@example.com", name: "User One" });
    await next();
  });
  app.route("/", notificationsRoutes);

  beforeEach(() => {
    vi.mocked(listNotificationInbox).mockReset();
    vi.mocked(markNotificationRead).mockReset();
    vi.mocked(markAllNotificationsRead).mockReset();
  });

  it("passes inbox filters through to the notifications service", async () => {
    vi.mocked(listNotificationInbox).mockResolvedValue({ deliveries: [], unreadCount: 0 });

    const response = await app.request(
      "/inbox?workspaceId=ws-1&event=plausibility.warning&limit=10"
    );

    expect(response.status).toBe(200);
    expect(listNotificationInbox).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "ws-1",
      event: "plausibility.warning",
      limit: 10
    });
  });

  it("marks a single notification as read", async () => {
    vi.mocked(markNotificationRead).mockResolvedValue({
      id: "delivery-1",
      userId: "user-1",
      orgId: null,
      workspaceId: null,
      eventType: "run.completed",
      provider: "console",
      recipient: "user@example.com",
      subject: "Run completed",
      delivered: true,
      metadata: {},
      readAt: "2026-03-12T00:00:00.000Z",
      isRead: true,
      createdAt: "2026-03-12T00:00:00.000Z"
    });

    const response = await app.request("/inbox/delivery-1/read", { method: "POST" });

    expect(response.status).toBe(200);
    expect(markNotificationRead).toHaveBeenCalledWith({
      id: "delivery-1",
      userId: "user-1"
    });
  });

  it("marks all notifications as read", async () => {
    vi.mocked(markAllNotificationsRead).mockResolvedValue(4);

    const response = await app.request("/inbox/read-all", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ workspaceId: "ws-1" })
    });

    expect(response.status).toBe(200);
    expect(markAllNotificationsRead).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: "ws-1"
    });
  });
});

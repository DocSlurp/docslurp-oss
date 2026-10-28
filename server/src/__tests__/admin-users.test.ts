import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), usage: vi.fn() }));
vi.mock("../db.js", () => ({ sql: mocks.query }));
vi.mock("../services/usage-attribution.js", () => ({ userUsageTotals: mocks.usage }));
vi.mock("../lib/request-actor.js", () => ({ getRequestActor: (c: { get: (key: string) => unknown }) => c.get("requestActor") }));
const { adminUsersRoutes } = await import("../routes/admin-users.js");

function as(actor: unknown) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("requestActor", actor as never); await next(); });
  app.route("/admin/users", adminUsersRoutes);
  return app;
}
const admin = { type: "session", userId: "platform-admin", user: { isAdmin: true } };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([]);
  mocks.usage.mockResolvedValue(new Map());
});

describe("platform administrator user directory boundary", () => {
  it.each([
    ["an org owner session", { type: "session", userId: "org-owner", user: { isAdmin: false } }],
    ["a session without the admin flag", { type: "session", userId: "member", user: {} }],
    ["an admin's server API key", { type: "apiKey", userId: "platform-admin", user: { isAdmin: true }, apiKey: { keyType: "server" } }],
    ["an admin's CLI OAuth token", { type: "apiKey", userId: "platform-admin", apiKey: { keyType: "server", oauth: { audience: "api" } } }],
    ["an admin's MCP OAuth token", { type: "apiKey", userId: "platform-admin", apiKey: { keyType: "server", oauth: { audience: "mcp" } } }],
  ])("refuses %s without touching the database", async (_label, actor) => {
    for (const path of ["/admin/users", "/admin/users/summary", "/admin/users?q=%25"]) {
      const response = await as(actor).request(path);
      expect(response.status).toBe(403);
    }
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.usage).not.toHaveBeenCalled();
  });

  it("lists users for a platform admin without caching", async () => {
    mocks.query.mockImplementation((strings: TemplateStringsArray) =>
      Promise.resolve(strings.join("").includes("with matched") ? [{ id: "u1", email: "a@example.test", total: 1 }] : []));
    mocks.usage.mockResolvedValueOnce(new Map([["u1", { costCents: 12.5, tokens: 900, eventCount: 3 }]]));
    const response = await as(admin).request("/admin/users?filter=verified&sort=last_active&limit=10");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({ total: 1, limit: 10, offset: 0, users: [{ id: "u1", spend_cents: 12.5, ai_tokens: 900 }] });
    expect(body.users[0]).not.toHaveProperty("total");
    expect(mocks.usage).toHaveBeenCalledWith(["u1"], null);
  });

  it.each([
    "limit=500", "limit=0", "offset=-1", "filter=admins", "sort=password", "surface=ftp", "q=" + "x".repeat(201), "unexpected=1",
  ])("rejects invalid query %s", async (query) => {
    expect((await as(admin).request(`/admin/users?${query}`)).status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("passes search text only as bound parameters with LIKE wildcards escaped", async () => {
    await as(admin).request(`/admin/users?q=${encodeURIComponent("a%_\\'; drop table user;--")}`);
    const calls = mocks.query.mock.calls as [TemplateStringsArray, ...unknown[]][];
    expect(calls.map(([strings]) => strings.join("?")).join("\n")).not.toContain("drop table");
    expect(calls.flatMap(([, ...values]) => values)).toContain("%a\\%\\_\\\\'; drop table user;--%");
  });

  it("returns summary with a clamped window", async () => {
    const response = await as(admin).request("/admin/users/summary?days=9999");
    expect(response.status).toBe(200);
    expect((await response.json()).days).toBe(30);
  });
});

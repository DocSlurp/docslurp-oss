import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiKey: vi.fn(), session: vi.fn() }));
vi.mock("../lib/request-actor.js", () => ({
  resolveApiKeyActor: mocks.apiKey,
  resolveBetterAuthSessionActor: mocks.session,
  setRequestActor: (c: any, actor: any) => c.set("requestActor", actor),
}));
const { env } = await import("../config.js");
const { sessionAuth } = await import("../middleware/session-auth.js");
const { acceptApiKeys, authenticatedByRoute } = await import("../lib/route-auth.js");

/**
 * sessionAuth reads the auth mode declared on the route that answers the
 * request (lib/route-auth.ts). The full route table is checked against the
 * OpenAPI document in route-auth-integration.test.ts.
 */
function app() {
  const ok = () => (c: any) => c.json({ ok: true });
  const workspaces = new Hono()
    .get("/board", ok())
    .get("/", ok())
    .post("/", ok())
    .get("/:workspaceId", ok())
    .patch("/:workspaceId", ok())
    .get("/:workspaceId/members", ok());
  acceptApiKeys(workspaces, ["GET /", "GET /:workspaceId", "PATCH /:workspaceId"]);
  // A router with its own onError: app.route() wraps its handlers.
  const organizations = new Hono()
    .onError((_error, c) => c.json({ error: "boom" }, 500))
    .get("/:orgId", ok())
    .post("/:orgId/members", ok())
    .post("/", ok());
  acceptApiKeys(organizations, ["GET /:orgId", "POST /:orgId/members"]);
  const publicRoutes = new Hono().get("/saml/:org/init", ok());
  authenticatedByRoute(publicRoutes);

  const server = new Hono();
  server.use("/v1/*", sessionAuth);
  server.route("/v1/workspaces", workspaces);
  server.route("/v1/organizations", organizations);
  server.route("/v1/auth", publicRoutes);
  server.all("/v1/mcp", ok());
  return server;
}
const headers = { authorization: "Bearer native-fixture" };

describe("native resource bearer authentication boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiKey.mockResolvedValue({ type: "apiKey" });
    mocks.session.mockResolvedValue(null);
  });

  it.each([["GET", "/v1/workspaces"], ["GET", "/v1/workspaces/one"], ["PATCH", "/v1/workspaces/amber-falcon-ridge"], ["GET", "/v1/organizations/one"], ["POST", "/v1/organizations/one/members"]])("accepts bearer credentials for declared %s %s", async (method, path) => {
    expect((await app().request(path, { method, headers })).status).toBe(200);
    expect(mocks.apiKey).toHaveBeenCalledOnce();
  });

  it.each([["GET", "/v1/workspaces/board"], ["POST", "/v1/workspaces"], ["GET", "/v1/workspaces/one/members"], ["POST", "/v1/organizations"], ["GET", "/v1/unknown"]])("keeps undeclared %s %s session-only", async (method, path) => {
    expect((await app().request(path, { method, headers })).status).toBe(401);
    expect(mocks.apiKey).not.toHaveBeenCalled();
  });

  it("does not let a more specific session-only route inherit a declared parameter route", async () => {
    mocks.session.mockResolvedValue({ type: "session" });
    expect((await app().request("/v1/workspaces/board", { headers })).status).toBe(200);
    expect(mocks.apiKey).not.toHaveBeenCalled();
  });

  it("rejects invalid bearer tokens without falling back to a cookie session", async () => {
    mocks.apiKey.mockResolvedValue(null);
    mocks.session.mockResolvedValue({ type: "session" });
    const response = await app().request("/v1/organizations/one", { headers });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Unauthorized" } });
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("passes self-authenticating routes through without resolving anyone", async () => {
    expect((await app().request("/v1/auth/saml/acme/init")).status).toBe(200);
    expect(mocks.apiKey).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("rejects a cross-site cookie mutation and accepts a same-origin one (SEC-2026-10-02)", async () => {
    mocks.apiKey.mockResolvedValue(null);
    mocks.session.mockResolvedValue({ type: "session" });
    const cross = await app().request("/v1/organizations/one/members", {
      method: "POST",
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" }
    });
    expect(cross.status).toBe(403);
    const same = await app().request("/v1/organizations/one/members", {
      method: "POST",
      headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" }
    });
    expect(same.status).toBe(200);
  });

  it.each(["same-site", "same-origin", "none"])("rejects untrusted Origin despite %s fetch metadata", async (site) => {
    mocks.session.mockResolvedValue({ type: "session" });
    expect((await app().request("/v1/organizations/one/members", {
      method: "POST", headers: { origin: "http://sibling.localhost", "sec-fetch-site": site }
    })).status).toBe(403);
  });

  it("accepts nonbrowser mutations and refuses an originless same-site browser mutation", async () => {
    mocks.session.mockResolvedValue({ type: "session" });
    expect((await app().request("/v1/organizations/one/members", { method: "POST" })).status).toBe(200);
    expect((await app().request("/v1/organizations/one/members", {
      method: "POST", headers: { "sec-fetch-site": "same-site" }
    })).status).toBe(403);
  });

  it("accepts an explicitly trusted cross-site UI Origin", async () => {
    mocks.session.mockResolvedValue({ type: "session" });
    env.corsAllowedOrigins.push("https://trusted-ui.example");
    try {
      expect((await app().request("/v1/organizations/one/members", {
        method: "POST", headers: { origin: "https://trusted-ui.example", "sec-fetch-site": "cross-site" }
      })).status).toBe(200);
    } finally {
      env.corsAllowedOrigins.splice(env.corsAllowedOrigins.indexOf("https://trusted-ui.example"), 1);
    }
  });

  it("does not apply the CSRF check to bearer credentials (not CSRFable)", async () => {
    const res = await app().request("/v1/organizations/one/members", {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example", "sec-fetch-site": "cross-site" }
    });
    expect(res.status).toBe(200);
  });

  it("delegates hosted MCP to resource authentication without cookie fallback", async () => {
    expect((await app().request("/v1/mcp", { headers: { Cookie: "session=fixture" } })).status).toBe(200);
    expect(mocks.apiKey).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("forwards a refreshed session cookie so active browsers stay signed in", async () => {
    mocks.session.mockImplementation(async (_headers: Headers, responseHeaders?: Headers) => {
      responseHeaders?.append("set-cookie", "better-auth.session_token=renewed; Max-Age=2592000; Path=/; HttpOnly");
      return { type: "session" };
    });
    const response = await app().request("/v1/workspaces/board");
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual(["better-auth.session_token=renewed; Max-Age=2592000; Path=/; HttpOnly"]);
  });

  it("lets a route's own session cookie win over the refresh", async () => {
    mocks.session.mockImplementation(async (_headers: Headers, responseHeaders?: Headers) => {
      responseHeaders?.append("set-cookie", "better-auth.session_token=renewed; Path=/");
      return { type: "session" };
    });
    const server = new Hono();
    server.use("/v1/*", sessionAuth);
    server.post("/v1/sign-out-everywhere", (c) => {
      c.header("set-cookie", "better-auth.session_token=; Max-Age=0; Path=/");
      return c.json({ ok: true });
    });
    const response = await server.request("/v1/sign-out-everywhere", { method: "POST" });
    expect(response.headers.getSetCookie()).toEqual(["better-auth.session_token=; Max-Age=0; Path=/"]);
  });

  it("refuses a declaration that names no route", () => {
    expect(() => acceptApiKeys(new Hono().get("/", (c) => c.text("ok")), ["GET /missing"])).toThrow(/does not match a route/);
  });
});

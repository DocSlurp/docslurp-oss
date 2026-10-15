import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  getInvitePreview: vi.fn(),
  notifySignup: vi.fn(),
  insert: vi.fn(),
  resolveSession: vi.fn(),
  consentQuery: vi.fn(),
  ensure: vi.fn(),
  listOrganizations: vi.fn(),
  admit: vi.fn(),
  sso: vi.fn(),
  devSeed: vi.fn(),
}));

vi.mock("../services/workspaces.js", () => ({ listWorkspaces: mocks.listWorkspaces }));
vi.mock("../services/organizations.js", () => ({ getInvitePreview: mocks.getInvitePreview }));
vi.mock("../lib/signup-notifications.js", () => ({ notifySignup: mocks.notifySignup }));
vi.mock("../db.js", () => ({ sql: (...args: unknown[]) => mocks.insert(...args) }));
vi.mock("../lib/auth.js", () => ({ appDbPool: { query: mocks.consentQuery } }));
vi.mock("../services/frontend-shell.js", () => ({ ensureUserAndOrganization: mocks.ensure, listOrganizations: mocks.listOrganizations }));
vi.mock("../lib/admin-emails.js", () => ({ admitConfiguredAdminUser: mocks.admit }));
vi.mock("../lib/sso-lookup.js", () => ({ hasConfiguredSsoProvider: mocks.sso }));
vi.mock("../lib/better-auth.js", () => ({
  configuredEmailAuth: true,
  configuredSocialProviders: { github: true, google: false },
  getDevSeedAccountDescriptors: mocks.devSeed,
}));
vi.mock("../lib/request-actor.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/request-actor.js")>("../lib/request-actor.js");
  return { ...actual, resolveBetterAuthSessionActor: mocks.resolveSession };
});

const { inviteRoutes, metaRoutes, shellRoutes, waitlistRoutes } = await import("../routes/frontend.js");
const { mcpOAuthRoutes } = await import("../routes/mcp-oauth.js");

type TestActor = { type: "session"; userId: string; sessionId: string; user: { id: string; isAdmin?: boolean } } | { type: "apiKey"; userId: string };

function appAs(actor: TestActor) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("requestActor", actor as never); await next(); });
  app.route("/v1/shell", shellRoutes).route("/v1/invites", inviteRoutes).route("/meta", metaRoutes).route("/v1/waitlist", waitlistRoutes);
  return app;
}
const session = (userId: string, isAdmin = false): TestActor => ({ type: "session", userId, sessionId: `s-${userId}`, user: { id: userId, isAdmin } });

beforeEach(() => { vi.resetAllMocks(); });

describe("GET /v1/shell", () => {
  it("bootstraps, admits, then returns the caller's organizations and workspaces only", async () => {
    const order: string[] = [];
    mocks.ensure.mockImplementation(async () => { order.push("ensure"); });
    mocks.admit.mockImplementation(async () => { order.push("admit"); return true; });
    mocks.listOrganizations.mockImplementation(async () => { order.push("orgs"); return [{ id: "o1" }]; });
    mocks.listWorkspaces.mockImplementation(async () => { order.push("workspaces"); return [{ id: "w1", orgId: "o1" }]; });
    const res = await appAs(session("u1")).request("/v1/shell");
    expect(await res.json()).toEqual({ isAdmin: true, organizations: [{ id: "o1" }], workspaces: [{ id: "w1", orgId: "o1" }] });
    expect(order.slice(0, 2)).toEqual(["ensure", "admit"]);
    expect(mocks.listWorkspaces).toHaveBeenCalledExactlyOnceWith("u1");
    expect(mocks.listOrganizations).toHaveBeenCalledExactlyOnceWith("u1");
  });
  it("is session-only: an API key is refused and nothing is listed", async () => {
    const res = await appAs({ type: "apiKey", userId: "u1" }).request("/v1/shell");
    expect(res.status).toBe(403);
    expect(mocks.listWorkspaces).not.toHaveBeenCalled();
  });
});

describe("GET /v1/invites/:token", () => {
  it("previews by token and kind", async () => {
    mocks.getInvitePreview.mockResolvedValue({ kind: "organization", status: "pending", email: "a@b.c" });
    const res = await appAs(session("u1")).request("/v1/invites/tok?kind=organization");
    expect(res.status).toBe(200);
    expect(mocks.getInvitePreview).toHaveBeenCalledWith("tok", "organization");
  });
  it("defaults to a workspace invite and returns 404 for an unknown token", async () => {
    mocks.getInvitePreview.mockResolvedValue(null);
    const res = await appAs(session("u1")).request("/v1/invites/nope");
    expect(res.status).toBe(404);
    expect(mocks.getInvitePreview).toHaveBeenCalledWith("nope", "workspace");
  });
  it("refuses API keys", async () => {
    expect((await appAs({ type: "apiKey", userId: "u1" }).request("/v1/invites/tok")).status).toBe(403);
    expect(mocks.getInvitePreview).not.toHaveBeenCalled();
  });
});

describe("GET /meta/mcp-origin", () => {
  it("reports the configured origin, never the request Host", async () => {
    vi.stubEnv("MCP_PUBLIC_URL", "https://mcp.example.com/ignored/path");
    const res = await appAs(session("u1")).request("http://evil.example/meta/mcp-origin");
    expect(await res.json()).toEqual({ origin: "https://mcp.example.com" });
    vi.unstubAllEnvs();
  });
});

describe("GET /meta/auth-config", () => {
  it("reports provider availability and only the dev accounts the server allows", async () => {
    mocks.sso.mockResolvedValue(true);
    mocks.devSeed.mockReturnValue([]);
    const res = await appAs(session("u1")).request("/meta/auth-config");
    expect(await res.json()).toEqual({ emailAuth: true, socialProviders: { github: true, google: false }, ssoConfigured: true, devSeedAccounts: [] });
    mocks.devSeed.mockReturnValue([{ id: "admin", label: "Seed admin", email: "admin@docslurp.local" }]);
    expect((await (await appAs(session("u1")).request("/meta/auth-config")).json()).devSeedAccounts).toHaveLength(1);
  });
});

describe("POST /v1/waitlist", () => {
  const post = (body: unknown) => appAs(session("u1")).request("/v1/waitlist", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  it("rejects bad JSON and bad emails", async () => {
    expect((await post("{")).status).toBe(400);
    expect((await post({ email: "nope" })).status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it.each([[1, false], [0, true]])("notifies only new signups (inserted=%i)", async (inserted, already) => {
    mocks.insert.mockResolvedValue(Array.from({ length: inserted }, () => ({ id: "x" })));
    vi.stubEnv("SLACK_WAITLIST_WEBHOOK_URL", "");
    const res = await post({ email: " New@Example.com ", name: "N", use_case: "U" });
    expect(await res.json()).toEqual({ ok: true, already_registered: already });
    expect(mocks.notifySignup).toHaveBeenCalledTimes(inserted);
    if (inserted) expect(mocks.notifySignup).toHaveBeenCalledWith({ kind: "waitlist", email: "new@example.com", name: "N", useCase: "U" });
    vi.unstubAllEnvs();
  });
});

describe("GET /oauth/mcp/consent/:id", () => {
  const app = new Hono().route("/oauth/mcp", mcpOAuthRoutes);
  it("needs a signed-in session", async () => {
    mocks.resolveSession.mockResolvedValue(null);
    expect((await app.request("/oauth/mcp/consent/c1")).status).toBe(401);
    expect(mocks.consentQuery).not.toHaveBeenCalled();
  });
  it("looks the request up by the caller's own user and session, and hides the PKCE challenge", async () => {
    mocks.resolveSession.mockResolvedValue({ type: "session", userId: "u1", sessionId: "s1" });
    mocks.consentQuery.mockResolvedValue({ rows: [{ id: "c1", client_name: "Client", redirect_uri: "https://c.example/cb", scopes: ["search"], challenge: "secret", user_id: "u1", session_id: "s1" }] });
    const res = await app.request("/oauth/mcp/consent/c1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ id: "c1", client_name: "Client", redirect_uri: "https://c.example/cb", scopes: ["search"] });
    expect(mocks.consentQuery.mock.calls[0]?.[1]).toEqual(["c1", "u1", "s1"]);
  });
  it("returns 404 when the request belongs to someone else (query matches no row)", async () => {
    mocks.resolveSession.mockResolvedValue({ type: "session", userId: "u2", sessionId: "s2" });
    mocks.consentQuery.mockResolvedValue({ rows: [] });
    expect((await app.request("/oauth/mcp/consent/c1")).status).toBe(404);
    expect(mocks.consentQuery.mock.calls[0]?.[1]).toEqual(["c1", "u2", "s2"]);
  });
});

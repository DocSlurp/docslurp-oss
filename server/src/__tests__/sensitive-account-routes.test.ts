import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actor: { type: "session", userId: "actor", sessionId: "verified-session", mfaVerified: true } as any,
  sensitive: vi.fn(), query: vi.fn(),
  createKey: vi.fn(), updateKey: vi.fn(), rotateKey: vi.fn(), revokeKey: vi.fn(), listKeys: vi.fn(),
  deleteAccount: vi.fn(), planAccount: vi.fn(), deleteOrganization: vi.fn(), revokeAll: vi.fn(), policy: vi.fn(),
}));
vi.mock("../lib/auth.js", () => ({
  appDbPool: { query: mocks.query }, mfaConfig: { reauthMaxAgeSeconds: 600 },
  auth: { api: { signOut: vi.fn(async () => new Response(null)) } },
}));
vi.mock("../lib/auth-sensitive-access.js", () => ({ hasSensitiveAccess: mocks.sensitive }));
vi.mock("../lib/auth-mfa.js", () => ({ evaluateMfaPolicy: vi.fn() }));
vi.mock("../lib/request-actor.js", () => ({ getRequestActor: () => mocks.actor }));
vi.mock("../lib/request-context.js", () => ({ requestIp: () => "127.0.0.1", requestUserAgent: () => "test" }));
vi.mock("../services/audit-log.js", () => ({ appendAuditLog: vi.fn() }));
vi.mock("../services/api-keys.js", () => ({
  apiKeyTypes: ["server", "client"], supportedApiKeyScopes: ["ingest", "search", "organizations:manage"],
  ApiKeyTypeChangeError: class extends Error {}, createApiKey: mocks.createKey,
  updateApiKey: mocks.updateKey, rotateApiKey: mocks.rotateKey, revokeApiKey: mocks.revokeKey,
  listApiKeys: mocks.listKeys, listOrganizationApiKeys: vi.fn(), revokeOrganizationApiKeys: mocks.revokeAll,
}));
vi.mock("../services/tenant-offboarding.js", () => ({
  OffboardingError: class extends Error {}, deleteAccount: mocks.deleteAccount,
  planAccountDeletion: mocks.planAccount, deleteOrganization: mocks.deleteOrganization,
}));
vi.mock("../services/organizations.js", () => {
  class OrganizationError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) { super(message); }
  }
  return {
    OrganizationError, updateOrganizationMfaPolicy: mocks.policy, getOrganizationMfaPolicy: vi.fn(),
    acceptOrganizationInvite: vi.fn(), createOrganization: vi.fn(), getOrganization: vi.fn(),
    getOrganizationAccess: vi.fn(), getOrganizationDetails: vi.fn(), inviteOrganizationMember: vi.fn(),
    listOrganizationInvites: vi.fn(), listOrganizationMembers: vi.fn(), listOrganizations: vi.fn(),
    removeOrganizationMember: vi.fn(), revokeOrganizationInvite: vi.fn(), updateOrganization: vi.fn(), updateOrganizationMemberRole: vi.fn(),
  };
});
const { accountRoutes } = await import("../routes/account.js");
const { apiKeysRoutes } = await import("../routes/api-keys.js");
const { organizationsRoutes } = await import("../routes/organizations.js");
const { OrganizationError } = await import("../services/organizations.js");

const app = new Hono().use("*", async (c, next) => {
  c.set("sessionUser", { id: mocks.actor.userId, email: "actor@example.test", name: "Actor" });
  await next();
}).route("/v1/account", accountRoutes).route("/v1/api-keys", apiKeysRoutes).route("/v1/organizations", organizationsRoutes);
const operations = [
  ["POST", "/v1/api-keys", { name: "Integration", scopes: ["search"] }, mocks.createKey],
  ["PATCH", "/v1/api-keys/key", { name: "Renamed" }, mocks.updateKey],
  ["POST", "/v1/api-keys/key/rotate", {}, mocks.rotateKey],
  ["DELETE", "/v1/api-keys/key", undefined, mocks.revokeKey],
  ["DELETE", "/v1/account", { confirmation: "actor@example.test" }, mocks.deleteAccount],
  ["DELETE", "/v1/organizations/org", { confirmation: "Team" }, mocks.deleteOrganization],
  ["DELETE", "/v1/organizations/org/api-keys", undefined, mocks.revokeAll],
  ["PUT", "/v1/organizations/org/security-policy", { requireMfa: true }, mocks.policy],
] as const;
const send = (method: string, path: string, body?: unknown) => app.request(path, {
  method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor = { type: "session", userId: "actor", sessionId: "verified-session", mfaVerified: true };
  // Route tests exercise the helper's contract; its database ownership, expiry
  // and liveness predicates are independently covered in auth-sensitive-access tests.
  mocks.sensitive.mockImplementation(async (_pool, userId, sessionId) => userId === "actor" && sessionId === "verified-session");
  const key = { id: "key", name: "Integration", scopes: ["search"], allowedDomains: [], rateLimits: [], workspaceIds: [] };
  mocks.createKey.mockResolvedValue({ key, rawKey: "one-time-secret" });
  mocks.updateKey.mockResolvedValue(key); mocks.rotateKey.mockResolvedValue({ key, rawKey: "replacement-secret" });
  mocks.revokeKey.mockResolvedValue(key); mocks.revokeAll.mockResolvedValue([]);
  mocks.deleteAccount.mockResolvedValue({}); mocks.deleteOrganization.mockResolvedValue({}); mocks.policy.mockResolvedValue({});
});

describe("sensitive account mutation guards", () => {
  it.each(operations)("allows a verified session through %s %s", async (method, path, body, mutation) => {
    const response = await send(method, path, body);
    expect(response.status).toBeLessThan(300);
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mocks.sensitive).toHaveBeenCalledWith(expect.anything(), "actor", "verified-session");
  });
  it.each(operations)("refuses missing, expired, revoked and other-session verification for %s %s", async (method, path, body, mutation) => {
    for (const sessionId of ["", "missing", "expired", "revoked", "another-session"]) {
      mocks.actor.sessionId = sessionId;
      const response = await send(method, path, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "REAUTH_REQUIRED" } });
      expect(mutation).not.toHaveBeenCalled();
    }
    mocks.actor = { type: "session", userId: "another-user", sessionId: "verified-session" };
    const response = await send(method, path, body);
    expect(response.status).toBe(403);
    expect(mocks.sensitive).toHaveBeenLastCalledWith(expect.anything(), "another-user", "verified-session");
    expect(mutation).not.toHaveBeenCalled();
  });
  it("checks verification before reading hostile mutation bodies", async () => {
    mocks.actor.sessionId = "expired";
    const response = await app.request("/v1/api-keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"name":"' + "x".repeat(20_000) });
    expect(response.status).toBe(403);
    expect(mocks.createKey).not.toHaveBeenCalled();
  });
  it("fails closed when verification cannot be checked", async () => {
    mocks.sensitive.mockRejectedValueOnce(new Error("verification storage unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await send("POST", "/v1/api-keys", { name: "Integration" });
      expect(response.status).toBe(500);
      expect(mocks.createKey).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain("verification storage unavailable");
    } finally { log.mockRestore(); }
  });
  it("leaves settings and deletion-impact reads outside the step-up gate", async () => {
    mocks.actor.sessionId = "expired";
    mocks.listKeys.mockResolvedValue([]); mocks.planAccount.mockResolvedValue({ blockers: [] });
    expect((await send("GET", "/v1/api-keys")).status).toBe(200);
    expect((await send("GET", "/v1/account/deletion")).status).toBe(200);
    expect(mocks.sensitive).not.toHaveBeenCalled();
  });
  it("retains role and tenant refusals after successful session verification", async () => {
    mocks.revokeAll.mockRejectedValueOnce(new OrganizationError(403, "organization_forbidden", "Admin required"));
    expect((await send("DELETE", "/v1/organizations/org/api-keys")).status).toBe(403);
    mocks.revokeAll.mockRejectedValueOnce(new OrganizationError(404, "organization_not_found", "Unavailable"));
    expect((await send("DELETE", "/v1/organizations/other/api-keys")).status).toBe(404);
  });
  it("preserves explicitly scoped machine revoke-all while rejecting wrong tenant, scope and client keys", async () => {
    const actor = (scopes: string[], orgId = "org", keyType = "server") => ({ type: "apiKey", userId: "actor", apiKey: { orgId, keyType, scopes } });
    mocks.actor = actor(["organizations:manage"]);
    expect((await send("DELETE", "/v1/organizations/org/api-keys")).status).toBe(200);
    expect(mocks.sensitive).not.toHaveBeenCalled();
    for (const value of [actor(["organizations:read"]), actor(["organizations:manage"], "other"), actor(["organizations:manage"], "org", "client")]) {
      mocks.actor = value;
      expect((await send("DELETE", "/v1/organizations/org/api-keys")).status).toBeGreaterThanOrEqual(400);
    }
    expect(mocks.revokeAll).toHaveBeenCalledTimes(1);
  });
  it.each(operations.filter(([, path]) => path !== "/v1/organizations/org/api-keys"))("does not accept machine keys for session-only %s %s", async (method, path, body, mutation) => {
    mocks.actor = { type: "apiKey", userId: "actor", apiKey: { orgId: "org", keyType: "server", scopes: ["organizations:manage"] } };
    expect((await send(method, path, body)).status).toBe(403);
    expect(mutation).not.toHaveBeenCalled();
  });
});

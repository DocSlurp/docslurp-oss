import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestActor } from "../lib/request-actor.js";

const { validateApiKey, enforceAuthenticatedApiRateLimit } = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
  enforceAuthenticatedApiRateLimit: vi.fn(async () => null),
}));
vi.mock("../services/api-keys.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../services/api-keys.js")>()), validateApiKey }));
vi.mock("../middleware/rate-limit.js", () => ({ enforceAuthenticatedApiRateLimit }));
vi.mock("../lib/auth.js", () => ({ auth: { api: { getSession: vi.fn(async () => null) } }, appDbPool: {} }));

const { ApiKeyIpNotAllowedError, ClientKeyOriginNotAllowedError, ClientKeyWorkspacesRequiredError } = await import("../services/api-keys.js");
const { apiKeyAuth } = await import("../middleware/api-key-auth.js");
const { mcpAuth } = await import("../middleware/mcp-auth.js");
const { apiKeyAllowsWorkspace, apiKeyCanUseWorkspace } = await import("../lib/api-key-workspace-scope.js");
const { resetCapabilityKeyForTests, sealCapabilityToken } = await import("../lib/capability-tokens.js");
const { chatSessionForRequest, ChatSessionForbiddenError, chatSessionTokenRefusal, sealChatSessionToken } = await import("../lib/chat-session-tokens.js");

function clientActor(keyId = "pub-1"): Extract<RequestActor, { type: "apiKey" }> {
  return { type: "apiKey", userId: "owner", apiKey: { keyId, userId: "owner", orgId: "org-1", keyType: "client", allowedDomains: ["docs.example.com"], scopes: ["search", "chat"], rateLimitRpm: null, rateLimitPpd: 0, rateLimits: [], workspaceIds: ["ws-1"] } };
}

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", "public-key-boundaries-test-secret-with-entropy");
  resetCapabilityKeyForTests();
});
afterEach(() => vi.unstubAllEnvs());

describe("browser keys need a workspace allowlist", () => {
  it("refuses a legacy browser key with no allowlist, saying how to fix it", async () => {
    validateApiKey.mockRejectedValueOnce(new ClientKeyWorkspacesRequiredError());
    const app = new Hono().use("*", apiKeyAuth).get("/compat/x", (c) => c.json({ ok: true }));
    const response = await app.request("/compat/x", { headers: { Authorization: "Bearer dslp_pub_legacy" } });
    expect(response.status).toBe(403);
    const body = await response.json() as { code: string; error: string };
    expect(body.code).toBe("client_key_workspaces_required");
    expect(body.error).toMatch(/workspaceIds/);
  });

  it("answers a browser key on a website it doesn't allow with its own code and fix, not invalid-key", async () => {
    validateApiKey.mockRejectedValueOnce(new ClientKeyOriginNotAllowedError());
    const app = new Hono().use("*", apiKeyAuth).get("/compat/x", (c) => c.json({ ok: true }));
    const response = await app.request("/compat/x", { headers: { Authorization: "Bearer dslp_pub_wrong_site", Origin: "https://evil.example" } });
    expect(response.status).toBe(403);
    const body = await response.json() as { code: string; error: string };
    expect(body.code).toBe("client_key_origin_not_allowed");
    expect(body.error).toMatch(/allowed websites/);
  });

  it("refuses a server key used from outside its IP allowlist, on the API and on MCP, passing the client address", async () => {
    validateApiKey.mockRejectedValueOnce(new ApiKeyIpNotAllowedError());
    const api = new Hono().use("*", apiKeyAuth).get("/compat/x", (c) => c.json({ ok: true }));
    const refused = await api.request("/compat/x", { headers: { Authorization: "Bearer dslp_priv_office", "x-forwarded-for": "198.51.100.1" } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("api_key_ip_not_allowed");
    expect(validateApiKey).toHaveBeenLastCalledWith("dslp_priv_office", expect.objectContaining({ ip: expect.any(String) }));
    validateApiKey.mockRejectedValueOnce(new ApiKeyIpNotAllowedError());
    const mcp = new Hono().use("*", mcpAuth).post("/v1/mcp", (c) => c.json({ ok: true }));
    const mcpRefused = await mcp.request("/v1/mcp", { method: "POST", headers: { Authorization: "Bearer dslp_priv_office" } });
    expect(mcpRefused.status).toBe(403);
    expect(await mcpRefused.json()).toMatchObject({ code: "api_key_ip_not_allowed" });
  });

  it.each([ClientKeyWorkspacesRequiredError, ClientKeyOriginNotAllowedError])("refuses a legacy or wrong-site browser key on MCP like any browser key (%o)", async (ErrorType) => {
    validateApiKey.mockRejectedValueOnce(new ErrorType());
    const app = new Hono().use("*", mcpAuth).post("/v1/mcp", (c) => c.json({ ok: true }));
    const response = await app.request("/v1/mcp", { method: "POST", headers: { Authorization: "Bearer dslp_pub_legacy" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "A server API key is required" });
  });

  it("never treats an empty allowlist as every workspace for a browser key, and refuses other workspaces", () => {
    expect(apiKeyAllowsWorkspace({ keyType: "client", workspaceIds: [] }, "ws-1")).toBe(false);
    expect(apiKeyAllowsWorkspace({ keyType: "client", workspaceIds: ["ws-1"] }, "ws-2")).toBe(false);
    expect(apiKeyAllowsWorkspace({ keyType: "client", workspaceIds: ["ws-1"] }, "ws-1")).toBe(true);
    expect(apiKeyCanUseWorkspace({ keyType: "client", orgId: "org-1", workspaceIds: ["ws-1"] }, { id: "ws-1", orgId: "org-2" })).toBe(false);
    // Server keys keep the documented "empty means the owner's org" behaviour.
    expect(apiKeyAllowsWorkspace({ keyType: "server", workspaceIds: [] }, "ws-9")).toBe(true);
  });
});

describe("browser-key chat sessions are bound to a sealed grant", () => {
  const actor = clientActor();
  const scope = { workspaceId: "ws-1", sessionId: "11111111-1111-4111-8111-111111111111" };
  const grant = (overrides: Partial<{ keyId: string; workspaceId: string; sessionId: string; nowMs: number }> = {}) =>
    sealChatSessionToken({ keyId: "pub-1", ...scope, ...overrides });

  it("continues a session only with the grant issued for it", () => {
    expect(chatSessionForRequest(actor, { ...scope, sessionToken: grant() })).toBe(scope.sessionId);
    // A new conversation needs no grant.
    expect(chatSessionForRequest(actor, { workspaceId: "ws-1" })).toBeUndefined();
  });

  it("starts a fresh session (never the old one) for a session id with no grant, as pre-grant widgets send", () => {
    expect(chatSessionForRequest(actor, scope)).toBeUndefined();
  });

  it("refuses another visitor's session id presented with this visitor's own grant", () => {
    const mine = grant({ sessionId: "22222222-2222-4222-8222-222222222222" });
    expect(chatSessionTokenRefusal(mine, { keyId: "pub-1", ...scope })).toBe("scope");
    expect(() => chatSessionForRequest(actor, { ...scope, sessionToken: mine })).toThrow(ChatSessionForbiddenError);
  });

  it("refuses a grant for another key or workspace", () => {
    expect(chatSessionTokenRefusal(grant({ keyId: "pub-2" }), { keyId: "pub-1", ...scope })).toBe("scope");
    expect(chatSessionTokenRefusal(grant({ workspaceId: "ws-2" }), { keyId: "pub-1", ...scope })).toBe("scope");
  });

  it("refuses tampered and foreign-family grants; treats expired ones as no grant", () => {
    const token = grant();
    const flipped = token.slice(0, 20) + (token[20] === "A" ? "B" : "A") + token.slice(21);
    expect(chatSessionTokenRefusal(flipped, { keyId: "pub-1", ...scope })).toBe("invalid");
    expect(chatSessionTokenRefusal("not a token", { keyId: "pub-1", ...scope })).toBe("invalid");
    // A search capability (same root secret, other family) never opens as a chat grant.
    const capability = sealCapabilityToken({ v: 1, orgId: "org-1", workspaceIds: ["ws-1"], policy: {}, issuedByKeyId: "pub-1", exp: Math.floor(Date.now() / 1000) + 600, jti: "j" } as never);
    expect(chatSessionTokenRefusal(capability, { keyId: "pub-1", ...scope })).toBe("invalid");
    const old = grant({ nowMs: Date.now() - 25 * 60 * 60 * 1000 });
    expect(chatSessionTokenRefusal(old, { keyId: "pub-1", ...scope })).toBe("expired");
    // An expired grant starts a fresh session; a tampered one is refused.
    expect(chatSessionForRequest(actor, { ...scope, sessionToken: old })).toBeUndefined();
    expect(() => chatSessionForRequest(actor, { ...scope, sessionToken: flipped })).toThrow(ChatSessionForbiddenError);
  });

  it("answers a refusal as 403 chat_session_forbidden", async () => {
    const error = new ChatSessionForbiddenError("missing");
    expect(error.status).toBe(403);
    await expect(error.getResponse().json()).resolves.toMatchObject({ error: { code: "chat_session_forbidden", details: { category: "missing" } } });
  });

  it("leaves server keys and app sessions on their own user-scoped sessions", () => {
    const server = { ...actor, apiKey: { ...actor.apiKey, keyType: "server" as const } };
    expect(chatSessionForRequest(server, scope)).toBe(scope.sessionId);
    expect(chatSessionForRequest({ type: "session", userId: "owner", sessionId: "s", user: { id: "owner", email: "", name: "" } }, scope)).toBe(scope.sessionId);
  });
});

vi.mock("../lib/require-sensitive-session.js", () => ({
  requireSensitiveSession: async (_c: unknown, next: () => Promise<void>) => next(),
}));
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTestSession } from "./helpers/session-app.js";

vi.mock("../services/api-keys.js", () => ({
  apiKeyTypes: ["server", "client"],
  defaultApiKeyScopes: ["ingest", "search", "artifacts"],
  supportedApiKeyScopes: ["ingest", "search", "artifacts", "organizations:read", "organizations:manage"],
  createApiKey: vi.fn(),
  listApiKeys: vi.fn(),
  revokeApiKey: vi.fn(),
  rotateApiKey: vi.fn(),
  updateApiKey: vi.fn()
}));

vi.mock("../services/audit-log.js", () => ({
  appendAuditLog: vi.fn()
}));

vi.mock("../lib/request-context.js", () => ({
  requestIp: vi.fn(() => "127.0.0.1"),
  requestUserAgent: vi.fn(() => "vitest")
}));

const { apiKeysRoutes } = await import("../routes/api-keys.js");
const { createApiKey, listApiKeys, rotateApiKey, updateApiKey } = await import("../services/api-keys.js");

function buildApp() {
  const app = withTestSession(new Hono(), {
    id: "demo-user"
  });
  app.route("/api-keys", apiKeysRoutes);
  return app;
}

describe("apiKeysRoutes", () => {
  let app: Hono;

  beforeEach(() => {
    app = buildApp();
    vi.mocked(createApiKey).mockReset();
    vi.mocked(listApiKeys).mockReset();
    vi.mocked(rotateApiKey).mockReset();
    vi.mocked(updateApiKey).mockReset();
  });

  it("creates API keys with explicit scopes", async () => {
    vi.mocked(createApiKey).mockResolvedValue({
      key: {
        id: "key-1",
        userId: "demo-user",
        orgId: "org-1",
        name: "Zapier",
        keyType: "client",
        allowedDomains: ["app.docslurp.dev"],
        scopes: ["ingest", "search"],
        rateLimitRpm: 120,
        rateLimitPpd: 20000,
        rateLimits: [], workspaceIds: [],
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
        revokedAt: null,
        requestsLastMinute: 0,
        pagesToday: 0, lastUsedIp: null, expiresAt: null, ipAllowlist: [], maxOutputTokens: null, rotatedFromKeyId: null
      },
      rawKey: "dslp_secret"
    });

    const response = await app.request("/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Zapier",
        keyType: "client",
        allowedDomains: ["app.docslurp.dev"],
        scopes: ["ingest", "search"],
        rateLimitRpm: 120,
        rateLimitPpd: 20000,
        rateLimits: [{ metric: "spend", limit: 500, windowSeconds: 86_400 }],
      })
    });

    expect(response.status).toBe(201);
    expect(createApiKey).toHaveBeenCalledWith("demo-user", "Zapier", {
      orgId: undefined,
      keyType: "client",
      allowedDomains: ["app.docslurp.dev"],
      scopes: ["ingest", "search"],
      rpm: 120,
      ppd: 20000,
      rateLimits: [{ metric: "spend", limit: 500, windowSeconds: 86_400 }],
    });
  });

  it("rejects duplicate custom limits for the same metric and window", async () => {
    vi.mocked(createApiKey).mockClear();
    const response = await app.request("/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Dupes",
        rateLimits: [
          { metric: "requests", limit: 100, windowSeconds: 3_600 },
          { metric: "requests", limit: 200, windowSeconds: 3_600 },
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("returns 404 when updating a missing key", async () => {
    vi.mocked(updateApiKey).mockResolvedValue(null);

    const response = await app.request("/api-keys/key-missing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "demo-user",
        name: "Missing",
        scopes: ["ingest"]
      })
    });

    expect(response.status).toBe(404);
  });

  it("lists enriched keys", async () => {
    vi.mocked(listApiKeys).mockResolvedValue([
      {
        id: "key-1",
        userId: "demo-user",
        orgId: "org-1",
        name: "Airbyte",
        keyType: "server",
        allowedDomains: [],
        scopes: ["artifacts"],
        rateLimitRpm: 60,
        rateLimitPpd: 10000,
        rateLimits: [], workspaceIds: [],
        lastUsedAt: "2026-03-07T12:00:00.000Z",
        createdAt: "2026-03-06T12:00:00.000Z",
        revokedAt: null,
        requestsLastMinute: 3,
        pagesToday: 140, lastUsedIp: null, expiresAt: null, ipAllowlist: [], maxOutputTokens: null, rotatedFromKeyId: null
      }
    ]);

    const response = await app.request("/api-keys");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.keys[0].pagesToday).toBe(140);
    expect(body.keys[0].scopes).toEqual(["artifacts"]);
  });

  it("rotates a key and returns the raw secret once", async () => {
    vi.mocked(rotateApiKey).mockResolvedValue({
      key: {
        id: "key-1",
        userId: "demo-user",
        orgId: "org-1",
        name: "Retool",
        keyType: "server",
        allowedDomains: [],
        scopes: ["search"],
        rateLimitRpm: 60,
        rateLimitPpd: 10000,
        rateLimits: [], workspaceIds: [],
        lastUsedAt: null,
        createdAt: "2026-03-06T12:00:00.000Z",
        revokedAt: null,
        requestsLastMinute: 0,
        pagesToday: 0, lastUsedIp: null, expiresAt: null, ipAllowlist: [], maxOutputTokens: null, rotatedFromKeyId: null
      },
      rawKey: "dslp_rotated"
    });

    const response = await app.request("/api-keys/key-1/rotate", {
      method: "POST"
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rawKey).toBe("dslp_rotated");
    expect(rotateApiKey).toHaveBeenCalledWith("key-1", "demo-user", { overlapSeconds: undefined });
  });

  it("passes client-key domain updates through to the service", async () => {
    vi.mocked(updateApiKey).mockResolvedValue({
      id: "key-1",
      userId: "demo-user",
      orgId: "org-1",
      name: "Embeds",
      keyType: "client",
      allowedDomains: ["docs.docslurp.dev", "app.docslurp.dev"],
      scopes: ["search"],
      rateLimitRpm: 60,
      rateLimitPpd: 10000,
      rateLimits: [], workspaceIds: [],
      lastUsedAt: null,
      createdAt: "2026-03-06T12:00:00.000Z",
      revokedAt: null,
      requestsLastMinute: 0,
      pagesToday: 0, lastUsedIp: null, expiresAt: null, ipAllowlist: [], maxOutputTokens: null, rotatedFromKeyId: null
    });

    const response = await app.request("/api-keys/key-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keyType: "client",
        allowedDomains: ["docs.docslurp.dev", "app.docslurp.dev"],
        scopes: ["search"]
      })
    });

    expect(response.status).toBe(200);
    expect(updateApiKey).toHaveBeenCalledWith("key-1", "demo-user", {
      name: undefined,
      keyType: "client",
      allowedDomains: ["docs.docslurp.dev", "app.docslurp.dev"],
      scopes: ["search"],
      rateLimitRpm: undefined,
      rateLimitPpd: undefined,
      rateLimits: undefined,
    });
  });
});

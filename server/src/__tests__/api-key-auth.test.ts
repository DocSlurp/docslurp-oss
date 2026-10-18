import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidatedKey } from "../services/api-keys.js";

// Mock the api-keys service before importing the middleware
vi.mock("../services/api-keys.js", () => ({
  validateApiKey: vi.fn(),
}));

// These imports must come after vi.mock() so they get the mocked version
const { validateApiKey } = await import("../services/api-keys.js");
const { apiKeyAuth } = await import("../middleware/api-key-auth.js");

const validatedKey: ValidatedKey = {
  keyId: "key-1",
  userId: "user-1",
  orgId: null,
  keyType: "server",
  allowedDomains: [],
  scopes: ["documents:read"],
  rateLimitRpm: 60,
  rateLimitPpd: 10_000,
  rateLimits: [], workspaceIds: [],
};

function buildApp() {
  const app = new Hono();
  app.use("/v1/protected", apiKeyAuth);
  app.get("/v1/protected", (c) => {
    const actor = c.get("requestActor");
    return c.json({
      ok: true,
      actorType: actor.type,
      actorUserId: actor.userId,
      sessionUserId: c.get("sessionUser").id,
      apiKeyId: c.get("apiKey").keyId
    });
  });
  return app;
}

describe("apiKeyAuth middleware", () => {
  let app: Hono;

  beforeEach(() => {
    app = buildApp();
    vi.mocked(validateApiKey).mockReset();
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const res = await app.request("/v1/protected");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Missing or invalid Authorization header" } });
  });

  it("returns 401 when Authorization header doesn't start with 'Bearer '", async () => {
    const res = await app.request("/v1/protected", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an Authorization header with only 'Bearer' (no key)", async () => {
    const res = await app.request("/v1/protected", {
      headers: { Authorization: "Bearer" },
    });
    // "Bearer" doesn't start with "Bearer " (note trailing space) → 401
    expect(res.status).toBe(401);
  });

  it("returns 403 when validateApiKey returns null (invalid/revoked key)", async () => {
    vi.mocked(validateApiKey).mockResolvedValue(null);
    const res = await app.request("/v1/protected", {
      headers: { Authorization: "Bearer dslp_invalid" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "Invalid API key or rate limit exceeded" } });
  });

  it("keeps the flat { error, code } body on protocol surfaces", async () => {
    const compat = new Hono().use("*", apiKeyAuth).get("/compat/algolia/ping", (c) => c.json({ ok: true }));
    const res = await compat.request("/compat/algolia/ping");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Missing or invalid Authorization header", code: "unauthorized" });
  });

  it("calls next and returns 200 for a valid API key", async () => {
    vi.mocked(validateApiKey).mockResolvedValue(validatedKey);
    const res = await app.request("/v1/protected", {
      headers: { Authorization: "Bearer dslp_validkey123" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      actorType: "apiKey",
      actorUserId: "user-1",
      sessionUserId: "user-1",
      apiKeyId: "key-1"
    });
  });

  it("strips the 'Bearer ' prefix before passing the key to validateApiKey", async () => {
    vi.mocked(validateApiKey).mockResolvedValue(null);
    await app.request("/v1/protected", {
      headers: { Authorization: "Bearer my-secret-key" },
    });
    expect(validateApiKey).toHaveBeenCalledWith("my-secret-key", {
      origin: undefined,
      referer: undefined
    });
  });

  it("calls validateApiKey exactly once per request", async () => {
    vi.mocked(validateApiKey).mockResolvedValue(validatedKey);
    await app.request("/v1/protected", {
      headers: { Authorization: "Bearer dslp_key" },
    });
    expect(validateApiKey).toHaveBeenCalledTimes(1);
  });

  it("does not call validateApiKey when the Authorization header is malformed", async () => {
    await app.request("/v1/protected", {
      headers: { Authorization: "Token abc" },
    });
    expect(validateApiKey).not.toHaveBeenCalled();
  });

  it("forwards origin and referer headers to API key validation", async () => {
    vi.mocked(validateApiKey).mockResolvedValue(validatedKey);

    await app.request("/v1/protected", {
      headers: {
        Authorization: "Bearer dslp_client_key",
        Origin: "https://app.docslurp.dev",
        Referer: "https://app.docslurp.dev/widget"
      }
    });

    expect(validateApiKey).toHaveBeenCalledWith("dslp_client_key", {
      origin: "https://app.docslurp.dev",
      referer: "https://app.docslurp.dev/widget"
    });
  });
});

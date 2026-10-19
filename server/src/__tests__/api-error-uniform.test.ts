import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Boots the real API app (server.ts: every router and the global middleware
 * stack) with the database, Better Auth and key validation faked, and checks
 * that every native error leaves in the one envelope, with the headers the
 * middleware set, while protocol surfaces keep their own shapes.
 */
const mocks = vi.hoisted(() => ({ validateApiKey: vi.fn() }));

vi.mock("../lib/better-auth.js", () => ({
  auth: { api: { getSession: async () => null }, handler: async () => new Response(null, { status: 404 }) },
  handleAuthRequest: async () => new Response(null, { status: 404 }),
  appDbPool: { query: async () => { throw new Error("database disabled in uniform-error test"); } },
  configuredEmailAuth: false,
  configuredSocialProviders: { github: false, google: false },
}));
vi.mock("../db.js", () => {
  const fail = () => ({
    then: (resolve: (value: never) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.reject(new Error("database disabled in uniform-error test")).then(resolve, reject),
  });
  const sql = Object.assign(fail, { begin: fail, unsafe: fail, json: (value: unknown) => value, array: (value: unknown) => value, end: async () => undefined });
  return { sql };
});
vi.mock("../services/api-keys.js", async () => {
  const actual = await vi.importActual<typeof import("../services/api-keys.js")>("../services/api-keys.js");
  return { ...actual, validateApiKey: mocks.validateApiKey };
});

const key = (extra: Record<string, unknown> = {}) => ({
  keyId: "key-uniform", userId: "user-uniform", orgId: "org-uniform", keyType: "server", allowedDomains: [],
  scopes: ["ingest", "search", "workspaces:manage"], rateLimitRpm: 600, rateLimitPpd: 100_000, rateLimits: [], workspaceIds: [], ...extra,
});
const ip = { "fly-client-ip": "192.0.2.77" };
const bearer = { Authorization: "Bearer dslp_priv_uniform", ...ip };

let app: import("hono").Hono;
let resetBuckets: () => void;

beforeAll(async () => {
  vi.stubEnv("API_RATE_LIMIT_ENABLED", "false");
  vi.stubEnv("API_RATE_LIMIT_REDIS_REST_URL", "");
  vi.stubEnv("API_RATE_LIMIT_REDIS_REST_TOKEN", "");
  vi.stubEnv("API_RATE_LIMIT_REDIS_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("REDIS_URL", "");
  mocks.validateApiKey.mockResolvedValue(key());
  const { createApiApp } = await import("../server.js");
  ({ resetApiRateLimitBuckets: resetBuckets } = await import("../middleware/rate-limit.js"));
  app = createApiApp();
}, 120_000);

afterEach(() => {
  vi.stubEnv("API_RATE_LIMIT_ENABLED", "false");
  mocks.validateApiKey.mockResolvedValue(key());
  resetBuckets();
});

async function envelope(response: Response) {
  const body = await response.json();
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error.requestId).toEqual(expect.any(String));
  expect(body.error.message).toEqual(expect.any(String));
  return body.error as { code: string; message: string; requestId: string; details?: Record<string, unknown> };
}

describe("one error shape for the native API (real middleware stack)", () => {
  it("answers missing and invalid credentials with unauthorized", async () => {
    expect((await envelope(await app.request("/v1/workspaces/board", { headers: ip }))).code).toBe("unauthorized");
    expect((await envelope(await app.request("/dashboard/bootstrap", { headers: ip }))).code).toBe("unauthorized");
    mocks.validateApiKey.mockResolvedValue(null);
    expect((await envelope(await app.request("/v1/documents", { headers: bearer }))).code).toBe("unauthorized");
  });

  it("answers a 429 with the envelope and keeps Retry-After and the RateLimit headers", async () => {
    vi.stubEnv("API_RATE_LIMIT_ENABLED", "true");
    vi.stubEnv("API_RATE_LIMIT_IP_READ_MAX", "1");
    await app.request("/health", { headers: ip });
    await app.request("/v1/workspaces/board", { headers: ip });
    const limited = await app.request("/v1/workspaces/board", { headers: ip });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(limited.headers.get("RateLimit-Policy")).toContain("ip-read");
    expect(limited.headers.get("RateLimit")).toContain("ip-read");
    const error = await envelope(limited);
    expect(error.code === "rate_limited" || error.code === "ip_temporarily_blocked").toBe(true);
    expect(error.details).toMatchObject({ retryAfterSeconds: expect.any(Number) });
  });

  it("answers a key whose spend window is exhausted with spend_limit_exceeded and the spend header", async () => {
    vi.stubEnv("API_RATE_LIMIT_ENABLED", "true");
    mocks.validateApiKey.mockResolvedValue(key({ rateLimits: [{ metric: "spend", limit: 0, windowSeconds: 3600 }] }));
    const limited = await app.request("/v1/search?q=x&workspaceId=00000000-0000-4000-8000-000000000001", { headers: bearer });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("X-DocSlurp-Spend")).toContain("u=usd-cents");
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect((await envelope(limited)).code).toBe("spend_limit_exceeded");
  });

  it("answers oversized uploads with payload_too_large", async () => {
    for (const path of ["/v1/uploads/bulk", "/v1/ingest/bulk", "/v1/uploads/url"]) {
      const response = await app.request(path, { method: "POST", headers: { ...bearer, "content-type": "multipart/form-data; boundary=x", "content-length": String(10 * 1024 * 1024 * 1024) }, body: "--x--" });
      expect(response.status, path).toBe(413);
      const error = await envelope(response);
      expect(error.code, path).toBe("payload_too_large");
      expect(error.details, path).toMatchObject({ maxBytes: expect.any(Number) });
    }
  });

  it("answers requests carrying NUL bytes with invalid_request", async () => {
    expect((await envelope(await app.request("/v1/search?q=a%00b", { headers: bearer }))).code).toBe("invalid_request");
  });

  it("answers an unexpected failure with internal and never its text", async () => {
    const response = await app.request("/v1/workspaces", { headers: bearer });
    expect(response.status).toBe(500);
    const error = await envelope(response);
    expect(error.code).toBe("internal");
    expect(JSON.stringify(error)).not.toMatch(/database disabled/);
  });

  it("keeps protocol surfaces in their own shapes", async () => {
    const compat = await app.request("/compat/algolia/1/indexes/ws/query", { method: "POST", headers: ip, body: "{}" });
    expect(compat.status).toBe(401);
    expect(typeof (await compat.json()).error).toBe("string");

    const openai = await app.request("/v1/chat/completions", { method: "POST", headers: { ...ip, "content-type": "application/json" }, body: "{}" });
    expect(openai.status).toBe(401);
    expect(await openai.json()).toMatchObject({ error: { type: "invalid_request_error", param: null } });

    const mcp = await app.request("/v1/mcp", { method: "POST", headers: { ...ip, "content-type": "application/json" }, body: "{}" });
    expect(mcp.status).toBeGreaterThanOrEqual(400);
    expect((await mcp.json()).error?.requestId).toBeUndefined();

    const oauth = await app.request("/oauth/mcp/token", { method: "POST", headers: { ...ip, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=bad" });
    expect(oauth.status).toBeGreaterThanOrEqual(400);
    const oauthBody = await oauth.json();
    expect(typeof oauthBody.error).toBe("string");
  });
});

import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Boots the real API app (server.ts: every router and the global middleware
 * stack, including sessionAuth) and checks the API key surface against the
 * OpenAPI document: every operation documented with bearerAuth must accept a
 * key, and every other /v1 route must reject one. Only the database, Better
 * Auth and key validation are faked, so handlers fail after auth (4xx/5xx),
 * which is fine: the assertion is only about the 401 from sessionAuth.
 */
const mocks = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
}));

vi.mock("../lib/better-auth.js", () => ({
  auth: { api: { getSession: async () => null }, handler: async () => new Response(null, { status: 404 }) },
  handleAuthRequest: async () => new Response(null, { status: 404 }),
  appDbPool: { query: async () => { throw new Error("database disabled in route-auth test"); } },
  configuredEmailAuth: false,
  configuredSocialProviders: { github: false, google: false },
}));
vi.mock("../db.js", () => {
  // Lazy like postgres.js: a fragment built at module load (sql`...` in a
  // constant) must not reject until something actually awaits it.
  const fail = () => ({
    then: (resolve: (value: never) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.reject(new Error("database disabled in route-auth test")).then(resolve, reject),
  });
  const sql = Object.assign(fail, {
    begin: fail,
    unsafe: fail,
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    end: async () => undefined,
  });
  return { sql };
});
vi.mock("../services/api-keys.js", async () => {
  const actual = await vi.importActual<typeof import("../services/api-keys.js")>("../services/api-keys.js");
  return { ...actual, validateApiKey: mocks.validateApiKey };
});

const ALL_SCOPES = ["ingest", "search", "artifacts", "organizations:read", "organizations:manage", "workspaces:manage"];
const KEY = "dslp_priv_route_auth_test";
// Routes that authenticate callers themselves; adding one is a reviewed change.
const ROUTE_AUTHENTICATED = [
  "GET /v1/models",
  "POST /v1/chat/completions",
  // Session-bound proof start checks its own cookie session, including policy-blocked sessions.
  "POST /v1/auth/sensitive-sso/start",
  "GET /v1/auth/oidc/:orgId/init",
  "GET /v1/auth/oidc/:orgId/callback",
  "GET /v1/auth/saml/:orgSlug/init",
  "POST /v1/auth/saml/:orgSlug/callback",
  // Public signup capture relayed by the dashboard (routes/frontend.ts); no credential applies.
  "POST /v1/waitlist",
  // Public price list (routes/billing.ts): prices are readable without signing in.
  "GET /v1/billing/prices",
].sort();

type Operation = { method: string; path: string };

let app: import("hono").Hono;
let documented: Operation[];
let routes: Array<{ method: string; path: string; mode: string }>;

function concretePath(path: string): string {
  return path
    .replace(/\{workspaceId\}|:workspaceId\b/g, "00000000-0000-4000-8000-000000000001")
    .replace(/\{[^}]+\}/g, "test-id")
    .replace(/:[A-Za-z_]+/g, "test-id");
}

async function requestWithKey(operation: Operation): Promise<Response> {
  const method = operation.method.toUpperCase();
  return await app.request(concretePath(operation.path), {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json", "fly-client-ip": "192.0.2.1" },
    body: method === "GET" || method === "DELETE" ? undefined : "{}",
  });
}

function toHonoPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

beforeAll(async () => {
  vi.stubEnv("API_RATE_LIMIT_ENABLED", "false");
  mocks.validateApiKey.mockResolvedValue({
    keyId: "key-route-auth", userId: "user-route-auth", orgId: "org-route-auth", keyType: "server",
    allowedDomains: [], scopes: ALL_SCOPES, rateLimitRpm: 600, rateLimitPpd: 100_000, rateLimits: [],
  });
  const { createApiApp } = await import("../server.js");
  // The SSO limiter counts in the database, which this stack replaces with a refusing stub.
  const { setSsoRateLimitStoreForTests } = await import("../routes/sso.js");
  setSsoRateLimitStoreForTests((await import("../lib/auth-rate-limits.js")).createMemoryAuthBudgetStore());
  const { buildOpenApiDocument } = await import("../lib/openapi.js");
  const { listRouteAuthModes } = await import("../lib/route-auth.js");
  app = createApiApp();
  routes = listRouteAuthModes(app);
  const doc = buildOpenApiDocument("http://localhost") as { paths: Record<string, Record<string, { security?: Array<Record<string, unknown>> }>> };
  documented = Object.entries(doc.paths).flatMap(([path, operations]) => Object.entries(operations)
    .filter(([, operation]) => operation.security?.some((scheme) => "bearerAuth" in scheme))
    .map(([method, operation]) => { void operation; return { method: method.toUpperCase(), path }; }))
    .filter((operation) => operation.path.startsWith("/v1/") && !operation.path.startsWith("/v1/mcp"));
}, 120_000);

describe("API key route declarations (real middleware stack)", () => {
  it("requires a session for dashboard bootstrap and retires the shell route", async () => {
    expect(routes).toContainEqual({ method: "GET", path: "/dashboard/bootstrap", mode: "session" });
    expect(routes.some((route) => route.path === "/v1/shell")).toBe(false);
    expect((await app.request("/dashboard/bootstrap")).status).toBe(401);
    expect((await requestWithKey({ method: "GET", path: "/dashboard/bootstrap" })).status).toBe(401);
  });

  it("documents the workspace graph routes as API-key routes", () => {
    const graph = documented.filter((operation) => operation.path.includes("/graph"));
    expect(graph.length).toBeGreaterThanOrEqual(6);
  });

  it("accepts an API key on every documented bearerAuth route", async () => {
    const rejected: string[] = [];
    for (const operation of documented) {
      const response = await requestWithKey(operation);
      if (response.status === 401) rejected.push(`${operation.method} ${operation.path}`);
    }
    expect(rejected).toEqual([]);
  }, 120_000);

  it("declares exactly the documented routes as API-key routes", () => {
    const declared = routes.filter((route) => route.mode === "apiKey" && !route.path.startsWith("/v1/mcp"))
      .map((route) => `${route.method} ${route.path}`).sort();
    const documentedKeys = documented.map((operation) => `${operation.method} ${toHonoPath(operation.path)}`)
      .filter((key) => !ROUTE_AUTHENTICATED.includes(key)).sort();
    expect(declared).toEqual(documentedKeys);
  });

  it("rejects API keys on the self-authenticating sensitive SSO start route", async () => {
    const before = mocks.validateApiKey.mock.calls.length;
    const response = await app.request("/v1/auth/sensitive-sso/start", {
      method: "POST", headers: { Authorization: `Bearer ${KEY}`, Origin: "http://localhost", "content-type": "application/json" }, body: "{}",
    });
    // Trusted origin passes; an API key must never substitute for the original browser session.
    expect(response.status).toBe(401);
    expect(mocks.validateApiKey.mock.calls.length).toBe(before);
  });

  it("keeps the self-authenticating route list explicit", () => {
    const self = routes.filter((route) => route.mode === "route").map((route) => `${route.method} ${route.path}`).sort();
    expect(self).toEqual(ROUTE_AUTHENTICATED);
  });

  it("rejects an API key on every undocumented /v1 route", async () => {
    const documentedKeys = new Set(documented.map((operation) => `${operation.method} ${toHonoPath(operation.path)}`));
    const accepted: string[] = [];
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (!route.path.startsWith("/v1/") || route.path.startsWith("/v1/mcp") || documentedKeys.has(key) || ROUTE_AUTHENTICATED.includes(key)) continue;
      const response = await requestWithKey(route);
      if (response.status !== 401) accepted.push(`${key} -> ${response.status}`);
    }
    expect(accepted).toEqual([]);
  }, 120_000);
});

describe("browser keys on admin and server-only routes (real middleware stack)", () => {
  const browserKey = {
    keyId: "key-browser", userId: "user-route-auth", orgId: "org-route-auth", keyType: "client",
    allowedDomains: ["docs.example.com"], scopes: ["search", "chat"], rateLimitRpm: null, rateLimitPpd: 0, rateLimits: [],
    workspaceIds: ["00000000-0000-4000-8000-000000000001"], maxOutputTokens: 1000,
  };
  it.each([
    ["GET", "/v1/api-keys"],
    ["POST", "/v1/api-keys"],
    ["POST", "/v1/api-keys/test-id/rotate"],
    ["GET", "/v1/admin/billing/organizations"],
    ["POST", "/v1/admin/billing/credits"],
    ["GET", "/v1/organizations"],
    ["DELETE", "/v1/organizations/test-id"],
    ["PATCH", "/v1/workspaces/00000000-0000-4000-8000-000000000001"],
    ["POST", "/v1/workspaces/00000000-0000-4000-8000-000000000001/settings-proposals/apply"],
    ["POST", "/v1/uploads/url"],
    ["GET", "/v1/workspaces/00000000-0000-4000-8000-000000000001/state"],
  ])("refuses a browser key on %s %s", async (method, path) => {
    mocks.validateApiKey.mockResolvedValueOnce(browserKey);
    const response = await app.request(path, {
      method,
      headers: { Authorization: "Bearer dslp_pub_route_auth", "content-type": "application/json", "fly-client-ip": "192.0.2.1", Origin: "https://docs.example.com" },
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
    });
    expect([401, 403, 404], `${method} ${path} answered ${response.status}`).toContain(response.status);
  });
});


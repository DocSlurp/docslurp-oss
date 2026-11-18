import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { validateMcpToken, validateApiKey, validateOAuthApiToken, recordApiKeyRequest } = vi.hoisted(() => ({ validateMcpToken: vi.fn(), validateApiKey: vi.fn(), validateOAuthApiToken: vi.fn(async () => null), recordApiKeyRequest: vi.fn() }));
vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(), { json: (value: unknown) => value, array: (value: unknown) => value }) }));
// The real request-actor and route-credentials code; only the key stores are faked.
vi.mock("../services/mcp-oauth.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../services/mcp-oauth.js")>(), validateMcpToken, validateOAuthApiToken }));
vi.mock("../services/api-keys.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../services/api-keys.js")>(), validateApiKey }));
vi.mock("../services/api-key-usage.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../services/api-key-usage.js")>(), recordApiKeyRequest }));

const { nativeBodyLimit } = await import("../lib/api-error.js");
const { v1BodyLimit } = await import("../lib/v1-body-limit.js");
const { bodyReadSettings, bufferedBodyBytes, configureBodyReads } = await import("../lib/bounded-body-limit.js");
const { registerBodyBudgetCredentialResolver } = await import("../lib/body-budget-owner.js");
const { PREVERIFY_TIMEOUT_MS, verifyBodyBudgetCredential } = await import("../lib/body-budget-credentials.js");
const { apiKeyAuth } = await import("../middleware/api-key-auth.js");
const { mcpResource } = await import("../services/mcp-oauth.js");
const { mcpAuth } = await import("../middleware/mcp-auth.js");
const { compatibleChatAuth } = await import("../routes/chat-completions.js");
const { algoliaCompatRoutes } = await import("../routes/algolia-compat.js");
const { PREVERIFY_MAX_CONCURRENT, bodyBudgetFallbackCounts, bodyBudgetPreverifyInFlight, preverifiedRoute } = await import("../lib/body-budget-credentials.js");
const { requestContextMiddleware } = await import("../lib/request-context.js");

let saved: ReturnType<typeof bodyReadSettings>;
beforeEach(() => {
  saved = bodyReadSettings();
  // Verified keys for these tests: "good" (org-a) and a dsmcp token (org-b).
  registerBodyBudgetCredentialResolver(async c => {
    const auth = c.req.header("Authorization");
    if (auth === "Bearer good") return { orgId: "org-a", keyId: "k-a" };
    if (auth === "Bearer dsmcp_good") return { orgId: "org-b", keyId: "k-b" };
    return null;
  });
});
afterEach(() => {
  configureBodyReads(saved);
  registerBodyBudgetCredentialResolver(null);
  vi.clearAllMocks();
});

/** The production /v1 stack for routes that authenticate inside their handler; handlers wait until released. */
function app() {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const hono = new Hono();
  hono.use("/v1/mcp", nativeBodyLimit(1024 * 1024));
  hono.use("/v1/*", v1BodyLimit({ maxMultipartUploadBytes: 25 * 1024 * 1024 }));
  hono.post("/v1/chat/completions", async c => { await c.req.arrayBuffer(); await held; return c.text("ok"); });
  hono.post("/v1/mcp", async c => { await c.req.arrayBuffer(); await held; return c.text("ok"); });
  const post = (path: string, bytes: number, token?: string) => hono.request(path, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: new Uint8Array(bytes),
  });
  return { post, release: () => release() };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

describe("routes that authenticate in their handler are charged to the authenticated pool", () => {
  it("lets a 2 MiB chat-completions body through with a valid key (public requests stop at 1 MiB)", async () => {
    const { post, release } = app();
    release();
    expect((await post("/v1/chat/completions", 2 * 1024 * 1024, "good")).status).toBe(200);
    expect((await post("/v1/chat/completions", 2 * 1024 * 1024)).status).toBe(413);
    expect((await post("/v1/chat/completions", 2 * 1024 * 1024, "forged")).status).toBe(413);
  });

  it("serves 20 concurrent 100 KB chat completions from one IP with valid keys", async () => {
    const { post, release } = app();
    const pending = Array.from({ length: 20 }, () => post("/v1/chat/completions", 100 * 1024, "good"));
    await settle();
    expect(bufferedBodyBytes("authenticated")).toBe(20 * 100 * 1024);
    expect(bufferedBodyBytes("public")).toBe(0);
    release();
    for (const response of await Promise.all(pending)) expect(response.status).toBe(200);
  });

  it("serves 20 concurrent MCP calls from one IP", async () => {
    const { post, release } = app();
    const pending = Array.from({ length: 20 }, () => post("/v1/mcp", 100 * 1024, "dsmcp_good"));
    await settle();
    expect(bufferedBodyBytes("authenticated")).toBe(20 * 100 * 1024);
    release();
    for (const response of await Promise.all(pending)) expect(response.status).toBe(200);
  });

  it("charges an unauthenticated request to the public pool", async () => {
    const { post, release } = app();
    const pending = post("/v1/chat/completions", 100 * 1024);
    await settle();
    expect(bufferedBodyBytes("public")).toBe(100 * 1024);
    expect(bufferedBodyBytes("authenticated")).toBe(0);
    release();
    expect((await pending).status).toBe(200);
  });
});

describe("the production credential check: the route's own verifier and admission rule", () => {
  /** A context as the pre-check sees it. */
  const context = (method: string, path: string, headers: Record<string, string>) => {
    const request = new Request(`http://localhost${path}`, { method, headers });
    return { req: { url: request.url, path, method, header: (name: string) => request.headers.get(name) ?? undefined }, env: {} } as never;
  };
  const key = (overrides: Record<string, unknown>) => ({
    keyId: "k", userId: "u", orgId: "org-k", keyType: "server", allowedDomains: [], scopes: ["search:deep", "chat"], rateLimits: [], projectIds: [], ...overrides,
  });

  it("charges public a search-only browser key on chat, a browser key on MCP and an MCP token on chat", async () => {
    validateApiKey.mockResolvedValue(key({ keyType: "client", scopes: ["search:deep"] }));
    expect(await verifyBodyBudgetCredential(context("POST", "/v1/chat/completions", { Authorization: "Bearer dslp_pub_search" }))).toBeNull();
    validateApiKey.mockResolvedValue(key({ keyType: "client", scopes: ["search:deep", "chat"] }));
    expect(await verifyBodyBudgetCredential(context("POST", "/v1/mcp", { Authorization: "Bearer dslp_pub_browser" }))).toBeNull();
    validateMcpToken.mockResolvedValue(key({}));
    expect(await verifyBodyBudgetCredential(context("POST", "/v1/chat/completions", { Authorization: "Bearer dsmcp_token" }))).toBeNull();
  });

  it("charges the org of a credential the route admits", async () => {
    validateApiKey.mockResolvedValue(key({}));
    expect(await verifyBodyBudgetCredential(context("POST", "/v1/chat/completions", { Authorization: "Bearer dslp_priv_chat" }))).toEqual({ orgId: "org-k", keyId: "k" });
    validateMcpToken.mockResolvedValue(key({ orgId: "org-m", keyId: "k-m" }));
    expect(await verifyBodyBudgetCredential(context("POST", "/v1/mcp", { Authorization: "Bearer dsmcp_token" }))).toEqual({ orgId: "org-m", keyId: "k-m" });
    // Validated against the MCP resource, exactly as mcp-auth validates it.
    expect(validateMcpToken).toHaveBeenCalledWith("dsmcp_token", mcpResource("http://localhost/v1/mcp"), expect.anything(), { timeoutMs: expect.any(Number) });
    expect(await verifyBodyBudgetCredential(context("POST", "/compat/algolia/1/indexes/docs/query", { "X-Algolia-API-Key": "dslp_priv_algolia" }))).toEqual({ orgId: "org-k", keyId: "k" });
  });

  it("reads X-Algolia-API-Key on Algolia routes only, and binds admission to the exact route and method", async () => {
    validateApiKey.mockResolvedValue(key({}));
    expect(await verifyBodyBudgetCredential(context("POST", "/v1/chat/completions", { "X-Algolia-API-Key": "dslp_priv_algolia" }))).toBeNull();
    expect(await verifyBodyBudgetCredential(context("PATCH", "/v1/chat/completions", { Authorization: "Bearer dslp_priv_chat" }))).toBeNull();
    expect(await verifyBodyBudgetCredential(context("POST", "/v1/chat/completions/extra", { Authorization: "Bearer dslp_priv_chat" }))).toBeNull();
    // A route that must never look a key up (the sensitive SSO start) resolves nothing.
    validateApiKey.mockClear();
    expect(await verifyBodyBudgetCredential(context("POST", "/v1/auth/sensitive-sso/start", { Authorization: "Bearer dslp_priv_chat" }))).toBeNull();
    expect(validateApiKey).not.toHaveBeenCalled();
  });

  it("treats a missing, unknown or policy-refused credential as unverified, and never records usage", async () => {
    expect(await verifyBodyBudgetCredential(context("POST", "/v1/chat/completions", {}))).toBeNull();
    validateApiKey.mockResolvedValue(null);
    expect(await verifyBodyBudgetCredential(context("POST", "/v1/chat/completions", { Authorization: "Bearer unknown" }))).toBeNull();
    validateApiKey.mockRejectedValue(Object.assign(new Error("ip"), { code: "api_key_ip_not_allowed" }));
    expect(await verifyBodyBudgetCredential(context("POST", "/v1/chat/completions", { Authorization: "Bearer refused" }))).toBeNull();
    for (const call of validateApiKey.mock.calls) expect(call[2]).toMatchObject({ recordUsage: false, timeoutMs: expect.any(Number) });
    expect(recordApiKeyRequest).not.toHaveBeenCalled();
  });

  it("gives up after its wait bound (public), without failing the request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settle!: () => void;
      validateApiKey.mockReturnValue(new Promise((resolve) => { settle = () => resolve(null); }));
      const pending = verifyBodyBudgetCredential(context("POST", "/v1/chat/completions", { Authorization: "Bearer slow" }));
      await vi.advanceTimersByTimeAsync(PREVERIFY_TIMEOUT_MS);
      expect(await pending).toBeNull();
      // Let the lookup settle, releasing its slot for later tests.
      settle();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes one key lookup and one usage record per request: the route's auth reuses the pre-check", async () => {
    registerBodyBudgetCredentialResolver(verifyBodyBudgetCredential);
    validateApiKey.mockResolvedValue(key({}));
    const hono = new Hono();
    hono.use("/v1/*", v1BodyLimit({ maxMultipartUploadBytes: 25 * 1024 * 1024 }));
    hono.use("/v1/chat/completions", apiKeyAuth);
    hono.post("/v1/chat/completions", c => c.text("ok"));
    const response = await hono.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer dslp_priv_chat" }, body: "{}" });
    expect(response.status).toBe(200);
    expect(validateApiKey).toHaveBeenCalledTimes(1);
    expect(recordApiKeyRequest).toHaveBeenCalledTimes(1);
  });

  it("refuses a body over the route's absolute cap before any credential lookup", async () => {
    registerBodyBudgetCredentialResolver(verifyBodyBudgetCredential);
    const hono = new Hono();
    hono.use("/v1/*", v1BodyLimit({ maxMultipartUploadBytes: 25 * 1024 * 1024 }));
    hono.post("/v1/chat/completions", c => c.text("ok"));
    const response = await hono.request("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer dslp_priv_chat", "content-length": String(9 * 1024 * 1024) }, body: "{}",
    });
    expect(response.status).toBe(413);
    expect(validateApiKey).not.toHaveBeenCalled();
  });
});

describe("route auth end to end: one lookup, one usage record (none for OAuth tokens)", () => {
  const key = (overrides: Record<string, unknown> = {}) => ({
    keyId: "k", userId: "u", orgId: "org-k", keyType: "server", allowedDomains: [], scopes: ["chat", "search:deep"], rateLimits: [], projectIds: [], ...overrides,
  });
  /** The production order: the request context, the route's body limit, then the route's own auth. */
  function routeApp(path: string, auth: Parameters<Hono["use"]>[1], limit: "v1" | "mcp" | "none" | "after-auth" = "v1") {
    registerBodyBudgetCredentialResolver(verifyBodyBudgetCredential);
    const hono = new Hono();
    hono.use("*", requestContextMiddleware);
    const limiter = limit === "mcp" ? nativeBodyLimit(1024 * 1024) : v1BodyLimit({ maxMultipartUploadBytes: 25 * 1024 * 1024 });
    if (limit !== "none" && limit !== "after-auth") hono.use(path, limiter);
    hono.use(path, auth);
    if (limit === "after-auth") hono.use(path, limiter);
    hono.post(path, c => c.text("ok"));
    return (headers: Record<string, string>) => hono.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
  }

  it("mcpAuth: an MCP token (no usage record) and a server key (one record), one lookup each", async () => {
    const send = routeApp("/v1/mcp", mcpAuth, "mcp");
    validateMcpToken.mockResolvedValue(key());
    expect((await send({ Authorization: "Bearer dsmcp_token" })).status).toBe(200);
    expect(validateMcpToken).toHaveBeenCalledTimes(1);
    expect(recordApiKeyRequest).not.toHaveBeenCalled();
    validateApiKey.mockResolvedValue(key());
    expect((await send({ Authorization: "Bearer dslp_priv_server" })).status).toBe(200);
    expect(validateApiKey).toHaveBeenCalledTimes(1);
    expect(recordApiKeyRequest).toHaveBeenCalledTimes(1);
  });

  it("compatibleChatAuth: a CLI token (no usage record) and an API key (one record), one lookup each", async () => {
    const send = routeApp("/v1/chat/completions", compatibleChatAuth);
    validateOAuthApiToken.mockResolvedValue(key() as never);
    expect((await send({ Authorization: "Bearer dscli_token" })).status).toBe(200);
    expect(validateOAuthApiToken).toHaveBeenCalledTimes(1);
    expect(recordApiKeyRequest).not.toHaveBeenCalled();
    validateApiKey.mockResolvedValue(key());
    expect((await send({ Authorization: "Bearer dslp_priv_chat" })).status).toBe(200);
    expect(validateApiKey).toHaveBeenCalledTimes(1);
    expect(recordApiKeyRequest).toHaveBeenCalledTimes(1);
  });

  it("the Algolia shim: X-Algolia-API-Key, one lookup and one record, refused without a search scope", async () => {
    registerBodyBudgetCredentialResolver(verifyBodyBudgetCredential);
    const hono = new Hono();
    hono.use("*", requestContextMiddleware);
    hono.use("/compat/algolia/*", nativeBodyLimit(256 * 1024));
    hono.route("/compat/algolia", algoliaCompatRoutes);
    validateApiKey.mockResolvedValue(key({ scopes: ["chat"] }));
    const response = await hono.request("/compat/algolia/1/indexes/w/query", { method: "POST", headers: { "content-type": "application/json", "X-Algolia-API-Key": "dslp_priv_chat" }, body: JSON.stringify({ query: "a" }) });
    expect(response.status).toBe(403);
    expect(validateApiKey).toHaveBeenCalledTimes(1);
    expect(recordApiKeyRequest).toHaveBeenCalledTimes(1);
  });

  it("memoizes when the limiter is absent or runs after auth: still one lookup and one record", async () => {
    validateApiKey.mockResolvedValue(key());
    for (const limit of ["none", "after-auth"] as const) {
      validateApiKey.mockClear(); recordApiKeyRequest.mockClear();
      expect((await routeApp("/v1/chat/completions", compatibleChatAuth, limit)({ Authorization: "Bearer dslp_priv_chat" })).status).toBe(200);
      expect({ limit, lookups: validateApiKey.mock.calls.length, records: recordApiKeyRequest.mock.calls.length }).toEqual({ limit, lookups: 1, records: 1 });
    }
  });

  it("fails closed with a retryable 503 when verification is unavailable, and the budget falls back to public", async () => {
    validateApiKey.mockRejectedValue(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }));
    const before = bodyBudgetFallbackCounts().unavailable;
    const chat = await routeApp("/v1/chat/completions", compatibleChatAuth)({ Authorization: "Bearer dslp_priv_chat" });
    expect(chat.status).toBe(503);
    expect(chat.headers.get("Retry-After")).toBeTruthy();
    expect(await chat.json()).toMatchObject({ error: { code: "service_unavailable" } });
    expect(bodyBudgetFallbackCounts().unavailable).toBe(before + 1);
    const mcp = await routeApp("/v1/mcp", mcpAuth, "mcp")({ Authorization: "Bearer dslp_priv_server" });
    expect(mcp.status).toBe(503);
    expect(recordApiKeyRequest).not.toHaveBeenCalled();
  });
});

describe("pre-check concurrency", () => {
  it("allows 64 lookups at once, holds each slot until its lookup settles, and counts busy fallbacks", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let release!: () => void;
      const stalled = new Promise<null>((resolve) => { release = () => resolve(null); });
      validateApiKey.mockReturnValue(stalled);
      const context = (i: number) => {
        const request = new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer dslp_priv_${i}` } });
        return { req: { url: request.url, path: "/v1/chat/completions", method: "POST", header: (name: string) => request.headers.get(name) ?? undefined }, env: {} } as never;
      };
      const waiting = Array.from({ length: PREVERIFY_MAX_CONCURRENT }, (_, i) => verifyBodyBudgetCredential(context(i)));
      // Each lookup takes its slot a microtask later (a synchronous throw in resolve cannot leak one).
      await vi.advanceTimersByTimeAsync(0);
      expect(bodyBudgetPreverifyInFlight()).toBe(PREVERIFY_MAX_CONCURRENT);
      const busyBefore = bodyBudgetFallbackCounts().busy;
      expect(await verifyBodyBudgetCredential(context(99))).toBeNull();
      expect(bodyBudgetFallbackCounts().busy).toBe(busyBefore + 1);
      // The callers stop waiting after the bound, but the slots stay held while the lookups run.
      await vi.advanceTimersByTimeAsync(PREVERIFY_TIMEOUT_MS);
      for (const outcome of await Promise.all(waiting)) expect(outcome).toBeNull();
      expect(bodyBudgetPreverifyInFlight()).toBe(PREVERIFY_MAX_CONCURRENT);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(bodyBudgetPreverifyInFlight()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("budget selection matches the router exactly", () => {
  it("selects a route only where the router itself would serve that method and path", async () => {
    const probe = new Hono();
    const served: Array<{ method: string; path: string }> = [];
    for (const route of algoliaCompatRoutes.routes) {
      if (route.method === "ALL") continue;
      served.push({ method: route.method, path: `/compat/algolia${route.path}` });
      probe.on(route.method, `/compat/algolia${route.path}`, c => c.text("matched"));
    }
    probe.post("/v1/chat/completions", c => c.text("matched"));
    probe.post("/v1/mcp", c => c.text("matched"));
    const routerServes = async (method: string, path: string) => (await probe.request(path, { method })).status === 200
      && (await probe.request(path, { method })).headers.get("content-type")?.startsWith("text/plain");
    const paths = [
      "/v1/chat/completions", "/v1/mcp",
      ...served.map((route) => route.path.replace(":indexName", "docs").replace(":facetName", "brand").replace("*", "docs")),
      "/compat/algolia/1/indexes/*/queries", "/compat/algolia/1/indexes/a/b/queries",
    ];
    for (const base of paths) {
      for (const path of [base, `${base}/`]) {
        for (const method of ["POST", "PUT", "PATCH", "GET", "HEAD"]) {
          // Whatever the budget selects, the router serves with that method, exactly.
          if (preverifiedRoute(method, path)) expect({ method, path, served: await routerServes(method, path) }).toEqual({ method, path, served: true });
        }
        expect({ path, trailing: path.endsWith("/") && Boolean(preverifiedRoute("POST", path) ?? preverifiedRoute("PUT", path)) }).toEqual({ path, trailing: false });
      }
    }
    // And every authenticated Algolia POST or PUT the router serves is budgeted.
    for (const route of served.filter((entry) => entry.method === "POST" || entry.method === "PUT")) {
      const path = route.path.replace(":indexName", "docs").replace(":facetName", "brand").replace("*", "docs");
      expect({ route: `${route.method} ${route.path}`, budgeted: Boolean(preverifiedRoute(route.method, path)) }).toEqual({ route: `${route.method} ${route.path}`, budgeted: true });
    }
  });
});

describe("one admission limit for route auth and the pre-check", () => {
  it("answers route auth 503 with Retry-After, running no lookup, while the limit is full", async () => {
    let release!: () => void;
    validateApiKey.mockReturnValue(new Promise((resolve) => { release = () => resolve(null); }));
    const hono = new Hono();
    hono.use("*", requestContextMiddleware);
    hono.use("/v1/chat/completions", compatibleChatAuth);
    hono.post("/v1/chat/completions", c => c.text("ok"));
    const send = (i: number) => hono.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer dslp_priv_${i}` }, body: "{}" });
    const holding = Array.from({ length: PREVERIFY_MAX_CONCURRENT }, (_, i) => send(i));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lookups = validateApiKey.mock.calls.length;
    const refused = await send(999);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("Retry-After")).toBeTruthy();
    expect(validateApiKey.mock.calls.length).toBe(lookups);
    release();
    await Promise.all(holding);
  });
});


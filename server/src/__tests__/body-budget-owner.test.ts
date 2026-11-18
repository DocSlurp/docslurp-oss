import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { validateMcpToken, validateApiKey, recordApiKeyRequest } = vi.hoisted(() => ({ validateMcpToken: vi.fn(), validateApiKey: vi.fn(), recordApiKeyRequest: vi.fn() }));
vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(), { json: (value: unknown) => value, array: (value: unknown) => value }) }));
// The real request-actor and route-credentials code; only the key stores are faked.
vi.mock("../services/mcp-oauth.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../services/mcp-oauth.js")>(), validateMcpToken, validateOAuthApiToken: vi.fn(async () => null) }));
vi.mock("../services/api-keys.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../services/api-keys.js")>(), validateApiKey }));
vi.mock("../services/api-key-usage.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../services/api-key-usage.js")>(), recordApiKeyRequest }));

const { nativeBodyLimit } = await import("../lib/api-error.js");
const { v1BodyLimit } = await import("../lib/v1-body-limit.js");
const { bodyReadSettings, bufferedBodyBytes, configureBodyReads } = await import("../lib/bounded-body-limit.js");
const { registerBodyBudgetCredentialResolver } = await import("../lib/body-budget-owner.js");
const { PREVERIFY_TIMEOUT_MS, verifyBodyBudgetCredential } = await import("../lib/body-budget-credentials.js");
const { apiKeyAuth } = await import("../middleware/api-key-auth.js");
const { mcpResource } = await import("../services/mcp-oauth.js");

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
    keyId: "k", userId: "u", orgId: "org-k", keyType: "server", allowedDomains: [], scopes: ["search", "chat"], rateLimits: [], projectIds: [], ...overrides,
  });

  it("charges public a search-only browser key on chat, a browser key on MCP and an MCP token on chat", async () => {
    validateApiKey.mockResolvedValue(key({ keyType: "client", scopes: ["search"] }));
    expect(await verifyBodyBudgetCredential(context("POST", "/v1/chat/completions", { Authorization: "Bearer dslp_pub_search" }))).toBeNull();
    validateApiKey.mockResolvedValue(key({ keyType: "client", scopes: ["search", "chat"] }));
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
    expect(validateMcpToken).toHaveBeenCalledWith("dsmcp_token", mcpResource("http://localhost/v1/mcp"), expect.anything());
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
    for (const call of validateApiKey.mock.calls) expect(call[2]).toEqual({ recordUsage: false });
    expect(recordApiKeyRequest).not.toHaveBeenCalled();
  });

  it("gives up after its wait bound (public), without failing the request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      validateApiKey.mockReturnValue(new Promise(() => {}));
      const pending = verifyBodyBudgetCredential(context("POST", "/v1/chat/completions", { Authorization: "Bearer slow" }));
      await vi.advanceTimersByTimeAsync(PREVERIFY_TIMEOUT_MS);
      expect(await pending).toBeNull();
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

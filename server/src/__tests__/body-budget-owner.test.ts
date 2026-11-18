import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { validateMcpToken, resolveApiKeyActor } = vi.hoisted(() => ({ validateMcpToken: vi.fn(), resolveApiKeyActor: vi.fn() }));
vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(), { json: (value: unknown) => value, array: (value: unknown) => value }) }));
vi.mock("../services/mcp-oauth.js", () => ({ validateMcpToken, mcpResource: (url: string) => `${new URL(url).origin}/v1/mcp` }));
vi.mock("../lib/request-actor.js", () => ({ resolveApiKeyActor }));

const { nativeBodyLimit } = await import("../lib/api-error.js");
const { v1BodyLimit } = await import("../lib/v1-body-limit.js");
const { bodyReadSettings, bufferedBodyBytes, configureBodyReads } = await import("../lib/bounded-body-limit.js");
const { registerBodyBudgetCredentialResolver } = await import("../lib/body-budget-owner.js");
const { verifyBodyBudgetCredential } = await import("../lib/body-budget-credentials.js");

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

  it("never pre-verifies a credential on routes that must not look keys up", async () => {
    const resolver = vi.fn(async () => ({ orgId: "org-a", keyId: "k-a" }));
    registerBodyBudgetCredentialResolver(resolver);
    const hono = new Hono();
    hono.use("/v1/*", v1BodyLimit({ maxMultipartUploadBytes: 25 * 1024 * 1024 }));
    hono.post("/v1/auth/sensitive-sso/start", c => c.text("ok"));
    await hono.request("/v1/auth/sensitive-sso/start", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer good" }, body: "{}" });
    expect(resolver).not.toHaveBeenCalled();
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

describe("the production credential check", () => {
  const context = (headers: Record<string, string>, url = "http://localhost/v1/mcp") => {
    const request = new Request(url, { headers });
    return { req: { url: request.url, header: (name: string) => request.headers.get(name) ?? undefined }, env: {} } as never;
  };

  it("verifies MCP tokens against the MCP resource and other bearers as API keys", async () => {
    validateMcpToken.mockResolvedValue({ orgId: "org-m", keyId: "k-m" });
    expect(await verifyBodyBudgetCredential(context({ Authorization: "Bearer dsmcp_x" }))).toEqual({ orgId: "org-m", keyId: "k-m" });
    expect(validateMcpToken).toHaveBeenCalledWith("dsmcp_x", "http://localhost/v1/mcp", expect.anything());
    resolveApiKeyActor.mockResolvedValue({ apiKey: { orgId: "org-k", keyId: "k-k" } });
    expect(await verifyBodyBudgetCredential(context({ "X-Algolia-API-Key": "dslp_priv_abc" }, "http://localhost/compat/algolia/1/indexes/x/query"))).toEqual({ orgId: "org-k", keyId: "k-k" });
    expect(resolveApiKeyActor).toHaveBeenCalledWith("Bearer dslp_priv_abc", expect.anything());
  });

  it("treats a missing, unknown or policy-refused credential as unverified", async () => {
    expect(await verifyBodyBudgetCredential(context({}))).toBeNull();
    resolveApiKeyActor.mockResolvedValue(null);
    expect(await verifyBodyBudgetCredential(context({ Authorization: "Bearer unknown" }))).toBeNull();
    resolveApiKeyActor.mockRejectedValue(new Error("api_key_ip_not_allowed"));
    expect(await verifyBodyBudgetCredential(context({ Authorization: "Bearer refused" }))).toBeNull();
  });
});

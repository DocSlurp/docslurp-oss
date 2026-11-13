import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock: any = Object.assign(vi.fn(), { json: (value: unknown) => value, begin: vi.fn(async (run: (tx: unknown) => unknown) => run(sqlMock)) });
vi.mock("../db.js", () => ({ sql: sqlMock }));
const appendAuditLog = vi.fn(async () => ({}));
vi.mock("../services/audit-log.js", () => ({ appendAuditLog }));
// Platform admin: a session with isAdmin, or an API key owned by the configured admin user ("admin").
vi.mock("../lib/request-actor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/request-actor.js")>()),
  isPlatformAdminActor: vi.fn(async (actor: { type: string; userId: string; user?: { isAdmin?: boolean } }) =>
    actor.type === "session" ? actor.user?.isAdmin === true : actor.userId === "admin"),
}));

const { setRequestActor } = await import("../lib/request-actor.js");
const { adminProjectsRoutes } = await import("../routes/admin-projects.js");
const { customerChatResponse, parseStoredChatTierModels } = await import("../services/managed-models.js");
const { projectChatInputSchema, projectChatRequestSchema } = await import("../lib/search-input.js");
const { mcpTools } = await import("../services/mcp-catalog.js");
const { buildOpenApiDocument } = await import("../lib/openapi.js");

const BACKEND_ID = /llm:\/\/|openrouter|z-ai\/|deepseek\/|openai\/|anthropic\//i;

function app(actor: unknown) {
  return new Hono()
    .use("*", async (c, next) => { setRequestActor(c, actor as never); await next(); })
    .route("/v1/admin/projects", adminProjectsRoutes);
}

const put = (actor: unknown, body: unknown) => app(actor).request("/v1/admin/projects/p1/managed-models", {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

const adminSession = { type: "session", userId: "admin", sessionId: "s", user: { id: "admin", email: "a@example.com", name: "", isAdmin: true } };
const memberSession = { type: "session", userId: "owner", sessionId: "s", user: { id: "owner", email: "o@example.com", name: "" } };
const serverKey = (overrides: Record<string, unknown> = {}, userId = "admin") => ({
  type: "apiKey", userId,
  apiKey: { keyId: "k1", keyType: "server", orgId: "o1", scopes: ["projects:manage", "chat"], projectIds: null, ...overrides },
});
const projectRow = (extra: Record<string, unknown> = {}) => [{ org_id: "o1", chat: {}, overrides: null, pipeline: {}, ...extra }];

describe("platform-admin managed model route", () => {
  beforeEach(() => { sqlMock.mockReset(); sqlMock.begin.mockClear(); appendAuditLog.mockClear(); });

  it("lets a platform-admin session map a tier to a reviewed model, with an audit row", async () => {
    sqlMock.mockResolvedValueOnce(projectRow()).mockResolvedValue([]);
    const response = await put(adminSession, { chat: { smart: "anthropic/claude-haiku-5.5" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ managedModels: { chat: { smart: "anthropic/claude-haiku-5.5" }, pipeline: null } });
    expect(appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "project.managed_models.updated", projectId: "p1",
      metadata: { before: { chat: {}, pipeline: null }, after: { chat: { smart: "anthropic/claude-haiku-5.5" }, pipeline: null } },
    }), expect.anything());
  });

  it("lets a platform admin's server key with admin:models set and read models, for scripted setups", async () => {
    sqlMock.mockResolvedValueOnce(projectRow()).mockResolvedValue([]);
    expect((await put(serverKey({ scopes: ["admin:models"] }), { chat: { smart: "anthropic/claude-haiku-5.5" } })).status).toBe(200);
    expect(appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ apiKeyId: "k1" }), expect.anything());
    sqlMock.mockReset();
    sqlMock.mockResolvedValueOnce([{ chat: { smart: "anthropic/claude-haiku-5.5" }, pipeline: null }]);
    const read = await app(serverKey({ scopes: ["admin:models"] })).request("/v1/admin/projects/p1/managed-models");
    expect(await read.json()).toEqual({ managedModels: { chat: { smart: "anthropic/claude-haiku-5.5" }, pipeline: null } });
  });

  it("refuses owners, keys without admin:models (even an admin's), a non-admin's admin:models key, OAuth and client keys", async () => {
    for (const actor of [memberSession, serverKey(), serverKey({ scopes: ["admin:models"], oauth: true }), serverKey({ scopes: ["admin:models"] }, "owner"), serverKey({ scopes: ["admin:models"], keyType: "client" })]) {
      expect((await put(actor, { chat: { smart: "anthropic/claude-haiku-5.5" } })).status).toBe(403);
      expect((await app(actor).request("/v1/admin/projects/p1/managed-models")).status).toBe(403);
    }
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("refuses unreviewed, prohibited, Nitro, llm:// and denied chat models before writing", async () => {
    for (const model of ["acme/unlisted-1", "openai/gpt-6-sol-pro", "z-ai/glm-5.3-flash:nitro", "llm://openrouter/anthropic/claude-haiku-5.5", "deepseek/deepseek-v4.1-flash-1017"]) {
      const response = await put(adminSession, { chat: { fastest: model } });
      expect(response.status, model).toBe(400);
    }
    expect((await put(adminSession, { chat: { premium: "anthropic/claude-haiku-5.5" } })).status).toBe(400);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("stores pipeline overrides in managed_models and rewrites the stored pipeline", async () => {
    sqlMock.mockResolvedValueOnce(projectRow()).mockResolvedValue([]);
    const ok = await put(adminSession, { pipeline: { vision: { modelUri: "llm://openrouter/google/gemini-2.5-flash-lite" }, textGeneration: { model: "qwen/qwen3.5-flash-02-23" } } });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const update = sqlMock.mock.calls.find((call: unknown[]) => String((call[0] as string[]).join("?")).includes("update projects set managed_models"));
    expect(update?.[1]).toEqual({ chat: {}, pipeline: { vision: { modelUri: "llm://openrouter/google/gemini-2.5-flash-lite" }, textGeneration: { model: "qwen/qwen3.5-flash-02-23" } } });
    expect((update?.[2] as { vision: { modelUri: string } }).vision.modelUri).toBe("llm://openrouter/google/gemini-2.5-flash-lite");
  });

  it("refuses denied, Pro/Ultra (with a ? suffix), unpriced and uncatalogued pipeline models, and embedding changes once documents exist", async () => {
    for (const pipeline of [
      { vision: { modelUri: "llm://openrouter/deepseek/deepseek-v4.1-flash-1017" } },
      { textGeneration: { model: "openai/gpt-6-sol-pro?reasoning=high" } },
      { textGeneration: { model: "acme/unpriced" } },
      { vision: { modelUri: "llm://openrouter/acme/unlisted" } },
      { pageRouter: { decisionModel: ["deepseek/deepseek-v4.1-flash-1017"] } },
    ]) {
      expect((await put(adminSession, { pipeline })).status, JSON.stringify(pipeline)).toBe(400);
    }
    expect(sqlMock).not.toHaveBeenCalled();
    sqlMock.mockResolvedValueOnce(projectRow()).mockResolvedValueOnce([{ count: 3 }]);
    const embedding = await put(adminSession, { pipeline: { embedding: { modelUri: "llm://openrouter/perplexity/pplx-embed-v1-0.6b" } } });
    expect(embedding.status).toBe(400);
    expect((await embedding.json()).error.message).toContain("re-index");
  });

  it("refuses an override that conflicts with the project's privacy mode", async () => {
    sqlMock.mockResolvedValueOnce(projectRow({ pipeline: { privacyMode: "local-only", vision: { profile: "cheapest-local" }, embedding: { profile: "cheapest-local" } } }));
    const response = await put(adminSession, { pipeline: { vision: { remoteFallbackModelUri: "llm://openrouter/google/gemini-2.5-flash-lite" } } });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("conflict");
  });

  it("answers 404 for a missing project", async () => {
    sqlMock.mockResolvedValueOnce([]);
    expect((await put(adminSession, { chat: { smart: null } })).status).toBe(404);
  });
});

describe("stored tier mappings", () => {
  it("drops entries that no longer pass review", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseStoredChatTierModels({ fastest: "anthropic/claude-haiku-5.5", smart: "openai/gpt-6-sol-pro", balanced: "deepseek/deepseek-v4.1-flash-1017", other: "x/y" }))
      .toEqual({ fastest: "anthropic/claude-haiku-5.5" });
    expect(parseStoredChatTierModels("nope")).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("customer chat responses", () => {
  it("name the tier that answered and drop backend model and provider ids", () => {
    const response = customerChatResponse({
      answer: "x",
      debug: {
        citations: 0, fallback: false, historyTurns: 0, mode: "retrieval" as const, wholeCorpus: {} as never,
        model: "openai/gpt-6-luna:nitro", requestedModel: "smart",
        resolvedModel: "openai/gpt-6-luna-20261101", resolvedProvider: "OpenAI",
        stepUsage: [{ step: 0, model: "openai/gpt-6.1-sol", finishReason: "stop", inputTokens: 1, outputTokens: 1, toolCalls: [] }],
      },
    } as never, "smart") as { debug: Record<string, unknown> };
    // A failover answer on Luna's fast route reads as Luna's tier; the turn's own step reads as smart.
    expect(response.debug.model).toBe("balanced");
    expect(response.debug.requestedModel).toBe("smart");
    expect((response.debug.stepUsage as Array<{ model: string }>)[0]!.model).toBe("smart");
    expect(response.debug).not.toHaveProperty("resolvedModel");
    expect(response.debug).not.toHaveProperty("resolvedProvider");
    expect(JSON.stringify(response)).not.toMatch(BACKEND_ID);
  });

  it("report a failover model that is no tier's (GLM 5.3 Flash) as the turn's tier", () => {
    const response = customerChatResponse({ debug: { model: "z-ai/glm-5.3-flash", citations: 0 } } as never, "fastest") as { debug: { model: unknown } };
    expect(response.debug.model).toBe("fastest");
  });

  it("report an unknown model as the turn's tier", () => {
    const response = customerChatResponse({ debug: { model: "acme/other", citations: 0 } } as never, "smart") as { debug: { model: unknown } };
    expect(response.debug.model).toBe("smart");
  });
});

describe("public chat contracts", () => {
  it("offer tier and reasoning, never a backend model field", () => {
    expect(projectChatInputSchema.shape).not.toHaveProperty("model");
    expect(projectChatInputSchema.safeParse({ q: "hi", model: "anthropic/claude-haiku-5.5" }).success).toBe(false);
    expect(projectChatInputSchema.safeParse({ q: "hi", tier: "smart", reasoning: "high" }).success).toBe(true);
    expect(projectChatInputSchema.safeParse({ q: "hi", tier: "openai/gpt-6.1-sol" }).success).toBe(false);
    // The routes still parse `model` so the policy can refuse it with a message naming the tiers.
    expect(projectChatRequestSchema.safeParse({ q: "hi", model: "anthropic/claude-haiku-5.5" }).success).toBe(true);
  });

  it("MCP chat tool schema has tier and no model", () => {
    const chat = mcpTools("https://api.example.test").find(tool => tool.id === "chat")!;
    const properties = (chat.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(properties).toHaveProperty("tier");
    expect(properties).not.toHaveProperty("model");
    expect(JSON.stringify(chat)).not.toMatch(BACKEND_ID);
  });

  it("OpenAPI chat requests carry no backend model ids or model fields", () => {
    const document = buildOpenApiDocument("https://api.example.test") as { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any> } };
    const chatBody = JSON.stringify(document.paths["/v1/chat"].post.requestBody);
    expect(chatBody).not.toMatch(BACKEND_ID);
    expect(chatBody).toContain("tier");
    expect(chatBody).not.toContain("\"model\"");
    const completions = JSON.stringify(document.components.schemas.ChatCompletionRequest ?? document.paths["/v1/chat/completions"].post.requestBody);
    expect(completions).not.toMatch(BACKEND_ID);
  });
});

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock: any = Object.assign(vi.fn(), { json: (value: unknown) => value, begin: vi.fn(async (run: (tx: unknown) => unknown) => run(sqlMock)) });
vi.mock("../db.js", () => ({ sql: sqlMock }));

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
const serverKey = (overrides: Record<string, unknown> = {}) => ({
  type: "apiKey", userId: "admin",
  apiKey: { keyId: "k1", keyType: "server", orgId: "o1", scopes: ["projects:manage", "chat"], projectIds: null, ...overrides },
});

describe("platform-admin managed model route", () => {
  beforeEach(() => { sqlMock.mockReset(); sqlMock.begin.mockClear(); });

  it("lets a platform-admin session map a tier to a reviewed model", async () => {
    sqlMock.mockResolvedValueOnce([{ chat: {} }]).mockResolvedValueOnce([]);
    const response = await put(adminSession, { chat: { smart: "anthropic/claude-haiku-5.5" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ managedModels: { chat: { smart: "anthropic/claude-haiku-5.5" } } });
  });

  it("refuses project owners, server keys (even an admin's, with projects:manage) and revoked or OAuth keys", async () => {
    for (const actor of [memberSession, serverKey(), serverKey({ oauth: true }), serverKey({ scopes: [] }), serverKey({ keyType: "client" })]) {
      const response = await put(actor, { chat: { smart: "anthropic/claude-haiku-5.5" } });
      expect(response.status).toBe(403);
    }
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("refuses unreviewed, prohibited, Nitro and llm:// models before writing", async () => {
    for (const model of ["acme/unlisted-1", "openai/gpt-6-sol-pro", "z-ai/glm-5.3-flash:nitro", "llm://openrouter/anthropic/claude-haiku-5.5", "deepseek/deepseek-v4.1-flash-1017"]) {
      const response = await put(adminSession, { chat: { fastest: model } });
      expect(response.status, model).toBe(400);
    }
    const unknownTier = await put(adminSession, { chat: { premium: "anthropic/claude-haiku-5.5" } });
    expect(unknownTier.status).toBe(400);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("lets a platform admin set a private or catalog vision model, validated by the pipeline schema", async () => {
    sqlMock.mockResolvedValueOnce([{ chat: {}, pipeline: {} }]).mockResolvedValue([]);
    const ok = await put(adminSession, { pipeline: { vision: { modelUri: "llm://openrouter/google/gemini-2.5-flash-lite" }, textGeneration: { model: "qwen/qwen3.5-flash-02-23" } } });
    expect(ok.status, await ok.clone().text()).toBe(200);
    sqlMock.mockReset();
    sqlMock.mockResolvedValueOnce([{ chat: {}, pipeline: {} }]);
    const bad = await put(adminSession, { pipeline: { vision: { modelUri: "not a uri" } } });
    expect(bad.status).toBe(400);
  });

  it("refuses prohibited pipeline models and embedding changes once documents exist", async () => {
    expect((await put(adminSession, { pipeline: { textGeneration: { model: "openai/gpt-6-sol-pro" } } })).status).toBe(400);
    expect(sqlMock).not.toHaveBeenCalled();
    sqlMock.mockResolvedValueOnce([{ chat: {}, pipeline: {} }]).mockResolvedValueOnce([{ count: 3 }]);
    const embedding = await put(adminSession, { pipeline: { embedding: { modelUri: "llm://openrouter/perplexity/pplx-embed-v1-0.6b" } } });
    expect(embedding.status).toBe(400);
    expect((await embedding.json()).error.message).toContain("re-index");
  });

  it("never lets an API key or owner set pipeline models", async () => {
    for (const actor of [memberSession, serverKey()]) {
      expect((await put(actor, { pipeline: { vision: { modelUri: "llm://openrouter/google/gemini-2.5-flash-lite" } } })).status).toBe(403);
    }
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
        model: "z-ai/glm-5.3-flash:nitro", requestedModel: "smart",
        resolvedModel: "z-ai/glm-5.3-flash-20261101", resolvedProvider: "Fireworks",
        stepUsage: [{ step: 0, model: "openai/gpt-6.1-sol", finishReason: "stop", inputTokens: 1, outputTokens: 1, toolCalls: [] }],
      },
    } as never, "smart") as { debug: Record<string, unknown> };
    // A fast-route GLM answer reads as GLM's tier; the turn's own step reads as smart.
    expect(response.debug.model).toBe("fastest");
    expect(response.debug.requestedModel).toBe("smart");
    expect((response.debug.stepUsage as Array<{ model: string }>)[0]!.model).toBe("smart");
    expect(response.debug).not.toHaveProperty("resolvedModel");
    expect(response.debug).not.toHaveProperty("resolvedProvider");
    expect(JSON.stringify(response)).not.toMatch(BACKEND_ID);
  });

  it("report the turn's tier when tiers share a model", () => {
    const response = customerChatResponse({ debug: { model: "z-ai/glm-5.3-flash", citations: 0 } } as never, "balanced") as { debug: { model: unknown } };
    expect(response.debug.model).toBe("balanced");
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

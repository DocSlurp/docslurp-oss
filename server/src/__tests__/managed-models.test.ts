import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = Object.assign(vi.fn(), { json: (value: unknown) => value });
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
  beforeEach(() => { sqlMock.mockReset(); });

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
    for (const model of ["acme/unlisted-1", "openai/gpt-6-sol-pro", "z-ai/glm-5.3-flash:nitro", "llm://openrouter/anthropic/claude-haiku-5.5"]) {
      const response = await put(adminSession, { chat: { fastest: model } });
      expect(response.status, model).toBe(400);
    }
    const unknownTier = await put(adminSession, { chat: { premium: "anthropic/claude-haiku-5.5" } });
    expect(unknownTier.status).toBe(400);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a missing project", async () => {
    sqlMock.mockResolvedValueOnce([]);
    expect((await put(adminSession, { chat: { smart: null } })).status).toBe(404);
  });
});

describe("stored tier mappings", () => {
  it("drops entries that no longer pass review", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseStoredChatTierModels({ fastest: "anthropic/claude-haiku-5.5", smart: "openai/gpt-6-sol-pro", other: "x/y" }))
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
        model: "deepseek/deepseek-v4.1-flash-1017:nitro", requestedModel: "fastest",
        resolvedModel: "deepseek/deepseek-v4.1-flash-1017-20261017", resolvedProvider: "Fireworks",
        stepUsage: [{ step: 0, model: "z-ai/glm-5.3-flash", finishReason: "stop", inputTokens: 1, outputTokens: 1, toolCalls: [] }],
      },
    } as never, "fastest") as { debug: Record<string, unknown> };
    expect(response.debug.model).toBe("balanced");
    expect(response.debug.requestedModel).toBe("fastest");
    expect(response.debug).not.toHaveProperty("resolvedModel");
    expect(response.debug).not.toHaveProperty("resolvedProvider");
    expect(JSON.stringify(response)).not.toMatch(BACKEND_ID);
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

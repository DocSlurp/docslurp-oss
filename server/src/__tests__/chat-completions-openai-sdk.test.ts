import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import OpenAI from "openai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The OpenAI-compatible chat surface driven by the official `openai` SDK over
 * real HTTP. Authentication, request parsing, workspace model resolution, SSE
 * framing and error shapes are the production code; only the workspace answer
 * (the model call) and the workspace lookups are test doubles, so nothing here
 * calls or pays a model provider.
 */

const { chatWorkspace, workspaceChatDisabledBody, listWorkspaces, getWorkspace, resolveWorkspaceRef, findWorkspaceForInput, ensureDefaultWorkspace, validateApiKey } = vi.hoisted(() => ({
  chatWorkspace: vi.fn(),
  workspaceChatDisabledBody: vi.fn(async (): Promise<null> => null),
  listWorkspaces: vi.fn(),
  getWorkspace: vi.fn(),
  resolveWorkspaceRef: vi.fn(),
  findWorkspaceForInput: vi.fn(),
  ensureDefaultWorkspace: vi.fn(),
  validateApiKey: vi.fn(),
}));
vi.mock("../services/billing/spend-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/billing/spend-guard.js")>()),
  assertCanSpend: vi.fn(async () => undefined),
  canSpend: vi.fn(async () => true),
}));
vi.mock("../services/workspace-chat.js", () => ({ chatWorkspace, workspaceChatDisabledBody }));
vi.mock("../services/workspaces.js", () => ({ listWorkspaces, getWorkspace, resolveWorkspaceRef, findWorkspaceForInput, ensureDefaultWorkspace }));
vi.mock("../services/api-keys.js", () => ({ validateApiKey }));
vi.mock("../middleware/rate-limit.js", () => ({ enforceAuthenticatedApiRateLimit: vi.fn(async () => null) }));
vi.mock("../lib/auth.js", () => ({ auth: {}, appDbPool: {} }));

const API_KEY = "dslp_live_test_key";
const contracts = { id: "11111111-1111-4111-8111-111111111111", orgId: "org-1", name: "Contracts", slug: "contracts", createdAt: "2026-10-01T00:00:00Z" };
const manuals = { id: "22222222-2222-4222-8222-222222222222", orgId: "org-1", name: "Manuals", slug: "manuals", createdAt: "2026-10-02T00:00:00Z" };
const key = { userId: "user-1", orgId: "org-1", scopes: ["search", "chat"], keyType: "server", keyId: "key-1", workspaceIds: [] };
const answer = {
  answer: "Renewal is annual [1].",
  citations: [{ text: "annual", score: 1, citation: { filename: "contract.pdf", documentId: "doc-1", pageNumber: 2 } }],
  availability: null,
  usage: { inputTokens: 19, outputTokens: 7, totalTokens: 26 },
};

let server: ReturnType<typeof serve>;
let baseURL = "";
const client = (apiKey = API_KEY) => new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: 10_000 });

beforeAll(async () => {
  const { chatCompletionsRoutes } = await import("../routes/chat-completions.js");
  const app = new Hono().route("/v1", chatCompletionsRoutes);
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  if ("closeAllConnections" in server) server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  validateApiKey.mockImplementation(async (raw: string) => raw === API_KEY ? key : null);
  listWorkspaces.mockResolvedValue([contracts, manuals]);
  getWorkspace.mockImplementation(async (id: string) => [contracts, manuals].find((workspace) => workspace.id === id) ?? null);
  resolveWorkspaceRef.mockImplementation(async (ref: string) => [contracts, manuals].find((workspace) => workspace.slug === ref) ?? null);
  findWorkspaceForInput.mockImplementation(async (ref: { kind: string; id?: string; slug?: string }) =>
    [contracts, manuals].find((workspace) => ref.kind === "id" ? workspace.id === ref.id : workspace.slug === ref.slug) ?? null);
  ensureDefaultWorkspace.mockResolvedValue(contracts);
  chatWorkspace.mockResolvedValue(answer);
});

describe("OpenAI-compatible chat with the official openai SDK", () => {
  it("lists workspace models", async () => {
    const models = [];
    for await (const model of client().models.list()) models.push(model);
    expect(models.map((model) => model.id)).toEqual([`workspace:${contracts.id}`, `workspace:${manuals.id}`]);
    expect(models[0]).toMatchObject({ object: "model", owned_by: "docslurp", created: 1790812800 });
  });

  it("answers non-streaming requests for workspace:default with cited text and real usage", async () => {
    const completion = await client().chat.completions.create({
      model: "workspace:default",
      messages: [{ role: "system", content: "Be brief" }, { role: "user", content: "When does it renew?" }],
      max_completion_tokens: 200,
    });
    expect(completion.object).toBe("chat.completion");
    expect(completion.id).toMatch(/^chatcmpl-/);
    expect(completion.model).toBe("workspace:default");
    expect(completion.choices[0]).toMatchObject({ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Renewal is annual [1].\n\nSources:\n[1] contract.pdf, page 2" } });
    expect(completion.usage).toEqual({ prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 });
    expect(chatWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: contracts.id, query: "When does it renew?", history: [{ role: "system", content: "Be brief" }], maxOutputTokens: 200,
    }));
  });

  it("resolves workspace:<slug> models", async () => {
    await client().chat.completions.create({ model: "workspace:manuals", messages: [{ role: "user", content: "How do I reset it?" }] });
    expect(chatWorkspace).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: manuals.id }));
  });

  it("streams SSE chunks the SDK reassembles, ending with usage and [DONE]", async () => {
    chatWorkspace.mockImplementationOnce(async (args: { onTextDelta: (text: string) => Promise<void> }) => {
      await args.onTextDelta("Renewal is ");
      await args.onTextDelta("annual [1].");
      return answer;
    });
    const stream = await client().chat.completions.create({
      model: `workspace:${contracts.id}`,
      messages: [{ role: "user", content: "When does it renew?" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    // The SDK stops at [DONE]; every chunk shares one completion id.
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
    expect(chunks.every((chunk) => chunk.object === "chat.completion.chunk")).toBe(true);
    expect(chunks[0]!.choices[0]!.delta.role).toBe("assistant");
    const text = chunks.flatMap((chunk) => chunk.choices.map((choice) => choice.delta.content ?? "")).join("");
    expect(text).toBe("Renewal is annual [1].\n\nSources:\n[1] contract.pdf, page 2");
    expect(chunks.flatMap((chunk) => chunk.choices.map((choice) => choice.finish_reason)).filter(Boolean)).toEqual(["stop"]);
    expect(chunks.at(-1)).toMatchObject({ choices: [], usage: { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 } });

    // The SDK's stream helper also produces the final message.
    chatWorkspace.mockImplementationOnce(async (args: { onTextDelta: (text: string) => Promise<void> }) => { await args.onTextDelta("Renewal is annual [1]."); return answer; });
    const runner = client().chat.completions.stream({ model: "workspace:default", messages: [{ role: "user", content: "When does it renew?" }] });
    const final = await runner.finalChatCompletion();
    expect(final.choices[0]!.message.content).toContain("Renewal is annual [1].");
  });

  it("raises AuthenticationError with an OpenAI-shaped 401 body for a bad key", async () => {
    const error = await client("dslp_wrong").chat.completions.create({ model: "workspace:default", messages: [{ role: "user", content: "hi" }] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAI.AuthenticationError);
    expect(error).toMatchObject({ status: 401, type: "authentication_error", code: "invalid_api_key" });
    expect(chatWorkspace).not.toHaveBeenCalled();
    await expect(client("dslp_wrong").models.list()).rejects.toBeInstanceOf(OpenAI.AuthenticationError);
  });

  it("raises NotFoundError with model_not_found for an unknown workspace model", async () => {
    const error = await client().chat.completions.create({ model: "workspace:no-such-workspace", messages: [{ role: "user", content: "hi" }] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAI.NotFoundError);
    expect(error).toMatchObject({ status: 404, type: "invalid_request_error", code: "model_not_found", param: "model" });
    expect(chatWorkspace).not.toHaveBeenCalled();
  });

  it("raises BadRequestError for a model id outside the workspace namespace and for unsupported parameters", async () => {
    const wrongModel = await client().chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }).catch((caught: unknown) => caught);
    expect(wrongModel).toBeInstanceOf(OpenAI.BadRequestError);
    expect(wrongModel).toMatchObject({ status: 400, type: "invalid_request_error", param: "model" });
    const tools = await client().chat.completions.create({
      model: "workspace:default", messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    }).catch((caught: unknown) => caught);
    expect(tools).toBeInstanceOf(OpenAI.BadRequestError);
    expect(chatWorkspace).not.toHaveBeenCalled();
  });
});

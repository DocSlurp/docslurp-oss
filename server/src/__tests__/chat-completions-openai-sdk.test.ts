import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import OpenAI from "openai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The OpenAI-compatible chat surface driven by the official `openai` SDK over
 * real HTTP. Authentication, request parsing, project model resolution, SSE
 * framing and error shapes are the production code; only the project answer
 * (the model call) and the project lookups are test doubles, so nothing here
 * calls or pays a model provider.
 */

const { chatProject, projectChatDisabledBody, listProjects, getProject, resolveProjectRef, findProjectForInput, ensureDefaultProject, validateApiKey } = vi.hoisted(() => ({
  chatProject: vi.fn(),
  projectChatDisabledBody: vi.fn(async (): Promise<null> => null),
  listProjects: vi.fn(),
  getProject: vi.fn(),
  resolveProjectRef: vi.fn(),
  findProjectForInput: vi.fn(),
  ensureDefaultProject: vi.fn(),
  validateApiKey: vi.fn(),
}));
vi.mock("../services/billing/spend-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/billing/spend-guard.js")>()),
  assertCanSpend: vi.fn(async () => undefined),
  canSpend: vi.fn(async () => true),
}));
// Route access reads (lib/search-access.ts) answered from this file's getProject mock with the real scope rules.
vi.mock("../lib/search-access.js", async () => {
  const { authorizeFromProjectMock } = await import("./helpers/search-access.js");
  return { authorizeActorProjectSearch: authorizeFromProjectMock(async (id, userId) => (await import("../services/projects.js")).getProject(id, userId)) };
});
vi.mock("../services/project-chat.js", () => ({ chatProject, projectChatDisabledBody }));
vi.mock("../services/projects.js", () => ({ listProjects, getProject, resolveProjectRef, findProjectForInput, ensureDefaultProject }));
vi.mock("../services/api-keys.js", () => ({ validateApiKey }));
vi.mock("../middleware/rate-limit.js", () => ({ enforceAuthenticatedApiRateLimit: vi.fn(async () => null) }));
vi.mock("../lib/auth.js", () => ({ auth: {}, appDbPool: {} }));

const API_KEY = "dslp_live_test_key";
const contracts = { id: "11111111-1111-4111-8111-111111111111", orgId: "org-1", name: "Contracts", slug: "contracts", createdAt: "2026-10-01T00:00:00Z" };
const manuals = { id: "22222222-2222-4222-8222-222222222222", orgId: "org-1", name: "Manuals", slug: "manuals", createdAt: "2026-10-02T00:00:00Z" };
const key = { userId: "user-1", orgId: "org-1", scopes: ["search:deep", "chat"], keyType: "server", keyId: "key-1", projectIds: [] };
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
// Importing the route graph can take longer than the default hook timeout on a busy machine.
}, 60_000);

afterAll(async () => {
  if ("closeAllConnections" in server) server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  validateApiKey.mockImplementation(async (raw: string) => raw === API_KEY ? key : null);
  listProjects.mockResolvedValue([contracts, manuals]);
  getProject.mockImplementation(async (id: string) => [contracts, manuals].find((project) => project.id === id) ?? null);
  resolveProjectRef.mockImplementation(async (ref: string) => [contracts, manuals].find((project) => project.slug === ref) ?? null);
  findProjectForInput.mockImplementation(async (ref: { kind: string; id?: string; slug?: string }) =>
    [contracts, manuals].find((project) => ref.kind === "id" ? project.id === ref.id : project.slug === ref.slug) ?? null);
  ensureDefaultProject.mockResolvedValue(contracts);
  chatProject.mockResolvedValue(answer);
});

describe("OpenAI-compatible chat with the official openai SDK", () => {
  it("lists project models", async () => {
    const models = [];
    for await (const model of client().models.list()) models.push(model);
    expect(models.map((model) => model.id)).toEqual([`project:${contracts.id}`, `project:${manuals.id}`]);
    expect(models[0]).toMatchObject({ object: "model", owned_by: "docslurp", created: 1790812800 });
  });

  it("answers non-streaming requests for project:default with cited text and real usage", async () => {
    const completion = await client().chat.completions.create({
      model: "project:default",
      messages: [{ role: "system", content: "Be brief" }, { role: "user", content: "When does it renew?" }],
      max_completion_tokens: 200,
    });
    expect(completion.object).toBe("chat.completion");
    expect(completion.id).toMatch(/^chatcmpl-/);
    expect(completion.model).toBe("project:default");
    expect(completion.choices[0]).toMatchObject({ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Renewal is annual [1].\n\nSources:\n[1] contract.pdf, page 2" } });
    expect(completion.usage).toEqual({ prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 });
    expect(chatProject).toHaveBeenCalledWith(expect.objectContaining({
      projectId: contracts.id, query: "When does it renew?", history: [{ role: "system", content: "Be brief" }], maxOutputTokens: 200,
    }));
  });

  it("resolves project:<slug> models", async () => {
    await client().chat.completions.create({ model: "project:manuals", messages: [{ role: "user", content: "How do I reset it?" }] });
    expect(chatProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: manuals.id }));
  });

  it("streams SSE chunks the SDK reassembles, ending with usage and [DONE]", async () => {
    chatProject.mockImplementationOnce(async (args: { onTextDelta: (text: string) => Promise<void> }) => {
      await args.onTextDelta("Renewal is ");
      await args.onTextDelta("annual [1].");
      return answer;
    });
    const stream = await client().chat.completions.create({
      model: `project:${contracts.id}`,
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
    chatProject.mockImplementationOnce(async (args: { onTextDelta: (text: string) => Promise<void> }) => { await args.onTextDelta("Renewal is annual [1]."); return answer; });
    const runner = client().chat.completions.stream({ model: "project:default", messages: [{ role: "user", content: "When does it renew?" }] });
    const final = await runner.finalChatCompletion();
    expect(final.choices[0]!.message.content).toContain("Renewal is annual [1].");
  });

  it("raises AuthenticationError with an OpenAI-shaped 401 body for a bad key", async () => {
    const error = await client("dslp_wrong").chat.completions.create({ model: "project:default", messages: [{ role: "user", content: "hi" }] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAI.AuthenticationError);
    expect(error).toMatchObject({ status: 401, type: "authentication_error", code: "invalid_api_key" });
    expect(chatProject).not.toHaveBeenCalled();
    await expect(client("dslp_wrong").models.list()).rejects.toBeInstanceOf(OpenAI.AuthenticationError);
  });

  it("raises NotFoundError with model_not_found for an unknown project model", async () => {
    const error = await client().chat.completions.create({ model: "project:no-such-project", messages: [{ role: "user", content: "hi" }] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAI.NotFoundError);
    expect(error).toMatchObject({ status: 404, type: "invalid_request_error", code: "model_not_found", param: "model" });
    expect(chatProject).not.toHaveBeenCalled();
  });

  it("raises BadRequestError for a model id outside the project namespace and for unsupported parameters", async () => {
    const wrongModel = await client().chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }).catch((caught: unknown) => caught);
    expect(wrongModel).toBeInstanceOf(OpenAI.BadRequestError);
    expect(wrongModel).toMatchObject({ status: 400, type: "invalid_request_error", param: "model" });
    const tools = await client().chat.completions.create({
      model: "project:default", messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    }).catch((caught: unknown) => caught);
    expect(tools).toBeInstanceOf(OpenAI.BadRequestError);
    expect(tools).toMatchObject({ param: "tools", code: "unsupported_parameter" });
    const required = await client().chat.completions.create({ model: "project:default", messages: [{ role: "user", content: "hi" }], tool_choice: "required" }).catch((caught: unknown) => caught);
    expect(required).toBeInstanceOf(OpenAI.BadRequestError);
    expect(required).toMatchObject({ param: "tool_choice" });
    expect(chatProject).not.toHaveBeenCalled();
  });

  it("streams a direct answer for tool_choice none with docslurp retrieval overrides from extra body", async () => {
    chatProject.mockImplementationOnce(async (args: { onTextDelta: (text: string) => Promise<void> }) => { await args.onTextDelta("Renewal is annual [1]."); return answer; });
    // The DocSlurp request extension rides along as an extra body field.
    const body = { model: "project:default", messages: [{ role: "user", content: "When does it renew?" }], stream: true, tool_choice: "none",
      docslurp: { retrieval: { parentRetrieval: false } } } as OpenAI.ChatCompletionCreateParamsStreaming;
    const stream = await client().chat.completions.create(body);
    let text = "";
    for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? "";
    expect(text).toContain("Renewal is annual [1].");
    expect(chatProject).toHaveBeenCalledWith(expect.objectContaining({ allowAgentTools: false, retrieval: { parentRetrieval: false } }));
  });
});

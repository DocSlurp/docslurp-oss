import { ChatToolBlockedError } from "../services/chat-tool-error.js";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { chatWorkspace, workspaceChatDisabledBody, listWorkspaces, getWorkspace, validateApiKey, enforceAuthenticatedApiRateLimit } = vi.hoisted(() => ({
  chatWorkspace: vi.fn(), workspaceChatDisabledBody: vi.fn(async (_workspaceId: string, _userId: string): Promise<{ error: string; code: "chat_disabled" } | null> => null), listWorkspaces: vi.fn(), getWorkspace: vi.fn(), validateApiKey: vi.fn(), enforceAuthenticatedApiRateLimit: vi.fn(),
}));
// Spend admission has its own tests (spend-guard.test.ts); allow spend here.
vi.mock("../services/billing/spend-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/billing/spend-guard.js")>()),
  assertCanSpend: vi.fn(async () => undefined),
  canSpend: vi.fn(async () => true),
}));

vi.mock("../services/workspace-chat.js", () => ({ chatWorkspace, workspaceChatDisabledBody }));
vi.mock("../services/workspaces.js", () => ({ listWorkspaces, getWorkspace, findWorkspaceForInput: vi.fn(async (ref: { id?: string; slug?: string }) => ({ id: (ref.id ?? ref.slug)!, orgId: "org-1" })) }));
vi.mock("../services/api-keys.js", () => ({ validateApiKey }));
vi.mock("../middleware/rate-limit.js", () => ({ enforceAuthenticatedApiRateLimit }));
vi.mock("../lib/auth.js", () => ({ auth: {}, appDbPool: {} }));
const { chatCompletionsRoutes } = await import("../routes/chat-completions.js");
const id = "11111111-1111-4111-8111-111111111111";
const workspace = { id, orgId: "org-1", name: "Contracts", createdAt: "2026-10-01T00:00:00Z" };
const answer = {
  answer: "Renewal is annual [1].",
  citations: [{ text: "annual", score: 1, citation: { filename: "contract.pdf", documentId: "doc-1", pageNumber: 2 } }],
  availability: null, usage: { inputTokens: 19, outputTokens: 7, totalTokens: 26 },
};
const key = { userId: "user-1", orgId: "org-1", scopes: ["search", "chat"], keyType: "server", keyId: "key-1" };
function app() { return new Hono().route("/v1", chatCompletionsRoutes); }
function request(body: unknown) {
  return app().request("/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function input(extra: Record<string, unknown> = {}) { return { model: `workspace:${id}`, messages: [{ role: "user", content: "When does it renew?" }], ...extra }; }

describe("OpenAI-compatible workspace chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceAuthenticatedApiRateLimit.mockReset();
    enforceAuthenticatedApiRateLimit.mockResolvedValue(null);
    validateApiKey.mockReset();
    validateApiKey.mockResolvedValue(key);
    getWorkspace.mockResolvedValue(workspace);
    listWorkspaces.mockResolvedValue([workspace, { ...workspace, id: "foreign", orgId: "org-2" }, { ...workspace, id: "archived", archivedAt: "today" }]);
    chatWorkspace.mockResolvedValue(answer);
  });
  it("does not apply chat authentication to unrelated v1 routes", async () => {
    const host = app().get("/v1/unrelated", (c) => c.json({ ok: true }));
    expect((await host.request("/v1/unrelated")).status).toBe(200);
  });
  it("requires a bearer key and chat access", async () => {
    const response = await app().request("/v1/models");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { type: "authentication_error" } });
    validateApiKey.mockResolvedValueOnce({ ...key, scopes: ["ingest"] });
    expect((await request(input())).status).toBe(403);
    expect(chatWorkspace).not.toHaveBeenCalled();
  });
  it("refuses search-only keys: answers need the chat scope", async () => {
    validateApiKey.mockResolvedValueOnce({ ...key, scopes: ["search"] });
    const response = await request(input());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { type: "permission_error", code: "insufficient_scope", message: "API key needs chat access" } });
    expect(chatWorkspace).not.toHaveBeenCalled();
  });
  it("reports throttling as a rate limit rather than invalid credentials", async () => {
    enforceAuthenticatedApiRateLimit.mockResolvedValueOnce(new Response("Limited", { status: 429, headers: { "Retry-After": "60" } }));
    const response = await request(input());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toMatchObject({ error: { type: "rate_limit_error", code: "rate_limit_exceeded" } });
    expect(chatWorkspace).not.toHaveBeenCalled();
  });
  it("discovers only accessible models in the key's organization", async () => {
    const response = await app().request("/v1/models", { headers: { Authorization: "Bearer dslp_test" } });
    expect(await response.json()).toEqual({ object: "list", data: [{ id: `workspace:${id}`, object: "model", owned_by: "docslurp", name: "Contracts", created: 1790812800 }] });
  });
  it("preserves external history, citations and actual token usage", async () => {
    const response = await request(input({ max_completion_tokens: 100, messages: [
      { role: "developer", content: "Keep it short" },
      { role: "user", content: "Which contract?" },
      { role: "assistant", content: "The main contract" },
      { role: "user", content: [{ type: "text", text: "When does it renew?" }] },
    ] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ object: "chat.completion", usage: { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 }, choices: [{ message: { role: "assistant", content: "Renewal is annual [1].\n\nSources:\n[1] contract.pdf, page 2" }, finish_reason: "stop" }] });
    expect(chatWorkspace).toHaveBeenCalledWith(expect.objectContaining({ history: [{ role: "system", content: "Keep it short" }, { role: "user", content: "Which contract?" }, { role: "assistant", content: "The main contract" }], maxOutputTokens: 100, allowConfiguration: false, actor: { type: "apiKey", userId: "user-1", apiKey: key }, allowAgentTools: true, signal: expect.any(AbortSignal) }));
  });
  it("refuses workspaces that turned chat off with an OpenAI-shaped 403", async () => {
    workspaceChatDisabledBody.mockResolvedValueOnce({ error: "Chat is turned off for this workspace.", code: "chat_disabled" });
    const response = await request(input({ stream: true }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { type: "permission_error", code: "chat_disabled" } });
    expect(chatWorkspace).not.toHaveBeenCalled();
  });
  it("does not execute inaccessible workspace models", async () => {
    getWorkspace.mockResolvedValueOnce({ ...workspace, orgId: "org-2" });
    expect((await request(input())).status).toBe(404);
    expect(chatWorkspace).not.toHaveBeenCalled();
  });
  it("answers an unknown workspace reference with an OpenAI-shaped model_not_found", async () => {
    const { findWorkspaceForInput } = await import("../services/workspaces.js");
    vi.mocked(findWorkspaceForInput).mockResolvedValueOnce(null);
    const response = await request(input({ model: "workspace:no-such-workspace" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error", code: "model_not_found", param: "model" } });
    expect(chatWorkspace).not.toHaveBeenCalled();
  });
  it.each([{ tools: [] }, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/image" } }] }] }, { n: 2 }, { max_tokens: 10, max_completion_tokens: 10 }, { messages: [{ role: "assistant", content: "hi" }] }])("rejects unsupported or invalid inputs: %j", async (extra) => {
    const response = await request(input(extra));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } });
    expect(chatWorkspace).not.toHaveBeenCalled();
  });
  it.each([undefined, "auto"])("keeps the workspace agent for tool_choice %s", async (toolChoice) => {
    expect((await request(input(toolChoice ? { tool_choice: toolChoice } : {}))).status).toBe(200);
    expect(chatWorkspace).toHaveBeenCalledWith(expect.objectContaining({ allowAgentTools: true }));
  });
  it.each([false, true])("answers directly without agent tools for tool_choice none (stream=%s)", async (stream) => {
    chatWorkspace.mockImplementationOnce(async (args) => { if (args.onTextDelta) await args.onTextDelta(answer.answer); return answer; });
    const response = await request(input({ tool_choice: "none", stream }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Renewal is annual [1].");
    expect(chatWorkspace).toHaveBeenCalledOnce();
    expect(chatWorkspace).toHaveBeenCalledWith(expect.objectContaining({ allowAgentTools: false, allowConfiguration: false }));
    if (stream) expect(chatWorkspace.mock.calls[0]![0].onTextDelta).toEqual(expect.any(Function));
  });
  it.each(["required", { type: "function", function: { name: "search" } }, { type: "allowed_tools", allowed_tools: { mode: "auto", tools: [] } }, ""])("rejects unsupported tool_choice %j naming the param", async (toolChoice) => {
    const response = await request(input({ tool_choice: toolChoice }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ error: { type: "invalid_request_error", param: "tool_choice" } });
    expect(body.error.message).toContain('"auto" or "none"');
    expect(chatWorkspace).not.toHaveBeenCalled();
  });
  it("names client-defined tools as an unsupported parameter", async () => {
    const response = await request(input({ tools: [{ type: "function", function: { name: "lookup", parameters: {} } }] }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ error: { type: "invalid_request_error", param: "tools", code: "unsupported_parameter" } });
    expect(body.error.message).toContain('tool_choice "none"');
  });
  it("passes docslurp.retrieval overrides to the workspace answer and validates them", async () => {
    expect((await request(input({ docslurp: { retrieval: { parentRetrieval: false, resultCount: 6 } } }))).status).toBe(200);
    expect(chatWorkspace).toHaveBeenCalledWith(expect.objectContaining({ retrieval: { parentRetrieval: false, resultCount: 6 } }));
    for (const docslurp of [{ retrieval: { parentRetrieval: "no" } }, { retrieval: { secret: true } }, { filters: {} }]) {
      const response = await request(input({ docslurp }));
      expect(response.status).toBe(400);
      expect((await response.json()).error.param).toMatch(/^docslurp\./);
    }
    expect(chatWorkspace).toHaveBeenCalledOnce();
  });
  it("streams data-only deltas, usage and DONE with one stable completion id", async () => {
    chatWorkspace.mockImplementationOnce(async (args) => {
      await args.onTextDelta("Renewal is ");
      await args.onTextDelta("annual [1].");
      return answer;
    });
    const response = await request(input({ stream: true, stream_options: { include_usage: true } }));
    const text = await response.text();
    expect(text).not.toContain("event:");
    const frames = text.trim().split("\n\n").map((frame) => frame.slice(6));
    expect(frames.pop()).toBe("[DONE]");
    const chunks = frames.map((frame) => JSON.parse(frame));
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks.at(-2).choices[0].finish_reason).toBe("stop");
    expect(chunks.at(-1)).toMatchObject({ choices: [], usage: { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 } });
    expect(chunks.slice(0, -1).map((chunk) => chunk.choices[0].delta.content ?? "").join("")).toBe(answer.answer + "\n\nSources:\n[1] contract.pdf, page 2");
  });
  it("returns complete fallback answers when generation emits no deltas", async () => {
    const response = await request(input({ stream: true }));
    const text = await response.text();
    expect(text).toContain("Renewal is annual [1].");
    expect(text).toContain("[DONE]");
    expect(text).not.toContain('"usage"');
  });
  it("accepts successful Unicode output despite service normalization", async () => {
    chatWorkspace.mockImplementationOnce(async (args) => { await args.onTextDelta("x² = 4"); return { ...answer, answer: "x2 = 4" }; });
    const response = await request(input({ stream: true }));
    const text = await response.text();
    expect(text).toContain("[DONE]");
    expect(text).not.toContain('"type":"server_error"');
  });
  it.each([false, true])("preserves output-limit termination with streaming=%s", async (stream) => {
    chatWorkspace.mockResolvedValueOnce({ ...answer, finishReason: "length" });
    const response = await request(input({ stream, max_completion_tokens: 1 }));
    expect(await response.text()).toContain('"finish_reason":"length"');
  });
  it("rejects malformed workspace UUIDs before querying", async () => {
    const response = await request(input({ model: `workspace:${"-".repeat(36)}` }));
    expect(response.status).toBe(400);
    expect(getWorkspace).not.toHaveBeenCalled();
  });
  it.each([false, true])("blocks tool failures without a successful completion (stream=%s)", async (stream) => {
    chatWorkspace.mockRejectedValueOnce(new ChatToolBlockedError("search", "http_503"));
    const response = await request(input({ stream }));
    if (!stream) {
      expect(response.status).toBe(424);
      expect(await response.json()).toMatchObject({ error: { code: "chat_tool_failed" } });
    } else {
      const text = await response.text();
      expect(text).toContain('"code":"chat_tool_failed"');
      expect(text).not.toContain('"finish_reason":"stop"');
      expect(text).not.toContain("[DONE]");
    }
  });

  it("reports midstream failure without a false successful finish", async () => {
    chatWorkspace.mockImplementationOnce(async (args) => { await args.onTextDelta("partial"); throw new Error("provider failed"); });
    const response = await request(input({ stream: true }));
    const text = await response.text();
    expect(text).toContain('"type":"server_error"');
    expect(text).not.toContain('[DONE]');
    expect(text).not.toContain('"finish_reason":"stop"');
  });
});

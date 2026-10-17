import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidatedKey } from "../services/api-keys.js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const aggregateWorkspaceRagSearch = vi.fn();
const getAutomationCapabilityManifest = vi.fn();
const validateApiKey = vi.fn();
const hybridSearch = vi.fn();
const chatWorkspace = vi.fn();
const workspaceChatDisabledBody = vi.fn(async (_workspaceId: string, _userId: string): Promise<{ error: string; code: "chat_disabled" } | null> => null);
const getWorkspace = vi.fn();
const listWorkspaces = vi.fn();
const uploadRequest = vi.fn();
const loadDirectUploadSession = vi.fn();
vi.mock("../services/direct-upload-session.js", () => ({ loadDirectUploadSession }));
const getAutomationOperation = vi.fn();
const submitSimpleAutomation = vi.fn();

vi.mock("../services/api-keys.js", () => ({
  validateApiKey,
}));

vi.mock("../services/aggregate-rag.js", () => ({
  aggregateWorkspaceRagSearch,
}));

vi.mock("../services/search.js", () => ({
  hybridSearch,
  MissingWorkspaceScopeError: class extends Error {},
}));
vi.mock("../services/workspace-chat.js", () => ({ chatWorkspace, workspaceChatDisabledBody }));
vi.mock("../services/workspaces.js", () => ({ resolveWorkspaceRef: vi.fn(async () => null), ensureDefaultWorkspace: vi.fn(async () => ({ id: "default-ws" })), getWorkspace, listWorkspaces }));

vi.mock("../routes/uploads.js", async () => {
  const { Hono } = await import("hono");
  return { uploadsRoutes: new Hono().post("/*", async (c) => {
    const body = c.req.path.endsWith("/confirm") ? {} : await c.req.json();
    const outcome = uploadRequest({ path: c.req.path, actor: c.get("requestActor"), body, idempotencyKey: c.req.header("Idempotency-Key") });
    if (outcome instanceof Response) return outcome;
    return c.json({ workspace: { id: "ws-1" }, run: { id: "run-1" } }, 201);
  }) };
});

vi.mock("../services/automation.js", () => ({
  getAutomationCapabilityManifest,
  getAutomationOperation,
  submitAdvancedAutomation: vi.fn(),
  submitSimpleAutomation,
}));

vi.mock("../db.js", () => ({
  sql: vi.fn(),
}));
const loadIngestReport = vi.fn(async (args: { workspace: { id: string } }) => ({ workspaceId: args.workspace.id, files: { total: 0 } }));
vi.mock("../services/ingest-report.js", () => ({
  loadIngestReport,
  summarizeIngestReport: vi.fn(() => "**Ingest report**: no files yet."),
}));

const { mcpRoutes } = await import("../routes/mcp.js");

const validatedKey: ValidatedKey = {
  keyId: "key-1",
  userId: "user-1",
  orgId: "org-1",
  keyType: "server",
  allowedDomains: [],
  scopes: ["search"],
  rateLimitRpm: 60,
  rateLimitPpd: 10_000,
  rateLimits: [], workspaceIds: [],
};

function buildApp() {
  const app = new Hono();
  app.route("/mcp", mcpRoutes);
  return app;
}

describe("mcpRoutes", () => {
  let app: Hono;

  beforeEach(() => {
    app = buildApp();
    aggregateWorkspaceRagSearch.mockReset();
    getAutomationCapabilityManifest.mockReset();
    getAutomationCapabilityManifest.mockReturnValue({ server: { transports: ["http", "sse", "stdio"] }, capabilities: [] });
    validateApiKey.mockReset();
    validateApiKey.mockResolvedValue(validatedKey);
    listWorkspaces.mockReset();
    uploadRequest.mockReset();
    loadDirectUploadSession.mockReset();
    hybridSearch.mockReset();
    hybridSearch.mockResolvedValue({ results: [{ text: "Support hours", citation: { filename: "guide.txt", pageNumber: 1 } }], sessionId: "retrieval-1", availability: { status: "ready" }, usageEvents: [{ inputTokens: 7, outputTokens: 0, costCents: 0.001, metadata: { costSource: "provider" } }] });
    chatWorkspace.mockReset();
    getWorkspace.mockReset();
    getWorkspace.mockImplementation(async (id: string) => id === "foreign" ? { id, orgId: "org-2" } : { id, orgId: "org-1" });
  });

  it("exposes aggregate workspace RAG search as an MCP tool", async () => {
    aggregateWorkspaceRagSearch.mockResolvedValueOnce({
      query: "audience?",
      answer: "The documents target implementation teams [1].",
      citations: [],
      evidenceSpans: [],
      workspaces: [],
      warnings: [],
      partial: false,
      usage: {
        inputTokens: 10,
        outputTokens: 12,
        totalTokens: 22,
      },
    });

    const response = await app.request("/mcp/tools/workspace.aggregate-rag-search", {
      method: "POST",
      headers: {
        Authorization: "Bearer dslp_test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        goal: "audience?",
        workspaceIds: ["ws-1", "ws-2"],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tool: "workspace.aggregate-rag-search",
      query: "audience?",
      answer: "The documents target implementation teams [1].",
    });
    expect(aggregateWorkspaceRagSearch).toHaveBeenCalledWith({
      userId: "user-1",
      apiKey: validatedKey,
      request: expect.objectContaining({
        goal: "audience?",
        workspaceIds: ["ws-1", "ws-2"],
      }),
    });
  });
  it("lists only credential-authorized workspaces before pagination without refining names", async () => {
    validateApiKey.mockResolvedValue({ ...validatedKey, workspaceIds: ["allowed"] });
    listWorkspaces.mockResolvedValue([
      { id: "foreign", orgId: "org-2", name: "Secret" },
      { id: "excluded", orgId: "org-1", name: "Excluded" },
      { id: "allowed", orgId: "org-1", slug: "manuals", name: "Manuals", isDefault: true, systemPrompt: "private instructions" },
    ]);
    const response = await app.request("/mcp/tools/listWorkspaces", { method: "POST", headers: { Authorization: "Bearer key", "Content-Type": "application/json" }, body: '{"limit":1}' });
    expect(await response.json()).toEqual({ workspaces: [{ id: "allowed", slug: "manuals", name: "Manuals", isDefault: true }], total: 1, nextOffset: null });
    expect(listWorkspaces).toHaveBeenCalledWith("user-1", { refineNames: false });
  });

  it("uploads URLs and requests up to ten single-part signed uploads with actor, default scope and retry key", async () => {
    validateApiKey.mockResolvedValue({ ...validatedKey, scopes: ["ingest"] });
    const headers = { Authorization: "Bearer key", "Content-Type": "application/json" };
    const response = await app.request("/mcp/tools/upload", { method: "POST", headers, body: JSON.stringify({ urls: ["https://example.com/manual.pdf"], idempotencyKey: "retry-1" }) });
    expect(response.status).toBe(201);
    expect(uploadRequest).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/url", actor: expect.objectContaining({ userId: "user-1", apiKey: expect.objectContaining({ orgId: "org-1" }) }), body: { workspaceId: "default-ws", urls: ["https://example.com/manual.pdf"] }, idempotencyKey: "retry-1" }));
    const text = await app.request("/mcp/tools/upload", { method: "POST", headers, body: JSON.stringify({ workspaceId: "ws-1", files: Array.from({ length: 10 }, (_, i) => ({ filename: `notes-${i}.pdf`, sizeBytes: 40 * 1024 * 1024, mimeType: "application/pdf" })) }) });
    expect(text.status).toBe(201);
    const call = uploadRequest.mock.lastCall![0];
    expect(call.path).toBe("/direct/sessions");
    expect(call.body.files).toHaveLength(10);
    expect(call.body.files.every((file: { singlePart: boolean }) => file.singlePart)).toBe(true);
  });

  it("preserves an explicitly named new workspace for signed-upload completion", async () => {
    validateApiKey.mockResolvedValue({ ...validatedKey, scopes: ["ingest"] });
    const response = await app.request("/mcp/tools/upload", { method: "POST", headers: { Authorization: "Bearer key", "Content-Type": "application/json" }, body: JSON.stringify({ workspaceName: "Legal contracts", files: [{ filename: "contract.pdf", sizeBytes: 42, mimeType: "application/pdf" }] }) });
    expect(response.status).toBe(201);
    expect(uploadRequest.mock.lastCall![0].body).toEqual({ workspaceName: "Legal contracts", files: [{ filename: "contract.pdf", sizeBytes: 42, mimeType: "application/pdf", singlePart: true }] });
  });

  it("completes every signed file before confirming ingestion, checking ownership and session state", async () => {
    validateApiKey.mockResolvedValue({ ...validatedKey, scopes: ["ingest"], workspaceIds: ["ws-1"] });
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const fileId = "00000000-0000-4000-8000-000000000002";
    const loaded = { session: { status: "pending", org_id: "org-1", workspace_id: "ws-1" }, files: [{ id: fileId, upload_mode: "single" }] };
    loadDirectUploadSession.mockResolvedValue(loaded);
    const request = () => app.request("/mcp/tools/completeUpload", { method: "POST", headers: { Authorization: "Bearer key", "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, fileIds: [fileId] }) });
    expect((await request()).status).toBe(201);
    expect(uploadRequest.mock.calls.map(([call]) => call.path)).toEqual([`/direct/sessions/${sessionId}/files/complete`, `/direct/sessions/${sessionId}/confirm`]);
    expect(loadDirectUploadSession).toHaveBeenCalledWith(sessionId, "user-1");
    uploadRequest.mockClear();
    uploadRequest.mockReturnValueOnce(Response.json({ error: "File is incomplete" }, { status: 400 }));
    expect((await request()).status).toBe(400);
    expect(uploadRequest).toHaveBeenCalledTimes(1);
    uploadRequest.mockClear();
    loadDirectUploadSession.mockResolvedValue({ ...loaded, session: { ...loaded.session, org_id: "foreign" } });
    expect((await request()).status).toBe(404);
    loadDirectUploadSession.mockResolvedValue({ ...loaded, session: { ...loaded.session, workspace_id: "foreign" } });
    expect((await request()).status).toBe(404);
    loadDirectUploadSession.mockResolvedValue({ ...loaded, session: { ...loaded.session, status: "confirmed" } });
    expect((await request()).status).toBe(409);
    loadDirectUploadSession.mockResolvedValue({ ...loaded, files: [...loaded.files, { id: "missing", upload_mode: "single" }] });
    expect((await request()).status).toBe(400);
    expect(uploadRequest).not.toHaveBeenCalled();
  });

  it("refuses upload without ingest scope or outside the credential workspace allowlist", async () => {
    const request = (body: unknown) => app.request("/mcp/tools/upload", { method: "POST", headers: { Authorization: "Bearer key", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const input = { urls: ["https://example.com/manual.pdf"] };
    expect((await request(input)).status).toBe(403);
    validateApiKey.mockResolvedValue({ ...validatedKey, scopes: ["ingest"], workspaceIds: ["ws-1"] });
    expect((await request({ ...input, workspaceId: "foreign" })).status).toBe(404);
    expect((await request({ ...input, workspaceName: "New" })).status).toBe(403);
    expect(uploadRequest).not.toHaveBeenCalled();
  });

  it.each([{}, { files: Array.from({ length: 11 }, () => ({ filename: "x.pdf", mimeType: "application/pdf", sizeBytes: 1 })) }, { urls: ["file:///etc/passwd"] }, { urls: ["https://example.com"], files: [{ filename: "x", content: "x" }] }, { urls: ["https://example.com"], userId: "victim" }])("rejects invalid upload arguments: %j", async body => {
    validateApiKey.mockResolvedValue({ ...validatedKey, scopes: ["ingest"] });
    const response = await app.request("/mcp/tools/upload", { method: "POST", headers: { Authorization: "Bearer key", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(uploadRequest).not.toHaveBeenCalled();
  });

  it("discovers documented workspace tools and advertises only the implemented MCP transport", async () => {
    const response = await app.request("/mcp/tools", { headers: { Authorization: "Bearer dslp_test" } });
    expect(response.status).toBe(200);
    expect((await response.json()).tools.map((tool: { id: string }) => tool.id)).toEqual(["listWorkspaces", "search", "chat", "getUploadStatus", "suggestQueries"]);
    const manifest = await app.request("/mcp/manifest", { headers: { Authorization: "Bearer dslp_test" } });
    expect((await manifest.json()).server.transports).toEqual(["streamable-http", "stdio"]);
  });

  it.each(["null", "[]", "{", '"string"'])("rejects malformed tool bodies with HTTP 400: %s", async (body) => {
    const response = await app.request("/mcp/tools/workspace.search", {
      method: "POST", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json" }, body,
    });
    expect(response.status).toBe(400);
  });

  it.each([
    ["workspace.search", { workspaceId: "", q: "query" }],
    ["workspace.search", { workspaceId: "00000000-0000-4000-8000-000000000001", q: " " }],
    ["workspace.suggest", { workspaceId: "00000000-0000-4000-8000-000000000001", limit: -1 }],
    ["workspace.ingest-report", { documentIds: Array.from({ length: 101 }, (_, index) => `d${index}`) }],
    ["workspace.ingest-report", { workspaceId: "ws-1", sql: "drop table documents" }],
    ["ai.simple", {}],
    ["ai.advanced", {}],
    ["workspace.chat", { workspaceId: "ws-1", q: " " }],
    ["workspace.search", { queries: [] }],
    ["workspace.search", { queries: [{ workspaceId: "ws-1", q: "query" }], concurrency: 5 }],
  ])("rejects invalid %s arguments before running the tool", async (tool, body) => {
    const response = await app.request(`/mcp/tools/${tool}`, {
      method: "POST", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  });

  it("never lets a remote MCP caller pre-approve automation spend", async () => {
    getAutomationCapabilityManifest.mockReturnValue({ server: {}, capabilities: [{ id: "ai.simple", title: "Simple", category: "tool", inputSchema: {} }] });
    submitSimpleAutomation.mockReset();
    submitSimpleAutomation.mockResolvedValueOnce({ operation: { id: "00000000-0000-4000-8000-000000000001" }, events: [] });
    const tools = (await (await app.request("/mcp/tools", { headers: { Authorization: "Bearer dslp_test" } })).json()).tools as Array<{ id: string; inputSchema: unknown }>;
    expect(tools.map((tool) => tool.id)).not.toContain("ai.operation.approve");
    expect(JSON.stringify(tools.map((tool) => tool.inputSchema))).not.toMatch(/approve/i);
    const response = await app.request("/mcp/tools/ai.simple", {
      method: "POST", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-1", goal: "ingest", approveCostEstimate: true }),
    });
    expect(response.status).toBe(202);
    expect(submitSimpleAutomation.mock.calls[0]![0].request).not.toHaveProperty("approveCostEstimate");
  });

  it("requires a bearer key and enforces search scope", async () => {
    expect((await app.request("/mcp/tools")).status).toBe(401);
    validateApiKey.mockResolvedValueOnce({ ...validatedKey, scopes: ["ingest"] });
    const response = await app.request("/mcp/tools/workspace.suggest", {
      method: "POST", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(403);
  });

  it("advertises safe names, explicit upload alternatives and mutation annotations", async () => {
    validateApiKey.mockResolvedValue({ ...validatedKey, scopes: ["search", "ingest"] });
    const client = new Client({ name: "catalog-contract", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:4321/mcp"), { requestInit: { headers: { Authorization: "Bearer key" } }, fetch: async (url, init) => app.request(new Request(url, init)) }));
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(7);
    expect(new Set(tools.map(tool => tool.name)).size).toBe(7);
    expect(tools.every(tool => /^[A-Za-z0-9_.-]{1,128}$/.test(tool.name))).toBe(true);
    for (const name of ["upload", "completeUpload", "chat"]) {
      expect(tools.find(tool => tool.name === name)?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    }
    for (const name of ["listWorkspaces", "search", "getUploadStatus", "suggestQueries"]) {
      expect(tools.find(tool => tool.name === name)?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
    }
    const upload = tools.find(tool => tool.name === "upload")!;
    expect(upload.inputSchema.oneOf).toHaveLength(2);
    expect(upload.inputSchema.additionalProperties).toBe(false);
    expect(upload.annotations?.openWorldHint).toBe(true);
    const result = await client.callTool({ name: "upload", arguments: { files: [] } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toHaveProperty("error");
    await client.close();
  });

  it("offers a real HTTP MCP endpoint and preserves scoped actor on tool dispatch", async () => {
    aggregateWorkspaceRagSearch.mockResolvedValueOnce({ answer: "safe evidence" });
    getAutomationCapabilityManifest.mockReturnValue({ server: {}, capabilities: [{
      id: "workspace.aggregate-rag-search", title: "RAG", description: "Grounded retrieval", category: "tool", inputSchema: { type: "object", properties: {} },
    }] });
    const client = new Client({ name: "http-route-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:4321/mcp"), {
      requestInit: { headers: { Authorization: "Bearer dslp_test" } },
      fetch: async (url, init) => app.request(new Request(url, init)),
    }));
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain("search");
    const called = await client.callTool({ name: "search", arguments: { q: "audience?", workspaceId: "ws-1" } });
    expect(called.isError).toBe(false);
    expect(hybridSearch).toHaveBeenCalledWith("audience?", "user-1", expect.anything());
    await client.close();
  });

  it("rejects untrusted Origin and Host without executing a tool", async () => {
    const init = { method: "POST", body: "{}", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json", Origin: "https://evil.example" } };
    expect((await app.request("http://localhost:4321/mcp", init)).status).toBe(403);
    const host = await app.request("http://localhost:4321/mcp", { ...init, headers: { ...init.headers, Origin: "http://localhost:4321", Host: "evil.example" } });
    expect(host.status).toBe(403);
    expect(aggregateWorkspaceRagSearch).not.toHaveBeenCalled();
  });

  it("requires bearer authentication on the protocol endpoint", async () => {
    const response = await app.request("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource/v1/mcp");
  });

  it("returns portable cited search data and a direct grounded chat answer", async () => {
    chatWorkspace.mockResolvedValueOnce({ answer: "Weekdays [1]", citations: [{ filename: "guide.txt", pageNumber: 1 }], sessionId: "chat-1", usage: { inputTokens: 10, outputTokens: 3 } });
    const call = (name: string, args: unknown) => app.request(`/mcp/tools/workspace.${name}`, {
      method: "POST", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json" }, body: JSON.stringify(args),
    });
    expect(await (await call("search", { workspaceId: "ws-1", q: "Support hours?" })).json()).toMatchObject({ results: [{ text: "Support hours" }], sessionId: "retrieval-1", availability: { status: "ready" } });
    const chat = await call("chat", { workspaceId: "ws-1", q: "Support hours?", sessionId: "chat-existing" });
    expect(await chat.json()).toMatchObject({ answer: "Weekdays [1]", citations: [{ filename: "guide.txt" }], usage: { outputTokens: 3 } });
    expect(chatWorkspace).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1", userId: "user-1", query: "Support hours?", sessionId: "chat-existing" }));
    expect(hybridSearch).toHaveBeenCalledWith("Support hours?", "user-1", expect.objectContaining({ useHyDE: undefined, useRerank: undefined, queryRewrite: undefined }));
  });

  it("keeps parallel retrieval results ordered and denies foreign workspaces before retrieval", async () => {
    const response = await app.request("/mcp/tools/workspace.search", {
      method: "POST", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json" }, body: JSON.stringify({ queries: [{ q: "first", workspaceId: "ws-1" }, { q: "private", workspaceId: "foreign" }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ results: [{ ok: true, data: { sessionId: "retrieval-1" } }, { ok: false, error: { code: "WORKSPACE_NOT_FOUND", status: 404 } }] });
    expect(hybridSearch).toHaveBeenCalledTimes(1);
    expect(hybridSearch).toHaveBeenCalledWith("first", "user-1", expect.anything());
    expect(chatWorkspace).not.toHaveBeenCalled();
  });

  it("does not discover or execute search/chat tools without search scope", async () => {
    validateApiKey.mockResolvedValue({ ...validatedKey, scopes: ["ingest"] });
    const listed = await app.request("/mcp/tools", { headers: { Authorization: "Bearer dslp_test" } });
    expect((await listed.json()).tools.map((tool: { id: string }) => tool.id)).toEqual(["listWorkspaces", "upload", "completeUpload", "getUploadStatus"]);
    for (const name of ["search", "chat"]) {
      expect((await app.request(`/mcp/tools/workspace.${name}`, { method: "POST", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
    }
    expect(chatWorkspace).not.toHaveBeenCalled();
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it("discovers and calls search and chat through the official HTTP client", async () => {
    chatWorkspace.mockResolvedValue({ answer: "Weekdays [1]", citations: [], sessionId: "chat-1", usage: { inputTokens: 10, outputTokens: 3 } });
    const client = new Client({ name: "rag-chat-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:4321/mcp"), { requestInit: { headers: { Authorization: "Bearer dslp_test" } }, fetch: async (url, init) => app.request(new Request(url, init)) }));
    const tools = (await client.listTools()).tools;
    expect(tools.find(tool => tool.name === "chat")?.annotations?.idempotentHint).toBe(false);
    const search = await client.callTool({ name: "search", arguments: { q: "Support?", workspaceId: "ws-1" } });
    expect(search.structuredContent).toMatchObject({ usage: { totalTokens: 7, costCents: 0.001, costSource: "provider" } });
    const batch = await client.callTool({ name: "search", arguments: { queries: [{ q: "Support?", workspaceId: "ws-1" }] } });
    expect(batch.structuredContent).toMatchObject({ results: [{ ok: true, data: { results: [{ text: "Support hours" }] } }] });
    const chat = await client.callTool({ name: "chat", arguments: { q: "Support?", workspaceId: "ws-1" } });
    expect(chat.structuredContent).toMatchObject({ answer: "Weekdays [1]", usage: { outputTokens: 3 } });
    await client.close();
  });

});


describe("session MCP tools", () => {
  const actor = { type: "session" as const, userId: "user-1", sessionId: "session-1", user: { id: "user-1", email: "", name: "Member" } };
  let app: Hono;
  beforeEach(async () => {
    const { sessionToolRoutes } = await import("../routes/session-tools.js");
    const { setRequestActor } = await import("../lib/request-actor.js");
    app = new Hono().use("*", async (c, next) => { setRequestActor(c, actor); await next(); }).route("/tools", sessionToolRoutes);
    getAutomationCapabilityManifest.mockReturnValue({ server: {}, capabilities: [{ id: "ai.simple", title: "Simple", category: "tool", inputSchema: {} }] });
    getWorkspace.mockImplementation(async (id: string) => id === "foreign" ? null : { id, orgId: "org-1" });
    hybridSearch.mockClear();
    submitSimpleAutomation.mockReset();
  });
  const headers = { Origin: "http://localhost:4321", "Content-Type": "application/json" };

  it("uses the authenticated session identity and preserves workspace access checks", async () => {
    const response = await app.request("/tools/tools/workspace.search", { method: "POST", headers, body: JSON.stringify({ workspaceId: "ws-1", q: "hello" }) });
    expect(response.status).toBe(200);
    expect(hybridSearch).toHaveBeenCalledWith("hello", "user-1", expect.anything());
    expect((await app.request("/tools/tools/workspace.suggest", { method: "POST", headers, body: JSON.stringify({ workspaceId: "foreign" }) })).status).toBe(404);
  });

  it("returns a read-only ingest report for an accessible workspace and hides foreign ones", async () => {
    loadIngestReport.mockClear();
    const response = await app.request("/tools/tools/workspace.ingest-report", { method: "POST", headers, body: JSON.stringify({ workspaceId: "ws-1", runId: "run-1" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ tool: "workspace.ingest-report", summary: expect.stringContaining("Ingest report"), report: { workspaceId: "ws-1" } });
    expect(loadIngestReport).toHaveBeenCalledWith(expect.objectContaining({ canEdit: false, runId: "run-1", workspace: expect.objectContaining({ id: "ws-1" }) }));
    expect((await app.request("/tools/tools/workspace.ingest-report", { method: "POST", headers, body: JSON.stringify({ workspaceId: "foreign" }) })).status).toBe(404);
    expect(loadIngestReport).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "https://foreign.example", "null"])("rejects an untrusted execution origin: %s", async origin => {
    const response = await app.request("/tools/tools/workspace.search", { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: '{"q":"hello"}' });
    expect(response.status).toBe(403);
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it("does not accept bearer credentials on the browser adapter", async () => {
    const response = await app.request("/tools/tools", { headers: { Authorization: "Bearer invalid" } });
    expect(response.status).toBe(401);
  });

  it("advertises upload inputs without accepting caller identity", async () => {
    const response = await app.request("/tools/tools");
    const tools = (await response.json()).tools;
    const tool = tools.find((tool: { id: string }) => tool.id === "upload");
    expect(tool.inputSchema.properties.urls).toBeDefined();
    expect(tool.inputSchema.properties.files).toBeDefined();
    expect(tool.inputSchema.properties.userId).toBeUndefined();
    expect(tools.some((tool: { id: string }) => tool.id.startsWith("ai."))).toBe(false);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("submits automation as the session user and returns a usable poll tool", async () => {
    submitSimpleAutomation.mockResolvedValueOnce({ operation: { id: "00000000-0000-4000-8000-000000000001" }, events: [] });
    const response = await app.request("/tools/tools/ai.simple", { method: "POST", headers, body: JSON.stringify({ workspaceId: "ws-1", goal: "summarize", userId: "victim", maxCostCents: 5 }) });
    expect(response.status).toBe(202);
    expect(submitSimpleAutomation).toHaveBeenCalledWith({ apiKey: null, request: expect.objectContaining({ userId: "user-1", workspaceId: "ws-1", maxCostCents: 5 }) });
    expect(await response.json()).toMatchObject({ pollTool: { name: "ai.operation.get" } });
  });

  it("never lets a WebMCP caller pre-approve automation spend", async () => {
    submitSimpleAutomation.mockResolvedValueOnce({ operation: { id: "00000000-0000-4000-8000-000000000001" }, events: [] });
    const tools = (await (await app.request("/tools/tools")).json()).tools as Array<{ id: string; inputSchema: unknown }>;
    expect(JSON.stringify(tools.map((tool) => tool.inputSchema))).not.toMatch(/approve/i);
    await app.request("/tools/tools/ai.simple", { method: "POST", headers, body: JSON.stringify({ workspaceId: "ws-1", goal: "ingest", approveCostEstimate: true }) });
    expect(submitSimpleAutomation.mock.calls[0]![0].request).not.toHaveProperty("approveCostEstimate");
  });

  it("looks up operations with the caller identity", async () => {
    getAutomationOperation.mockResolvedValueOnce(null);
    const response = await app.request("/tools/tools/ai.operation.get", { method: "POST", headers, body: '{"operationId":"00000000-0000-4000-8000-000000000001"}' });
    expect(response.status).toBe(404);
    expect(getAutomationOperation).toHaveBeenLastCalledWith({ operationId: "00000000-0000-4000-8000-000000000001", userId: "user-1", apiKey: null });
  });
});

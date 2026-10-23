import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidatedKey } from "../services/api-keys.js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const validateApiKey = vi.fn();
const hybridSearch = vi.fn();
const chatWorkspace = vi.fn();
const workspaceChatDisabledBody = vi.fn(async (_workspaceId: string, _userId: string): Promise<{ error: string; code: "chat_disabled" } | null> => null);
const getWorkspace = vi.fn();
const listWorkspaces = vi.fn();
const uploadRequest = vi.fn();
const loadDirectUploadSession = vi.fn();
vi.mock("../services/direct-upload-session.js", () => ({ loadDirectUploadSession }));

const loadMediaEvidence = vi.fn();
vi.mock("../services/media-evidence.js", () => ({ loadMediaEvidence }));

const forwardInProcess = vi.fn();
const listEditableWorkspaceIds = vi.fn(async (_userId: string): Promise<string[]> => []);
vi.mock("../services/organizations.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../services/organizations.js")>()), listEditableWorkspaceIds }));

// forwardInProcess is mocked, so the route modules it statically mounts only need to exist.
vi.mock("../routes/workspaces.js", async () => ({ workspacesRoutes: new (await import("hono")).Hono() }));
vi.mock("../routes/workspace-graph.js", async () => ({ workspaceGraphRoutes: new (await import("hono")).Hono() }));
vi.mock("../routes/documents.js", async () => ({ documentsRoutes: new (await import("hono")).Hono() }));
vi.mock("../routes/runs.js", async () => ({ runsRoutes: new (await import("hono")).Hono() }));
vi.mock("../routes/jobs.js", async () => ({ jobsRoutes: new (await import("hono")).Hono() }));
vi.mock("../services/mcp-estimate-tools.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../services/mcp-estimate-tools.js")>()), forwardInProcess }));
vi.mock("../services/api-keys.js", () => ({
  validateApiKey,
}));

vi.mock("../services/search.js", () => ({
  hybridSearch,
  MissingWorkspaceScopeError: class extends Error {},
}));
vi.mock("../services/workspace-chat.js", () => ({ chatWorkspace, workspaceChatDisabledBody }));
vi.mock("../services/workspaces.js", () => ({ resolveWorkspaceRef: vi.fn(async () => null), findWorkspaceForInput: vi.fn(async (ref: { id?: string; slug?: string }) => ({ id: (ref.id ?? ref.slug)!, orgId: "org-1" })), ensureDefaultWorkspace: vi.fn(async () => ({ id: "default-ws" })), getWorkspace, listWorkspaces }));

vi.mock("../routes/uploads.js", async () => {
  const { Hono } = await import("hono");
  return { uploadEstimateRoutes: new Hono(), uploadsRoutes: new Hono().post("/*", async (c) => {
    const body = c.req.path.endsWith("/confirm") ? {} : await c.req.json();
    const outcome = uploadRequest({ path: c.req.path, actor: c.get("requestActor"), body, idempotencyKey: c.req.header("Idempotency-Key") });
    if (outcome instanceof Response) return outcome;
    return c.json({ workspace: { id: "ws-1" }, run: { id: "run-1" } }, 201);
  }) };
});

vi.mock("../db.js", () => ({
  sql: vi.fn(),
}));
const loadIngestReport = vi.fn(async (args: { workspace: { id: string } }) => ({ workspaceId: args.workspace.id, files: { total: 0 } }));
vi.mock("../services/ingest-report.js", () => ({
  loadIngestReport,
  summarizeIngestReport: vi.fn(() => "**Ingest report**: no files yet."),
}));

const { mcpRoutes } = await import("../routes/mcp.js");
const { markSessionToolsSurface, mcpAdapterRoutes } = await import("../services/mcp-tools.js");
const { setRequestActor } = await import("../lib/request-actor.js");
const { UPLOAD_UI_URI } = await import("../lib/mcp-ui-resources.js");
const { resetApiRateLimitBuckets } = await import("../middleware/rate-limit.js");

// Each case represents an independent client, not cumulative production traffic.
beforeEach(() => resetApiRateLimitBuckets());

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
    validateApiKey.mockReset();
    validateApiKey.mockResolvedValue(validatedKey);
    listWorkspaces.mockReset();
    listEditableWorkspaceIds.mockReset();
    listEditableWorkspaceIds.mockResolvedValue(["default-ws", "ws-2"]);
    loadMediaEvidence.mockReset();
    uploadRequest.mockReset();
    loadDirectUploadSession.mockReset();
    hybridSearch.mockReset();
    hybridSearch.mockResolvedValue({ results: [{ text: "Support hours", citation: { filename: "guide.txt", pageNumber: 1 } }], sessionId: "retrieval-1", availability: { status: "ready" }, usageEvents: [{ inputTokens: 7, outputTokens: 0, costCents: 0.001, metadata: { costSource: "provider" } }] });
    chatWorkspace.mockReset();
    getWorkspace.mockReset();
    getWorkspace.mockImplementation(async (id: string) => id === "foreign" ? { id, orgId: "org-2" } : { id, orgId: "org-1" });
  });

  it("reads media evidence only inside the credential-authorized workspace", async () => {
    loadMediaEvidence.mockResolvedValue({ results: [], summary: { coverage: "sampled-visual-only" } });
    const request = (workspace: string) => app.request("/mcp/tools/getMediaEvidence", {
      method: "POST", headers: { Authorization: "Bearer key", "Content-Type": "application/json" },
      body: JSON.stringify({ workspace, documentId: "video", offset: 16000 }),
    });
    expect((await request("foreign")).status).toBe(404);
    expect(loadMediaEvidence).not.toHaveBeenCalled();
    expect((await request("ws-1")).status).toBe(200);
    expect(loadMediaEvidence).toHaveBeenCalledWith("ws-1", "video", 16000);
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

  it("resolves the uploader target read-only and hides the tool while the MCP Apps flag is off", async () => {
    validateApiKey.mockResolvedValue({ ...validatedKey, scopes: ["ingest"] });
    listWorkspaces.mockResolvedValue([
      { id: "default-ws", orgId: "org-1", slug: "main", name: "Main", isDefault: true, systemPrompt: "private" },
      { id: "ws-2", orgId: "org-1", slug: "legal", name: "Legal", isDefault: false },
    ]);
    const call = (body: object) => app.request("/mcp/tools/openUploader", { method: "POST", headers: { Authorization: "Bearer key", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await call({})).status).toBe(404);
    const { env } = await import("../config.js");
    env.mcpAppsUiEnabled = true;
    try {
      const defaulted = await (await call({})).json();
      expect(defaulted).toEqual({
        workspace: { id: "default-ws", slug: "main", name: "Main", isDefault: true },
        workspaces: [{ id: "default-ws", slug: "main", name: "Main", isDefault: true }, { id: "ws-2", slug: "legal", name: "Legal", isDefault: false }],
        limits: { maxFiles: 10, maxFileBytes: 5368709120 },
        uploader: { resourceUri: UPLOAD_UI_URI },
        hint: expect.any(String),
      });
      expect((await (await call({ workspace: "ws-2" })).json()).workspace.id).toBe("ws-2");
      expect((await call({ extra: 1 })).status).toBe(400);
      expect(uploadRequest).not.toHaveBeenCalled();
    } finally { env.mcpAppsUiEnabled = false; }
  });

  it("offers the uploader only workspaces the user may upload to, matching the upload route's viewer rule", async () => {
    validateApiKey.mockResolvedValue({ ...validatedKey, scopes: ["ingest"] });
    listWorkspaces.mockResolvedValue([
      { id: "default-ws", orgId: "org-1", slug: "main", name: "Main", isDefault: true },
      { id: "ws-2", orgId: "org-1", slug: "legal", name: "Legal", isDefault: false },
      { id: "shared-view", orgId: "org-1", slug: "shared", name: "Shared (viewer)", isDefault: false },
    ]);
    const call = (body: object) => app.request("/mcp/tools/openUploader", { method: "POST", headers: { Authorization: "Bearer key", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const { env } = await import("../config.js");
    env.mcpAppsUiEnabled = true;
    try {
      const listed = await (await call({})).json();
      expect(listed.workspaces.map((item: { id: string }) => item.id)).toEqual(["default-ws", "ws-2"]);
      // A read-only share is not a valid target even when asked for by id.
      expect((await call({ workspace: "shared-view" })).status).toBe(403);
      // Default-workspace viewers may upload (listEditableWorkspaceIds includes the default for org members).
      listEditableWorkspaceIds.mockResolvedValue(["default-ws"]);
      const viewer = await (await call({})).json();
      expect(viewer.workspace.id).toBe("default-ws");
      expect(viewer.workspaces.map((item: { id: string }) => item.id)).toEqual(["default-ws"]);
      expect(listEditableWorkspaceIds).toHaveBeenCalledWith("user-1");
    } finally { env.mcpAppsUiEnabled = false; }
  });

  it("hides the uploader on every WebMCP (session-tools) surface via the explicit surface flag, not the path", async () => {
    const { env } = await import("../config.js");
    env.mcpAppsUiEnabled = true;
    try {
      const mount = (session: boolean) => new Hono()
        .use("*", async (c, next) => { setRequestActor(c, { type: "session", userId: "user-1", sessionId: "s", user: { id: "user-1", email: "", name: "" } }); await next(); })
        .route("/any/prefix", new Hono().use("*", session ? markSessionToolsSurface : async (_c, next) => { await next(); }).route("/", mcpAdapterRoutes));
      const hidden = mount(true);
      const shown = mount(false);
      const ids = async (app: Hono, path: string) => (await (await app.request(`/any/prefix/${path}`)).json())[path === "manifest" ? "capabilities" : "tools"].map((item: { id: string }) => item.id);
      for (const path of ["manifest", "tools"]) {
        expect(await ids(hidden, path)).not.toContain("openUploader");
        expect(await ids(shown, path)).toContain("openUploader");
      }
      const post = (app: Hono) => app.request("/any/prefix/tools/openUploader", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect((await post(hidden)).status).toBe(404);
    } finally { env.mcpAppsUiEnabled = false; }
  });

  it("answers 404 when the uploader target workspace does not exist", async () => {
    validateApiKey.mockResolvedValue({ ...validatedKey, scopes: ["ingest"] });
    listWorkspaces.mockResolvedValue([]);
    getWorkspace.mockResolvedValue(null);
    const { env } = await import("../config.js");
    env.mcpAppsUiEnabled = true;
    try {
      const response = await app.request("/mcp/tools/openUploader", { method: "POST", headers: { Authorization: "Bearer key", "Content-Type": "application/json" }, body: JSON.stringify({ workspace: "ghost" }) });
      expect(response.status).toBe(404);
      expect(listEditableWorkspaceIds).not.toHaveBeenCalled();
    } finally { env.mcpAppsUiEnabled = false; }
  });

  it("uploads URLs and requests up to ten single-part signed uploads with actor, default scope and retry key", async () => {
    validateApiKey.mockResolvedValue({ ...validatedKey, scopes: ["ingest"] });
    const headers = { Authorization: "Bearer key", "Content-Type": "application/json" };
    const response = await app.request("/mcp/tools/upload", { method: "POST", headers, body: JSON.stringify({ urls: ["https://example.com/manual.pdf"], idempotencyKey: "retry-1" }) });
    expect(response.status).toBe(201);
    expect(uploadRequest).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/url", actor: expect.objectContaining({ userId: "user-1", apiKey: expect.objectContaining({ orgId: "org-1" }) }), body: { urls: ["https://example.com/manual.pdf"] }, idempotencyKey: "retry-1" }));
    // An omitted workspace is left to the uploads route, which files it into the default workspace.
    const text = await app.request("/mcp/tools/upload", { method: "POST", headers, body: JSON.stringify({ workspace: "ws-1", files: Array.from({ length: 10 }, (_, i) => ({ filename: `notes-${i}.pdf`, sizeBytes: 40 * 1024 * 1024, mimeType: "application/pdf" })) }) });
    expect(text.status).toBe(201);
    const call = uploadRequest.mock.lastCall![0];
    expect(call.path).toBe("/direct/sessions");
    expect(call.body.workspace).toBe("ws-1");
    expect(call.body.files).toHaveLength(10);
    expect(call.body.files.every((file: { singlePart: boolean }) => file.singlePart)).toBe(true);
  });

  it("preserves an explicitly named new workspace for signed-upload completion", async () => {
    validateApiKey.mockResolvedValue({ ...validatedKey, scopes: ["ingest"] });
    const response = await app.request("/mcp/tools/upload", { method: "POST", headers: { Authorization: "Bearer key", "Content-Type": "application/json" }, body: JSON.stringify({ workspace: "Legal contracts", files: [{ filename: "contract.pdf", sizeBytes: 42, mimeType: "application/pdf" }] }) });
    expect(response.status).toBe(201);
    expect(uploadRequest.mock.lastCall![0].body).toEqual({ workspace: "Legal contracts", files: [{ filename: "contract.pdf", sizeBytes: 42, mimeType: "application/pdf", singlePart: true }] });
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
    expect(uploadRequest).not.toHaveBeenCalled();
    // The uploads route resolves the workspace inside the key's allowlist (a
    // restricted key can neither reach nor create others); MCP forwards the
    // value with the restricted actor and passes the route's refusal through.
    validateApiKey.mockResolvedValue({ ...validatedKey, scopes: ["ingest"], workspaceIds: ["ws-1"] });
    uploadRequest.mockReturnValueOnce(Response.json({ error: { code: "workspace_not_found" } }, { status: 404 }));
    expect((await request({ ...input, workspace: "00000000-0000-4000-8000-00000000f0f0" })).status).toBe(404);
    uploadRequest.mockReturnValueOnce(Response.json({ error: { code: "forbidden" } }, { status: 403 }));
    expect((await request({ ...input, workspace: "New" })).status).toBe(403);
    expect(uploadRequest.mock.calls.map(([call]) => [call.body.workspace, call.actor.apiKey.workspaceIds])).toEqual([
      ["00000000-0000-4000-8000-00000000f0f0", ["ws-1"]],
      ["New", ["ws-1"]],
    ]);
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
    expect((await response.json()).tools.map((tool: { id: string }) => tool.id)).toEqual(["listWorkspaces", "search", "chat", "getUploadStatus", "getMediaEvidence", "suggestQueries", "getJob"]);
    const manifest = await app.request("/mcp/manifest", { headers: { Authorization: "Bearer dslp_test" } });
    expect((await manifest.json()).server.transports).toEqual(["streamable-http", "stdio"]);
  });

  it.each(["null", "[]", "{", '"string"'])("rejects malformed tool bodies with HTTP 400: %s", async (body) => {
    const response = await app.request("/mcp/tools/search", {
      method: "POST", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json" }, body,
    });
    expect(response.status).toBe(400);
  });

  it.each([
    ["search", { workspace: "", q: "query" }],
    ["search", { workspace: "00000000-0000-4000-8000-000000000001", q: " " }],
    ["suggestQueries", { workspace: "00000000-0000-4000-8000-000000000001", limit: -1 }],
    ["getUploadStatus", { documentIds: Array.from({ length: 101 }, (_, index) => `d${index}`) }],
    ["getUploadStatus", { workspace: "ws-1", sql: "drop table documents" }],
    ["chat", { workspace: "ws-1", q: " " }],
    ["search", { queries: [] }],
    ["search", { queries: [{ workspace: "ws-1", q: "query" }], concurrency: 9 }],
  ])("rejects invalid %s arguments before running the tool", async (tool, body) => {
    const response = await app.request(`/mcp/tools/${tool}`, {
      method: "POST", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  });

  it("never lets a remote MCP caller pre-approve spend", async () => {
    const tools = (await (await app.request("/mcp/tools", { headers: { Authorization: "Bearer dslp_test" } })).json()).tools as Array<{ id: string; inputSchema: unknown }>;
    expect(JSON.stringify(tools.map((tool) => tool.inputSchema))).not.toMatch(/approve/i);
  });

  it("offers each estimate tool only to keys that could perform its mutation", async () => {
    const listed = async (key: Partial<ValidatedKey>) => {
      validateApiKey.mockResolvedValueOnce({ ...validatedKey, ...key });
      const res = await app.request("/mcp/tools", { headers: { Authorization: "Bearer dslp_test" } });
      return (await res.json()).tools.map((tool: { id: string }) => tool.id).filter((id: string) => id.endsWith("Estimate"));
    };
    expect(await listed({ scopes: ["search", "ingest", "workspaces:manage"], keyType: "server" })).toEqual([
      "updateEstimate", "fullIndexEstimate", "indexingModeEstimate", "graphRebuildEstimate", "uploadEstimate",
    ]);
    expect(await listed({ scopes: ["ingest"] })).toEqual(["fullIndexEstimate", "uploadEstimate"]);
    expect(await listed({ scopes: ["search"] })).toEqual([]);
  });

  describe("estimate tools and getJob", () => {
    const post = (tool: string, body: unknown) => app.request(`/mcp/tools/${tool}`, {
      method: "POST", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    beforeEach(() => {
      validateApiKey.mockResolvedValue({ ...validatedKey, scopes: ["search", "ingest", "workspaces:manage"] });
      forwardInProcess.mockReset();
      forwardInProcess.mockImplementation(async () => Response.json({ estimate: { pages: 3 }, billing: "disabled" }));
    });

    it("resolves the workspace and forwards the mutation body to the estimate route", async () => {
      const response = await post("indexingModeEstimate", { workspace: "ws-1", mode: "map" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ tool: "indexingModeEstimate", estimate: { pages: 3 } });
      expect(forwardInProcess).toHaveBeenCalledWith(expect.anything(), "POST", "/v1/workspaces/ws-1/indexing-mode/estimate", { mode: "map" }, expect.anything());
    });

    it("does not forward for a foreign workspace or invalid input", async () => {
      expect((await post("graphRebuildEstimate", { workspace: "foreign" })).status).toBe(404);
      expect((await post("indexingModeEstimate", { workspace: "ws-1", mode: "bogus" })).status).toBe(400);
      expect(forwardInProcess).not.toHaveBeenCalled();
    });

    it("requires the mutation's scope and key type, and never offers session-only estimates to keys", async () => {
      expect((await post("uploadEstimate", { workspace: "ws-1", files: [{ name: "a.pdf", size: 1 }] })).status).toBe(200);
      validateApiKey.mockResolvedValueOnce({ ...validatedKey, scopes: ["search"] });
      expect((await post("uploadEstimate", { workspace: "ws-1", files: [{ name: "a.pdf", size: 1 }] })).status).toBe(403);
      validateApiKey.mockResolvedValueOnce({ ...validatedKey, scopes: ["search", "ingest"] });
      expect((await post("updateEstimate", { workspace: "ws-1", changes: {} })).status).toBe(403);
      // reprocess and search-settings mutations accept no API key, so neither do their estimates.
      expect((await post("reprocessEstimate", { runId: "r1" })).status).toBe(403);
      expect((await post("searchSettingsEstimate", { workspace: "ws-1", changes: {} })).status).toBe(403);
      expect(forwardInProcess).toHaveBeenCalledTimes(1);
    });

    it("getJob forwards to /v1/jobs/:id and surfaces route_unavailable", async () => {
      forwardInProcess.mockResolvedValueOnce(Response.json({ id: "j1", status: "queued" }));
      expect(await (await post("getJob", { jobId: "j1" })).json()).toMatchObject({ tool: "getJob", job: { id: "j1" } });
      expect(forwardInProcess).toHaveBeenCalledWith(expect.anything(), "GET", "/v1/jobs/j1", undefined, expect.anything());
      forwardInProcess.mockResolvedValueOnce(Response.json({ code: "route_unavailable" }, { status: 501 }));
      const missing = await post("getJob", { jobId: "j1" });
      expect(missing.status).toBe(501);
      expect(await missing.json()).toMatchObject({ code: "route_unavailable" });
    });
  });

  it("requires a bearer key and enforces search scope", async () => {
    expect((await app.request("/mcp/tools")).status).toBe(401);
    validateApiKey.mockResolvedValueOnce({ ...validatedKey, scopes: ["ingest"] });
    const response = await app.request("/mcp/tools/suggestQueries", {
      method: "POST", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(403);
  });

  it("advertises safe names, explicit upload alternatives and mutation annotations", async () => {
    validateApiKey.mockResolvedValue({ ...validatedKey, scopes: ["search", "ingest"] });
    const client = new Client({ name: "catalog-contract", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:4321/mcp"), { requestInit: { headers: { Authorization: "Bearer key" } }, fetch: async (url, init) => app.request(new Request(url, init)) }));
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(11);
    expect(new Set(tools.map(tool => tool.name)).size).toBe(11);
    expect(tools.every(tool => /^[A-Za-z0-9_.-]{1,128}$/.test(tool.name))).toBe(true);
    for (const name of ["upload", "completeUpload", "chat"]) {
      expect(tools.find(tool => tool.name === name)?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    }
    for (const name of ["listWorkspaces", "search", "getUploadStatus", "getMediaEvidence", "suggestQueries"]) {
      expect(tools.find(tool => tool.name === name)?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
    }
    const upload = tools.find(tool => tool.name === "upload")!;
    expect(upload.inputSchema).not.toHaveProperty("oneOf");
    expect(upload.inputSchema.additionalProperties).toBe(false);
    expect(upload.annotations?.openWorldHint).toBe(true);
    const result = await client.callTool({ name: "upload", arguments: { files: [] } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toHaveProperty("error");
    await client.close();
  });

  it("offers a real HTTP MCP endpoint and preserves scoped actor on tool dispatch", async () => {
    const client = new Client({ name: "http-route-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:4321/mcp"), {
      requestInit: { headers: { Authorization: "Bearer dslp_test" } },
      fetch: async (url, init) => app.request(new Request(url, init)),
    }));
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain("search");
    const called = await client.callTool({ name: "search", arguments: { q: "audience?", workspace: "ws-1" } });
    expect(called.isError).toBe(false);
    expect(hybridSearch).toHaveBeenCalledWith("audience?", "user-1", expect.anything());
    await client.close();
  });

  it("rejects untrusted Origin and Host without executing a tool", async () => {
    const init = { method: "POST", body: "{}", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json", Origin: "https://evil.example" } };
    expect((await app.request("http://localhost:4321/mcp", init)).status).toBe(403);
    const host = await app.request("http://localhost:4321/mcp", { ...init, headers: { ...init.headers, Origin: "http://localhost:4321", Host: "evil.example" } });
    expect(host.status).toBe(403);
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it("requires bearer authentication on the protocol endpoint", async () => {
    const response = await app.request("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource/v1/mcp");
  });

  it("returns portable cited search data and a direct grounded chat answer", async () => {
    chatWorkspace.mockResolvedValueOnce({ answer: "Weekdays [1]", citations: [{ filename: "guide.txt", pageNumber: 1 }], sessionId: "chat-1", usage: { inputTokens: 10, outputTokens: 3 } });
    const call = (name: string, args: unknown) => app.request(`/mcp/tools/${name}`, {
      method: "POST", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json" }, body: JSON.stringify(args),
    });
    expect(await (await call("search", { workspace: "ws-1", q: "Support hours?" })).json()).toMatchObject({ results: [{ text: "Support hours" }], sessionId: "retrieval-1", availability: { status: "ready" } });
    const chat = await call("chat", { workspace: "ws-1", q: "Support hours?", sessionId: "chat-existing" });
    expect(await chat.json()).toMatchObject({ answer: "Weekdays [1]", citations: [{ filename: "guide.txt" }], usage: { outputTokens: 3 } });
    expect(chatWorkspace).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1", userId: "user-1", query: "Support hours?", sessionId: "chat-existing" }));
    expect(hybridSearch).toHaveBeenCalledWith("Support hours?", "user-1", expect.objectContaining({ useHyDE: undefined, useRerank: undefined, queryRewrite: undefined }));
  });

  it("keeps parallel retrieval results ordered and denies foreign workspaces before retrieval", async () => {
    const response = await app.request("/mcp/tools/search", {
      method: "POST", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json" }, body: JSON.stringify({ queries: [{ q: "first", workspace: "ws-1" }, { q: "private", workspace: "foreign" }] }),
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
    expect((await listed.json()).tools.map((tool: { id: string }) => tool.id)).toEqual(["listWorkspaces", "upload", "completeUpload", "getUploadStatus", "fullIndexEstimate", "uploadEstimate", "getJob"]);
    for (const name of ["search", "chat"]) {
      expect((await app.request(`/mcp/tools/${name}`, { method: "POST", headers: { Authorization: "Bearer dslp_test", "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
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
    const search = await client.callTool({ name: "search", arguments: { q: "Support?", workspace: "ws-1" } });
    expect(search.structuredContent).toMatchObject({ usage: { totalTokens: 7, costCents: 0.001, costSource: "provider" } });
    const batch = await client.callTool({ name: "search", arguments: { queries: [{ q: "Support?", workspace: "ws-1" }] } });
    expect(batch.structuredContent).toMatchObject({ results: [{ ok: true, data: { results: [{ text: "Support hours" }] } }] });
    const chat = await client.callTool({ name: "chat", arguments: { q: "Support?", workspace: "ws-1" } });
    expect(chat.structuredContent).toMatchObject({ answer: "Weekdays [1]", usage: { outputTokens: 3 } });
    expect(chatWorkspace).toHaveBeenCalledWith(expect.objectContaining({ actor: expect.objectContaining({ type: "apiKey", apiKey: validatedKey }), allowAgentTools: false, allowConfiguration: false }));
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
    getWorkspace.mockImplementation(async (id: string) => id === "foreign" ? null : { id, orgId: "org-1" });
    hybridSearch.mockClear();
  });
  const headers = { Origin: "http://localhost:4321", "Content-Type": "application/json" };

  it("uses the authenticated session identity and preserves workspace access checks", async () => {
    const response = await app.request("/tools/tools/search", { method: "POST", headers, body: JSON.stringify({ workspace: "ws-1", q: "hello" }) });
    expect(response.status).toBe(200);
    expect(hybridSearch).toHaveBeenCalledWith("hello", "user-1", expect.anything());
    expect((await app.request("/tools/tools/suggestQueries", { method: "POST", headers, body: JSON.stringify({ workspace: "foreign" }) })).status).toBe(404);
  });

  it("returns a read-only ingest report for an accessible workspace and hides foreign ones", async () => {
    loadIngestReport.mockClear();
    const response = await app.request("/tools/tools/getUploadStatus", { method: "POST", headers, body: JSON.stringify({ workspace: "ws-1", runId: "run-1" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ tool: "getUploadStatus", summary: expect.stringContaining("Ingest report"), report: { workspaceId: "ws-1" } });
    expect(loadIngestReport).toHaveBeenCalledWith(expect.objectContaining({ canEdit: false, runId: "run-1", workspace: expect.objectContaining({ id: "ws-1" }) }));
    expect((await app.request("/tools/tools/getUploadStatus", { method: "POST", headers, body: JSON.stringify({ workspace: "foreign" }) })).status).toBe(404);
    expect(loadIngestReport).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "https://foreign.example", "null"])("rejects an untrusted execution origin: %s", async origin => {
    const response = await app.request("/tools/tools/search", { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: '{"q":"hello"}' });
    expect(response.status).toBe(403);
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it.each([
    [{ Origin: "https://foreign.example" }],
    [{ Origin: "null" }],
    [{ "Sec-Fetch-Site": "cross-site" }],
    [{ "Sec-Fetch-Site": "same-site" }],
  ])("rejects a cross-origin read of the tool catalog: %o", async extra => {
    const response = await app.request("/tools/tools", { headers: extra });
    expect(response.status).toBe(403);
  });

  it.each([
    [{}],
    [{ Origin: "http://localhost:4321" }],
    [{ "Sec-Fetch-Site": "same-origin" }],
  ])("allows same-origin reads of the tool catalog: %o", async extra => {
    const response = await app.request("/tools/tools", { headers: extra });
    expect(response.status).toBe(200);
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
    expect(tools.map((tool: { id: string }) => tool.id)).toEqual(["listWorkspaces", "upload", "completeUpload", "search", "chat", "getUploadStatus", "getMediaEvidence", "suggestQueries", "updateEstimate", "searchSettingsEstimate", "reprocessEstimate", "fullIndexEstimate", "indexingModeEstimate", "graphRebuildEstimate", "uploadEstimate", "getJob"]);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

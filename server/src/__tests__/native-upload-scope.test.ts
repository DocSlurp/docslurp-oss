import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ intake: vi.fn(), direct: vi.fn(), sessionAccess: vi.fn(), workspace: vi.fn(), lookup: vi.fn(), requireWorkspace: vi.fn() }));
vi.mock("../lib/request-actor.js", () => ({
  getRequestActor: (c: any) => ({ type: "apiKey", userId: "user-a", apiKey: c.get("apiKey") }),
  actorHasAnyApiKeyScope: (actor: any, scopes: string[]) => scopes.some(scope => actor.apiKey.scopes.includes(scope)),
  lookupActorWorkspace: mocks.lookup,
  requireActorWorkspace: mocks.requireWorkspace,
}));
vi.mock("../services/workspace-intake-actions.js", () => ({
  createBulkWorkspaceIntake: mocks.intake, createRemoteUrlWorkspaceIntake: mocks.intake,
  parseFormWorkspaceIntakePipeline: vi.fn(), parseWorkspaceIntakePipeline: vi.fn(),
  parseFormDocumentTags: vi.fn(),
  parseWorkspaceIntakeTemplateKey: vi.fn(value => value), confirmDirectUploadWorkspaceIntake: vi.fn(),
}));
vi.mock("../services/direct-upload-session.js", () => ({
  createDirectUploadSession: mocks.direct, directUploadSessionBelongsToOrganization: mocks.sessionAccess,
  abortDirectUploadSession: vi.fn(), completeDirectUploadFile: vi.fn(), getDirectUploadSessionDescription: vi.fn(),
}));
vi.mock("../services/runs.js", () => ({ isRunCreationBlockedError: vi.fn(() => false) }));
vi.mock("../services/workspaces.js", () => ({
  getWorkspace: vi.fn(), ensureDefaultWorkspace: vi.fn(async () => ({ id: "ws-default" })),
}));
const { uploadsRoutes } = await import("../routes/uploads.js");
function app(orgId: string | null = "org-a", workspaceIds: string[] = [], keyType = "server", scopes = ["ingest"]) {
  const server = new Hono(); server.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-a", email: "", name: "" });
    c.set("apiKey", { orgId, workspaceIds, keyType, scopes } as never); await next();
  }); return server.route("/uploads", uploadsRoutes);
}
function upload(fields: Record<string, string | undefined> = {}) {
  const form = new FormData(); form.append("files", new File(["authored text"], "note.txt"));
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) form.append(key, value);
  return { method: "POST", body: form };
}
describe("native key ingestion organization isolation", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.intake.mockResolvedValue({ payload: { ok: true }, status: 201 }); });
  it.each(["bad", "x".repeat(8192)])("rejects malformed session identifiers before lookup", async id => {
    expect((await app().request(`/uploads/direct/sessions/${id}`)).status).toBe(400);
    expect(mocks.sessionAccess).not.toHaveBeenCalled();
  });
  it.each([["client", ["ingest"]], ["server", ["search"]]])("rejects prohibited key type/scope", async (type, scopes) => {
    expect((await app("org-a", [], type as string, scopes as string[]).request("/uploads/direct/sessions/11111111-1111-4111-8111-111111111111")).status).toBe(403);
    expect(mocks.sessionAccess).not.toHaveBeenCalled();
  });
  it.each([
    { newWorkspace: "true" }, { templateKey: "legal-contracts" },
  ])("rejects every bulk workspace creation signal for scoped keys: %j", async fields => {
    expect((await app("org-a", ["ws-a"]).request("/uploads/bulk", upload(fields))).status).toBe(403);
    expect(mocks.intake).not.toHaveBeenCalled();
  });
  it.each([{ newWorkspace: true }, { templateKey: "legal-contracts" }])("rejects URL workspace creation for scoped keys: %j", async fields => {
    const response = await app("org-a", ["ws-a"]).request("/uploads/url", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...fields, urls: ["https://example.com/doc.pdf"] }),
    });
    expect(response.status).toBe(403);
    expect(mocks.intake).not.toHaveBeenCalled();
  });
  it.each([{ workspace: "New workspace" }, { newWorkspace: true }, { templateKey: "legal-contracts" }])("rejects direct workspace creation for scoped keys: %j", async fields => {
    mocks.lookup.mockResolvedValue(fields.workspace
      ? { ref: { kind: "slug", name: fields.workspace, slug: "new-workspace" }, workspace: null }
      : { ref: { kind: "default" } });
    const response = await app("org-a", ["ws-a"]).request("/uploads/direct/sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...fields, files: [{ filename: "doc.txt", mimeType: "text/plain", sizeBytes: 12 }] }),
    });
    expect(response.status).toBe(403);
    expect(mocks.direct).not.toHaveBeenCalled();
  });
  it("allows an explicitly targeted default workspace despite creation flags", async () => {
    const response = await app("org-a", ["ws-a"]).request("/uploads/url", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: "default", newWorkspace: true, templateKey: "legal-contracts", urls: ["https://example.com/doc.pdf"] }),
    });
    expect(response.status).toBe(201);
    expect(mocks.intake).toHaveBeenCalledWith(expect.objectContaining({ workspace: "default", allowedWorkspaceIds: ["ws-a"] }), expect.anything());
  });
  it("binds new workspaces to the key organization", async () => {
    expect((await app().request("/uploads/bulk", upload())).status).toBe(201);
    expect(mocks.intake).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-a", workspace: null, allowedWorkspaceIds: null }), expect.anything());
  });
  it("rejects an explicit foreign organization before intake", async () => {
    expect((await app().request("/uploads/bulk", upload({ orgId: "org-b" }))).status).toBe(403);
    expect(mocks.intake).not.toHaveBeenCalled();
  });
  it("resolves the workspace inside the key organization and allowlist, answering intake's 404", async () => {
    const { WorkspaceAccessError } = await import("../services/default-workspace.js");
    mocks.intake.mockRejectedValueOnce(new WorkspaceAccessError(404, "workspace_not_found", "Workspace not found"));
    const response = await app("org-a", ["ws-allowed"]).request("/uploads/bulk", upload({ workspace: "foreign" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "workspace_not_found" } });
    // The route never pre-resolves the value; intake scopes it to the key's org and allowlist.
    expect(mocks.intake).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-a", workspace: "foreign", allowedWorkspaceIds: ["ws-allowed"] }), expect.anything());
  });
  it.each(["/uploads/url", "/uploads/direct/sessions"])("rejects foreign org on JSON intake %s", async path => {
    expect((await app().request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId: "org-b" }) })).status).toBe(403);
    expect(mocks.intake).not.toHaveBeenCalled(); expect(mocks.direct).not.toHaveBeenCalled();
  });
  it.each(["/uploads/direct/sessions/11111111-1111-4111-8111-111111111111", "/uploads/direct/sessions/11111111-1111-4111-8111-111111111111/abort", "/uploads/direct/sessions/11111111-1111-4111-8111-111111111111/confirm", "/uploads/direct/sessions/11111111-1111-4111-8111-111111111111/files/complete"])("hides foreign direct-upload sessions at %s", async path => {
    mocks.sessionAccess.mockResolvedValue(false);
    expect((await app().request(path, { method: path.endsWith("/11111111-1111-4111-8111-111111111111") ? "GET" : "POST" })).status).toBe(404);
    expect(mocks.sessionAccess).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "user-a", "org-a", null);
  });
  it("rejects keys without an organization", async () => {
    expect((await app(null).request("/uploads/bulk", upload())).status).toBe(403);
    expect(mocks.intake).not.toHaveBeenCalled();
  });
});

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ intake: vi.fn(), direct: vi.fn(), sessionAccess: vi.fn(), workspace: vi.fn() }));
vi.mock("../lib/request-actor.js", () => ({
  getRequestActor: (c: any) => ({ type: "apiKey", userId: "user-a", apiKey: c.get("apiKey") }),
  actorHasAnyApiKeyScope: (actor: any, scopes: string[]) => scopes.some(scope => actor.apiKey.scopes.includes(scope)),
  loadActorScopedWorkspace: mocks.workspace,
}));
vi.mock("../services/workspace-intake-actions.js", () => ({
  createBulkWorkspaceIntake: mocks.intake, createRemoteUrlWorkspaceIntake: mocks.intake,
  parseFormWorkspaceIntakePipeline: vi.fn(), parseWorkspaceIntakePipeline: vi.fn(),
  parseWorkspaceIntakeTemplateKey: vi.fn(), confirmDirectUploadWorkspaceIntake: vi.fn(),
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
function app(orgId: string | null = "org-a") {
  const server = new Hono(); server.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-a", email: "", name: "" });
    c.set("apiKey", { orgId, scopes: ["ingest"] } as never); await next();
  }); return server.route("/uploads", uploadsRoutes);
}
function upload(fields: Record<string, string> = {}) {
  const form = new FormData(); form.append("files", new File(["authored text"], "note.txt"));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return { method: "POST", body: form };
}
describe("native key ingestion organization isolation", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.intake.mockResolvedValue({ payload: { ok: true }, status: 201 }); });
  it("binds new workspaces to the key organization", async () => {
    expect((await app().request("/uploads/bulk", upload())).status).toBe(201);
    expect(mocks.intake).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-a", workspaceId: null }), expect.anything());
  });
  it("rejects an explicit foreign organization before intake", async () => {
    expect((await app().request("/uploads/bulk", upload({ orgId: "org-b" }))).status).toBe(403);
    expect(mocks.intake).not.toHaveBeenCalled();
  });
  it("hides foreign workspaces before any ingestion side effect", async () => {
    mocks.workspace.mockResolvedValue(null);
    expect((await app().request("/uploads/bulk", upload({ workspaceId: "foreign" }))).status).toBe(404);
    expect(mocks.intake).not.toHaveBeenCalled();
  });
  it.each(["/uploads/url", "/uploads/direct/sessions"])("rejects foreign org on JSON intake %s", async path => {
    expect((await app().request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId: "org-b" }) })).status).toBe(403);
    expect(mocks.intake).not.toHaveBeenCalled(); expect(mocks.direct).not.toHaveBeenCalled();
  });
  it.each(["/uploads/direct/sessions/foreign", "/uploads/direct/sessions/foreign/abort", "/uploads/direct/sessions/foreign/confirm", "/uploads/direct/sessions/foreign/files/complete"])("hides foreign direct-upload sessions at %s", async path => {
    mocks.sessionAccess.mockResolvedValue(false);
    expect((await app().request(path, { method: path.endsWith("/foreign") ? "GET" : "POST" })).status).toBe(404);
    expect(mocks.sessionAccess).toHaveBeenCalledWith("foreign", "user-a", "org-a");
  });
  it("rejects keys without an organization", async () => {
    expect((await app(null).request("/uploads/bulk", upload())).status).toBe(403);
    expect(mocks.intake).not.toHaveBeenCalled();
  });
});

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ intake: vi.fn(), direct: vi.fn(), sessionAccess: vi.fn(), project: vi.fn(), lookup: vi.fn(), requireProject: vi.fn() }));
vi.mock("../lib/request-actor.js", () => ({
  getRequestActor: (c: any) => ({ type: "apiKey", userId: "user-a", apiKey: c.get("apiKey") }),
  actorHasAnyApiKeyScope: (actor: any, scopes: string[]) => scopes.some(scope => actor.apiKey.scopes.includes(scope)),
  lookupActorProject: mocks.lookup,
  requireActorProject: mocks.requireProject,
}));
vi.mock("../services/project-intake-actions.js", () => ({
  createBulkProjectIntake: mocks.intake, createRemoteUrlProjectIntake: mocks.intake,
  parseFormProjectIntakePipeline: vi.fn(), parseProjectIntakePipeline: vi.fn(),
  parseFormDocumentTags: vi.fn(), assertIntakeChartExportTier: vi.fn(),
  parseProjectIntakeTemplateKey: vi.fn(value => value), confirmDirectUploadProjectIntake: vi.fn(),
}));
vi.mock("../services/direct-upload-session.js", () => ({
  createDirectUploadSession: mocks.direct, directUploadSessionBelongsToOrganization: mocks.sessionAccess,
  abortDirectUploadSession: vi.fn(), completeDirectUploadFile: vi.fn(), getDirectUploadSessionDescription: vi.fn(),
}));
vi.mock("../services/runs.js", () => ({ isRunCreationBlockedError: vi.fn(() => false) }));
vi.mock("../services/projects.js", () => ({
  getProject: vi.fn(), ensureDefaultProject: vi.fn(async () => ({ id: "ws-default" })),
}));
const { uploadsRoutes } = await import("../routes/uploads.js");
function app(orgId: string | null = "org-a", projectIds: string[] = [], keyType = "server", scopes = ["ingest"]) {
  const server = new Hono(); server.use("*", async (c, next) => {
    c.set("sessionUser", { id: "user-a", email: "", name: "" });
    c.set("apiKey", { orgId, projectIds, keyType, scopes } as never); await next();
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
    { newProject: "true" }, { templateKey: "legal-contracts" },
  ])("rejects every bulk project creation signal for scoped keys: %j", async fields => {
    expect((await app("org-a", ["ws-a"]).request("/uploads/bulk", upload(fields))).status).toBe(403);
    expect(mocks.intake).not.toHaveBeenCalled();
  });
  it.each([{ newProject: true }, { templateKey: "legal-contracts" }])("rejects URL project creation for scoped keys: %j", async fields => {
    const response = await app("org-a", ["ws-a"]).request("/uploads/url", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...fields, urls: ["https://example.com/doc.pdf"] }),
    });
    expect(response.status).toBe(403);
    expect(mocks.intake).not.toHaveBeenCalled();
  });
  it.each([{ project: "New project" }, { newProject: true }, { templateKey: "legal-contracts" }])("rejects direct project creation for scoped keys: %j", async fields => {
    mocks.lookup.mockResolvedValue(fields.project
      ? { ref: { kind: "slug", name: fields.project, slug: "new-project" }, project: null }
      : { ref: { kind: "default" } });
    const response = await app("org-a", ["ws-a"]).request("/uploads/direct/sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...fields, files: [{ filename: "doc.txt", mimeType: "text/plain", sizeBytes: 12 }] }),
    });
    expect(response.status).toBe(403);
    expect(mocks.direct).not.toHaveBeenCalled();
  });
  it("allows an explicitly targeted default project despite creation flags", async () => {
    const response = await app("org-a", ["ws-a"]).request("/uploads/url", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "default", newProject: true, templateKey: "legal-contracts", urls: ["https://example.com/doc.pdf"] }),
    });
    expect(response.status).toBe(201);
    expect(mocks.intake).toHaveBeenCalledWith(expect.objectContaining({ project: "default", allowedProjectIds: ["ws-a"] }), expect.anything());
  });
  it("binds new projects to the key organization", async () => {
    expect((await app().request("/uploads/bulk", upload())).status).toBe(201);
    expect(mocks.intake).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-a", project: null, allowedProjectIds: null }), expect.anything());
  });
  it("rejects an explicit foreign organization before intake", async () => {
    expect((await app().request("/uploads/bulk", upload({ orgId: "org-b" }))).status).toBe(403);
    expect(mocks.intake).not.toHaveBeenCalled();
  });
  it("resolves the project inside the key organization and allowlist, answering intake's 404", async () => {
    const { ProjectAccessError } = await import("../services/default-project.js");
    mocks.intake.mockRejectedValueOnce(new ProjectAccessError(404, "project_not_found", "Project not found"));
    const response = await app("org-a", ["ws-allowed"]).request("/uploads/bulk", upload({ project: "foreign" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "project_not_found" } });
    // The route never pre-resolves the value; intake scopes it to the key's org and allowlist.
    expect(mocks.intake).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-a", project: "foreign", allowedProjectIds: ["ws-allowed"] }), expect.anything());
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

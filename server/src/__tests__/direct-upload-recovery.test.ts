import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  sql: Object.assign(vi.fn(), { json: (v: unknown) => v, array: (v: unknown) => v }),
  load: vi.fn(), prepare: vi.fn(), intake: vi.fn(), discard: vi.fn(), workspace: vi.fn(), multipart: vi.fn(),
}));
vi.mock("../db.js", () => ({ sql: mocks.sql }));
vi.mock("../services/run-creation.js", () => ({ discardUnstartedRun: mocks.discard }));
vi.mock("../services/workspaces.js", () => ({ getWorkspace: mocks.workspace }));
vi.mock("../services/run-records.js", () => ({ mapWorkspaceRun: (v: unknown) => v, mapDocument: (v: unknown) => v }));
vi.mock("../services/idempotency.js", () => ({ getCachedIdempotentResponse: vi.fn(), hashIdempotencyPayload: vi.fn(), storeIdempotentResponse: vi.fn() }));
vi.mock("../services/remote-ingest.js", () => ({ remoteUrlIntakeItems: vi.fn() }));
vi.mock("../lib/storage.js", () => ({ abortMultipartUpload: vi.fn(), completeMultipartUpload: vi.fn(), createMultipartUpload: mocks.multipart, getUploadedObjectMetadata: vi.fn(), listMultipartUploadParts: vi.fn(), signMultipartUploadPart: vi.fn(), signSingleUploadPut: vi.fn() }));
vi.mock("../services/workspace-intake.js", () => ({
  intakeIntoWorkspace: mocks.intake, workspaceIntakePorts: {},
  WorkspaceIntakeError: class extends Error { constructor(message: string, public statusCode: number) { super(message); } },
  admitIntakeFile: (v: unknown) => v, rawSourceKey: (_u: string, name: string) => `raw/${name}`,
}));
vi.mock("../services/direct-upload-session.js", async original => ({
  ...await original<typeof import("../services/direct-upload-session.js")>(),
  loadDirectUploadSession: mocks.load, prepareDirectUploadWorkspaceIntake: mocks.prepare,
  withDirectUploadLock: async (_id: string, run: () => Promise<unknown>) => run(),
}));
import { confirmDirectUploadWorkspaceIntake } from "../services/workspace-intake-actions.js";
import { createDirectUploadSession, directUploadSessionBelongsToOrganization } from "../services/direct-upload-session.js";
import type { WorkspaceIntakePorts } from "../services/workspace-intake.js";
const session = { id: "session", user_id: "user", org_id: "org", workspace_id: "workspace", status: "ingesting", pipeline: {}, api_key_id: "key", allowed_workspace_ids: ["workspace"] };
const loaded = { session, files: [{ status: "completed" }] };
const payload = { workspace: { id: "workspace", orgId: "org" }, run: { id: "session" }, documents: [], warnings: [] };
const ports = { records: {} } as WorkspaceIntakePorts;
beforeEach(() => {
  vi.clearAllMocks(); mocks.sql.mockResolvedValue([]); mocks.load.mockResolvedValue(loaded);
  mocks.prepare.mockResolvedValue({ session, items: [] });
  mocks.intake.mockResolvedValue({ ...payload, pipeline: {}, deferredReason: null, rejected: [] });
  mocks.workspace.mockResolvedValue(payload.workspace);
});
describe("durable direct upload acceptance", () => {
  it("replays a saved response without creating or loading another run", async () => {
    const saved = { payload, status: 201, temporalDeferred: false };
    mocks.load.mockResolvedValue({ ...loaded, session: { ...session, status: "confirmed", result: saved } });
    expect(await confirmDirectUploadWorkspaceIntake({ sessionId: "session", userId: "user" }, ports)).toBe(saved);
    expect(mocks.sql).not.toHaveBeenCalled(); expect(mocks.intake).not.toHaveBeenCalled();
  });
  it("recovers a published run after a crash without creating a second run", async () => {
    const published = { id: "session", workspace_id: "workspace", creation_ready_at: "2026-10-23", pipeline: {} };
    mocks.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      if (strings.join("").includes("from workspace_runs")) return [published];
      if (strings.join("").includes("from documents")) return [{ id: "document", run_id: "session" }];
      return [];
    });
    const result = await confirmDirectUploadWorkspaceIntake({ sessionId: "session", userId: "user" }, ports);
    expect(result.payload.run.id).toBe("session");
    expect(result.payload.documents).toEqual([{ id: "document", run_id: "session" }]);
    expect(mocks.intake).not.toHaveBeenCalled(); expect(mocks.discard).not.toHaveBeenCalled();
    expect(mocks.sql.mock.calls.some(([s]) => s.join("").includes("result ="))).toBe(true);
  });
  it("reuses durable identity and original key scope after incomplete run recovery", async () => {
    mocks.sql.mockImplementation(async (s: TemplateStringsArray) => s.join("").includes("from workspace_runs") ? [{ id: "session", creation_ready_at: null }] : []);
    await confirmDirectUploadWorkspaceIntake({ sessionId: "session", userId: "user" }, ports);
    expect(mocks.discard).toHaveBeenCalledWith("session");
    expect(mocks.intake).toHaveBeenCalledWith(expect.objectContaining({ runId: "session", apiKeyId: "key", allowedWorkspaceIds: ["workspace"] }), expect.anything());
  });
  it("clears a newly created target if intake rolls the workspace back", async () => {
    const discardWorkspace = vi.fn(async () => {});
    mocks.intake.mockImplementationOnce(async (_request, wrapped) => { await wrapped.records.discardWorkspace("temporary"); throw new Error("Transient failure"); });
    await expect(confirmDirectUploadWorkspaceIntake({ sessionId: "session", userId: "user" }, { records: { discardWorkspace } } as unknown as WorkspaceIntakePorts)).rejects.toThrow("Transient failure");
    expect(discardWorkspace).toHaveBeenCalledWith("temporary");
    expect(mocks.sql.mock.calls.some(([s]) => s.join("").includes("workspace_id = null"))).toBe(true);
  });
});
describe("session scope and initialization", () => {
  it("denies sessions outside the current key's organization or workspace scope", async () => {
    mocks.sql.mockImplementation(async (s: TemplateStringsArray) => s.join("").includes("from upload_sessions") ? [session] : []);
    await expect(directUploadSessionBelongsToOrganization("session", "user", "org", ["other"])).resolves.toBe(false);
    await expect(directUploadSessionBelongsToOrganization("session", "user", "org", ["workspace"])).resolves.toBe(true);
    await expect(directUploadSessionBelongsToOrganization("session", "user", "other-org", null)).resolves.toBe(false);
    mocks.sql.mockImplementation(async (s: TemplateStringsArray) => s.join("").includes("from upload_sessions") ? [{ ...session, workspace_id: null }] : []);
    await expect(directUploadSessionBelongsToOrganization("session", "user", "org", ["workspace"])).resolves.toBe(false);
  });
  it("stays ineligible for reconciliation until provider and file initialization finish", async () => {
    const events: string[] = [];
    mocks.sql.mockImplementation(async (strings: TemplateStringsArray) => {
      const query = strings.join("");
      if (query.includes("insert into upload_sessions")) { expect(query).toContain("'initializing'"); events.push("initializing"); }
      if (query.includes("insert into upload_session_files")) events.push("file");
      if (query.includes("set status = 'pending'")) events.push("pending");
      return query.includes("from upload_sessions") ? [{ ...session, status: "pending" }] : [];
    });
    mocks.multipart.mockImplementationOnce(async () => { expect(events).toEqual(["initializing"]); events.push("provider"); return "upload"; });
    await createDirectUploadSession({ userId: "user", pipeline: {}, files: [{ filename: "stream.pdf", mimeType: "application/pdf" }] });
    expect(events).toEqual(["initializing", "provider", "file", "pending"]);
  });
});

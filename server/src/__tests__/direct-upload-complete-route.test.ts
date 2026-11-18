import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Request validation for POST /direct/sessions/:id/files/complete. The service is replaced: a refused body never reaches it.
const mocks = vi.hoisted(() => ({ single: vi.fn(), batch: vi.fn(), row: vi.fn() }));
vi.mock("../services/direct-upload-session.js", () => ({
  completeDirectUploadFile: mocks.single, completeDirectUploadFiles: mocks.batch,
  loadDirectUploadSessionRow: mocks.row, loadDirectUploadSession: vi.fn(),
  directUploadSessionBelongsToOrganization: vi.fn(), abortDirectUploadSession: vi.fn(),
  createDirectUploadSession: vi.fn(), getDirectUploadSessionDescription: vi.fn(), signDirectUploadParts: vi.fn(),
}));
const { createUploadsRoutes } = await import("../routes/uploads.js");
const { ProjectIntakeError } = await import("../services/project-intake.js");

const session = "11111111-1111-4111-8111-111111111111";
const app = new Hono().use("*", async (c, next) => { c.set("sessionUser", { id: "u", email: "u@example.test", name: "U" } as never); await next(); })
  .route("/uploads", createUploadsRoutes());
const complete = (body: unknown) => app.request(`/uploads/direct/sessions/${session}/files/complete`, {
  method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.row.mockResolvedValue(null);
  mocks.single.mockResolvedValue(undefined);
  mocks.batch.mockImplementation(async ({ files }: { files: Array<{ fileId: string }> }) => ({
    files: files.map(file => ({ fileId: file.fileId, status: "completed" })), completedCount: files.length, failedCount: 0, sessionComplete: false,
  }));
});

describe("files/complete request shapes", () => {
  it("keeps the single-file body and answer", async () => {
    const response = await complete({ fileId: "f1", sizeBytes: 3 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.single).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session, userId: "u", fileId: "f1", sizeBytes: 3 }));
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it("answers a batch per file, for this session and user only", async () => {
    const response = await complete({ files: [{ fileId: "f1" }, { fileId: "f2", sizeBytes: 9 }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, completedCount: 2, files: [{ fileId: "f1", status: "completed" }, { fileId: "f2", status: "completed" }] });
    expect(mocks.batch).toHaveBeenCalledWith({ sessionId: session, userId: "u", files: [{ fileId: "f1" }, { fileId: "f2", sizeBytes: 9 }] });
  });

  it("reports ok:false with 200 when some files fail", async () => {
    mocks.batch.mockResolvedValueOnce({ files: [{ fileId: "f1", status: "completed" }, { fileId: "f2", status: "failed", error: { statusCode: 409, code: "rejected", message: "changed" } }], completedCount: 1, failedCount: 1, sessionComplete: false });
    const response = await complete({ files: [{ fileId: "f1" }, { fileId: "f2" }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, failedCount: 1 });
  });

  it.each([
    ["an oversized batch", { files: Array.from({ length: 101 }, (_, i) => ({ fileId: `f${i}` })) }],
    ["an empty batch", { files: [] }],
    ["a duplicated fileId", { files: [{ fileId: "f1" }, { fileId: "f1" }] }],
    ["both shapes at once", { fileId: "f1", files: [{ fileId: "f2" }] }],
    ["a batch entry without fileId", { files: [{ sizeBytes: 3 }] }],
    ["an unknown batch field", { files: [{ fileId: "f1" }], projectId: "elsewhere" }],
  ])("refuses %s before the service", async (_label, body) => {
    expect((await complete(body)).status).toBe(400);
    expect(mocks.batch).not.toHaveBeenCalled();
    expect(mocks.single).not.toHaveBeenCalled();
  });

  it("refuses a body above the completion limit", async () => {
    const response = await complete(JSON.stringify({ files: [{ fileId: "f1", etag: "x".repeat(9 * 1024 * 1024) }] }));
    expect(response.status).toBe(413);
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it("fails the whole batch for a session-level problem, keeping its code", async () => {
    mocks.batch.mockRejectedValueOnce(new ProjectIntakeError("Upload session is being finalized; retry shortly", 409, undefined, "upload_session_busy"));
    const response = await complete({ files: [{ fileId: "f1" }] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "upload_session_busy" } });
  });
});

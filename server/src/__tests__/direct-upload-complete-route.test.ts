import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Request validation for POST /direct/sessions/:id/files/complete. The service is replaced: a refused body never reaches it.
const mocks = vi.hoisted(() => ({ single: vi.fn(), batch: vi.fn(), row: vi.fn(), abort: vi.fn() }));
vi.mock("../services/direct-upload-session.js", () => ({
  completeDirectUploadFile: mocks.single, completeDirectUploadFiles: mocks.batch,
  loadDirectUploadSessionRow: mocks.row, loadDirectUploadSession: vi.fn(),
  directUploadSessionBelongsToOrganization: vi.fn(), abortDirectUploadSession: mocks.abort,
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
  mocks.single.mockResolvedValue({ sessionComplete: false });
  mocks.abort.mockResolvedValue(true);
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
    expect(mocks.batch).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session, userId: "u", files: [{ fileId: "f1" }, { fileId: "f2", sizeBytes: 9 }] }));
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

  it("refuses a body above the single-file limit", async () => {
    const response = await complete(JSON.stringify({ fileId: "f1", etag: "x".repeat(2 * 1024 * 1024) }));
    expect(response.status).toBe(413);
    expect(mocks.single).not.toHaveBeenCalled();
  });

  it("caps a batch body at a few KiB and refuses nested part manifests in batch entries", async () => {
    // Within the old 8 MiB cap this carried hundreds of thousands of nested entries; now it is refused by size first.
    const nested = { files: [{ fileId: "f1", parts: Array.from({ length: 50_000 }, () => ({ partNumber: "x", etag: 1 })) }] };
    const huge = await complete(nested);
    expect(huge.status).toBe(413);
    // Small enough to pass the size cap, but batch entries take no parts at all.
    const withParts = await complete({ files: [{ fileId: "f1", parts: [{ partNumber: 1, etag: "e" }] }] });
    expect(withParts.status).toBe(400);
    // Too many entries is refused before schema validation walks them.
    const many = await complete(JSON.stringify({ files: Array.from({ length: 5_000 }, () => 0) }));
    expect(many.status).toBe(400);
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it("keeps the legacy single body with its part manifest, bounded at 10,000 parts", async () => {
    const parts = Array.from({ length: 3 }, (_, i) => ({ partNumber: i + 1, etag: `e${i}` }));
    expect((await complete({ fileId: "f1", sizeBytes: 3, parts })).status).toBe(200);
    expect(mocks.single).toHaveBeenCalledWith(expect.objectContaining({ fileId: "f1", parts }));
    const tooMany = await complete({ fileId: "f1", parts: Array.from({ length: 10_001 }, (_, i) => ({ partNumber: i + 1, etag: "e" })) });
    expect(tooMany.status).toBe(400);
  });

  it("fails the whole batch for a session-level problem, keeping its code", async () => {
    mocks.batch.mockRejectedValueOnce(new ProjectIntakeError("Upload session is being finalized; retry shortly", 409, undefined, "upload_session_busy"));
    const response = await complete({ files: [{ fileId: "f1" }] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "upload_session_busy" } });
  });
});

describe("files/complete and abort never answer a server failure as a client error", () => {
  const providerOutage = () => Object.assign(new Error("The specified bucket does not exist"), { name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } });
  it("maps an unclassified storage outage on complete to 503 with Retry-After", async () => {
    mocks.single.mockRejectedValueOnce(providerOutage());
    const response = await complete({ fileId: "f1" });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toMatchObject({ error: { code: "upload_storage_unavailable" } });
  });
  it("answers an unexpected non-storage failure with 500, never 400", async () => {
    mocks.single.mockRejectedValueOnce(new TypeError("x is not a function"));
    expect((await complete({ fileId: "f1" })).status).toBe(500);
  });

  const abort = () => app.request(`/uploads/direct/sessions/${session}/abort`, { method: "POST" });
  it("answers abort during a reconciler pass with a retryable 409 upload_session_busy", async () => {
    mocks.abort.mockRejectedValueOnce(new ProjectIntakeError("Upload session is being finalized; retry shortly", 409, undefined, "upload_session_busy"));
    const response = await abort();
    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toMatchObject({ error: { code: "upload_session_busy" } });
    // The route waits out a short holder before answering busy.
    expect(mocks.abort).toHaveBeenCalledWith(session, "u", expect.any(Number));
    expect(mocks.abort.mock.calls[0]![2]).toBeGreaterThan(0);
  });
  it("answers abort of an ingested session with 409", async () => {
    mocks.abort.mockRejectedValueOnce(new ProjectIntakeError("Ingested uploads cannot be aborted", 409));
    expect((await abort()).status).toBe(409);
  });
  it("answers abort during a storage outage with 503", async () => {
    mocks.abort.mockRejectedValueOnce(providerOutage());
    expect((await abort()).status).toBe(503);
  });
  it("still answers 404 and 200", async () => {
    mocks.abort.mockResolvedValueOnce(false);
    expect((await abort()).status).toBe(404);
    expect((await abort()).status).toBe(200);
  });
});

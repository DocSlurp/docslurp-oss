import { describe, expect, it, vi } from "vitest";

const lockMock = vi.hoisted(() => Object.assign(vi.fn(async () => [{ acquired: true }]), { release: vi.fn() }));
const sqlMock = vi.hoisted(() => Object.assign(vi.fn(), { json: (value: unknown) => value, array: (value: unknown) => value, reserve: async () => lockMock }));
const listMultipartUploadParts = vi.hoisted(() => vi.fn());
const completeMultipartUpload = vi.hoisted(() => vi.fn());
const abortMultipartUpload = vi.hoisted(() => vi.fn());
const signSingleUploadPut = vi.hoisted(() => vi.fn(async ({ key }: { key: string }) => `https://storage.example/${key}`));
const getUploadedObjectMetadata = vi.hoisted(() => vi.fn());
const deleteUploadedObject = vi.hoisted(() => vi.fn(async () => {}));
const createMultipartUpload = vi.hoisted(() => vi.fn());
vi.mock("../lib/direct-upload-locks.js", () => ({ reserveDirectUploadLockConnection: async () => ({ connection: lockMock, release: lockMock.release }) }));
vi.mock("../lib/storage.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/storage.js")>(), signSingleUploadPut, createMultipartUpload, getUploadedObjectMetadata, deleteUploadedObject, listMultipartUploadParts, completeMultipartUpload, abortMultipartUpload }));
vi.mock("../db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../db.js")>(), sql: sqlMock }));

import {
  createDirectUploadSession,
  validMultipartLayout,
  queueAbandonedDirectUploadCleanup,
  finalizeDirectUploadFile,
  withDirectUploadLock,
  describeDirectUploadSession,
  completeDirectUploadFile,
  assertDirectUploadSessionReadyForIntake,
  directUploadIntakeItems,
  loadDirectUploadSession,
  toDirectUploadPartCount,
  type LoadedDirectUploadSession,
} from "../services/direct-upload-session.js";
import { WorkspaceIntakeError } from "../services/workspace-intake.js";

function directUploadSessionFixture(
  overrides: {
    session?: Partial<LoadedDirectUploadSession["session"]>;
    files?: LoadedDirectUploadSession["files"];
  } = {},
): LoadedDirectUploadSession {
  return {
    session: {
      id: "session-1",
      user_id: "user-1",
      org_id: "org-1",
      workspace_id: null,
      workspace_name: null,
      template_key: null,
      pipeline: {} as LoadedDirectUploadSession["session"]["pipeline"],
      status: "uploading",
      ...(overrides.session ?? {}),
    },
    files: overrides.files ?? [
      {
        id: "file-1",
        session_id: "session-1",
        filename: "contracts.pdf",
        mime_type: "application/pdf",
        size_bytes: 42,
        source_key: "user-1/raw/contracts.pdf",
        upload_mode: "single",
        upload_id: null,
        part_size: null,
        status: "completed",
        completed_parts: null,
      },
    ],
  };
}

describe("Direct Upload Session Module", () => {
  it("normalizes PostgreSQL bigint sizes before matching and verifying browser files", async () => {
    const fixture = directUploadSessionFixture();
    sqlMock.mockResolvedValueOnce([fixture.session]).mockResolvedValueOnce([
      { ...fixture.files[0], size_bytes: "42", part_size: "8" },
    ]);
    const loaded = await loadDirectUploadSession("session-1", "user-1");
    expect(loaded?.files[0].size_bytes).toBe(42);
    expect(loaded?.files[0].part_size).toBe(8);
  });

  it("returns one signed PUT per requested single-part file even above the multipart threshold", async () => {
    const fixture = directUploadSessionFixture();
    const files = Array.from({ length: 10 }, (_, i) => ({ ...fixture.files[0]!, id: `file-${i}`, source_key: `source-${i}`, status: "pending", size_bytes: 40 * 1024 * 1024 }));
    sqlMock.mockReset();
    sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("from upload_sessions")) return [fixture.session];
      if (query.includes("from upload_session_files")) return files;
      return [];
    });
    signSingleUploadPut.mockClear();
    const result = await createDirectUploadSession({ userId: "user-1", orgId: "org-1", pipeline: {}, tags: ["finance"], files: files.map(file => ({ filename: file.filename, mimeType: file.mime_type, sizeBytes: file.size_bytes, singlePart: true })) });
    expect(sqlMock.mock.calls.some((call) => call.slice(1).some((value: unknown) => Array.isArray(value) && value[0] === "finance"))).toBe(true);
    expect(result.files).toHaveLength(10);
    expect(result.files.every(file => file.mode === "single" && "putUrl" in file)).toBe(true);
    expect(signSingleUploadPut).toHaveBeenCalledTimes(10);
    expect(result.files[0]).toMatchObject({ method: "PUT", headers: { "Content-Type": "application/pdf" }, expiresInSeconds: 900 });
    expect(signSingleUploadPut).toHaveBeenCalledWith(expect.objectContaining({ expiresInSeconds: 900 }));
    expect(createMultipartUpload).not.toHaveBeenCalled();
    const insertedFiles = sqlMock.mock.calls.filter(([strings]) => strings.join("?").includes("insert into upload_session_files"));
    expect(insertedFiles).toHaveLength(10);
    expect(insertedFiles.every(call => call.includes("single"))).toBe(true);
  });

  it("rejects oversized single-part uploads before creating a session", async () => {
    sqlMock.mockClear();
    await expect(createDirectUploadSession({ userId: "user-1", pipeline: {}, files: [{ filename: "large.pdf", mimeType: "application/pdf", sizeBytes: 5 * 1024 ** 3 + 1, singlePart: true }] })).rejects.toThrow("5 GiB");
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("verifies stored bytes before completing a signed file", async () => {
    const fixture = directUploadSessionFixture();
    fixture.files[0].status = "pending";
    for (const actualSize of [null, 41, 42]) {
      sqlMock.mockReset();
      sqlMock.mockResolvedValueOnce([fixture.session]).mockResolvedValueOnce(fixture.files).mockResolvedValue([]);
      getUploadedObjectMetadata.mockResolvedValue({ contentLength: actualSize, etag: "etag" });
      const completing = completeDirectUploadFile({ sessionId: "session-1", userId: "user-1", fileId: "file-1" });
      if (actualSize === 42) {
        await expect(completing).resolves.toBeUndefined();
        expect(sqlMock.mock.calls.some(([strings]) => strings.join("?").includes("set status = 'completed'"))).toBe(true);
      } else {
        await expect(completing).rejects.toThrow();
        expect(sqlMock).toHaveBeenCalledTimes(2);
      }
    }
  });

  it("rejects missing or incorrectly sized authoritative parts without assembling", async () => {
    const file = { ...directUploadSessionFixture().files[0], status: "pending", upload_mode: "multipart", upload_id: "u1", part_size: 8, size_bytes: 20 };
    getUploadedObjectMetadata.mockRejectedValue(Object.assign(new Error("NotFound"), { name: "NotFound" }));
    completeMultipartUpload.mockClear();
    for (const parts of [[], [{partNumber:1,sizeBytes:8,etag:"a"}], [{partNumber:1,sizeBytes:8,etag:"a"},{partNumber:2,sizeBytes:7,etag:"b"},{partNumber:3,sizeBytes:5,etag:"c"}]]) {
      listMultipartUploadParts.mockResolvedValue(parts);
      await expect(finalizeDirectUploadFile(file)).resolves.toBe(false);
    }
    expect(completeMultipartUpload).not.toHaveBeenCalled();
  });

  it("assembles only the provider's contiguous complete layout", async () => {
    const file = { ...directUploadSessionFixture().files[0], status: "pending", upload_mode: "multipart", upload_id: "u1", part_size: 8, size_bytes: 20 };
    const parts = [{partNumber:1,sizeBytes:8,etag:"a"},{partNumber:2,sizeBytes:8,etag:"b"},{partNumber:3,sizeBytes:4,etag:"c"}];
    getUploadedObjectMetadata.mockReset().mockRejectedValueOnce(Object.assign(new Error("NotFound"), { name: "NotFound" })).mockResolvedValueOnce({contentLength:20,etag:"e"});
    listMultipartUploadParts.mockResolvedValue(parts);
    sqlMock.mockResolvedValue([]);
    await expect(finalizeDirectUploadFile(file)).resolves.toBe(true);
    expect(completeMultipartUpload).toHaveBeenLastCalledWith({key:file.source_key,uploadId:"u1",parts});
  });

  it("never finalizes an unknown stream before EOS", async () => {
    getUploadedObjectMetadata.mockClear();
    await expect(finalizeDirectUploadFile({ ...directUploadSessionFixture().files[0], status:"pending", unknown_size:true })).resolves.toBe(false);
    expect(getUploadedObjectMetadata).not.toHaveBeenCalled();
  });

  it("rejects noncontiguous, duplicate, extra, and oversized layouts", () => {
    expect(validMultipartLayout([{partNumber:1,sizeBytes:8},{partNumber:2,sizeBytes:4}],12,8)).toBe(true);
    for (const parts of [[{partNumber:2,sizeBytes:4}], [{partNumber:1,sizeBytes:8},{partNumber:1,sizeBytes:4}], [{partNumber:1,sizeBytes:8},{partNumber:2,sizeBytes:5}], [{partNumber:1,sizeBytes:8},{partNumber:2,sizeBytes:4},{partNumber:3,sizeBytes:0}]]) expect(validMultipartLayout(parts,12,8)).toBe(false);
  });

  it("fences a concurrent finalizer without executing it", async () => {
    lockMock.mockResolvedValueOnce([{acquired:false}]);
    const work = vi.fn();
    await expect(withDirectUploadLock("session-1",work)).rejects.toMatchObject({statusCode:409});
    expect(work).not.toHaveBeenCalled();
    expect(lockMock.release).toHaveBeenCalled();
  });

  it("returns the persisted intake payload without signing completed sessions", async () => {
    const payload = {run:{id:"run-1"}};
    signSingleUploadPut.mockClear();
    const result = await describeDirectUploadSession(directUploadSessionFixture({session:{status:"confirmed",result:{payload,status:201,temporalDeferred:false}}}));
    expect(result.result).toEqual(payload);
    expect(signSingleUploadPut).not.toHaveBeenCalled();
  });

  it("aborts known abandoned multiparts idempotently and waits out signed PUTs for object cleanup", async () => {
    sqlMock.mockReset().mockResolvedValueOnce([{source_key:"raw/a",upload_id:"mpu-a"}]).mockResolvedValue([]);
    abortMultipartUpload.mockRejectedValueOnce(Object.assign(new Error("gone"),{name:"NoSuchUpload"}));
    await expect(queueAbandonedDirectUploadCleanup("session-1")).resolves.toBeUndefined();
    expect(abortMultipartUpload).toHaveBeenCalledWith({key:"raw/a",uploadId:"mpu-a"});
    expect(sqlMock.mock.calls.some(([strings]) => strings.join("").includes("interval '16 minutes'"))).toBe(true);
  });

  it("computes multipart part counts at the protocol seam", () => {
    expect(toDirectUploadPartCount(1, 8)).toBe(1);
    expect(toDirectUploadPartCount(8, 8)).toBe(1);
    expect(toDirectUploadPartCount(9, 8)).toBe(2);
  });

  it("turns completed session files into a Workspace Intake source", () => {
    expect(
      directUploadIntakeItems(directUploadSessionFixture()),
    ).toEqual([
      {
        filename: "contracts.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        canonicalId: null,
        path: "",
        content: { storedKey: "user-1/raw/contracts.pdf" },
      },
    ]);
  });

  it("keeps direct upload intake readiness rules inside the session seam", () => {
    expect(() =>
      assertDirectUploadSessionReadyForIntake(directUploadSessionFixture()),
    ).not.toThrow();

    expect(() =>
      assertDirectUploadSessionReadyForIntake(
        directUploadSessionFixture({ session: { status: "confirmed" } }),
      ),
    ).toThrow(WorkspaceIntakeError);

    // An unfinished file does not block the session; intake reports it instead.
    expect(() =>
      assertDirectUploadSessionReadyForIntake(
        directUploadSessionFixture({
          files: [{ ...directUploadSessionFixture().files[0], status: "pending" }],
        }),
      ),
    ).not.toThrow();
  });

  it("reports unfinished session files as rejected intake items", () => {
    const [completed] = directUploadSessionFixture().files;
    const [done, unfinished] = directUploadIntakeItems(
      directUploadSessionFixture({
        files: [completed, { ...completed, filename: "late.pdf", status: "pending" }],
      }),
    );
    expect(done?.content).toEqual({ storedKey: "user-1/raw/contracts.pdf" });
    expect(unfinished?.content).toEqual({ rejected: expect.any(WorkspaceIntakeError) });
    expect((unfinished?.content as { rejected: WorkspaceIntakeError }).rejected).toMatchObject({
      statusCode: 409,
      message: "late.pdf did not finish uploading",
    });
  });
});

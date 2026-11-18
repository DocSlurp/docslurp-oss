import { uploadContentIdentitySchema } from "@docslurp/shared";
import { describe, expect, it, vi } from "vitest";

const lockMock = vi.hoisted(() => Object.assign(vi.fn(async () => [{ acquired: true }]), { release: vi.fn() }));
const sqlMock = vi.hoisted(() => Object.assign(vi.fn(), { json: (value: unknown) => value, array: (value: unknown) => value, reserve: async () => lockMock }));
const listMultipartUploadParts = vi.hoisted(() => vi.fn());
const completeMultipartUpload = vi.hoisted(() => vi.fn());
const abortMultipartUpload = vi.hoisted(() => vi.fn());
const signMultipartUploadPart = vi.hoisted(() => vi.fn(async () => "https://storage.example/part"));
const signSingleUploadPut = vi.hoisted(() => vi.fn(async ({ key }: { key: string }) => `https://storage.example/${key}`));
const getUploadedObjectMetadata = vi.hoisted(() => vi.fn());
const deleteUploadedObject = vi.hoisted(() => vi.fn(async () => {}));
const createMultipartUpload = vi.hoisted(() => vi.fn());
const copyUploadedObject = vi.hoisted(() => vi.fn(async () => ({ etag: "sealed-etag" })));
vi.mock("../lib/direct-upload-locks.js", () => ({ reserveDirectUploadLockConnection: async () => ({ connection: lockMock, release: lockMock.release }) }));
vi.mock("../lib/storage.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/storage.js")>(), signMultipartUploadPart, signSingleUploadPut, createMultipartUpload, getUploadedObjectMetadata, deleteUploadedObject, copyUploadedObject, listMultipartUploadParts, completeMultipartUpload, abortMultipartUpload }));
vi.mock("../db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../db.js")>(), sql: sqlMock }));

import {
  getDirectUploadSessionDescription,
  assertUploadSessionActive,
  buildDirectUploadFileDescriptor,
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
  sealedSourceKey,
  toDirectUploadPartCount,
  type LoadedDirectUploadSession,
} from "../services/direct-upload-session.js";
import { intakeIntoProject, ProjectIntakeError } from "../services/project-intake.js";
import { createProjectIntakeFakes } from "./helpers/project-intake-fakes.js";

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
      project_id: null,
      project_name: null,
      template_key: null,
      pipeline: {} as LoadedDirectUploadSession["session"]["pipeline"],
      status: "uploading",
      expires_at: new Date(Date.now() + 3600_000),
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
  it("preserves verified object bytes through direct-upload intake into run creation", async () => {
    const fakes = createProjectIntakeFakes();
    await intakeIntoProject({
      userId: "user-1", orgId: "org-1", kind: "direct-upload", newProject: true,
      items: directUploadIntakeItems(directUploadSessionFixture()),
    }, fakes.ports);
    expect(fakes.runs[0].files[0].fileSize).toBe(42);
  });

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

  it("accepts the good files of a batch, rejects the unsupported one by request index, and echoes client ids", async () => {
    sqlMock.mockReset();
    const stored: Array<Record<string, unknown>> = [];
    sqlMock.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("insert into upload_session_files")) stored.push({ filename: values[2], index: values[13], clientId: values[14] });
      if (query.includes("from upload_sessions")) return [{ id: "s", user_id: "user-1", org_id: "org-1", expires_at: new Date(Date.now() + 3600_000), status: "pending" }];
      if (query.includes("from upload_session_files")) return stored.map((file, i) => ({ id: `file-${i}`, session_id: "s", filename: file.filename, mime_type: "application/pdf", size_bytes: 10, source_key: `k${i}`, upload_mode: "single", status: "pending", request_index: file.index, client_id: file.clientId }));
      return [];
    });
    const result = await createDirectUploadSession({
      userId: "user-1", orgId: "org-1", pipeline: {},
      files: [
        { clientId: "a", filename: "What is RAG?.pdf", mimeType: "application/pdf", sizeBytes: 10 },
        { clientId: "b", filename: "payload.exe", mimeType: "application/x-msdownload", sizeBytes: 10 },
        { clientId: "c", filename: "Scan  001.pdf", mimeType: "application/pdf", sizeBytes: 10 },
      ],
    });
    // The sanitized names differ from what the client sent; index and clientId are how it finds its files.
    expect(result.files.map((file) => [file.index, file.clientId, file.filename])).toEqual([[0, "a", "What is RAG-.pdf"], [2, "c", "Scan 001.pdf"]]);
    expect(result.rejected).toEqual([expect.objectContaining({ index: 1, clientId: "b", filename: "payload.exe", statusCode: 415, code: "unsupported_type" })]);
  });

  it("rejects an oversized file by index while the rest of the batch is accepted", async () => {
    sqlMock.mockReset();
    sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("from upload_sessions")) return [{ id: "s", user_id: "user-1", org_id: "org-1", expires_at: new Date(Date.now() + 3600_000), status: "pending" }];
      if (query.includes("from upload_session_files")) return [{ id: "f", session_id: "s", filename: "ok.pdf", mime_type: "application/pdf", size_bytes: 10, source_key: "k", upload_mode: "single", status: "pending", request_index: 1, client_id: "ok" }];
      return [];
    });
    const result = await createDirectUploadSession({
      userId: "user-1", orgId: "org-1", pipeline: {},
      files: [
        { clientId: "huge", filename: "huge.pdf", mimeType: "application/pdf", sizeBytes: 10 ** 13 },
        { clientId: "ok", filename: "ok.pdf", mimeType: "application/pdf", sizeBytes: 10 },
      ],
    });
    expect(result.rejected).toEqual([expect.objectContaining({ index: 0, clientId: "huge", statusCode: 413, code: "file_too_large" })]);
    expect(result.files).toHaveLength(1);
  });

  it("fails the request, naming every file, only when nothing can be accepted", async () => {
    sqlMock.mockReset();
    const error = await createDirectUploadSession({
      userId: "user-1", orgId: "org-1", pipeline: {},
      files: [{ filename: "a.exe", mimeType: "application/x-msdownload", sizeBytes: 1 }, { filename: "b.dll", mimeType: "application/x-msdownload", sizeBytes: 1 }],
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProjectIntakeError);
    expect(error.statusCode).toBe(415);
    expect(error.message).toContain("a.exe");
    expect(error.message).toContain("b.dll");
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("verifies stored bytes before completing a signed file", async () => {
    const fixture = directUploadSessionFixture();
    fixture.files[0].status = "pending";
    for (const actualSize of [null, 41, 42]) {
      sqlMock.mockReset().mockImplementation(async (strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("from upload_sessions") && !query.includes("update")) return [fixture.session];
        if (query.includes("from upload_session_files") && !query.includes("exists")) return fixture.files;
        if (query.includes("set status = 'completed'")) return [{ id: fixture.files[0].id, source_key: sealedSourceKey(fixture.files[0], "etag") }];
        if (query.includes("exists (select 1 from upload_session_files")) return [{ open: true }];
        return [{ one: 1 }];
      });
      getUploadedObjectMetadata.mockResolvedValue({ contentLength: actualSize, etag: "etag" });
      const completing = completeDirectUploadFile({ sessionId: "session-1", userId: "user-1", fileId: "file-1" });
      const queries = () => sqlMock.mock.calls.map(([strings]) => (strings as string[]).join("?"));
      if (actualSize === 42) {
        await expect(completing).resolves.toEqual({ sessionComplete: false });
        expect(queries().some(query => query.includes("set status = 'completed'"))).toBe(true);
        // New progress extends the hold, within the cap from when it began.
        expect(queries().at(-1)).toContain("client_finalizing_since");
      } else {
        await expect(completing).rejects.toThrow();
        // Nothing is completed, and with no new progress the hold opened before the lock is not extended.
        expect(queries().some(query => query.includes("set status = 'completed'"))).toBe(false);
        expect(queries().filter(query => query.includes("client_finalizing_until = least("))).toHaveLength(0);
        expect(queries().some(query => query.includes("client_finalizing_since is null"))).toBe(true);
      }
    }
  });

  // #234 round 7 (H2): a single-part PUT URL stays valid for 900 s, so the bytes that were verified
  // (and later hashed) must not be the bytes a second PUT can replace.
  it("seals a completed single-part upload: ingests a server-owned copy of exactly the verified version", async () => {
    const file = { ...directUploadSessionFixture().files[0], status: "pending", upload_mode: "single" };
    sqlMock.mockReset().mockResolvedValue([{ id: file.id, source_key: sealedSourceKey(file, "\"verified\"") }]);
    getUploadedObjectMetadata.mockReset().mockResolvedValue({ contentLength: file.size_bytes, etag: "\"verified\"" });
    copyUploadedObject.mockClear();
    deleteUploadedObject.mockClear();
    await expect(finalizeDirectUploadFile(file)).resolves.toBe(true);
    const sealed = sealedSourceKey(file, "\"verified\"");
    expect(sealed).not.toBe(file.source_key);
    expect(sealed.startsWith(file.source_key.slice(0, file.source_key.lastIndexOf("/") + 1))).toBe(true);
    // The copy is conditional on the verified ETag, and the copy itself is size-checked.
    expect(copyUploadedObject).toHaveBeenCalledWith({ fromKey: file.source_key, toKey: sealed, ifMatch: "\"verified\"" });
    expect(getUploadedObjectMetadata).toHaveBeenLastCalledWith(sealed, undefined);
    const completed = sqlMock.mock.calls.find(([strings]) => strings.join("?").includes("set status = 'completed'"));
    expect(completed).toContain(sealed);
    expect(completed?.[0].join("?")).toContain("insert into storage_cleanup_queue");
    expect(completed?.[0].join("?")).toContain("interval '1 day'");
    expect(completed).toContain(file.source_key);
    // The URL's key is dropped; a later PUT to it (the URL is still valid) is never read.
    expect(deleteUploadedObject).toHaveBeenCalledWith(file.source_key);
    // Intake reads the sealed key, never the presigned one.
    const loaded = { session: directUploadSessionFixture().session, files: [{ ...file, status: "completed", source_key: sealed }] } as unknown as LoadedDirectUploadSession;
    expect(directUploadIntakeItems(loaded)[0]!.content).toEqual({ storedKey: sealed, verifiedSizeBytes: file.size_bytes });
  });

  it("preserves the original when ownership registration or session publication fails", async () => {
    const file = { ...directUploadSessionFixture().files[0], status: "pending", upload_mode: "single" };
    sqlMock.mockReset().mockResolvedValue([]);
    getUploadedObjectMetadata.mockReset().mockResolvedValue({ contentLength: file.size_bytes, etag: "verified" });
    copyUploadedObject.mockReset().mockResolvedValue({ etag: "sealed" });
    deleteUploadedObject.mockClear();
    await expect(finalizeDirectUploadFile(file)).rejects.toMatchObject({statusCode: 409});
    expect(deleteUploadedObject).not.toHaveBeenCalled();
  });

  it("refuses to complete when the object changed between verification and the sealing copy", async () => {
    const file = { ...directUploadSessionFixture().files[0], status: "pending", upload_mode: "single" };
    sqlMock.mockReset().mockResolvedValue([]);
    getUploadedObjectMetadata.mockReset().mockResolvedValue({ contentLength: file.size_bytes, etag: "\"verified\"" });
    copyUploadedObject.mockReset().mockRejectedValueOnce(Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } }));
    await expect(finalizeDirectUploadFile(file)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("changed while its upload was being completed") });
    expect(sqlMock.mock.calls.some(([strings]) => strings.join("?").includes("set status = 'completed'"))).toBe(false);
    // Without an ETag there is no version to pin: refuse rather than copy whatever is there.
    getUploadedObjectMetadata.mockReset().mockResolvedValue({ contentLength: file.size_bytes, etag: null });
    copyUploadedObject.mockClear();
    await expect(finalizeDirectUploadFile(file)).rejects.toThrow(/Unable to verify the uploaded version/);
    expect(copyUploadedObject).not.toHaveBeenCalled();
    copyUploadedObject.mockReset().mockResolvedValue({ etag: "sealed-etag" });
  });

  it("does not copy a multipart upload: completion closed its part URLs and it has no PUT URL", async () => {
    const file = { ...directUploadSessionFixture().files[0], status: "pending", upload_mode: "multipart", upload_id: "u1", part_size: 8, size_bytes: 20 };
    // The fenced publish matches the still-pending row.
    sqlMock.mockReset().mockImplementation(async (strings: TemplateStringsArray) => strings.join("?").includes("set status = 'completed'") ? [{ id: "file-1" }] : []);
    getUploadedObjectMetadata.mockReset().mockResolvedValue({ contentLength: 20, etag: "e" });
    copyUploadedObject.mockClear();
    await expect(finalizeDirectUploadFile(file)).resolves.toBe(true);
    expect(copyUploadedObject).not.toHaveBeenCalled();
    const completed = sqlMock.mock.calls.find(([strings]) => strings.join("?").includes("set status = 'completed'"));
    expect(completed).toContain(file.source_key);
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
    // The fenced publish matches the still-pending row.
    sqlMock.mockReset().mockImplementation(async (strings: TemplateStringsArray) => strings.join("?").includes("set status = 'completed'") ? [{ id: "file-1" }] : []);
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
    // Coded, so clients can tell a held lock (repeat shortly) from a real conflict.
    await expect(withDirectUploadLock("session-1",work)).rejects.toMatchObject({statusCode:409,code:"upload_session_busy"});
    expect(work).not.toHaveBeenCalled();
    expect(lockMock.release).toHaveBeenCalled();
  });

  it("waits out a held lock when asked, retrying on a released connection, then answers busy", async () => {
    lockMock.mockClear(); lockMock.release.mockClear();
    lockMock.mockResolvedValueOnce([{acquired:false}]).mockResolvedValueOnce([{acquired:false}]);
    const work = vi.fn(async () => "done");
    await expect(withDirectUploadLock("session-1", work, undefined, undefined, 2_000)).resolves.toBe("done");
    expect(work).toHaveBeenCalledOnce();
    // Each failed try released its connection before waiting.
    expect(lockMock.release).toHaveBeenCalledTimes(3);
    lockMock.mockResolvedValue([{acquired:false}]);
    const started = Date.now();
    await expect(withDirectUploadLock("session-1", work, undefined, undefined, 300)).rejects.toMatchObject({ statusCode: 409, code: "upload_session_busy" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(work).toHaveBeenCalledOnce();
    lockMock.mockReset().mockResolvedValue([{acquired:true}]);
  });

  it("verifies the assembled object when a retried multipart completion finds the upload closed", async () => {
    const file = { ...directUploadSessionFixture().files[0], status: "pending", upload_mode: "multipart", upload_id: "u1", part_size: 8, size_bytes: 20 };
    // The fenced publish matches the still-pending row.
    sqlMock.mockReset().mockImplementation(async (strings: TemplateStringsArray) => strings.join("?").includes("set status = 'completed'") ? [{ id: "file-1" }] : []);
    const notFound = Object.assign(new Error("missing"), { name: "NotFound" });
    // Absent before completion; present after the completion whose answer was lost.
    getUploadedObjectMetadata.mockReset().mockRejectedValueOnce(notFound).mockResolvedValue({ contentLength: 20, etag: "e" });
    listMultipartUploadParts.mockReset().mockResolvedValue([{ partNumber: 1, sizeBytes: 8, etag: "a" }, { partNumber: 2, sizeBytes: 8, etag: "b" }, { partNumber: 3, sizeBytes: 4, etag: "c" }]);
    completeMultipartUpload.mockReset()
      .mockRejectedValueOnce(Object.assign(new Error("reset"), { code: "ECONNRESET" }))
      .mockRejectedValueOnce(Object.assign(new Error("closed"), { name: "NoSuchUpload", $metadata: { httpStatusCode: 404 } }));
    await expect(finalizeDirectUploadFile(file)).resolves.toBe(true);
    expect(completeMultipartUpload).toHaveBeenCalledTimes(2);
    expect(sqlMock.mock.calls.some(([strings]) => strings.join("?").includes("set status = 'completed'"))).toBe(true);
    // A closed upload with no assembled object is still the client's 400.
    getUploadedObjectMetadata.mockReset().mockRejectedValue(notFound);
    completeMultipartUpload.mockReset().mockRejectedValue(Object.assign(new Error("closed"), { name: "NoSuchUpload", $metadata: { httpStatusCode: 404 } }));
    await expect(finalizeDirectUploadFile(file)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("no longer open") });
    listMultipartUploadParts.mockReset(); completeMultipartUpload.mockReset();
  });

  it("turns a storage failure while finalizing into a retryable 503, never a client error", async () => {
    const file = { ...directUploadSessionFixture().files[0], status: "pending", upload_mode: "single" };
    sqlMock.mockReset().mockResolvedValue([]);
    getUploadedObjectMetadata.mockReset().mockRejectedValue(Object.assign(new Error("secret provider detail"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }));
    const failure = await finalizeDirectUploadFile(file).catch(error => error);
    expect(failure).toMatchObject({ statusCode: 503, code: "upload_storage_unavailable" });
    expect(failure.message).not.toContain("secret");
    // A definite answer is not retried.
    expect(getUploadedObjectMetadata).toHaveBeenCalledOnce();
    getUploadedObjectMetadata.mockReset();
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

  it("turns completed session files into a Project Intake source", () => {
    expect(
      directUploadIntakeItems(directUploadSessionFixture()),
    ).toEqual([
      {
        filename: "contracts.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        canonicalId: null,
        path: "",
        content: { storedKey: "user-1/raw/contracts.pdf", verifiedSizeBytes: 42 },
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
    ).toThrow(ProjectIntakeError);

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
    expect(done?.content).toEqual({ storedKey: "user-1/raw/contracts.pdf", verifiedSizeBytes: 42 });
    expect(unfinished?.content).toEqual({ rejected: expect.any(ProjectIntakeError) });
    expect((unfinished?.content as { rejected: ProjectIntakeError }).rejected).toMatchObject({
      statusCode: 409,
      message: "late.pdf did not finish uploading",
    });
  });
});


describe("authoritative recovery evidence", () => {
  it("refuses expired sessions before the sweeper and caps live URL lifetime", () => {
    const fixture = directUploadSessionFixture();
    expect(assertUploadSessionActive(fixture.session)).toBe(900);
    expect(assertUploadSessionActive({ ...fixture.session, expires_at: new Date(Date.now() + 60_000) })).toBeLessThanOrEqual(60);
    expect(() => assertUploadSessionActive({ ...fixture.session, expires_at: new Date(0) })).toThrow("expired");
    expect(() => assertUploadSessionActive({ ...fixture.session, expires_at: undefined })).toThrow("expired");
  });
  it.each(["AccessDenied", "TimeoutError", "NoSuchUpload"])("never signs retry URLs when inventory fails: %s", async name => {
    const file = { ...directUploadSessionFixture().files[0], status: "pending", upload_mode: "multipart", upload_id: "u", part_size: 8 };
    // Every attempt fails: a transient name is retried, then still refused.
    const failure = Object.assign(new Error("private provider detail"), { name });
    listMultipartUploadParts.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
    await expect(buildDirectUploadFileDescriptor(file)).rejects.toThrow();
    listMultipartUploadParts.mockReset();
  });
  it("retries a wrong-sized part despite a stale completed receipt", async () => {
    const file = { ...directUploadSessionFixture().files[0], status: "pending", upload_mode: "multipart", upload_id: "u", part_size: 42, completed_parts: [{ partNumber: 1, etag: "stale" }] };
    listMultipartUploadParts.mockResolvedValueOnce([{ partNumber: 1, etag: "wrong", sizeBytes: 41 }]);
    expect(await buildDirectUploadFileDescriptor(file)).toMatchObject({ verifiedBytes: 0, pendingParts: [{ partNumber: 1, sizeBytes: 42 }] });
  });
  it("does not let stale DB completed parts suppress missing storage parts", async () => {
    const file = { ...directUploadSessionFixture().files[0], status: "pending", upload_mode: "multipart", upload_id: "u", part_size: 42, completed_parts: [{ partNumber: 1, etag: "stale" }] };
    listMultipartUploadParts.mockResolvedValueOnce([]);
    const result = await buildDirectUploadFileDescriptor(file);
    expect(result).toMatchObject({ verifiedBytes: 0, transferState: "missing", pendingParts: [{ partNumber: 1, sizeBytes: 42 }] });
  });
});


describe("full recovery inspection", () => {
  function installSession() {
    const fixture = directUploadSessionFixture();
    fixture.files[0].status = "pending";
    sqlMock.mockReset().mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      // The publish names the sealed key it derived from the verified version.
      const sealed = values.find((value): value is string => typeof value === "string" && value.includes("/sealed-"));
      if (query.includes("update upload_session_files")) { fixture.files[0].status = "completed"; return [{ id: fixture.files[0].id, source_key: sealed ?? fixture.files[0].source_key }]; }
      if (query.includes("from upload_sessions")) return [fixture.session];
      if (query.includes("from upload_session_files")) return fixture.files;
      return [{ one: 1 }];
    });
    signSingleUploadPut.mockClear();
    signMultipartUploadPart.mockClear();
    getUploadedObjectMetadata.mockReset();
    return fixture;
  }
  it.each(["AccessDenied", "TimeoutError"])("returns public-safe unavailable and zero URLs for HEAD %s", async name => {
    installSession();
    getUploadedObjectMetadata.mockRejectedValue(Object.assign(new Error("secret storage detail"), { name }));
    await expect(getDirectUploadSessionDescription("session-1", "user-1")).rejects.toMatchObject({ statusCode: 503, code: "upload_storage_unavailable" });
    expect(signSingleUploadPut).not.toHaveBeenCalled();
    expect(signMultipartUploadPart).not.toHaveBeenCalled();
  });
  it.each(["AccessDenied", "TimeoutError", "InvalidPagination"])("returns no retry URLs when ListParts evidence fails: %s", async name => {
    const fixture = installSession();
    Object.assign(fixture.files[0], { upload_mode: "multipart", upload_id: "open", part_size: 42 });
    getUploadedObjectMetadata.mockRejectedValue(Object.assign(new Error("missing"), { name: "NotFound" }));
    const providerFailure = Object.assign(new Error("secret provider detail"), { name });
    listMultipartUploadParts.mockReset().mockRejectedValue(providerFailure);
    const failure = await getDirectUploadSessionDescription("session-1", "user-1").catch(error => error);
    expect(failure).toMatchObject({ statusCode: 503, code: "upload_storage_unavailable" });
    expect(failure.message).not.toContain("secret provider detail");
    expect(signSingleUploadPut).not.toHaveBeenCalled();
    expect(signMultipartUploadPart).not.toHaveBeenCalled();
  });
  it("seals a single PUT with a lost acknowledgement without signing another PUT", async () => {
    installSession();
    getUploadedObjectMetadata.mockResolvedValue({ contentLength: 42, etag: "original" });
    const recovered = await getDirectUploadSessionDescription("session-1", "user-1");
    expect(recovered?.files[0]).toMatchObject({ transferState: "complete", verifiedBytes: 42 });
    expect(signSingleUploadPut).not.toHaveBeenCalled();
  });
  it("authorizes a whole PUT only on provider-confirmed absence", async () => {
    installSession();
    getUploadedObjectMetadata.mockRejectedValue(Object.assign(new Error("missing"), { name: "NotFound" }));
    expect((await getDirectUploadSessionDescription("session-1", "user-1"))?.files[0]).toMatchObject({ transferState: "missing", verifiedBytes: 0 });
    expect(signSingleUploadPut).toHaveBeenCalledTimes(1);
  });
  it("refuses a lost multipart upload without silently creating another", async () => {
    const fixture = installSession();
    Object.assign(fixture.files[0], { upload_mode: "multipart", upload_id: "lost", part_size: 42 });
    getUploadedObjectMetadata.mockRejectedValue(Object.assign(new Error("missing"), { name: "NotFound" }));
    listMultipartUploadParts.mockRejectedValueOnce(Object.assign(new Error("lost"), { name: "NoSuchUpload" }));
    await expect(getDirectUploadSessionDescription("session-1", "user-1")).rejects.toMatchObject({ statusCode: 409, code: "intake_reconciliation_required" });
    expect(signMultipartUploadPart).not.toHaveBeenCalled();
  });
  it("keeps statusOnly metadata-only, even while storage is down", async () => {
    installSession();
    await getDirectUploadSessionDescription("session-1", "user-1", true);
    expect(getUploadedObjectMetadata).not.toHaveBeenCalled();
    expect(signSingleUploadPut).not.toHaveBeenCalled();
  });
});


describe("content identity input", () => {
  it.each([
    { algorithm: "md5", digest: "a".repeat(64) },
    { algorithm: "sha256", digest: "A".repeat(64) },
    { algorithm: "sha256", digest: "a".repeat(65) },
    { algorithm: "sha256", digest: "a".repeat(64), extra: true },
  ])("rejects malformed identity %j", input => {
    expect(uploadContentIdentitySchema.safeParse(input).success).toBe(false);
  });
});

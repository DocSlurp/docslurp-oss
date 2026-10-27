import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", async importOriginal => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return { ...actual, S3Client: class {
    middlewareStack = { add: vi.fn(), addRelativeTo: vi.fn() };
    send = send;
  } };
});
const { listMultipartUploadParts } = await import("../lib/storage.js");
const target = { key: "tenant-a/owned-upload/file.pdf", uploadId: "owned-upload-id" };
const part = (n: number) => ({ PartNumber: n, ETag: `etag-${n}`, Size: 8 * 1024 * 1024 });

beforeEach(() => { send.mockReset(); });

describe("multipart listing", () => {
  it("stops on a terminal page even when the provider returns a next marker", async () => {
    send.mockResolvedValue({ IsTruncated: false, NextPartNumberMarker: "2", Parts: [part(1), part(2)] });
    expect(await listMultipartUploadParts(target)).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reads all pages using the same scoped object and upload ID", async () => {
    send.mockResolvedValueOnce({ IsTruncated: true, NextPartNumberMarker: "1", Parts: [part(1)] })
      .mockResolvedValueOnce({ IsTruncated: false, NextPartNumberMarker: "2", Parts: [part(2)] });
    expect((await listMultipartUploadParts(target)).map(p => p.partNumber)).toEqual([1, 2]);
    expect(send.mock.calls.map(([c]) => ({ key: c.input.Key, uploadId: c.input.UploadId, marker: c.input.PartNumberMarker }))).toEqual([
      { ...target, marker: undefined }, { ...target, marker: "1" },
    ]);
    expect(send.mock.calls[1][1].abortSignal).toBe(send.mock.calls[0][1].abortSignal);
  });

  it.each([
    { IsTruncated: true, Parts: [part(1)] },
    { IsTruncated: true, NextPartNumberMarker: "2", Parts: [part(1)] },
    { IsTruncated: true, NextPartNumberMarker: "1", Parts: [] },
    { Parts: [part(1)] },
  ])("rejects incomplete or invalid pagination without returning a partial manifest", async page => {
    send.mockResolvedValue(page);
    await expect(listMultipartUploadParts(target)).rejects.toThrow("invalid multipart pagination");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects a repeated continuation marker instead of looping", async () => {
    send.mockResolvedValueOnce({ IsTruncated: true, NextPartNumberMarker: "1", Parts: [part(1)] })
      .mockResolvedValue({ IsTruncated: true, NextPartNumberMarker: "1", Parts: [] });
    await expect(listMultipartUploadParts(target)).rejects.toThrow("invalid multipart pagination");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    [part(1), part(1)], [part(10_001)], [{ ...part(1), Size: -1 }], [{ ...part(1), ETag: undefined }],
  ])("rejects malformed or excessive part metadata", async (...parts) => {
    send.mockResolvedValue({ IsTruncated: false, Parts: parts });
    await expect(listMultipartUploadParts(target)).rejects.toThrow("incomplete multipart metadata");
  });

  it("propagates an aborted listing without returning accumulated parts", async () => {
    const timeout = new DOMException("Timed out", "TimeoutError");
    send.mockResolvedValueOnce({ IsTruncated: true, NextPartNumberMarker: "1", Parts: [part(1)] })
      .mockRejectedValueOnce(timeout);
    await expect(listMultipartUploadParts(target)).rejects.toBe(timeout);
    expect(send.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("rejects overlapping parts across pages", async () => {
    send.mockResolvedValueOnce({ IsTruncated: true, NextPartNumberMarker: "1", Parts: [part(1)] })
      .mockResolvedValueOnce({ IsTruncated: false, Parts: [part(1), part(2)] });
    await expect(listMultipartUploadParts(target)).rejects.toThrow("incomplete multipart metadata");
  });

  it("passes its 30-second deadline to a request waiting for cancellation", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    send.mockImplementation((_command, options) => {
      return new Promise((_resolve, reject) => {
        options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), { once: true });
      });
    });
    try {
      const result = listMultipartUploadParts(target);
      const rejected = expect(result).rejects.toThrow("Test deadline elapsed");
      expect(timeout).toHaveBeenCalledWith(30_000);
      controller.abort(new DOMException("Test deadline elapsed", "TimeoutError"));
      await rejected;
    } finally { timeout.mockRestore(); }
  });
});

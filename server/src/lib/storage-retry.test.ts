import { describe, expect, it, vi } from "vitest";
import { isTransientStorageError, withStorageRetry } from "./storage-retry.js";

const s3 = (name: string, httpStatusCode?: number) => Object.assign(new Error(name), { name, ...(httpStatusCode ? { $metadata: { httpStatusCode } } : {}) });

describe("isTransientStorageError", () => {
  it.each([
    ["the provider's spurious missing bucket", s3("NoSuchBucket", 404)],
    ["a provider 5xx", s3("InternalError", 500)],
    ["an unnamed 503", s3("Unknown", 503)],
    ["throttling", s3("SlowDown", 503)],
    ["a 429", s3("TooManyRequests", 429)],
    ["an SDK timeout", s3("TimeoutError")],
    ["a reset socket", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    ["fetch failed with a socket cause", Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } })],
  ])("retries %s", (_label, error) => expect(isTransientStorageError(error)).toBe(true));

  it.each([
    ["an absent object", s3("NotFound", 404)],
    ["a changed object", s3("PreconditionFailed", 412)],
    ["a closed multipart upload", s3("NoSuchUpload", 404)],
    ["an invalid part", s3("InvalidPart", 400)],
    ["access denied", s3("AccessDenied", 403)],
    ["an intake decision", Object.assign(new Error("size"), { name: "ProjectIntakeError" })],
    ["a programming error", new TypeError("x is not a function")],
    ["a non-error", "boom"],
  ])("does not retry %s", (_label, error) => expect(isTransientStorageError(error)).toBe(false));
});

describe("withStorageRetry", () => {
  it("repeats a transient failure and returns the eventual answer", async () => {
    const operation = vi.fn().mockRejectedValueOnce(s3("NoSuchBucket", 404)).mockResolvedValueOnce("copied");
    await expect(withStorageRetry(operation, [1, 1])).resolves.toBe("copied");
    expect(operation).toHaveBeenCalledTimes(2);
  });
  it("gives up after the bounded attempts with the provider's last error", async () => {
    const operation = vi.fn().mockRejectedValue(s3("InternalError", 500));
    await expect(withStorageRetry(operation, [1, 1])).rejects.toMatchObject({ name: "InternalError" });
    expect(operation).toHaveBeenCalledTimes(3);
  });
  it("returns a definite answer at once", async () => {
    const operation = vi.fn().mockRejectedValue(s3("PreconditionFailed", 412));
    await expect(withStorageRetry(operation, [1, 1])).rejects.toMatchObject({ name: "PreconditionFailed" });
    expect(operation).toHaveBeenCalledOnce();
  });
});

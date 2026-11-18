import { describe, expect, it } from "vitest";

import {
  MAX_PART_BYTES,
  MAX_PARTS,
  partSizeAt,
  partSizeFor,
  planDirectUpload,
  readUploadTransferPolicy,
} from "../lib/upload-transfer-policy.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const policy = readUploadTransferPolicy({}, 500 * MIB);

describe("upload transfer policy", () => {
  it("defaults to 64 MiB parts, 16 MiB stream parts and 3 hour URLs", () => {
    expect(policy).toEqual({ urlTtlSeconds: 3 * 3600, partSizeBytes: 64 * MIB, streamPartSizeBytes: 16 * MIB });
  });

  it("reads overrides and fails startup on out-of-range values instead of clamping", () => {
    expect(readUploadTransferPolicy({ UPLOAD_PART_SIZE_MB: "128", UPLOAD_URL_TTL_SECONDS: "7200" }, GIB))
      .toMatchObject({ partSizeBytes: 128 * MIB, urlTtlSeconds: 7200 });
    expect(() => readUploadTransferPolicy({ UPLOAD_PART_SIZE_MB: "4" }, GIB)).toThrow("UPLOAD_PART_SIZE_MB");
    expect(() => readUploadTransferPolicy({ UPLOAD_PART_SIZE_MB: "64.5" }, GIB)).toThrow("UPLOAD_PART_SIZE_MB");
    expect(() => readUploadTransferPolicy({ UPLOAD_URL_TTL_SECONDS: String(13 * 3600) }, GIB)).toThrow("UPLOAD_URL_TTL_SECONDS");
    expect(() => readUploadTransferPolicy({ UPLOAD_URL_TTL_SECONDS: "60" }, GIB)).toThrow("UPLOAD_URL_TTL_SECONDS");
  });

  it("grows the stream part so the largest accepted upload fits in 10,000 parts", () => {
    const large = readUploadTransferPolicy({}, 1024 * GIB);
    expect(large.streamPartSizeBytes * MAX_PARTS).toBeGreaterThanOrEqual(1024 * GIB);
    expect(large.streamPartSizeBytes % MIB).toBe(0);
  });

  it("sends files up to one part as a single PUT and larger ones as multipart", () => {
    expect(planDirectUpload({ sizeBytes: 0 }, policy)).toEqual({ mode: "single", partSize: null });
    expect(planDirectUpload({ sizeBytes: 64 * MIB }, policy)).toEqual({ mode: "single", partSize: null });
    expect(planDirectUpload({ sizeBytes: 64 * MIB + 1 }, policy)).toEqual({ mode: "multipart", partSize: 64 * MIB });
    expect(planDirectUpload({ sizeBytes: 2 * GIB, singlePart: true }, policy)).toEqual({ mode: "single", partSize: null });
    expect(planDirectUpload({}, policy)).toEqual({ mode: "multipart", partSize: 16 * MIB });
  });

  it("never needs more than 10,000 parts, and parts fit the 32-bit part_size column", () => {
    for (const size of [65 * MIB, 640 * GIB, 641 * GIB, 5 * 1024 * GIB]) {
      const part = partSizeFor(size, policy);
      expect(part % MIB).toBe(0);
      expect(part).toBeLessThanOrEqual(MAX_PART_BYTES);
      expect(Math.ceil(size / part)).toBeLessThanOrEqual(MAX_PARTS);
    }
    expect(partSizeFor(641 * GIB, policy)).toBeGreaterThan(64 * MIB);
    expect(MAX_PART_BYTES).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(() => readUploadTransferPolicy({ UPLOAD_PART_SIZE_MB: "2048" }, GIB)).toThrow("UPLOAD_PART_SIZE_MB");
    expect(readUploadTransferPolicy({ UPLOAD_PART_SIZE_MB: "2047" }, GIB).partSizeBytes).toBe(MAX_PART_BYTES);
  });

  it("sizes every part exactly, with the remainder in the last", () => {
    expect([1, 2, 3].map((n) => partSizeAt(n, 130, 64))).toEqual([64, 64, 2]);
    expect(partSizeAt(4, 130, 64)).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { S3Client, PutObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { resolveObjectStorageConfig } from "@docslurp/shared";
import { uploadSigningTarget } from "../lib/upload-signing-target.js";

const storage = resolveObjectStorageConfig({
  STORAGE_URI: "s3://test-key:test-secret@files?endpoint=https://storage.invalid&region=auto",
});

describe("custom bucket upload signing", () => {
  it("signs single and multipart URLs at the bucket alias without a bucket path", async () => {
    const target = uploadSigningTarget(storage, "https://f.docslurp.io");
    const client = new S3Client(target.config);
    try {
      for (const command of [
        new PutObjectCommand({ Bucket: target.bucket, Key: "u/raw/a b.pdf", ContentType: "application/pdf" }),
        new UploadPartCommand({ Bucket: target.bucket, Key: "u/raw/a b.pdf", UploadId: "upload-one", PartNumber: 2 }),
      ]) {
        const url = new URL(await getSignedUrl(client, command, { expiresIn: 900 }));
        expect(url.origin).toBe("https://f.docslurp.io");
        expect(url.pathname).toBe("/u/raw/a%20b.pdf");
        expect(url.searchParams.has("X-Amz-Signature")).toBe(true);
        if (command instanceof UploadPartCommand) {
          expect(url.searchParams.get("partNumber")).toBe("2");
          expect(url.searchParams.get("uploadId")).toBe("upload-one");
        }
      }
    } finally { client.destroy(); }
  });

  it("keeps normal storage configuration when no alias is configured", () => {
    const target = uploadSigningTarget(storage);
    expect(target.bucket).toBe("files");
    expect(target.config.endpoint).toBe("https://storage.invalid");
    expect(target.config.bucketEndpoint).not.toBe(true);
  });

  it.each(["http://f.docslurp.io", "https://f.docslurp.io/bucket", "https://secret@f.docslurp.io", "https://f.docslurp.io?token=x"])("rejects unsafe or ambiguous alias %s", alias => {
    expect(() => uploadSigningTarget(storage, alias)).toThrow();
  });
});

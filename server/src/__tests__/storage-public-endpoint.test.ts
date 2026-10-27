import { S3Client, PutObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3ClientConfig, type ObjectStorageConfig } from "@docslurp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { presignStorageConfig } from "../lib/storage.js";
import { uploadSigningTarget } from "../lib/upload-signing-target.js";
import { uploadUiConnectDomains } from "../lib/mcp-ui-resources.js";

const internal: ObjectStorageConfig = {
  bucket: "docslurp-files",
  endpoint: "http://minio:9000",
  region: "us-west-2",
  forcePathStyle: true,
  accessKeyId: "minioadmin",
  secretAccessKey: "minioadmin",
  purgeSupersededSources: false,
  source: "uri",
};

describe("STORAGE_PUBLIC_ENDPOINT signing", () => {
  it("signs upload URLs against the public endpoint while keeping the bucket and key", async () => {
    const config = presignStorageConfig(internal, "https://storage.example.com");
    const url = new URL(await getSignedUrl(
      new S3Client(s3ClientConfig(config)),
      new PutObjectCommand({ Bucket: internal.bucket, Key: "uploads/a.pdf", ContentType: "application/pdf" }),
      { expiresIn: 900 },
    ));
    expect(url.origin).toBe("https://storage.example.com");
    expect(url.pathname).toBe("/docslurp-files/uploads/a.pdf");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("host");
  });

  it("allows the actual signed bucket alias when both public overrides are configured", async () => {
    const publicStorage = presignStorageConfig(internal, "https://storage.example.com");
    const alias = "https://files.example.com";
    const target = uploadSigningTarget(publicStorage, alias);
    const domains = uploadUiConnectDomains(publicStorage, "", alias);
    const client = new S3Client(target.config);
    try {
      for (const command of [
        new PutObjectCommand({ Bucket: target.bucket, Key: "uploads/a.pdf", ContentType: "application/pdf" }),
        new UploadPartCommand({ Bucket: target.bucket, Key: "uploads/a.pdf", UploadId: "upload-one", PartNumber: 1 }),
      ]) {
        const signed = new URL(command instanceof UploadPartCommand
          ? await getSignedUrl(client, command, { expiresIn: 900 })
          : await getSignedUrl(client, command, { expiresIn: 900 }));
        expect(signed.origin).toBe(alias);
        expect(signed.pathname).toBe("/uploads/a.pdf");
        expect(domains).toContain(signed.origin);
      }
      expect(domains).toContain("https://storage.example.com");
      expect(domains).not.toContain("http://minio:9000");
    } finally { client.destroy(); }
  });

  it.each(["http://files.example.com", "https://files.example.com/bucket", "https://secret@files.example.com", "https://files.example.com?token=x"])(
    "refuses a CSP bucket alias the signer would reject: %s", alias => {
      expect(() => uploadUiConnectDomains(internal, "", alias)).toThrow(/DOCSLURP_STORAGE_PUBLIC_BUCKET_URL/);
    },
  );

  it("leaves the storage config untouched when unset", () => {
    expect(presignStorageConfig(internal, null)).toBe(internal);
  });

  it("allows the widget to connect to the public endpoint instead of the internal one", () => {
    const domains = uploadUiConnectDomains(presignStorageConfig(internal, "https://storage.example.com"), "");
    expect(domains).toEqual(["https://storage.example.com"]);
  });
});

describe("STORAGE_PUBLIC_ENDPOINT parsing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load(value: string) {
    vi.stubEnv("STORAGE_PUBLIC_ENDPOINT", value);
    vi.resetModules();
    return (await import("../config.js")).env.storagePublicEndpoint;
  }

  it("normalizes a bare origin", async () => {
    await expect(load("https://storage.example.com/")).resolves.toBe("https://storage.example.com");
    await expect(load("http://localhost:9000")).resolves.toBe("http://localhost:9000");
  });

  it("is null when blank", async () => {
    await expect(load("  ")).resolves.toBeNull();
  });

  it.each(["not a url", "ftp://storage.example.com", "https://storage.example.com/bucket", "https://key:secret@storage.example.com"])(
    "rejects %s at startup",
    async (value) => {
      await expect(load(value)).rejects.toThrow(/STORAGE_PUBLIC_ENDPOINT/);
    },
  );
});

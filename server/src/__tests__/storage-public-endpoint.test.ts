import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3ClientConfig, type ObjectStorageConfig } from "@docslurp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { presignStorageConfig } from "../lib/storage.js";
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

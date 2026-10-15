import { describe, expect, it, vi } from "vitest";

import {
  parseLanceDbUri,
  parseStorageUri,
  redactUri,
  resolveObjectStorageConfig,
  s3ClientConfig,
} from "../connection-uri.js";

describe("STORAGE_URI", () => {
  it("parses bucket, endpoint, region, credentials and policy from one URI", () => {
    const storage = parseStorageUri("s3://AKIA%2FX:s%40cret@docslurp-files?endpoint=https://fly.storage.tigris.dev&region=auto&purgeSupersededSources=true", {});
    expect(storage).toMatchObject({
      bucket: "docslurp-files",
      endpoint: "https://fly.storage.tigris.dev",
      region: "auto",
      forcePathStyle: true,
      accessKeyId: "AKIA/X",
      secretAccessKey: "s@cret",
      purgeSupersededSources: true,
      source: "uri",
    });
    expect(s3ClientConfig(storage)).toEqual({
      region: "auto",
      endpoint: "https://fly.storage.tigris.dev",
      forcePathStyle: true,
      credentials: { accessKeyId: "AKIA/X", secretAccessKey: "s@cret" },
    });
  });

  it("falls back to standard AWS credential variables and omits the endpoint for AWS", () => {
    const storage = parseStorageUri("s3://bucket?pathStyle=false", { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" });
    expect(storage).toMatchObject({ endpoint: null, region: "us-west-2", forcePathStyle: false, accessKeyId: "id", secretAccessKey: "secret" });
    expect(s3ClientConfig(storage)).not.toHaveProperty("endpoint");
  });

  it("rejects malformed URIs and redacts credentials", () => {
    expect(() => parseStorageUri("gs://bucket", {})).toThrow();
    expect(() => parseStorageUri("s3://bucket/prefix", {})).toThrow();
    expect(() => parseStorageUri("s3://bucket?pathStyle=maybe", {})).toThrow();
    expect(redactUri("s3://key:secret@bucket?region=auto")).toBe("s3://***:***@bucket?region=auto");
  });

  it("keeps deprecated variables working with a one-time warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = resolveObjectStorageConfig({ S3_BUCKET: "legacy", AWS_ENDPOINT_URL_S3: "http://localhost:9000", AWS_REGION: "eu-west-1" });
    expect(storage).toMatchObject({ bucket: "legacy", endpoint: "http://localhost:9000", region: "eu-west-1", source: "legacy" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("STORAGE_URI"));
    warn.mockRestore();
  });
});

describe("LANCEDB_URI", () => {
  const storage = parseStorageUri("s3://k:s@files?endpoint=http://localhost:9000&region=us-east-1", {});

  it("strips the query from the root and inherits object storage settings on s3", () => {
    const lance = parseLanceDbUri("s3://files/lancedb/?reindexPages=10", storage);
    expect(lance.root).toBe("s3://files/lancedb");
    expect(lance.storageOptions).toEqual({
      region: "us-east-1",
      endpoint: "http://localhost:9000",
      allow_http: "true",
      aws_access_key_id: "k",
      aws_secret_access_key: "s",
    });
    expect(lance.params.get("reindexPages")).toBe("10");
  });

  it("lets the Lance URI override endpoint and region", () => {
    const lance = parseLanceDbUri("s3://vectors/db?endpoint=https://r2.example&region=auto", storage);
    expect(lance.storageOptions).toMatchObject({ endpoint: "https://r2.example", region: "auto", allow_http: "false" });
    expect([...lance.params.keys()]).toEqual([]);
  });

  it("accepts local paths and file URIs without storage options", () => {
    expect(parseLanceDbUri(undefined, storage)).toMatchObject({ root: "/tmp/docslurp-lancedb", storageOptions: undefined });
    expect(parseLanceDbUri("file:///var/lib/docslurp/lancedb", storage).root).toBe("/var/lib/docslurp/lancedb");
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  parseLanceDbUri,
  parseStorageUri,
  resolveLanceDbConfig,
  resolveS3ClientTuning,
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

describe("S3 client tuning", () => {
  const storage = parseStorageUri("s3://k:s@files?endpoint=https://s3.example.com&region=auto", {});

  it("is a no-op when no S3_* variables are set", () => {
    expect(resolveS3ClientTuning({})).toEqual({});
    expect(s3ClientConfig(storage, {})).toEqual({
      region: "auto",
      endpoint: "https://s3.example.com",
      forcePathStyle: true,
      credentials: { accessKeyId: "k", secretAccessKey: "s" },
    });
  });

  it("maps knobs onto S3Client options", () => {
    const config = s3ClientConfig(storage, {
      S3_MAX_SOCKETS: "256",
      S3_KEEPALIVE: "true",
      S3_CONNECTION_TIMEOUT_MS: "3000",
      S3_REQUEST_TIMEOUT_MS: "60000",
      S3_MAX_ATTEMPTS: "5",
      S3_RETRY_MODE: "adaptive",
      S3_CHECKSUM_MODE: "when_required",
      S3_FORCE_PATH_STYLE: "false",
    });
    expect(config).toMatchObject({
      forcePathStyle: false,
      maxAttempts: 5,
      retryMode: "adaptive",
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: {
        connectionTimeout: 3000,
        requestTimeout: 60000,
        httpsAgent: { maxSockets: 256, keepAlive: true },
        httpAgent: { maxSockets: 256, keepAlive: true },
      },
    });
  });

  it("parses multipart part size and rejects bad values", () => {
    expect(resolveS3ClientTuning({ S3_MULTIPART_PART_SIZE_MB: "16" }).multipartPartSizeBytes).toBe(16 * 1024 * 1024);
    expect(() => resolveS3ClientTuning({ S3_MULTIPART_PART_SIZE_MB: "1" })).toThrow();
    expect(() => resolveS3ClientTuning({ S3_MAX_SOCKETS: "abc" })).toThrow();
    expect(() => resolveS3ClientTuning({ S3_CHECKSUM_MODE: "always" })).toThrow();
    expect(() => resolveS3ClientTuning({ S3_RETRY_MODE: "fast" })).toThrow();
  });
});

describe("LANCEDB_STORAGE_URI", () => {
  const blobs = parseStorageUri("s3://blobs-key:blobs-secret@blobs?endpoint=https://b2.example.com&region=us-west-004", {});

  it("falls back to inheriting STORAGE_URI when unset", () => {
    const lance = resolveLanceDbConfig({ LANCEDB_URI: "s3://blobs/lancedb" }, blobs);
    expect(lance.storageOptions).toMatchObject({ endpoint: "https://b2.example.com", aws_access_key_id: "blobs-key" });
  });

  it("uses its own endpoint, region and credentials, defaulting the root to its bucket", () => {
    const lance = resolveLanceDbConfig({ LANCEDB_STORAGE_URI: "s3://idx-key:idx-secret@index?endpoint=https://t3.example.com&region=auto" }, blobs);
    expect(lance.root).toBe("s3://index/lancedb");
    expect(lance.storageOptions).toEqual({
      region: "auto",
      endpoint: "https://t3.example.com",
      allow_http: "false",
      aws_access_key_id: "idx-key",
      aws_secret_access_key: "idx-secret",
    });
  });

  it("honors an explicit LANCEDB_URI root and reports errors under its own name", () => {
    const lance = resolveLanceDbConfig({ LANCEDB_STORAGE_URI: "s3://k:s@index?region=auto", LANCEDB_URI: "s3://index/vec" }, blobs);
    expect(lance.root).toBe("s3://index/vec");
    expect(() => resolveLanceDbConfig({ LANCEDB_STORAGE_URI: "gs://x" }, blobs)).toThrow(/LANCEDB_STORAGE_URI/);
  });

  it("merges optional Lance object-store tuning for s3 roots only", () => {
    const env = { LANCEDB_URI: "s3://blobs/lancedb", LANCEDB_CONNECT_TIMEOUT_SECONDS: "5", LANCEDB_REQUEST_TIMEOUT_SECONDS: "60", LANCEDB_CLIENT_MAX_RETRIES: "6", LANCEDB_POOL_MAX_IDLE_PER_HOST: "32" };
    expect(resolveLanceDbConfig(env, blobs).storageOptions).toMatchObject({ connect_timeout: "5s", timeout: "60s", client_max_retries: "6", pool_max_idle_per_host: "32" });
    expect(resolveLanceDbConfig({ ...env, LANCEDB_URI: "/tmp/x" }, blobs).storageOptions).toBeUndefined();
  });
});

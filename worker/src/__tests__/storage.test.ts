import { describe, expect, it, vi } from "vitest";

import {
  ArtifactStore,
  streamJsonObject,
  StorageObjectTooLargeError,
  buildArtifactStorageKey,
  collectOrphanedStorageKeys,
  keyFromStorageUri,
  sourceStorageKey,
} from "../tools/storage.js";
import { parseLanceDbUri, parseStorageUri } from "@docslurp/shared";

describe("keyFromStorageUri", () => {
  it("returns the key for bucket-local s3 uris", () => {
    expect(
      keyFromStorageUri(
        "s3://docslurp-files/demo/run-1/output.json",
        "docslurp-files",
      ),
    ).toBe("demo/run-1/output.json");
  });

  it("passes through raw object keys", () => {
    expect(keyFromStorageUri("demo/run-1/output.json", "docslurp-files")).toBe(
      "demo/run-1/output.json",
    );
  });

  it("ignores uris from other buckets", () => {
    expect(
      keyFromStorageUri(
        "s3://other-bucket/demo/run-1/output.json",
        "docslurp-files",
      ),
    ).toBeNull();
  });
});

describe("ArtifactStore object inspection", () => {
  function createStore() {
    return new ArtifactStore({
      databaseUrl: "postgres://example",
      storage: parseStorageUri("s3://minioadmin:minioadmin@docslurp-files?endpoint=http://localhost:9000"),
      s3Bucket: "docslurp-files",
      lancedb: parseLanceDbUri(undefined),
      openAiApiKey: "",
      openAiBaseUrl: "https://api.openai.com/v1",
      defaultInferenceLane: "standard",
      vectorBackends: ["lancedb"],
      lancedbReindexPages: 20,
      lancedbMaintenanceEnabled: true,
      lancedbVectorIndexMinRows: 5_000,
      workerLeaseTtlMs: 1000,
      workerMaxRuntimeMs: 0,
      workerDocConcurrency: 1,
      workerActivityConcurrency: 1,
      workerAdaptiveTuning: true,
      serializePdfCandidateExtraction: false,
      visionDensityThreshold: 0.25,
      pythonPoolSize: 1,
      parserArtifactTimeoutMs: 30_000,
      unstructuredParserChunkTimeoutMs: 20_000,
      unstructuredParserInitialChunkPages: 1,
      unstructuredParserMaxChunkPages: 2,
      unstructuredParserMaxConcurrency: 3,
      costPer1kInputTokens: 0.01,
      costPer1kOutputTokens: 0.03,
      openRouterApiKey: "",
      plausibilityWarningThreshold: 0.3,
      budgetSweepIntervalMs: 1000,
      retentionSweepIntervalMs: 1000,
      retentionSweepBatchSize: 10,
      apiKeyUsageRetentionDays: 30,
      perfLogRetentionDays: 90,
      storageIntegritySweepMaxKeys: 500,
      storageIntegritySweepPrefix: null,
      quarantineEnabled: true,
      quarantineFailOpenOnToolMissing: true,
      quarantineMaxArchiveEntries: 100,
      quarantineMaxArchiveDepth: 5,
      quarantineMaxTotalUncompressedBytes: 1024,
      quarantineMaxSingleEntryBytes: 1024,
      quarantineMaxExpansionRatio: 10,
      workerDbPoolMax: 10,
      workerRunMaintenance: "auto",
      workerShutdownGraceMs: 240_000,
      temporalActivityTaskQueue: null,
      poisonRunFailureThreshold: 3,
      temporalAddress: "localhost:7233",
      temporalNamespace: "default",
      temporalTaskQueue: "docslurp-pipeline",
      temporalTlsEnabled: false,
      temporalTlsServerName: null,
      temporalTlsCaCertPem: null,
      temporalTlsCaCertPath: null,
      temporalTlsClientCertPem: null,
      temporalTlsClientCertPath: null,
      temporalTlsClientKeyPem: null,
      temporalTlsClientKeyPath: null,
    });
  }

  it("never PUTs a body of unknown length (regression: x-amz-decoded-content-length undefined)", async () => {
    const { writeFile, mkdtemp } = await import("node:fs/promises");
    const { createReadStream } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const store = createStore();
    const send = vi.fn().mockResolvedValue({ ETag: '"e"', UploadId: "u1" });
    (store as unknown as { client: { send: typeof send } }).client = { send };

    await store.streamText("doc.md", "# héllo", "text/markdown");
    const textPut = send.mock.calls[0]![0].input;
    expect(Buffer.isBuffer(textPut.Body)).toBe(true);
    expect(textPut.Body.toString("utf8")).toBe("# héllo");

    const dir = await mkdtemp(join(tmpdir(), "storage-test-"));
    const file = join(dir, "page.png");
    await writeFile(file, Buffer.alloc(1234, 7));
    await store.streamToStorage("page.png", createReadStream(file), "image/png");
    expect(send.mock.calls[1]![0].input.ContentLength).toBe(1234);

    const { Readable } = await import("node:stream");
    await store.streamToStorage("other.bin", Readable.from([Buffer.from("abc")]), "application/octet-stream");
    for (const [command] of send.mock.calls.slice(2)) {
      const body = command.input.Body;
      expect(body === undefined || Buffer.isBuffer(body) || body instanceof Uint8Array).toBe(true);
    }
  });

  it("returns false for missing objects", async () => {
    const store = createStore();
    const send = vi
      .fn()
      .mockRejectedValue({ $metadata: { httpStatusCode: 404 } });
    (store as unknown as { client: { send: typeof send } }).client = { send };

    await expect(store.objectExists("missing-key")).resolves.toBe(false);
  });

  it("paginates object listings until the requested limit is reached", async () => {
    const store = createStore();
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [{ Key: "a.json" }, { Key: "b.json" }],
        IsTruncated: true,
        NextContinuationToken: "next-page",
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: "c.json" }],
        IsTruncated: false,
        NextContinuationToken: undefined,
      });
    (store as unknown as { client: { send: typeof send } }).client = { send };

    await expect(store.listKeys({ maxKeys: 3 })).resolves.toEqual({
      keys: ["a.json", "b.json", "c.json"],
      truncated: false,
      nextContinuationToken: null,
    });
  });

  it("rejects reads when object metadata exceeds maxBytes", async () => {
    const store = createStore();
    const send = vi.fn().mockResolvedValue({
      ContentLength: 11,
      Body: {
        transformToByteArray: vi.fn().mockResolvedValue(Buffer.from("hello world")),
      },
    });
    (store as unknown as { client: { send: typeof send } }).client = { send };

    await expect(store.getBytes("demo/run-1/raw/sample.pdf", { maxBytes: 10 })).rejects.toThrow(
      StorageObjectTooLargeError,
    );
  });

  it("rejects reads when the downloaded body exceeds maxBytes without metadata", async () => {
    const store = createStore();
    const send = vi.fn().mockResolvedValue({
      Body: {
        transformToByteArray: vi.fn().mockResolvedValue(Buffer.from("hello world")),
      },
    });
    (store as unknown as { client: { send: typeof send } }).client = { send };

    await expect(store.getBytes("demo/run-1/raw/sample.pdf", { maxBytes: 10 })).rejects.toMatchObject({
      key: "demo/run-1/raw/sample.pdf",
      sizeBytes: 11,
      maxBytes: 10,
    });
  });
});

describe("typed storage keys", () => {
  it("accepts bucket-local source keys", () => {
    expect(sourceStorageKey("demo/run-1/raw/sample.pdf")).toBe("demo/run-1/raw/sample.pdf");
  });

  it("rejects source keys that are s3 uris or unsafe paths", () => {
    expect(() => sourceStorageKey("s3://docslurp-files/demo/run-1/raw/sample.pdf")).toThrow(
      "bucket-local",
    );
    expect(() => sourceStorageKey("demo/../sample.pdf")).toThrow("unsafe storage key");
  });

  it("builds artifact keys from encoded path segments", () => {
    expect(buildArtifactStorageKey("user 1", "run/1", "quarantine", "doc:1.json")).toBe(
      "user%201/run%2F1/quarantine/doc%3A1.json",
    );
  });
});

describe("collectOrphanedStorageKeys", () => {
  it("returns only listed keys that are not referenced", () => {
    expect(
      collectOrphanedStorageKeys(
        ["a.json", "b.json", "b.json"],
        new Set(["a.json"]),
      ),
    ).toEqual(["b.json"]);
  });

  it("ignores integrity sweep artifacts by default", () => {
    expect(
      collectOrphanedStorageKeys(
        ["system/integrity/report.json", "demo/orphan.json"],
        new Set<string>(),
      ),
    ).toEqual(["demo/orphan.json"]);
  });
});


describe("large artifact JSON streaming", () => {
  it("preserves JSON values and escaping without emitting a document-sized buffer", () => {
    const value = { name: 'quoted " text\nλ', missing: undefined, enabled: false,
      chunks: Array.from({ length: 2001 }, (_, id) => ({ id, vector: Array.from({ length: 256 }, (_, n) => n / 256), text: "body" })),
      nullable: [undefined, null, NaN], metadata: { count: 2001 } };
    const buffers = [...streamJsonObject(value)];
    expect(JSON.parse(Buffer.concat(buffers).toString())).toEqual(JSON.parse(JSON.stringify(value)));
    expect(Math.max(...buffers.map(buffer => buffer.length))).toBeLessThan(4096);
    expect(Buffer.concat(buffers).length).toBeGreaterThan(1_000_000);
  });
});

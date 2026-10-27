import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { isDocumentLevelFailure } from "../lib/document-failure.js";

import {
  ArtifactStore,
  streamJsonObject,
  StorageObjectTooLargeError,
  StorageReadError,
  cleanupTempFile,
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
      temporalMaterializeTaskQueue: null,
      materializeConcurrency: 4,
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

  it("bounds range reads and rejects ignored, oversized or incomplete responses", async () => {
    const store = createStore();
    const body = (chunks: Buffer[]) => ({
      transformToWebStream: () => Readable.toWeb(Readable.from(chunks)), destroy: vi.fn(),
    });
    const send = vi.fn().mockResolvedValue({ ContentRange: "bytes 10-13/100", ContentLength: 4, Body: body([Buffer.from("text")]) });
    (store as unknown as { client: { send: typeof send } }).client = { send };
    expect((await store.getByteRange("doc.md", 10, 13)).toString()).toBe("text");
    expect(send.mock.calls[0]![0].input.Range).toBe("bytes=10-13");
    const ignoredBody = body([Buffer.alloc(100)]);
    send.mockResolvedValueOnce({ ContentLength: 100, Body: ignoredBody });
    await expect(store.getByteRange("doc.md", 10, 13)).rejects.toBeInstanceOf(StorageReadError);
    expect(ignoredBody.destroy).toHaveBeenCalled();
    send.mockResolvedValueOnce({ ContentRange: "bytes 10-13/100", Body: body([Buffer.alloc(3), Buffer.alloc(3)]) });
    await expect(store.getByteRange("doc.md", 10, 13)).rejects.toBeInstanceOf(StorageObjectTooLargeError);
    send.mockResolvedValueOnce({ ContentRange: "bytes 10-13/100", Body: body([Buffer.alloc(3)]) });
    await expect(store.getByteRange("doc.md", 10, 13)).rejects.toBeInstanceOf(StorageReadError);
  });

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

  it("streams source bytes to disk without collecting the response in memory", async () => {
    const store = createStore();
    const source = Readable.from([Buffer.from("first"), Buffer.from("second")]);
    const collect = vi.fn(() => { throw new Error("must not buffer"); });
    const send = vi.fn().mockResolvedValue({ ContentLength: 11, Body: {
      transformToWebStream: () => Readable.toWeb(source), transformToByteArray: collect,
    } });
    (store as unknown as { client: { send: typeof send } }).client = { send };
    const file = await store.downloadSourceToTempFile(sourceStorageKey("raw/large.pdf"), "source-*.pdf");
    try {
      expect((await readFile(file)).toString()).toBe("firstsecond");
      expect(collect).not.toHaveBeenCalled();
    } finally {
      await cleanupTempFile(file);
    }
  });

  it.each(["size-limit", "interrupted", "short-body"])("removes partial downloads on %s", async (failure) => {
    const store = createStore();
    let destination: string | undefined;
    // Observe the private directory without replacing filesystem behavior.
    const { readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const before = new Set(await readdir(tmpdir()));
    const filename = `storage-failure-${randomUUID()}.pdf`;
    const source = Readable.from((async function* () {
      yield Buffer.from("first");
      // Wait for the file to open so the failure exercises partial-file cleanup.
      await new Promise(resolve => setTimeout(resolve, 30));
      const added = (await readdir(tmpdir())).filter(name => !before.has(name) && name.startsWith("docslurp-"));
      for (const name of added) {
        if (await access(`${tmpdir()}/${name}/${filename}`).then(() => true, () => false)) destination = name;
      }
      if (failure === "interrupted") throw new Error("aborted");
      if (failure === "size-limit") yield Buffer.from("second");
    })());
    const send = vi.fn().mockResolvedValue({
      ContentLength: failure === "short-body" ? 9 : undefined,
      Body: { transformToWebStream: () => Readable.toWeb(source) },
    });
    (store as unknown as { client: { send: typeof send } }).client = { send };
    const result = store.downloadToTempFile("raw/large.pdf", filename, { maxBytes: 10 });
    const error = await result.catch(error => error);
    expect(error).toBeInstanceOf(failure === "size-limit" ? StorageObjectTooLargeError : StorageReadError);
    if (failure !== "size-limit") expect(isDocumentLevelFailure(error)).toBe(false);
    expect(destination).toBeDefined();
    await expect(access(`${tmpdir()}/${destination}`)).rejects.toThrow();
  });

  it("treats an interrupted in-memory artifact body as retryable infrastructure", async () => {
    const store = createStore();
    const cause = new Error("aborted");
    const send = vi.fn().mockResolvedValue({ Body: { transformToByteArray: vi.fn().mockRejectedValue(cause) } });
    (store as unknown as { client: { send: typeof send } }).client = { send };
    const error = await store.getBytes("artifacts/chunks.json").catch(error => error);
    expect(error).toBeInstanceOf(StorageReadError);
    expect(error.cause).toBe(cause);
    expect(isDocumentLevelFailure(error)).toBe(false);
  });

  it("stream-parses nested JSON across byte boundaries without collecting its body", async () => {
    const store = createStore();
    const text = JSON.stringify({ text: 'quoted " λ 🦆', chunks: [{ vector: [1, -0.125, 3e-20], metadata: null }], empty: [], enabled: false });
    const bytes = Buffer.from(text);
    const collect = vi.fn(() => { throw new Error("must not buffer"); });
    const send = vi.fn().mockResolvedValue({ ContentLength: bytes.length, Body: {
      transformToWebStream: () => Readable.toWeb(Readable.from(Array.from(bytes, byte => Buffer.from([byte])))),
      transformToByteArray: collect,
    } });
    (store as unknown as { client: { send: typeof send } }).client = { send };
    expect(await store.getJson("artifacts/embeddings.json", { streamJson: true })).toEqual(JSON.parse(text));
    expect(collect).not.toHaveBeenCalled();
  });

  it.each(['{"chunks":[1', '{"chunks":[]} {"extra":true}', ""])("rejects incomplete or multiple streaming JSON values: %s", async (text) => {
    const store = createStore();
    const send = vi.fn().mockResolvedValue({ Body: {
      transformToWebStream: () => Readable.toWeb(Readable.from([Buffer.from(text)])),
    } });
    (store as unknown as { client: { send: typeof send } }).client = { send };
    await expect(store.getJson("artifacts/embeddings.json", { streamJson: true })).rejects.toBeInstanceOf(StorageReadError);
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

describe("run artifact roots", () => {
  it("keeps <user>/<run> for ordinary runs and the extract prefix for extract runs", async () => {
    const { runArtifactRoot, documentArtifactRoot } = await import("../tools/storage.js");
    expect(runArtifactRoot({ id: "run-1" }, "user-1")).toBe("user-1/run-1");
    expect(runArtifactRoot({ id: "run-1", storagePrefix: null }, "user-1")).toBe("user-1/run-1");
    expect(runArtifactRoot({ id: "run-1", storagePrefix: "extracts/org-1/ext_1" }, "user-1")).toBe("extracts/org-1/ext_1");
    expect(documentArtifactRoot({ userId: "user-1", runId: "run-1" })).toBe("user-1/run-1");
    expect(documentArtifactRoot({ userId: "user-1", runId: "run-1" }, "run-2")).toBe("user-1/run-2");
    expect(documentArtifactRoot({ userId: "user-1", runId: "run-1", artifactRoot: "extracts/org-1/ext_1" }, "run-2")).toBe("extracts/org-1/ext_1");
  });
});

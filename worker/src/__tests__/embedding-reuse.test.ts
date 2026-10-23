import { createHash } from "node:crypto";

import { assertProviderAllowed, normalizePipelineFeatures, type PipelineFeatureOverrides, VectorNamespaceManager } from "@docslurp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerCalls = vi.hoisted(() => ({ embed: [] as string[][], context: 0 }));

vi.mock("../stages/embedding-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stages/embedding-runtime.js")>();
  return {
    ...actual,
    // Stand-in provider: deterministic vectors, actual usage reported per call.
    embedTextChunks: vi.fn(async (args: Parameters<typeof actual.embedTextChunks>[0]) => {
      // Same fail-closed guard as the real client: provider misses obey privacyMode.
      assertProviderAllowed(args.privacyMode, {
        provider: args.profile.provider, model: args.profile.model, operation: "worker.embedding",
        target: args.profile.target, modelUri: args.profile.modelUri,
      });
      providerCalls.embed.push([...args.chunks]);
      const inputTokens = args.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      await args.onRemoteUsage?.({ inputTokens, chunks: args.chunks.length });
      return {
        vectors: args.chunks.map((chunk) => fakeVector(chunk, args.profile.dimensions)),
        usage: { runtime: "remote" },
        totalTokens: inputTokens,
      };
    }),
  };
});

vi.mock("../lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ai.js")>();
  return {
    ...actual,
    // A hosted model never writes the same context twice.
    generateOpenRouterText: vi.fn(async () => {
      providerCalls.context += 1;
      return {
        text: `Payroll handbook, revision ${providerCalls.context}.`,
        usage: { inputTokens: 50, outputTokens: 10, costCents: 0.01, metadata: {} },
      };
    }),
  };
});

import { fromEnv } from "../config.js";
import {
  documentContextKey,
  EmbeddingReuseLookup,
  embeddingInputKey,
  embeddingVectorFingerprint,
  type EmbeddingReuseRef,
  type EmbeddingReuseStore,
  type ReusableEmbeddingArtifact,
} from "../embeddings/embedding-reuse.js";
import type { Document, WorkspaceRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { EmbedStage } from "../stages/embed.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";

const BUCKET = "test-bucket";

function fakeVector(text: string, dimensions: number): number[] {
  const digest = createHash("sha256").update(text).digest();
  return Array.from({ length: Math.min(dimensions, 8) }, (_, index) => digest[index]! / 255);
}

class MemoryStorage {
  readonly bucket = BUCKET;
  readonly objects = new Map<string, string>();
  uri(key: string) { return `s3://${BUCKET}/${key}`; }
  async getBytes(key: string) {
    const value = this.objects.get(key);
    if (value === undefined) throw new Error(`missing ${key}`);
    return Buffer.from(value, "utf8");
  }
  async getJson<T>(key: string): Promise<T> { return JSON.parse((await this.getBytes(key)).toString("utf8")) as T; }
  async putJson(key: string, value: unknown) { this.objects.set(key, JSON.stringify(value)); }
  artifact(uri: string) { return JSON.parse(this.objects.get(uri.replace(`s3://${BUCKET}/`, ""))!) as ReusableEmbeddingArtifact; }
}

/** The org-scoped ref table, as the Store implements it. */
class MemoryReuseStore implements EmbeddingReuseStore {
  readonly rows = new Map<string, EmbeddingReuseRef>();
  forgotten: string[] = [];
  async findEmbeddingReuseRefs(orgId: string, keys: readonly string[]) {
    return keys.flatMap((key) => {
      const row = this.rows.get(`${orgId}|${key}`);
      return row ? [row] : [];
    });
  }
  async recordEmbeddingReuseRefs(orgId: string, refs: readonly EmbeddingReuseRef[]) {
    for (const ref of refs) this.rows.set(`${orgId}|${ref.key}`, ref);
  }
  async forgetEmbeddingReuseRefs(orgId: string, artifactUri: string, keys: readonly string[]) {
    for (const key of keys) {
      if (this.rows.get(`${orgId}|${key}`)?.artifactUri === artifactUri) {
        this.rows.delete(`${orgId}|${key}`);
        this.forgotten.push(key);
      }
    }
  }
}

/** Checkpoint no-ops plus the reuse store, like the worker's Store. */
function checkpointStore(reuse: MemoryReuseStore) {
  return {
    updateProgress: async () => {},
    startRunStage: async () => {},
    completeRunStage: async () => {},
    failRunStage: async () => {},
    startDocumentStage: async () => {},
    completeDocumentStage: async () => {},
    failDocumentStage: async () => {},
    appendEvent: async () => {},
    setPageStageComplete: async () => {},
    setPagesStageComplete: async () => {},
    getCompletedPages: async () => new Set<number>(),
    findEmbeddingReuseRefs: reuse.findEmbeddingReuseRefs.bind(reuse),
    recordEmbeddingReuseRefs: reuse.recordEmbeddingReuseRefs.bind(reuse),
    forgetEmbeddingReuseRefs: reuse.forgetEmbeddingReuseRefs.bind(reuse),
  };
}

const SECTIONS = ["Overview", "Payroll", "Benefits", "Leave"].map((title, index) =>
  `# ${title}\n\n${`Section ${index + 1} explains ${title.toLowerCase()} policy in detail. `.repeat(12)}`);

const hosted: PipelineFeatureOverrides = {
  embedding: { profile: "cheapest-hosted", modelUri: "llm://openai/text-embedding-3-small", target: "hosted" } as PipelineFeatureOverrides["embedding"],
};

type EmbedArgs = {
  storage: MemoryStorage;
  reuse?: MemoryReuseStore;
  orgId?: string | null;
  runId: string;
  documentId: string;
  text?: string;
  pipeline?: PipelineFeatureOverrides;
  seedEmbeddingsUri?: string;
  dedupHashes?: ReadonlyMap<string, string>;
  openRouter?: boolean;
  allowFailure?: boolean;
  /** Applied after validation: a pipeline whose hosted route predates a privacy switch. */
  privacyMode?: "local-only" | "strict-privacy";
  /** Extra store methods (e.g. chunk materialization) merged over the checkpoint store. */
  storeExtras?: Record<string, unknown>;
  /** EmbedStage's LanceDB delete (default: none recorded). */
  deleteVectors?: (uri: string, table: string, ids: readonly string[]) => Promise<void>;
};

async function embedDocument(args: EmbedArgs) {
  const result = await runEmbed(args);
  const stageState = result.state.documentStage(args.documentId, "embed");
  expect(stageState?.status, stageState?.error ?? "").toBe("completed");
  const artifactUri = result.state.artifactLedger.readDocument(args.documentId, "embeddings")!;
  return {
    ...result,
    artifactUri,
    artifact: args.storage.artifact(artifactUri),
    stats: stageState?.stats ?? {},
  };
}

async function runEmbed(args: EmbedArgs) {
  const sourceKey = `u1/${args.runId}/source/${args.documentId}.txt`;
  args.storage.objects.set(sourceKey, args.text ?? SECTIONS.join("\n\n"));
  const document: Document = {
    id: args.documentId, userId: "u1", runId: args.runId, filename: "handbook.txt", mimeType: "text/plain",
    sourceKey, status: "processing", extractionMode: "hybrid", pageCount: 1,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const artifacts: Record<string, string> = {};
  if (args.seedEmbeddingsUri) artifacts[`${args.documentId}:embeddings`] = args.seedEmbeddingsUri;
  const pipeline = normalizePipelineFeatures({ contextualChunkPreambles: false, ...hosted, ...args.pipeline });
  if (args.privacyMode) pipeline.privacyMode = args.privacyMode;
  const run = {
    id: args.runId, userId: "u1", orgId: args.orgId === undefined ? "o1" : args.orgId, workspaceId: "w1",
    stage: "embed", status: "processing", pipeline, stats: {}, artifacts, spentCents: 0,
  } as unknown as WorkspaceRun;
  const state = WorkflowState.create(run, [document]);
  for (const [hash, uri] of args.dedupHashes ?? []) state.contentHashes.set(hash, uri);
  if (args.reuse) state.store = { ...checkpointStore(args.reuse), ...args.storeExtras } as unknown as WorkflowState["store"];
  const config = { ...fromEnv(), openRouterApiKey: args.openRouter ? "test-key" : "" };
  const embedCallsBefore = providerCalls.embed.length;
  const contextCallsBefore = providerCalls.context;

  let failure: unknown;
  try {
    await new EmbedStage({} as CommandRunner, args.storage as unknown as ArtifactStore, config, args.deleteVectors ?? (async () => {})).run(state);
  } catch (error) {
    if (!args.allowFailure) throw error;
    failure = error;
  }

  return {
    state,
    failure,
    status: state.documentStage(args.documentId, "embed")?.status,
    embedInputs: providerCalls.embed.slice(embedCallsBefore).flat(),
    contextCalls: providerCalls.context - contextCallsBefore,
  };
}

function embeddingUsage(state: WorkflowState) {
  return state.usageLedger.snapshot().filter((event) => event.metric === "embedding-tokens");
}

beforeEach(() => {
  providerCalls.embed.length = 0;
  providerCalls.context = 0;
});

describe("embedding reuse keys", () => {
  const base = {
    runtime: "remote" as const, provider: "openai", model: "text-embedding-3-small", baseUrl: null,
    dimensions: 1536, task: "document" as const, normalize: true, supportsCustomDimensions: true,
  };

  it("are stable for the same input and parameters and change with any vector parameter", () => {
    const fingerprint = embeddingVectorFingerprint(base);
    const key = embeddingInputKey("chunk text", fingerprint);
    expect(embeddingInputKey("chunk text", embeddingVectorFingerprint({ ...base }))).toBe(key);
    expect(embeddingInputKey("chunk text ", fingerprint)).not.toBe(key);
    for (const changed of [
      { model: "text-embedding-3-large" },
      { dimensions: 512 },
      { provider: "ollama" },
      { baseUrl: "http://gpu-box:11434/v1" },
      { task: "query" as const },
      { normalize: false },
    ]) {
      expect(embeddingInputKey("chunk text", embeddingVectorFingerprint({ ...base, ...changed })), JSON.stringify(changed)).not.toBe(key);
    }
    const local = { ...base, runtime: "local" as const };
    expect(embeddingVectorFingerprint({ ...local, localDtype: "q8" })).not.toBe(embeddingVectorFingerprint({ ...local, localDtype: "fp32" }));
  });

  it("separate document context by model and text", () => {
    const key = documentContextKey({ model: "m1", documentTitle: "a.pdf", documentText: "text" });
    expect(documentContextKey({ model: "m2", documentTitle: "a.pdf", documentText: "text" })).not.toBe(key);
    expect(documentContextKey({ model: "m1", documentTitle: "a.pdf", documentText: "text!" })).not.toBe(key);
  });
});

describe("EmbeddingReuseLookup", () => {
  function artifactWith(keys: Array<[string, number[]]>): ReusableEmbeddingArtifact {
    return {
      documentId: "d", embedding: {} as ReusableEmbeddingArtifact["embedding"], vectorBackends: [], chunking: "", source: {}, runtime: {},
      chunks: keys.map(([key, vector], index) => ({ id: `d-${index}`, index, text: key, tokenEstimate: 1, vector, metadata: { embeddingInputKey: key } })),
    };
  }

  it("partitions keys into verified hits and misses and never crosses organizations", async () => {
    const storage = new MemoryStorage();
    const reuse = new MemoryReuseStore();
    await storage.putJson("u1/r1/embeddings/d.json", artifactWith([["k1", [0.1, 0.2]], ["k2", [0.3, 0.4]], ["bad", []]]));
    const uri = storage.uri("u1/r1/embeddings/d.json");
    await reuse.recordEmbeddingReuseRefs("o1", [
      { key: "k1", artifactUri: uri, chunkIndex: 0 },
      { key: "k2", artifactUri: uri, chunkIndex: 1 },
      { key: "bad", artifactUri: uri, chunkIndex: 2 },
    ]);

    const hits = await new EmbeddingReuseLookup({ storage, store: reuse, orgId: "o1" }).findVectors(["k1", "k2", "k3", "bad"]);
    expect([...hits.keys()].sort()).toEqual(["k1", "k2"]);
    expect(hits.get("k2")).toEqual([0.3, 0.4]);

    expect((await new EmbeddingReuseLookup({ storage, store: reuse, orgId: "o2" }).findVectors(["k1", "k2"])).size).toBe(0);
    expect((await new EmbeddingReuseLookup({ storage, store: reuse, orgId: null }).findVectors(["k1"])).size).toBe(0);
  });

  it("treats a pointer to a purged artifact as a miss and drops it", async () => {
    const storage = new MemoryStorage();
    const reuse = new MemoryReuseStore();
    await reuse.recordEmbeddingReuseRefs("o1", [{ key: "k1", artifactUri: storage.uri("u1/gone/embeddings/d.json"), chunkIndex: 0 }]);

    const lookup = new EmbeddingReuseLookup({ storage, store: reuse, orgId: "o1" });
    expect((await lookup.findVectors(["k1"])).size).toBe(0);
    expect(lookup.stats.artifactsMissing).toBe(1);
    expect(reuse.forgotten).toEqual(["k1"]);
  });

  it("reads seed artifacts without a store", async () => {
    const storage = new MemoryStorage();
    await storage.putJson("u1/r1/embeddings/d.json", artifactWith([["k1", [1]]]));
    const lookup = new EmbeddingReuseLookup({ storage, orgId: null, seedArtifactUris: [storage.uri("u1/r1/embeddings/d.json"), undefined] });
    expect((await lookup.findVectors(["k1", "k2"])).get("k1")).toEqual([1]);
  });
});

describe("EmbedStage chunk materialization", () => {
  it("removes stale native and Postgres chunks when reusing an empty embedding artifact", async () => {
    const storage = new MemoryStorage();
    const reuse = new MemoryReuseStore();
    const original = await embedDocument({ storage, reuse, runId: "original", documentId: "original" });
    // Empty artifacts remain a valid stored shape (for example an earlier parser
    // result); materializing one is a replacement, not permission to keep old rows.
    await storage.putJson(original.artifactUri.replace(`s3://${BUCKET}/`, ""), { ...original.artifact, chunks: [] });
    const calls: string[] = [];
    const result = await embedDocument({
      storage, reuse, runId: "run-empty", documentId: "empty", dedupHashes: original.state.contentHashes,
      storeExtras: {
        insertChunks: async (chunks: unknown[]) => { calls.push(`insert:${chunks.length}`); },
        staleDocumentChunkIds: async (_id: string, keep: readonly string[]) => { expect(keep).toEqual([]); return ["empty-000"]; },
        deleteStaleDocumentChunks: async (_id: string, keep: readonly string[]) => { expect(keep).toEqual([]); calls.push("prune"); },
        markDocumentLexicalSearchable: async () => { calls.push("mark"); },
      },
      deleteVectors: async (_uri, _table, ids) => { expect(ids).toEqual(["empty-000"]); calls.push("lance"); },
    });
    expect(result.artifact.chunks).toEqual([]);
    expect(calls).toEqual(["insert:0", "lance", "prune"]);
  });

  it("publishes complete keyword chunks before embedding when early publication is enabled", async () => {
    vi.stubEnv("DOCSLURP_EARLY_LEXICAL_CHUNKS", "on");
    const calls: string[] = [];
    try {
      const result = await embedDocument({
        storage: new MemoryStorage(), reuse: new MemoryReuseStore(), runId: "run-early", documentId: "early",
        storeExtras: {
          insertChunks: async (chunks: Array<{ text: string }>) => {
            expect(chunks.length).toBeGreaterThan(0);
            expect(chunks.every(chunk => chunk.text.length > 0)).toBe(true);
            expect(providerCalls.embed).toHaveLength(0);
            calls.push("written");
          },
          markDocumentLexicalSearchable: async () => {
            expect(calls).toEqual(["written"]);
            expect(providerCalls.embed).toHaveLength(0);
            calls.push("searchable");
          },
        },
      });
      expect(calls).toEqual(["written", "searchable"]);
      expect(providerCalls.embed.length).toBeGreaterThan(0);
      expect(result.artifact.chunks.every(chunk => chunk.vector.length > 0)).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });

  it("never stamps the early marker, or calls the embedding provider, when the chunk insert fails", async () => {
    vi.stubEnv("DOCSLURP_EARLY_LEXICAL_CHUNKS", "on");
    const marked: string[] = [];
    try {
      const result = await runEmbed({
        storage: new MemoryStorage(), reuse: new MemoryReuseStore(), runId: "run-insert-fails", documentId: "insert-fails",
        allowFailure: true,
        storeExtras: {
          insertChunks: async () => { throw new Error("chunk insert failed"); },
          markDocumentLexicalSearchable: async (documentId: string) => { marked.push(documentId); },
        },
      });
      expect(marked).toEqual([]);
      expect(result.embedInputs).toEqual([]);
      expect(embeddingUsage(result.state)).toEqual([]);
      expect(result.status).toBe("failed");
    } finally { vi.unstubAllEnvs(); }
  });

  it("fails the document in the store when embedding fails after the early publish", async () => {
    // The marker is already stamped by then; search excludes the document only
    // because the store flips it to failed (server/src/search/eligibility.ts).
    vi.stubEnv("DOCSLURP_EARLY_LEXICAL_CHUNKS", "on");
    const calls: string[] = [];
    try {
      const result = await runEmbed({
        storage: new MemoryStorage(), reuse: new MemoryReuseStore(), runId: "run-embed-fails", documentId: "embed-fails",
        privacyMode: "local-only", allowFailure: true,
        storeExtras: {
          insertChunks: async () => { calls.push("written"); },
          markDocumentLexicalSearchable: async () => { calls.push("searchable"); },
          failDocumentStage: async (_state: unknown, documentId: string, stage: string) => { calls.push(`failed:${documentId}:${stage}`); },
        },
      });
      expect(result.embedInputs).toEqual([]);
      expect(calls).toEqual(["written", "searchable", "failed:embed-fails:embed"]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("writes identical chunk rows and an identical artifact whether or not early publication is on", async () => {
    const run = async (mode: "off" | "on") => {
      vi.stubEnv("DOCSLURP_EARLY_LEXICAL_CHUNKS", mode);
      const rows: Array<Record<string, unknown>> = [];
      try {
        const result = await embedDocument({
          storage: new MemoryStorage(), reuse: new MemoryReuseStore(), runId: "run-parity", documentId: "parity",
          storeExtras: {
            insertChunks: async (chunks: Array<Record<string, unknown>>) => { rows.push(...structuredClone(chunks)); },
            markDocumentLexicalSearchable: async () => {},
          },
        });
        return { rows, artifact: result.artifact, usage: result.state.usageLedger.snapshot().map(({ id: _id, metadata, ...event }) => {
          // Each activity has its own trace; compare usage and pricing, not tracing identity.
          const { traceId: _traceId, spanId: _spanId, ...usageMetadata } = metadata ?? {};
          return { ...event, metadata: usageMetadata };
        }) };
      } finally { vi.unstubAllEnvs(); }
    };

    const off = await run("off");
    const early = await run("on");
    expect(early.rows).toEqual(off.rows);
    expect(early.rows.some((row) => "vector" in row)).toBe(false);
    expect(JSON.stringify(early.artifact)).toBe(JSON.stringify(off.artifact));
    expect(early.artifact.chunks.every((chunk) => chunk.vector.length > 0)).toBe(true);
    expect(early.usage).toEqual(off.usage);

    // A retried activity upserts the same ids with the same rows.
    const retried = await run("on");
    expect(retried.rows.map((row) => row.id)).toEqual(early.rows.map((row) => row.id));
    expect(retried.rows).toEqual(early.rows);
  });

  it("prunes stale chunk rows after the replacement is written and before the document is marked searchable", async () => {
    const calls: string[] = [];
    let writtenIds: string[] = [];
    const result = await embedDocument({
      storage: new MemoryStorage(), reuse: new MemoryReuseStore(), runId: "run-prune", documentId: "prune",
      storeExtras: {
        insertChunks: async (chunks: Array<{ id: string }>) => { writtenIds = chunks.map((chunk) => chunk.id); calls.push("insert"); },
        deleteStaleDocumentChunks: async (documentId: string, keep: readonly string[]) => {
          expect([documentId, keep]).toEqual(["prune", writtenIds]);
          calls.push("prune");
        },
        markDocumentLexicalSearchable: async () => { calls.push("mark"); },
      },
    });
    expect(calls).toEqual(["insert", "prune", "mark"]);
    expect(writtenIds).toEqual(result.artifact.chunks.map((chunk) => chunk.id));
  });

  it("deletes the LanceDB rows of chunks a retry dropped before their Postgres rows, so native search cannot serve them", async () => {
    const calls: string[] = [];
    const deleted: Array<{ table: string; ids: readonly string[] }> = [];
    const result = await embedDocument({
      storage: new MemoryStorage(), reuse: new MemoryReuseStore(), runId: "run-orphan", documentId: "orphan",
      storeExtras: {
        insertChunks: async () => { calls.push("insert"); },
        staleDocumentChunkIds: async () => ["orphan-007", "orphan-008"],
        deleteStaleDocumentChunks: async () => { calls.push("prune"); },
        markDocumentLexicalSearchable: async () => { calls.push("mark"); },
      },
      deleteVectors: async (_uri, table, ids) => { calls.push("lance"); deleted.push({ table, ids }); },
    });
    expect(calls).toEqual(["insert", "lance", "prune", "mark"]);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.ids).toEqual(["orphan-007", "orphan-008"]);
    const space = result.artifact.embedding;
    expect(deleted[0]!.table).toBe(VectorNamespaceManager.getEmbeddingLocation("", "o1", space.model, space.dimensions).table);
    // Handed to the index stage, which deletes them again after its own write commits.
    expect(result.state.staleVectorIds.get("orphan")).toEqual(["orphan-007", "orphan-008"]);
  });

  it("keeps the stale Postgres rows when the LanceDB delete fails, so the retry deletes them again", async () => {
    const calls: string[] = [];
    const result = await runEmbed({
      storage: new MemoryStorage(), reuse: new MemoryReuseStore(), runId: "run-fail", documentId: "fail", allowFailure: true,
      storeExtras: {
        insertChunks: async () => {},
        staleDocumentChunkIds: async () => ["fail-009"],
        deleteStaleDocumentChunks: async () => { calls.push("prune"); },
        markDocumentLexicalSearchable: async () => { calls.push("mark"); },
      },
      deleteVectors: async () => { throw new Error("Too many concurrent writers"); },
    });
    expect(result.status).not.toBe("completed");
    expect(calls).toEqual([]);
  });

  it("leaves LanceDB alone when no chunk rows were stale", async () => {
    const deleted: unknown[] = [];
    await embedDocument({
      storage: new MemoryStorage(), reuse: new MemoryReuseStore(), runId: "run-clean", documentId: "clean",
      storeExtras: {
        insertChunks: async () => {},
        staleDocumentChunkIds: async () => [],
        deleteStaleDocumentChunks: async () => {},
        markDocumentLexicalSearchable: async () => {},
      },
      deleteVectors: async (...call) => { deleted.push(call); },
    });
    expect(deleted).toEqual([]);
  });

  it("marks the document keyword-searchable only after every chunk row is written", async () => {
    const calls: string[] = [];
    const storeExtras = {
      insertChunks: async (chunks: Array<{ documentId: string }>) => { calls.push(`insert:${chunks.length}:${chunks[0]?.documentId}`); },
      markDocumentLexicalSearchable: async (documentId: string) => { calls.push(`mark:${documentId}`); },
    };
    const result = await embedDocument({ storage: new MemoryStorage(), reuse: new MemoryReuseStore(), runId: "run-m", documentId: "m", storeExtras });
    expect(calls).toEqual([`insert:${result.artifact.chunks.length}:m`, "mark:m"]);
  });
});

describe("EmbedStage embedding reuse", () => {
  it("re-uploads in the same org embed nothing; another org pays for its own vectors", async () => {
    const storage = new MemoryStorage();
    const reuse = new MemoryReuseStore();

    const first = await embedDocument({ storage, reuse, runId: "run-1", documentId: "a" });
    const chunkCount = first.artifact.chunks.length;
    expect(chunkCount).toBeGreaterThan(1);
    expect(first.embedInputs).toHaveLength(chunkCount);
    expect(first.stats).toMatchObject({ reuseHits: 0, reuseMisses: chunkCount, providerInputs: chunkCount });
    expect(embeddingUsage(first.state)).not.toHaveLength(0);

    const again = await embedDocument({ storage, reuse, runId: "run-2", documentId: "b" });
    expect(again.embedInputs).toEqual([]);
    expect(again.stats).toMatchObject({ reuseHits: chunkCount, reuseMisses: 0, providerInputs: 0 });
    expect(embeddingUsage(again.state)).toEqual([]);
    // Vectors are written under the new document so index reads them unchanged.
    expect(again.artifact.documentId).toBe("b");
    expect(again.artifact.chunks.map((chunk) => chunk.id)).toEqual(first.artifact.chunks.map((chunk) => chunk.id.replace(/^a-/, "b-")));
    expect(again.artifact.chunks.map((chunk) => chunk.vector)).toEqual(first.artifact.chunks.map((chunk) => chunk.vector));
    const metrics = again.state.pendingPerformance.filter((event) => event.metric.startsWith("embedding-reuse"));
    expect(metrics.map((event) => [event.metric, event.value])).toEqual([["embedding-reuse-hits", chunkCount], ["embedding-reuse-misses", 0]]);

    const otherOrg = await embedDocument({ storage, reuse, orgId: "o2", runId: "run-3", documentId: "c" });
    expect(otherOrg.embedInputs).toHaveLength(chunkCount);
    expect(otherOrg.stats).toMatchObject({ reuseHits: 0 });
  });

  it("embeds only changed chunks and bills only those tokens", async () => {
    const storage = new MemoryStorage();
    const reuse = new MemoryReuseStore();
    await embedDocument({ storage, reuse, runId: "run-1", documentId: "a" });

    const edited = [...SECTIONS];
    edited[1] = edited[1]!.replace("Section 2", "Section two");
    const result = await embedDocument({ storage, reuse, runId: "run-2", documentId: "b", text: edited.join("\n\n") });

    expect(result.embedInputs).toHaveLength(1);
    expect(result.embedInputs[0]).toContain("Section two");
    expect(result.stats).toMatchObject({ reuseMisses: 1, providerInputs: 1 });
    const usage = embeddingUsage(result.state);
    expect(usage.reduce((sum, event) => sum + (event.inputTokens ?? 0), 0)).toBe(result.embedInputs[0]!.length);
  });

  it("misses when the embedding dimensions change", async () => {
    const storage = new MemoryStorage();
    const reuse = new MemoryReuseStore();
    const first = await embedDocument({ storage, reuse, runId: "run-1", documentId: "a" });

    const resized = await embedDocument({
      storage, reuse, runId: "run-2", documentId: "b",
      pipeline: { embedding: { profile: "cheapest-hosted", modelUri: "llm://openai/text-embedding-3-small", target: "hosted", dimensions: 512 } as PipelineFeatureOverrides["embedding"] },
    });
    expect(resized.embedInputs).toHaveLength(first.artifact.chunks.length);
    expect(resized.stats).toMatchObject({ reuseHits: 0 });
  });

  it("partial reprocess with unchanged text makes no embedding or context-model calls", async () => {
    const storage = new MemoryStorage();
    const withContext = { contextualChunkPreambles: true };
    const source = await embedDocument({ storage, runId: "run-src", documentId: "src", pipeline: withContext, openRouter: true });
    expect(source.contextCalls).toBe(1);
    expect(source.artifact.documentContext?.source).toBe("openrouter");

    // No ref store and no org: the seeded source artifact alone is enough.
    const reprocessed = await embedDocument({
      storage, orgId: null, runId: "run-re", documentId: "re", pipeline: withContext, openRouter: true,
      seedEmbeddingsUri: source.artifactUri,
    });

    expect(reprocessed.contextCalls).toBe(0);
    expect(reprocessed.embedInputs).toEqual([]);
    expect(reprocessed.state.usageLedger.snapshot()).toEqual([]);
    expect(reprocessed.stats).toMatchObject({ reuseMisses: 0, documentContextReused: true });
    expect(reprocessed.artifactUri).not.toBe(source.artifactUri);
    expect(reprocessed.artifact.chunks.map((chunk) => chunk.text)).toEqual(source.artifact.chunks.map((chunk) => chunk.text));
    expect(reprocessed.artifact.chunks.map((chunk) => chunk.vector)).toEqual(source.artifact.chunks.map((chunk) => chunk.vector));
    // The new artifact keeps the context, so the next reprocess can reuse it too.
    expect(reprocessed.artifact.documentContext).toMatchObject({ key: source.artifact.documentContext?.key, source: "reused" });
  });

  it("reuses local vectors under local-only privacy while provider misses stay blocked", async () => {
    const storage = new MemoryStorage();
    const reuse = new MemoryReuseStore();
    const first = await embedDocument({ storage, reuse, runId: "run-1", documentId: "a" });

    const cached = await embedDocument({ storage, reuse, runId: "run-2", documentId: "b", privacyMode: "local-only" });
    expect(cached.embedInputs).toEqual([]);
    expect(cached.stats).toMatchObject({ reuseHits: first.artifact.chunks.length, reuseMisses: 0 });

    const edited = [...SECTIONS];
    edited[0] = edited[0]!.replace("Section 1", "Section one");
    const blocked = await runEmbed({
      storage, reuse, runId: "run-3", documentId: "c", text: edited.join("\n\n"),
      privacyMode: "local-only", allowFailure: true,
    });
    expect(blocked.status).not.toBe("completed");
    expect(blocked.embedInputs).toEqual([]);
    expect(embeddingUsage(blocked.state)).toEqual([]);
  });
});

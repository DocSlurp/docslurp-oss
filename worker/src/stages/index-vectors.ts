import { instrumentPostgres } from "@docslurp/shared/observability";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { indexConfigHash, indexConfigOf, resolveLanceDbConfig, VectorNamespaceManager } from "@docslurp/shared";
import { encodeLanceChunkHydration, lancePageNumberValue } from "@docslurp/shared/lancedb-hydration";
import postgres from "postgres";

import type { Config } from "../config.js";
import type { VectorIndex as PipelineVectorIndex, Stage } from "../pipeline/pipeline.js";
import { runDocumentStage, runDocuments } from "../pipeline/checkpoints.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { backendRuntime, resolveVectorBackends } from "../embeddings/resolver.js";
import type { EmbeddingArtifact, VectorBackendRecord } from "./embedding-runtime.js";
import { maxInt } from "./utils.js";
import { chunkFirstPage, deleteLanceDbRecords, planPageWindows, writeLanceDbDocumentInWindows } from "./lancedb-writer.js";
import { lanceDbMaintenanceSettings, type LanceDbMaintenanceSettings } from "./lancedb-maintenance.js";
import { LanceDbWriteQueue, type VectorWriteOutcome } from "./lancedb-write-queue.js";
import { indexableDocuments } from "../pipeline/pii-gate.js";

type BackendResult = {
  backend: string;
  collection: string;
  records: number;
  uri?: string;
  table?: string;
  path?: string;
  location?: string;
  shardCount?: number;
  parallelism?: number;
  /** LanceDB page-window writes for this document, and the maintenance runs they requested. */
  writeWindows?: number;
  maintenanceRuns?: number;
  /** LanceDB write mode and, when queued, how the document's rows were committed. */
  writeMode?: "queued" | "direct";
  queue?: Omit<VectorWriteOutcome, "maintenance"> & { maintenanceRan: boolean };
  shards?: Array<{
    collection: string;
    records: number;
    uri?: string;
    location?: string;
  }>;
};

export function buildVectorIndexSearchMetadata(recordCount: number): {
  mode: "full-index";
  searchableChunks: number;
  fullyIndexed: true;
} {
  return {
    mode: "full-index",
    searchableChunks: recordCount,
    fullyIndexed: true
  };
}

export function vectorBackendCollectionName(args: {
  backend: string;
  orgId: string | null;
  runId: string;
  embedding?: { model: string; dimensions: number };
}): string {
  if (args.backend === "lancedb") {
    if (!args.orgId?.trim()) {
      throw new Error("LanceDB vector indexing requires a run orgId for tenant isolation");
    }
    return args.embedding
      ? VectorNamespaceManager.getEmbeddingLocation("", args.orgId, args.embedding.model, args.embedding.dimensions).table
      : VectorNamespaceManager.getTableName(args.orgId);
  }

  return `${args.runId}_${args.backend}`;
}

/**
 * Lance rows for one document's embedding artifact (the same shape in direct and queued mode).
 * With a run id the rows also carry the hydration columns (@docslurp/shared/lancedb-hydration),
 * so search can cite a hit without reading document_chunks: the same heading path, page, token
 * estimate and metadata the embed stage stored there.
 */
export function buildVectorRecords(
  artifact: Pick<EmbeddingArtifact, "chunks">,
  documentId: string,
  metadata: { sourceKey?: unknown; filename?: unknown },
  runId?: string | null,
): VectorBackendRecord[] {
  return artifact.chunks.map<VectorBackendRecord>((chunk) => ({
    id: chunk.id,
    documentId,
    chunkIndex: chunk.index,
    text: chunk.text,
    vector: chunk.vector,
    metadata: {
      documentId,
      sourceKey: metadata.sourceKey,
      filename: metadata.filename
    },
    ...(runId ? {
      runId,
      pageNumber: lancePageNumberValue(chunk.pageNumber),
      hydration: encodeLanceChunkHydration({
        runId,
        headingPath: chunk.headingPath,
        pageNumber: chunk.pageNumber,
        tokenEstimate: chunk.tokenEstimate,
        metadata: chunk.metadata,
      }),
    } : {}),
  }));
}

export class IndexStage implements Stage {
  readonly name = "index";
  private readonly lance: LanceDbMaintenanceSettings;
  private queueSql: ReturnType<typeof postgres> | null = null;
  private queue: LanceDbWriteQueue | null = null;

  constructor(
    private readonly runner: CommandRunner,
    private readonly storage: ArtifactStore,
    private readonly config: Config,
    private readonly deleteVectors: (uri: string, table: string, ids: readonly string[]) => Promise<void> = deleteLanceDbRecords
  ) {
    this.lance = lanceDbMaintenanceSettings(config.lancedb?.params ?? new URLSearchParams());
  }

  /** One queue (and a small pooled client) per worker process, created on first LanceDB write. */
  private writeQueue(): LanceDbWriteQueue {
    if (this.queue) return this.queue;
    this.queueSql = instrumentPostgres(postgres(this.config.databaseUrl, {
      max: Math.max(1, Number.parseInt(process.env.WORKER_VECTOR_QUEUE_DB_POOL_MAX ?? "2", 10) || 2),
      // Transaction-mode poolers (Neon pooler, PgBouncer) cannot route prepared statements.
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
    }), this.config.databaseUrl);
    this.queue = new LanceDbWriteQueue({
      sql: this.queueSql,
      loadRecords: async (row) => {
        const artifact = await this.storage.getJson<EmbeddingArtifact>(row.artifactKey, { streamJson: true });
        return buildVectorRecords(artifact, row.documentId, row.metadata, row.runId);
      },
      maintenance: {
        enabled: this.lance.enabled,
        mode: this.lance.mode,
        vectorIndexMinRows: this.lance.vectorIndexMinRows,
        versionRetentionMs: this.lance.versionRetentionMs,
        optimizeEveryRows: this.lance.optimizeEveryRows,
        optimizeEveryCommits: this.lance.optimizeEveryCommits,
        optimizeIntervalMs: this.lance.optimizeIntervalMs,
        optimizeMinIntervalMs: this.lance.optimizeMinIntervalMs,
        maxIndexSegments: this.lance.maxIndexSegments,
        consolidateMaxRows: this.lance.consolidateMaxRows,
      },
      settings: {
        maxBatchDocuments: this.lance.queueBatchDocuments,
        maxBatchRecords: this.lance.queueBatchRecords,
        waitTimeoutMs: this.lance.queueWaitTimeoutMs,
      },
    });
    return this.queue;
  }

  async run(state: import("../pipeline/pipeline.js").WorkflowState, signal?: AbortSignal): Promise<void> {
    if (!state.run.pipeline.indexVectors) {
      return;
    }

    const backends = resolveVectorBackends(this.config, state.run.pipeline);

    await runDocuments(indexableDocuments(state), state.docConcurrency, async (document) => {
      const artifactSlot = `${document.id}:index`;

      await runDocumentStage(
        state,
        document,
        this.name,
        artifactSlot,
        "vector index manifests ready",
        async () => {
          const embeddingKey = `${document.userId}/${state.run.id}/embeddings/${document.id}.json`;
          const artifact = await this.storage.getJson<EmbeddingArtifact>(embeddingKey, { streamJson: true });
          const records = buildVectorRecords(artifact, document.id, {
            sourceKey: document.sourceKey,
            filename: document.filename
          }, state.run.id);
          const recordPages = artifact.chunks.map((chunk) => chunkFirstPage(chunk));

          const manifests: Array<Record<string, unknown>> = [];
          const CONCURRENCY = Math.min(backends.length, 4);
          let idx = 0;

          async function runBackend(this: IndexStage): Promise<void> {
            while (true) {
              const i = idx++;
              if (i >= backends.length) return;
              const backend = backends[i]!;
              const collection = vectorBackendCollectionName({
                backend,
                orgId: state.run.orgId,
                runId: state.run.id,
                embedding: artifact.embedding,
              });
              const result = await this.writeBackend({
                backend,
                orgId: state.run.orgId,
                runId: state.run.id,
                documentId: document.id,
                embeddingKey,
                recordMetadata: { sourceKey: document.sourceKey, filename: document.filename },
                collection,
                records,
                recordPages,
                embedding: artifact,
                staleIds: state.staleVectorIds.get(document.id),
                signal
              });

              const key = `${document.userId}/${state.run.id}/vectors/${backend}/${document.id}/manifest.json`;
              const shardManifests = result.shards
                ? await Promise.all(
                    result.shards.map(async (shard, shardIndex) => {
                      const shardKey = `${document.userId}/${state.run.id}/vectors/${backend}/${document.id}/shards/${shardIndex.toString().padStart(3, "0")}.json`;
                      await this.storage.putJson(shardKey, {
                        documentId: document.id,
                        backend,
                        collection: result.collection,
                        shardIndex,
                        shardCollection: shard.collection,
                        records: shard.records,
                        uri: shard.uri ?? null,
                        location: shard.location ?? null
                      });
                      return {
                        shardIndex,
                        collection: shard.collection,
                        records: shard.records,
                        uri: this.storage.uri(shardKey)
                      };
                    })
                  )
                : [];
              await this.storage.putJson(key, {
                documentId: document.id,
                backend: {
                  name: backend,
                  runtime: backendRuntime(backend)
                },
                embedding: artifact.embedding,
                records: records.length,
                result,
                shardCount: result.shardCount ?? 0,
                shardParallelism: result.parallelism ?? 1,
                shards: shardManifests
              });

              state.vectorIndexes.push({
                documentId: document.id,
                backend,
                bucket: this.storage.bucket,
                path: key,
                embeddingModel: artifact.embedding.model,
                dimension: artifact.embedding.dimensions,
                indexConfigHash: indexConfigHash(indexConfigOf(state.run.pipeline))
              } satisfies PipelineVectorIndex);

              manifests.push({
                backend,
                uri: this.storage.uri(key),
                result
              });
            }
          }

          await Promise.all(
            Array.from({ length: CONCURRENCY }, () => runBackend.call(this))
          );

          const summaryKey = `${document.userId}/${state.run.id}/vectors/${document.id}.json`;
          const search = buildVectorIndexSearchMetadata(records.length);
          await this.storage.putJson(summaryKey, {
            documentId: document.id,
            embeddingModel: artifact.embedding.model,
            dimensions: artifact.embedding.dimensions,
            backends: manifests,
            search
          });

          state.pendingPerformance.push({
            documentId: document.id,
            scope: "document",
            stageName: this.name,
            metric: "vector-backend-count",
            value: backends.length,
            unit: "backend",
            tags: ["document", "vector", "fanout"],
            metadata: {
              backends,
              dimensions: artifact.embedding.dimensions,
              model: artifact.embedding.model
            }
          });
          state.run.processedDocuments += 1;
          state.run.pagesProcessed = Math.min(state.run.pagesTotal, state.run.pagesProcessed + maxInt(1, document.pageCount));

          return {
            artifactUri: this.storage.uri(summaryKey),
            stats: {
              backendCount: backends.length,
              dimensions: artifact.embedding.dimensions,
              records: records.length,
              search
            }
          };
        },
        signal
      );
    });
  }

  /**
   * Maintenance leader sweep (temporal/worker.ts): schedule maintenance for queued-mode tables
   * that are due but have no drainer coming, e.g. the last write before traffic stopped.
   */
  async sweepLanceDbMaintenance(): Promise<number> {
    // Inline mode keeps the old behaviour: maintenance only follows writes.
    if (!this.lance.enabled || this.lance.mode === "inline" || this.lance.writeMode !== "queued"
      || !this.config.vectorBackends.includes("lancedb")) return 0;
    return await this.writeQueue().sweepDueMaintenance();
  }

  async close(): Promise<void> {
    const sql = this.queueSql;
    this.queue = null;
    this.queueSql = null;
    await sql?.end({ timeout: 5 }).catch(() => undefined);
  }

  private async writeBackend(args: {
    backend: string;
    orgId: string | null;
    runId: string;
    documentId: string;
    embeddingKey: string;
    recordMetadata: { sourceKey?: unknown; filename?: unknown };
    collection: string;
    records: VectorBackendRecord[];
    recordPages: Array<number | null>;
    embedding: EmbeddingArtifact;
    /** Chunk ids the embed stage dropped; deleted again after this document's rows commit. */
    staleIds?: readonly string[];
    signal?: AbortSignal;
  }): Promise<BackendResult> {
    switch (args.backend) {
      case "lancedb":
        if (!args.orgId) throw new Error("LanceDB indexing requires orgId");
        const location = VectorNamespaceManager.getEmbeddingLocation(
          resolveLanceDbConfig().root,
          args.orgId, args.embedding.embedding.model, args.embedding.embedding.dimensions,
        );
        const result = this.lance.writeMode === "queued"
          ? await this.writeLanceDbQueued(location.uri, location.table, args)
          : await this.writeLanceDb(location.uri, location.table, args.records, args.recordPages, args.signal);
        // An earlier attempt's write still pending in the outbox can land
        // after the embed stage's delete. The table write lease normally
        // orders it before this document's write; it is a TTL, so a drainer
        // that lost it mid-write can still land later (rare, not guarded).
        const written = new Set(args.records.map((record) => record.id));
        const stale = (args.staleIds ?? []).filter((id) => !written.has(id));
        if (stale.length > 0) await this.deleteVectors(location.uri, location.table, stale);
        return result;
      default:
        return await this.writeScriptBackend(args.backend, args.collection, args.records, args.embedding, args.signal);
    }
  }

  private async writeLanceDbQueued(
    uri: string,
    table: string,
    args: {
      orgId: string | null;
      runId: string;
      documentId: string;
      embeddingKey: string;
      recordMetadata: { sourceKey?: unknown; filename?: unknown };
      records: VectorBackendRecord[];
      signal?: AbortSignal;
    }
  ): Promise<BackendResult> {
    const { maintenance, ...queue } = await this.writeQueue().indexDocument({
      uri,
      table,
      orgId: args.orgId,
      documentId: args.documentId,
      runId: args.runId,
      artifactKey: args.embeddingKey,
      metadata: args.recordMetadata,
      recordCount: args.records.length,
    }, args.signal);
    return {
      backend: "lancedb",
      collection: table,
      records: args.records.length,
      uri,
      location: uri,
      shardCount: 0,
      parallelism: 1,
      shards: [],
      writeMode: "queued",
      maintenanceRuns: maintenance ? 1 : 0,
      queue: { ...queue, maintenanceRan: maintenance !== null },
    };
  }

  private async writeLanceDb(
    uri: string,
    collection: string,
    records: VectorBackendRecord[],
    recordPages: Array<number | null>,
    signal?: AbortSignal
  ): Promise<BackendResult> {
    const indexed = records.map((record, index) => ({ record, page: recordPages[index] ?? null }));
    const windows = planPageWindows(indexed, (item) => item.page, this.config.lancedbReindexPages)
      .map((window) => window.map((item) => item.record));
    const { writes, maintenanceRuns } = await writeLanceDbDocumentInWindows({
      uri,
      table: collection,
      windows,
      maintenance: {
        enabled: this.config.lancedbMaintenanceEnabled,
        mode: this.lance.mode,
        vectorIndexMinRows: this.config.lancedbVectorIndexMinRows,
        versionRetentionMs: this.lance.versionRetentionMs,
        maxIndexSegments: this.lance.maxIndexSegments,
        consolidateMaxRows: this.lance.consolidateMaxRows,
        cadence: this.lance,
      },
      signal,
    });

    return {
      backend: "lancedb",
      collection,
      records: records.length,
      uri,
      location: uri,
      shardCount: 0,
      parallelism: 1,
      shards: [],
      writeWindows: writes,
      maintenanceRuns,
      writeMode: "direct"
    };
  }

  private async writeScriptBackend(
    backend: string,
    collection: string,
    records: VectorBackendRecord[],
    embedding: EmbeddingArtifact,
    signal?: AbortSignal
  ): Promise<BackendResult> {
    const directory = await mkdtemp(path.join(tmpdir(), "docslurp-vector-"));
    const inputPath = path.join(directory, "input.json");
    const outputPath = path.join(directory, "output.json");

    try {
      await writeFile(
        inputPath,
        JSON.stringify(
          {
            collection,
            records,
            embedding: embedding.embedding
          },
          null,
          2
        )
      );

      const plan = await this.runner.writeVectorBackend(inputPath, outputPath, backend, collection);
      await this.runner.run(plan, signal);
      return JSON.parse(await readFile(outputPath, "utf8")) as BackendResult;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

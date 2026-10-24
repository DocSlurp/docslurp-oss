import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { connect } from "@lancedb/lancedb";
import { normalizePipelineFeatures, VectorNamespaceManager } from "@docslurp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import type { Document, WorkspaceRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { IndexStage } from "../stages/index-vectors.js";

/**
 * The index stage writes into the run's workspace database; a dedup copy in
 * another workspace than its source indexes the source's embedding artifact
 * (named by its seeded embed checkpoint) as its own rows.
 */
const MODEL = "provider/embed";
const DIM = 2;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "docslurp-index-ws-"));
  vi.stubEnv("LANCEDB_URI", dir);
  vi.stubEnv("LANCEDB_WRITE_MODE", "direct");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function memoryStorage(objects: Map<string, unknown>): ArtifactStore {
  return {
    bucket: "b",
    uri: (key: string) => `s3://b/${key}`,
    getJson: async (key: string) => {
      if (!objects.has(key)) throw new Error(`missing ${key}`);
      return structuredClone(objects.get(key));
    },
    putJson: async (key: string, value: unknown) => { objects.set(key, value); },
  } as unknown as ArtifactStore;
}

const embeddingArtifact = (documentId: string) => ({
  documentId,
  embedding: { model: MODEL, dimensions: DIM },
  vectorBackends: ["lancedb"],
  chunking: "test",
  source: {},
  runtime: {},
  chunks: [0, 1].map((index) => ({
    id: `${documentId}-${index.toString().padStart(3, "0")}`, index, text: `text ${index}`, vector: [1, index],
    tokenEstimate: 2, headingPath: [], pageNumber: 1, metadata: { documentId },
  })),
});

function runState(args: { runId: string; workspaceId: string; documentId: string }): WorkflowState {
  const pipeline = { ...normalizePipelineFeatures({}), indexVectors: true, vectorBackends: ["lancedb"] };
  const run = {
    id: args.runId, orgId: "org-a", userId: "u", workspaceId: args.workspaceId, kind: "bulk-upload", status: "processing",
    stage: "index", totalDocuments: 1, processedDocuments: 0, pagesTotal: 1, pagesProcessed: 0, spentCents: 0,
    pipeline, error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
  } as WorkspaceRun;
  const document = {
    id: args.documentId, userId: "u", runId: args.runId, filename: "a.pdf", mimeType: "application/pdf", sourceKey: "k",
    status: "processing", extractionMode: "hybrid", pageCount: 1, createdAt: new Date(), updatedAt: new Date(),
  } as Document;
  return new WorkflowState(run, [document]);
}

async function rows(workspaceId: string) {
  const location = VectorNamespaceManager.getEmbeddingLocation(dir, "org-a", workspaceId, MODEL, DIM);
  const db = await connect(location.uri);
  try {
    if (!(await db.tableNames()).includes(location.table)) return [];
    const table = await db.openTable(location.table);
    try {
      return (await table.query().select(["id", "documentId", "runId"]).toArray() as Array<{ id: string; documentId: string; runId: string }>)
        .map((row) => ({ id: row.id, documentId: row.documentId, runId: row.runId }))
        .sort((a, b) => a.id.localeCompare(b.id));
    } finally { table.close(); }
  } finally { db.close(); }
}

describe("IndexStage per-workspace databases", () => {
  const config = {
    vectorBackends: ["lancedb"], lancedb: { params: new URLSearchParams() }, lancedbReindexPages: 20,
    lancedbMaintenanceEnabled: false, lancedbVectorIndexMinRows: 100_000, databaseUrl: "",
  } as unknown as Config;

  it("writes a document's own rows into its run's workspace database only", async () => {
    const objects = new Map<string, unknown>([["u/run-a/embeddings/src.json", embeddingArtifact("src")]]);
    const state = runState({ runId: "run-a", workspaceId: "ws-a", documentId: "src" });
    await new IndexStage({} as CommandRunner, memoryStorage(objects), config).run(state);

    expect(await rows("ws-a")).toEqual([
      { id: "src-000", documentId: "src", runId: "run-a" },
      { id: "src-001", documentId: "src", runId: "run-a" },
    ]);
    expect(await rows("ws-b")).toEqual([]);
    expect(state.vectorIndexes).toMatchObject([{ documentId: "src", embeddingModel: MODEL, dimension: DIM }]);
  });

  it("indexes a cross-workspace dedup copy from its source's artifact as the copy's own rows", async () => {
    const objects = new Map<string, unknown>([["u/run-a/embeddings/src.json", embeddingArtifact("src")]]);
    const state = runState({ runId: "run-b", workspaceId: "ws-b", documentId: "copy" });
    // Run creation seeds the copy's embed checkpoint with the source's artifact.
    state.setDocumentStage({
      runId: "run-b", documentId: "copy", stageName: "embed", status: "completed", attempts: 1,
      artifactUri: "s3://b/u/run-a/embeddings/src.json",
    } as Parameters<WorkflowState["setDocumentStage"]>[0]);
    await new IndexStage({} as CommandRunner, memoryStorage(objects), config).run(state);

    expect(await rows("ws-b")).toEqual([
      { id: "copy-000", documentId: "copy", runId: "run-b" },
      { id: "copy-001", documentId: "copy", runId: "run-b" },
    ]);
    expect(await rows("ws-a")).toEqual([]);
  });

  it("fails closed for a run without a workspace", async () => {
    const objects = new Map<string, unknown>([["u/run-a/embeddings/src.json", embeddingArtifact("src")]]);
    const state = runState({ runId: "run-a", workspaceId: "ws-a", documentId: "src" });
    state.run.workspaceId = undefined;
    await new IndexStage({} as CommandRunner, memoryStorage(objects), config).run(state).catch(() => undefined);
    expect(state.vectorIndexes).toEqual([]);
    expect(await rows("ws-a")).toEqual([]);
  });
});

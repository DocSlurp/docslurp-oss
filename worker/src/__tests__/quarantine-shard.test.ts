import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { QuarantineStage } from "../stages/quarantine.js";
import { WorkflowState, type CheckpointStore } from "../pipeline/pipeline.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import { sha256Bytes } from "../sandbox/source-integrity.js";
import type { Document, ProjectRun } from "../models.js";
import type { Config } from "../config.js";
import type { ArtifactStore } from "../tools/storage.js";
import type { CommandRunner } from "../tools/runner.js";

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  // Trusted synthetic bytes: only the external malware tool is mocked. The actual
  // stage, MIME/archive inspection, refusal and checkpoint code all run.
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "development");
  const dir = await mkdtemp(join(tmpdir(), "quarantine-shards-")); dirs.push(dir);
  const sources = new Map([
    ["clean.txt", Buffer.from("clean synthetic text")],
    ["infected.txt", Buffer.from("infected synthetic text")],
    ["oversized.zip", Buffer.from(zipSync({ "large.txt": new Uint8Array(1024) }))],
    ["interrupted.txt", Buffer.from("interrupt synthetic text")],
  ]);
  const now = new Date();
  const documents: Document[] = [...sources].map(([filename, bytes]) => ({
    id: filename, userId: "u", runId: "run", filename, mimeType: filename.endsWith("zip") ? "application/zip" : "text/plain",
    sourceKey: filename, sourceSha256: sha256Bytes(bytes), status: "queued", extractionMode: "hybrid", pageCount: 1,
    createdAt: now, updatedAt: now,
  }));
  const run: ProjectRun = { id: "run", orgId: "org", projectId: "project", userId: "u", kind: "bulk-upload",
    status: "processing", stage: "quarantine", totalDocuments: documents.length, processedDocuments: 0,
    pagesTotal: documents.length, pagesProcessed: 0, spentCents: 0, pipeline: { ...defaultPipelineFeatures },
    error: null, stats: {}, artifacts: {}, claimId: null, createdAt: now, updatedAt: now };
  const state = WorkflowState.create(run, documents); state.docConcurrency = 1;
  const persisted: Array<Record<string, string>> = [];
  const store: CheckpointStore = {
    startDocumentStage: vi.fn(async () => {}), completeDocumentStage: vi.fn(async () => {}), failDocumentStage: vi.fn(async () => {}),
    updateProgress: vi.fn(async (current) => { persisted.push({ ...current.artifacts }); }),
    startRunStage: vi.fn(async () => {}), completeRunStage: vi.fn(async () => {}), failRunStage: vi.fn(async () => {}),
    appendEvent: vi.fn(async () => {}), setPageStageComplete: vi.fn(async () => {}), getCompletedPages: vi.fn(async () => new Set<number>()),
  };
  state.store = store;
  const downloads: string[] = []; let sequence = 0;
  const artifacts = new Map<string, unknown>();
  const storage = {
    downloadSourceToTempFile: async (key: string, _pattern: string, options: { maxBytes: number }) => {
      downloads.push(key); const bytes = sources.get(key)!;
      expect(bytes.length).toBeLessThanOrEqual(options.maxBytes);
      const path = join(await mkdtemp(join(dir, "doc-")), `${sequence++}-${key}`); await writeFile(path, bytes); return path;
    },
    putArtifactJson: async (key: string, artifact: unknown) => { artifacts.set(key, artifact); },
    uri: (key: string) => `s3://test/${key}`,
  } as unknown as ArtifactStore;
  const scan = vi.fn(async (path: string, _signal?: AbortSignal) => ({
    status: (await readFile(path, "utf8")).startsWith("infected") ? "infected" : "clean",
    engine: "synthetic-test-scanner", signature: "synthetic", databaseStatus: "fresh",
  }));
  const config = { quarantineEnabled: true, quarantineFailOpenOnToolMissing: false,
    quarantineMaxArchiveEntries: 10, quarantineMaxArchiveDepth: 3, quarantineMaxTotalUncompressedBytes: 2048,
    quarantineMaxSingleEntryBytes: 128, quarantineMaxExpansionRatio: 10 } as Config;
  const stage = new QuarantineStage({ scanForMalware: scan } as unknown as CommandRunner, storage, config);
  return { state, stage, scan, store, downloads, artifacts, persisted };
}

describe("real quarantine stage under document sharding", () => {
  it("persists clean and refused checkpoints, excludes foreign IDs, and skips unsafe documents downstream", async () => {
    const f = await fixture();
    f.state.beginShard(["clean.txt", "infected.txt", "oversized.zip", "foreign-run-document"]);
    await f.stage.run(f.state);
    expect(f.state.documentStage("clean.txt", "quarantine")?.status).toBe("completed");
    for (const id of ["infected.txt", "oversized.zip"]) expect(f.state.documentStage(id, "quarantine")?.status).toBe("failed");
    expect(healthyDocuments(f.state).map((doc) => doc.id)).toEqual(["clean.txt"]);
    expect(f.downloads).toEqual(["clean.txt", "infected.txt", "oversized.zip"]);
    expect(f.artifacts.size).toBe(3);
    expect(f.store.failDocumentStage).toHaveBeenCalledTimes(2);
    // Reconciliation/retry cannot rescan completed or permanently refused bytes.
    await f.stage.run(f.state);
    expect(f.scan).toHaveBeenCalledTimes(3);
    expect(f.persisted.some((row) => row["clean.txt:quarantine"] !== undefined)).toBe(true);
  });

  it("retries an interrupted scan without rescanning a completed sibling", async () => {
    const f = await fixture(); f.state.beginShard(["clean.txt", "interrupted.txt"]);
    const controller = new AbortController();
    const original = f.scan.getMockImplementation()!;
    f.scan.mockImplementation(async (path, signal) => {
      if (path.includes("interrupted")) { controller.abort(new Error("worker shutdown")); throw controller.signal.reason; }
      return original(path, signal);
    });
    await expect(f.stage.run(f.state, controller.signal)).rejects.toThrow("worker shutdown");
    expect(f.state.documentStage("clean.txt", "quarantine")?.status).toBe("completed");
    expect(f.state.documentStage("interrupted.txt", "quarantine")?.status).not.toBe("failed");
    f.scan.mockImplementation(original);
    await f.stage.run(f.state);
    expect(f.downloads).toEqual(["clean.txt", "interrupted.txt", "interrupted.txt"]);
    expect(f.state.documentStage("interrupted.txt", "quarantine")?.status).toBe("completed");
    expect(f.store.failDocumentStage).not.toHaveBeenCalled();
    expect(f.store.updateProgress).toHaveBeenCalled();
  });
});

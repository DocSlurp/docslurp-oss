import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultPipelineFeatures } from "@docslurp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import type { Document, ProjectRun } from "../models.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import { type CheckpointStore, WorkflowState } from "../pipeline/pipeline.js";
import { sha256Bytes } from "../sandbox/source-integrity.js";
import { QuarantineStage } from "../stages/quarantine.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";

// Authored EICAR test string: the industry-standard harmless test file every engine reports as infected.
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture(extra: Document[] = []) {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "development");
  const dir = await mkdtemp(join(tmpdir(), "quarantine-scanner-flags-")); dirs.push(dir);
  const sources = new Map([["report.txt", Buffer.from("Quarterly revenue up 12% on strong demand")], ["eicar.txt", Buffer.from(EICAR)]]);
  const now = new Date();
  const documents: Document[] = [...sources].map(([filename, bytes]) => ({
    id: filename, userId: "u", runId: "run", filename, mimeType: "text/plain", sourceKey: filename, sourceSha256: sha256Bytes(bytes),
    status: "queued", extractionMode: "hybrid", pageCount: 1, createdAt: now, updatedAt: now,
  }));
  for (const document of extra) { documents.push(document); sources.set(document.sourceKey, Buffer.from("other")); }
  const run: ProjectRun = { id: "run", orgId: "org-a", projectId: "project", userId: "u", kind: "bulk-upload", status: "processing", stage: "quarantine",
    totalDocuments: documents.length, processedDocuments: 0, pagesTotal: documents.length, pagesProcessed: 0, spentCents: 0,
    pipeline: { ...defaultPipelineFeatures }, error: null, stats: {}, artifacts: {}, claimId: null, createdAt: now, updatedAt: now };
  const state = WorkflowState.create(run, documents);
  state.docConcurrency = 2;
  const store: CheckpointStore = {
    startDocumentStage: vi.fn(async () => {}), completeDocumentStage: vi.fn(async () => {}), failDocumentStage: vi.fn(async () => {}),
    updateProgress: vi.fn(async () => {}), startRunStage: vi.fn(async () => {}), completeRunStage: vi.fn(async () => {}), failRunStage: vi.fn(async () => {}),
    appendEvent: vi.fn(async () => {}), setPageStageComplete: vi.fn(async () => {}), getCompletedPages: vi.fn(async () => new Set<number>()),
  };
  state.store = store;
  let sequence = 0;
  const storage = {
    downloadSourceToTempFile: async (key: string) => { const p = join(await mkdtemp(join(dir, "doc-")), `${sequence++}-${key}`); await writeFile(p, sources.get(key)!); return p; },
    putArtifactJson: async () => {},
    uri: (key: string) => `s3://test/${key}`,
  } as unknown as ArtifactStore;
  // The scanner double reports what clamd reports for these bytes; the real stage, refusal and checkpoint code run.
  const sessions: Array<{ tenantKey: string | null | undefined; scanned: string[] }> = [];
  const current = new AsyncLocalStorage<{ tenantKey: string | null | undefined; scanned: string[] }>();
  const runner = {
    scanForMalware: vi.fn(async (p: string) => {
      current.getStore()?.scanned.push(p);
      return { status: (await readFile(p, "utf8")) === EICAR ? "infected" : "clean", engine: "clamdscan", signature: "Eicar-Test-Signature", databaseStatus: "fresh", healthWarnings: [] };
    }),
    withMalwareScanner: vi.fn(async (tenantKey: string | null | undefined, fn: () => Promise<unknown>) => {
      const session = { tenantKey, scanned: [] as string[] };
      sessions.push(session);
      return await current.run(session, fn);
    }),
  } as unknown as CommandRunner;
  const config = { quarantineEnabled: true, quarantineFailOpenOnToolMissing: false, quarantineMaxArchiveEntries: 10, quarantineMaxArchiveDepth: 3,
    quarantineMaxTotalUncompressedBytes: 1 << 20, quarantineMaxSingleEntryBytes: 1 << 20, quarantineMaxExpansionRatio: 10 } as Config;
  return { state, stage: new QuarantineStage(runner, storage, config), runner, sessions };
}

describe("quarantine scanner flags", () => {
  it.each([
    ["both off", "off", "off", 0],
    ["snapshot (Q1: one scanner session per document)", "on", "off", 2],
    // The batch flag was removed (council M1): a stale setting changes nothing, each document still gets its own session.
    ["snapshot with the removed batch flag still set", "on", "on", 2],
    ["batch without snapshot (ignored)", "off", "on", 0],
  ])("EICAR is refused and never reaches extraction or indexing: %s", async (_label, snapshot, batch, scannerSessions) => {
    vi.stubEnv("DOCSLURP_QUARANTINE_SCAN_SNAPSHOT", snapshot);
    vi.stubEnv("DOCSLURP_QUARANTINE_SCAN_BATCH", batch);
    const f = await fixture();
    await f.stage.run(f.state);
    expect(f.state.documentStage("eicar.txt", "quarantine")?.status).toBe("failed");
    expect(f.state.documentStage("report.txt", "quarantine")?.status).toBe("completed");
    // Later stages (extract, embed, index) work only on healthy documents: the infected one is never searchable.
    expect(healthyDocuments(f.state).map((document) => document.id)).toEqual(["report.txt"]);
    // Snapshot off: the stage never opens a scanner session (exactly today's path).
    expect(f.runner.withMalwareScanner).toHaveBeenCalledTimes(scannerSessions);
    expect(f.sessions.every((session) => session.tenantKey === "org-a")).toBe(true);
    // M1: no scanner session ever scans a second document.
    expect(f.sessions.every((session) => session.scanned.length === 1)).toBe(true);
  });
});

import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkflowState } from "../pipeline/pipeline.js";
import { storeFirstPassFigures } from "../pipeline/first-pass.js";

// The first pass's figure step (stage first-pass:figures) queues the asset ledger write for its checkpoint in every case:
// a stored folder (its rows spilled), a provider failure, and a refused folder.
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "doppler-golden", "v3-repeats");
const DOC_ID = "0b6f7e8c-3c1a-4f7e-9a51-2a1d3e4f5a6b";

let work: string;
beforeEach(async () => { work = await mkdtemp(path.join(tmpdir(), "first-pass-figures-")); });
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

function setup() {
  const document = { id: DOC_ID, userId: "u", runId: "r", filename: "a.pdf", mimeType: "application/pdf", sourceKey: "u/a.pdf", status: "processing", pageCount: 4, createdAt: new Date(), updatedAt: new Date() };
  const state = WorkflowState.create({ id: "r", orgId: "o", projectId: "p", userId: "u", kind: "bulk-upload", status: "processing", stage: "first-pass", totalDocuments: 1,
    processedDocuments: 0, pagesTotal: 4, pagesProcessed: 0, spentCents: 0, pipeline: {}, error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date() } as any, [document as any]);
  const objects = new Map<string, Buffer>();
  const storage = {
    putBytes: async (key: string, data: Uint8Array) => { objects.set(key, Buffer.from(data)); },
    putJson: async (key: string, value: unknown) => { objects.set(key, Buffer.from(JSON.stringify(value))); },
    deleteKeys: async (keys: string[]) => { for (const key of keys) objects.delete(key); },
    uri: (key: string) => `s3://b/${key}`,
  };
  return { document: document as any, state, objects, storage };
}

describe("first pass: the figure step queues the ledger", () => {
  it("a stored folder: slots recorded, the write queued with the spilled rows and the stored manifest", async () => {
    const { document, state, objects, storage } = setup();
    const dir = path.join(work, "images");
    await cp(path.join(FIXTURE, "images"), dir, { recursive: true });
    const markdownPath = path.join(FIXTURE, "document.md");
    const result = await storeFirstPassFigures({ state, document, dir, outcome: { status: "extracted", exitCode: 0 }, markdownPath, markdown: "", storage, runId: "r", signal: new AbortController().signal });
    expect(result.stats.dopplerFigures).toMatchObject({ status: "stored", ledger: "queued", manifestVersion: 3 });
    // The canonical manifest is stored but never served: no slot.
    expect(state.artifactLedger.readDocument(DOC_ID, "doppler-manifest")).toBeUndefined();
    expect(objects.has(`u/r/doppler/${DOC_ID}/images/manifest.jsonl`)).toBe(true);
    expect(objects.has(`u/r/doppler/${DOC_ID}/document.md`)).toBe(true);
    expect(state.pendingAssetLedger.get(DOC_ID)).toMatchObject({
      level: { imagesStatus: "complete", imagesExitCode: 0, manifestVersion: 3, manifest: { key: `u/r/doppler/${DOC_ID}/images/manifest.jsonl` } },
      assets: { rows: 5 },
    });
  });

  it("a provider failure queues the failed level, with no assets", async () => {
    const { document, state, storage } = setup();
    const result = await storeFirstPassFigures({ state, document, dir: work, outcome: { status: "failed", reason: "x", exitCode: 6 }, markdownPath: "", markdown: "", storage, runId: "r", signal: new AbortController().signal });
    expect(result.stats.dopplerFigures).toEqual({ status: "extraction-failed", ledger: "queued" });
    expect(state.pendingAssetLedger.get(DOC_ID)).toMatchObject({ level: { imagesStatus: "failed", imagesExitCode: 6 }, assets: [] });
  });

  it("a refused folder queues the failed level and stores nothing", async () => {
    const { document, state, objects, storage } = setup();
    const dir = path.join(work, "images");
    await cp(path.join(FIXTURE, "images"), dir, { recursive: true });
    await writeFile(path.join(dir, "notes.txt"), "x");
    const result = await storeFirstPassFigures({ state, document, dir, outcome: { status: "extracted" }, markdownPath: path.join(FIXTURE, "document.md"), markdown: "", storage, runId: "r", signal: new AbortController().signal });
    expect(result.stats.dopplerFigures).toEqual({ status: "failed", rule: "unexpected-file", ledger: "queued" });
    expect(objects.size).toBe(0);
    expect(state.pendingAssetLedger.get(DOC_ID)).toMatchObject({ level: { imagesStatus: "failed" }, assets: [] });
  });
});

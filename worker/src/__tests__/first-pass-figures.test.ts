import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkflowState } from "../pipeline/pipeline.js";
import { readMarkdownSlotBytes, storeFirstPassFigures } from "../pipeline/first-pass.js";

// The first pass's figure step (stage first-pass:figures) queues the asset ledger write for its checkpoint in every case:
// a stored folder (its rows spilled), a provider failure, and a refused folder.
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "doppler-golden", "v3-repeats");
const DOC_ID = "0b6f7e8c-3c1a-4f7e-9a51-2a1d3e4f5a6b";

let work: string;
beforeEach(async () => { work = await mkdtemp(path.join(tmpdir(), "first-pass-figures-")); });
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

function setup(pipeline: Record<string, unknown> = {}) {
  const document = { id: DOC_ID, userId: "u", runId: "r", filename: "a.pdf", mimeType: "application/pdf", sourceKey: "u/a.pdf", status: "processing", pageCount: 4, createdAt: new Date(), updatedAt: new Date() };
  const state = WorkflowState.create({ id: "r", orgId: "o", projectId: "p", userId: "u", kind: "bulk-upload", status: "processing", stage: "first-pass", totalDocuments: 1,
    processedDocuments: 0, pagesTotal: 4, pagesProcessed: 0, spentCents: 0, pipeline, error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date() } as any, [document as any]);
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
    const markdownSlot = await readFile(path.join(FIXTURE, "document.md"));
    const result = await storeFirstPassFigures({ state, document, dir, outcome: { status: "extracted", exitCode: 0 }, markdownSlot, storage, runId: "r", signal: new AbortController().signal });
    expect(result.stats.dopplerFigures).toMatchObject({ status: "stored", ledger: "queued", manifestVersion: 3 });
    expect(state.artifactLedger.readDocument(DOC_ID, "doppler-manifest")).toBe(`s3://b/u/r/doppler/${DOC_ID}/images/manifest.jsonl`);
    expect(objects.has(`u/r/doppler/${DOC_ID}/document.md`)).toBe(true);
    expect(state.pendingAssetLedger.get(DOC_ID)).toMatchObject({
      level: { imagesStatus: "complete", imagesExitCode: 0, manifestVersion: 3, manifest: { key: `u/r/doppler/${DOC_ID}/images/manifest.jsonl` } },
      assets: { rows: 5 },
    });
  });

  it("a provider failure queues the failed level, with no assets", async () => {
    const { document, state, storage } = setup();
    const result = await storeFirstPassFigures({ state, document, dir: work, outcome: { status: "failed", reason: "x", exitCode: 6 }, markdownSlot: null, storage, runId: "r", signal: new AbortController().signal });
    expect(result.stats.dopplerFigures).toEqual({ status: "extraction-failed", ledger: "queued" });
    expect(state.pendingAssetLedger.get(DOC_ID)).toMatchObject({ level: { imagesStatus: "failed", imagesExitCode: 6 }, assets: [] });
  });

  it("a refused folder queues the failed level and stores nothing", async () => {
    const { document, state, objects, storage } = setup();
    const dir = path.join(work, "images");
    await cp(path.join(FIXTURE, "images"), dir, { recursive: true });
    await writeFile(path.join(dir, "notes.txt"), "x");
    const result = await storeFirstPassFigures({ state, document, dir, outcome: { status: "extracted" }, markdownSlot: await readFile(path.join(FIXTURE, "document.md")), storage, runId: "r", signal: new AbortController().signal });
    expect(result.stats.dopplerFigures).toEqual({ status: "failed", rule: "unexpected-file", ledger: "queued" });
    expect(objects.size).toBe(0);
    expect(state.pendingAssetLedger.get(DOC_ID)).toMatchObject({ level: { imagesStatus: "failed" }, assets: [] });
  });
});

describe("first pass: figures stored after the PII stage are withheld with it (HIGH-1)", () => {
  async function folder() {
    const dir = path.join(work, "images");
    await cp(path.join(FIXTURE, "images"), dir, { recursive: true });
    // Doppler writes its page facts beside the manifest; they are never stored (owner decision).
    await writeFile(path.join(dir, "page-facts.jsonl"), '{"type":"doc","producer":"Hostile Producer 555-12-3456"}\n');
    return dir;
  }
  const run = async (env: ReturnType<typeof setup>, dir: string, slot: Buffer | null = null) => storeFirstPassFigures({
    state: env.state, document: env.document, dir, outcome: { status: "extracted", exitCode: 0 }, markdownSlot: slot ?? await readFile(path.join(FIXTURE, "document.md")),
    storage: env.storage, runId: "r", signal: new AbortController().signal,
  });

  for (const action of ["redact_artifacts", "block_indexing"] as const) {
    it(`${action} matched: every stored file joins the withheld list before its slot is recorded, and document.md is not stored`, async () => {
      const env = setup({ piiPolicy: { enabled: true, patterns: ["ssn"], action } });
      const appended: string[][] = [];
      const recordedAtAppend: number[] = [];
      (env.state as any).store = {
        documentPiiWithholds: async () => true,
        appendWithheldArtifactUris: async (_id: string, uris: readonly string[]) => {
          recordedAtAppend.push(Object.keys(env.state.artifactLedger.all()).length);
          appended.push([...uris]);
        },
      };
      const result = await run(env, await folder());
      expect(result.stats.dopplerFigures).toMatchObject({ status: "stored", piiWithheld: true });
      const slots = Object.entries(env.state.artifactLedger.all() as Record<string, string>).filter(([slot]) => slot.startsWith(`${DOC_ID}:doppler`));
      expect(slots.length).toBeGreaterThan(3);
      // Every recorded Doppler slot (figures, index, manifest) is withheld, and the stage's artifact (the index) too.
      expect(new Set(appended.flat())).toEqual(new Set(slots.map(([, uri]) => uri)));
      expect(appended.flat()).toContain(result.artifactUri);
      expect(recordedAtAppend).toEqual([0]);
      expect([...env.objects.keys()].some((key) => key.endsWith("/document.md"))).toBe(false);
      expect(slots.some(([slot]) => slot.endsWith(":doppler-markdown"))).toBe(false);
      expect([...env.objects.keys()].some((key) => key.includes("page-facts"))).toBe(false);
    });
  }

  it("a PII scan with nothing withheld stores document.md and withholds nothing; page facts are never stored", async () => {
    const env = setup({ piiPolicy: { enabled: true, patterns: ["ssn"], action: "redact_artifacts" } });
    const appended: string[] = [];
    (env.state as any).store = { documentPiiWithholds: async () => false, appendWithheldArtifactUris: async (_id: string, uris: readonly string[]) => { appended.push(...uris); } };
    await run(env, await folder());
    expect(appended).toEqual([]);
    expect(env.objects.has(`u/r/doppler/${DOC_ID}/document.md`)).toBe(true);
    expect([...env.objects.keys()].some((key) => key.includes("page-facts"))).toBe(false);
    expect(Object.keys(env.state.artifactLedger.all()).some((slot) => slot.includes("page-facts"))).toBe(false);
  });

  it("fails closed: a PII policy and a store that cannot say what it withholds store nothing", async () => {
    const env = setup({ piiPolicy: { enabled: true, patterns: ["ssn"], action: "redact_artifacts" } });
    const result = await run(env, await folder());
    expect(result.stats.dopplerFigures).toEqual({ status: "failed", rule: "pii-unverifiable", ledger: "queued" });
    expect(env.objects.size).toBe(0);
    expect(Object.keys(env.state.artifactLedger.all()).some((slot) => slot.includes("doppler"))).toBe(false);
  });

  it("an append that fails records no slot", async () => {
    const env = setup({ piiPolicy: { enabled: true, patterns: ["ssn"], action: "block_indexing" } });
    (env.state as any).store = { documentPiiWithholds: async () => true, appendWithheldArtifactUris: async () => { throw new Error("db down"); } };
    const result = await run(env, await folder());
    expect(result.stats.dopplerFigures).toMatchObject({ status: "failed" });
    expect(Object.keys(env.state.artifactLedger.all()).some((slot) => slot.includes("doppler"))).toBe(false);
  });
});

describe("first pass: document.md is exactly the scanned Markdown slot (M1, L2)", () => {
  // The batch's raw output: a front-matter-shaped block the host strips before the PII scan ever sees it.
  const RAW = "---\nName: Ada Example\nSSN: 123-45-6789\n---\n# Report\n\n![image](images/page-0001/image-001.webp)\n";
  const SCANNED = "# Report\n\n![image](images/page-0001/image-001.webp)\n";

  it("stores the slot's bytes (what pii-detect scanned), never the batch's raw output with its stripped front matter", async () => {
    const env = setup({ piiPolicy: { enabled: true, patterns: ["ssn"], action: "redact_artifacts" } });
    (env.state as any).store = { documentPiiWithholds: async () => false, appendWithheldArtifactUris: async () => undefined };
    const dir = path.join(work, "images");
    await cp(path.join(FIXTURE, "images"), dir, { recursive: true });
    // The slot as the drains committed it, read the way the batch loop reads it.
    const objects = new Map([["u/r/markdown/doc.md", Buffer.from(SCANNED)]]);
    const slot = await readMarkdownSlotBytes({ bucket: "b", getBytes: async (k: string) => objects.get(k)! } as any, "s3://b/u/r/markdown/doc.md");
    await writeFile(path.join(work, "output.md"), RAW);
    await storeFirstPassFigures({ state: env.state, document: env.document, dir, outcome: { status: "extracted", exitCode: 0 }, markdownSlot: slot,
      storage: env.storage, runId: "r", signal: new AbortController().signal });
    const stored = env.objects.get(`u/r/doppler/${DOC_ID}/document.md`)!;
    expect(stored.equals(Buffer.from(SCANNED))).toBe(true);
    expect(stored.toString()).not.toContain("123-45-6789");
    // A manifest slot (JSON) or none: no document.md rather than another text.
    expect(await readMarkdownSlotBytes({ bucket: "b", getBytes: async () => Buffer.from("{}") } as any, "s3://b/u/r/markdown/doc.json")).toBeNull();
    expect(await readMarkdownSlotBytes({ bucket: "b", getBytes: async () => Buffer.from("x") } as any, undefined)).toBeNull();
  });

  it("L2: an append that fails after the store removes every object it wrote, except committed ones", async () => {
    const env = setup({ piiPolicy: { enabled: true, patterns: ["ssn"], action: "block_indexing" } });
    (env.state as any).store = { documentPiiWithholds: async () => true, appendWithheldArtifactUris: async () => { throw new Error("db down"); } };
    // An earlier committed object at one of the keys this store writes again.
    const committedKey = `u/r/doppler/${DOC_ID}/images/manifest.jsonl`;
    const deleted: string[][] = [];
    const remove = env.storage.deleteKeys;
    env.storage.deleteKeys = async (keys: string[]) => { deleted.push(keys); await remove(keys); };
    env.state.artifactLedger.recordDocument(DOC_ID, "doppler-manifest", `s3://b/${committedKey}`);
    const dir = path.join(work, "images");
    await cp(path.join(FIXTURE, "images"), dir, { recursive: true });
    const result = await storeFirstPassFigures({ state: env.state, document: env.document, dir, outcome: { status: "extracted", exitCode: 0 },
      markdownSlot: null, storage: env.storage, runId: "r", signal: new AbortController().signal });
    expect(result.stats.dopplerFigures).toMatchObject({ status: "failed" });
    // The fake store had nothing at the committed key; what matters is that every other object is gone and that one was
    // never deleted (so a committed object there would survive).
    expect([...env.objects.keys()].filter((k) => k !== committedKey)).toEqual([]);
    expect(deleted.flat()).not.toContain(committedKey);
    expect(deleted.flat().length).toBeGreaterThan(0);
  });
});

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryCheckpointStore, type MemoryDocumentRecords } from "../pipeline/checkpoint-store-memory.js";

import { WorkflowState } from "../pipeline/pipeline.js";
import { readMarkdownSlotBytes, storeFirstPassFigures } from "../pipeline/first-pass.js";

/** An in-memory store whose document records are replaced by the given ones (PII withholding). */
const withRecords = (records: Partial<MemoryDocumentRecords>) => {
  const store = memoryCheckpointStore();
  Object.assign(store.records, records);
  return store;
};

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
      (env.state as any).store = withRecords({
        documentPiiWithholds: async () => true,
        appendWithheldArtifactUris: async (_scope: unknown, uris: readonly string[]) => {
          recordedAtAppend.push(Object.keys(env.state.artifactLedger.all()).length);
          uploadedAtAppend.push([...env.objects.keys()].filter((key) => key.includes("/doppler/")).length);
          appended.push([...uris]);
        },
      });
      const uploadedAtAppend: number[] = [];
      const result = await run(env, await folder());
      expect(result.stats.dopplerFigures).toMatchObject({ status: "stored", piiWithheld: true });
      const slots = Object.entries(env.state.artifactLedger.all() as Record<string, string>).filter(([slot]) => slot.startsWith(`${DOC_ID}:doppler`));
      expect(slots.length).toBeGreaterThan(3);
      // Every recorded Doppler slot (figures, index, manifest) is withheld, and the stage's artifact (the index) too.
      // Withheld first, from the layout, before any object is uploaded or any row is marked stored (the ledger serves
      // stored rows); then the recorded slots again (a union).
      expect(uploadedAtAppend[0]).toBe(0);
      for (const [, uri] of slots) expect(appended[0]).toContain(uri);
      expect(new Set(appended.flat())).toEqual(new Set([...slots.map(([, uri]) => uri), `s3://b/u/r/doppler/${DOC_ID}/document.md`]));
      expect(appended.flat()).toContain(result.artifactUri);
      expect(recordedAtAppend.every((n) => n === 0)).toBe(true);
      expect([...env.objects.keys()].some((key) => key.endsWith("/document.md"))).toBe(false);
      expect(slots.some(([slot]) => slot.endsWith(":doppler-markdown"))).toBe(false);
      expect([...env.objects.keys()].some((key) => key.includes("page-facts"))).toBe(false);
    });
  }

  it("page-scoped block_indexing: figures of clean pages stay servable; withheld pages' figures and every other file join the list", async () => {
    const env = setup({ piiPolicy: { enabled: true, patterns: ["ssn"], action: "block_indexing" } });
    const appended: string[] = [];
    (env.state as any).store = withRecords({
      documentPiiWithholds: async () => true,
      documentPiiWithholding: async () => ({ scope: "pages", pages: new Set([3]) }),
      appendWithheldArtifactUris: async (_scope: unknown, uris: readonly string[]) => { appended.push(...uris); },
    });
    await run(env, await folder());
    const slots = Object.entries(env.state.artifactLedger.all() as Record<string, string>).filter(([slot]) => slot.startsWith(`${DOC_ID}:doppler`));
    const figurePage = (slot: string) => /:doppler-figure:p(\d+)\./.exec(slot)?.[1];
    expect(slots.some(([slot]) => figurePage(slot) === "3")).toBe(true);
    expect(slots.some(([slot]) => figurePage(slot) === "1")).toBe(true);
    for (const [slot, uri] of slots) {
      const page = figurePage(slot);
      expect(appended.includes(uri), slot).toBe(page === undefined || page === "3");
    }
    expect([...env.objects.keys()].some((key) => key.endsWith("/document.md"))).toBe(false);
  });

  it("page-scoped block_indexing: the withheld page's figure and the index are on the list before any object is uploaded", async () => {
    const env = setup({ piiPolicy: { enabled: true, patterns: ["ssn"], action: "block_indexing" } });
    const firstAppend: { uris: string[]; objectsBefore: number } = { uris: [], objectsBefore: -1 };
    (env.state as any).store = withRecords({
      documentPiiWithholds: async () => true,
      documentPiiWithholding: async () => ({ scope: "pages", pages: new Set([3]) }),
      appendWithheldArtifactUris: async (_scope: unknown, uris: readonly string[]) => {
        if (firstAppend.objectsBefore === -1) { firstAppend.objectsBefore = env.objects.size; firstAppend.uris = [...uris]; }
      },
    });
    const before = env.objects.size;
    await run(env, await folder());
    expect(firstAppend.objectsBefore).toBe(before);
    expect(firstAppend.uris.some((uri) => uri.includes("/images/page-0003/"))).toBe(true);
    expect(firstAppend.uris.some((uri) => uri.includes("/images/page-0001/"))).toBe(false);
    expect(firstAppend.uris.some((uri) => uri.endsWith("/index.json"))).toBe(true);
  });

  describe("one PII page (page 3 of 4) under page-scoped block_indexing", () => {
    const placeholder = "[Page 3 withheld by the project's privacy policy]";
    async function scopedSlot() {
      // What pii-detect leaves in the Markdown slot: page 3 replaced by its placeholder, the other pages intact.
      const pages = (await readFile(path.join(FIXTURE, "document.md"), "utf8")).split("\f");
      pages[2] = placeholder;
      return Buffer.from(pages.join("\f"), "utf8");
    }
    function scopedEnv() {
      const env = setup({ piiPolicy: { enabled: true, patterns: ["ssn"], action: "block_indexing" } });
      const appended: string[] = [];
      (env.state as any).store = withRecords({
        documentPiiWithholds: async () => true,
        documentPiiWithholding: async () => ({ scope: "pages", pages: new Set([3]) }),
        appendWithheldArtifactUris: async (_scope: unknown, uris: readonly string[]) => { appended.push(...uris); },
      });
      return { env, appended };
    }

    it("keeps document.md with the placeholder and page 1's figure; withholds page 3's figure, the index and manifests", async () => {
      const { env, appended } = scopedEnv();
      await run(env, await folder(), await scopedSlot());
      const slots = Object.fromEntries(Object.entries(env.state.artifactLedger.all() as Record<string, string>)
        .filter(([slot]) => slot.startsWith(`${DOC_ID}:doppler`)).map(([slot, uri]) => [slot.slice(DOC_ID.length + 1), uri]));
      const markdownKey = [...env.objects.keys()].find((key) => key.endsWith("/document.md"));
      expect(markdownKey).toBeDefined();
      const stored = env.objects.get(markdownKey!)!.toString("utf8");
      expect(stored.split("\f")[2]).toBe(placeholder);
      expect(stored.split("\f")[0]).toContain("benign paragraph");
      expect(slots["doppler-markdown"]).toBeDefined();
      expect(appended).not.toContain(slots["doppler-markdown"]);
      const figure = (page: number) => Object.entries(slots).filter(([slot]) => slot.startsWith(`doppler-figure:p${page}.`)).map(([, uri]) => uri);
      expect(figure(1).length).toBeGreaterThan(0);
      expect(figure(3).length).toBeGreaterThan(0);
      for (const uri of figure(1)) expect(appended).not.toContain(uri);
      for (const uri of figure(3)) expect(appended).toContain(uri);
      expect(appended).toContain(slots["doppler-figures"]);
      expect(appended).toContain(slots["doppler-manifest"]);
    });

    it("fails closed: a slot whose withheld page still holds text, or whose page breaks are unknown, is not stored", async () => {
      for (const slot of [
        await readFile(path.join(FIXTURE, "document.md")),
        Buffer.from((await scopedSlot()).toString("utf8").replaceAll("\f", "\n"), "utf8"),
      ]) {
        const { env, appended } = scopedEnv();
        await run(env, await folder(), slot);
        expect([...env.objects.keys()].some((key) => key.endsWith("/document.md"))).toBe(false);
        // Figures still follow their pages.
        const recorded = Object.entries(env.state.artifactLedger.all() as Record<string, string>);
        const page1 = recorded.filter(([key]) => key.includes(":doppler-figure:p1.")).map(([, uri]) => uri);
        for (const uri of page1) expect(appended).not.toContain(uri);
      }
    });
  });

  it("page-scoped outcome unreadable: every file joins the list (fail closed)", async () => {
    const env = setup({ piiPolicy: { enabled: true, patterns: ["ssn"], action: "block_indexing" } });
    const appended: string[] = [];
    (env.state as any).store = withRecords({
      documentPiiWithholds: async () => true,
      documentPiiWithholding: async () => ({ scope: "document", reason: "malformed-metadata" }),
      appendWithheldArtifactUris: async (_scope: unknown, uris: readonly string[]) => { appended.push(...uris); },
    });
    await run(env, await folder());
    const slots = Object.entries(env.state.artifactLedger.all() as Record<string, string>).filter(([slot]) => slot.startsWith(`${DOC_ID}:doppler`));
    // Every stored slot, plus `document.md` (withheld before upload, then never stored).
    expect(new Set(appended)).toEqual(new Set([...slots.map(([, uri]) => uri), `s3://b/u/r/doppler/${DOC_ID}/document.md`]));
    expect(env.objects.has(`u/r/doppler/${DOC_ID}/document.md`)).toBe(false);
  });

  it("a PII scan with nothing withheld stores document.md and withholds nothing; page facts are never stored", async () => {
    const env = setup({ piiPolicy: { enabled: true, patterns: ["ssn"], action: "redact_artifacts" } });
    const appended: string[] = [];
    (env.state as any).store = withRecords({ documentPiiWithholds: async () => false, appendWithheldArtifactUris: async (_scope: unknown, uris: readonly string[]) => { appended.push(...uris); } });
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
    (env.state as any).store = withRecords({ documentPiiWithholds: async () => true, appendWithheldArtifactUris: async () => { throw new Error("db down"); } });
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
    (env.state as any).store = withRecords({ documentPiiWithholds: async () => false, appendWithheldArtifactUris: async () => undefined });
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

  it("L2: an append that fails stores nothing and deletes nothing (withheld before upload; orphan GC is the only deleter)", async () => {
    const env = setup({ piiPolicy: { enabled: true, patterns: ["ssn"], action: "block_indexing" } });
    (env.state as any).store = withRecords({ documentPiiWithholds: async () => true, appendWithheldArtifactUris: async () => { throw new Error("db down"); } });
    const deleted: string[][] = [];
    const remove = env.storage.deleteKeys;
    env.storage.deleteKeys = async (keys: string[]) => { deleted.push(keys); await remove(keys); };
    const dir = path.join(work, "images");
    await cp(path.join(FIXTURE, "images"), dir, { recursive: true });
    const result = await storeFirstPassFigures({ state: env.state, document: env.document, dir, outcome: { status: "extracted", exitCode: 0 },
      markdownSlot: null, storage: env.storage, runId: "r", signal: new AbortController().signal });
    expect(result.stats.dopplerFigures).toMatchObject({ status: "failed" });
    expect([...env.objects.keys()].filter((key) => key.includes("/doppler/"))).toEqual([]);
    expect(deleted.flat()).toEqual([]);
    expect(Object.keys(env.state.artifactLedger.all()).some((slot) => slot.includes("doppler"))).toBe(false);
  });
});

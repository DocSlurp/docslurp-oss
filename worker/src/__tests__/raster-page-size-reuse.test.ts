import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseDopplerPageFacts } from "../lib/doppler-page-facts.js";
import type { Document } from "../models.js";
import { configurePageAreaSink } from "../pipeline/page-area-sink.js";
import type { PageEquivalentRow } from "../db/page-equivalents.js";
import { PdfRasterCache, PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import {
  PdfPageSizeMemo,
  pageSizeBinding,
  pageSizesArtifactKey,
  serializePageSizes,
  storePageFactsRasterSizes,
  type PdfPageSize,
} from "../pipeline/pdf-page-sizes.js";
import { docLine } from "../test/doppler-page-facts-fixture.js";

const SOURCE_BYTES = "pdf bytes for page size reuse";
const SOURCE_SHA = createHash("sha256").update(SOURCE_BYTES).digest("hex");
/** pdfinfo's A4 (two standard pages of area, so the rendered area is recorded for billing). */
const A4 = { widthPt: 595.276, heightPt: 841.89 };

const roots: string[] = [];
afterEach(async () => {
  configurePageAreaSink(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function makeDocument(overrides: Partial<Document> = {}): Document {
  return {
    parseSourceDecision: "unscanned-allowed",
    id: "doc-1",
    userId: "user-1",
    runId: "run-1",
    filename: "sample.pdf",
    mimeType: "application/pdf",
    sourceKey: "sources/sample.pdf",
    status: "processing",
    extractionMode: "auto",
    pageCount: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Object storage shared by "workers": a missing object throws as S3 does. */
function sharedStorage() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async objectSize(key: string) { return objects.get(key)?.byteLength ?? null; },
    async putBytes(key: string, bytes: Uint8Array) { objects.set(key, Buffer.from(bytes)); },
    async getBytes(key: string, options?: { maxBytes?: number }) {
      const value = objects.get(key);
      if (!value) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      if (options?.maxBytes !== undefined && value.byteLength > options.maxBytes) throw new Error("too large");
      return value;
    },
    uri(key: string) { return `s3://test/${key}`; },
  };
}

/** One worker process: its own source cache and memo, a fake sandbox runner counting pdfinfo calls. */
function worker(storage: ReturnType<typeof sharedStorage>, options: { reuse?: boolean; facts?: boolean; memo?: PdfPageSizeMemo; size?: PdfPageSize; bytes?: string } = {}) {
  const pdfinfo: Array<[number, number]> = [];
  const runner = {
    async pdfPageSizes(_source: string, first: number, last: number) { return { binary: "pdfinfo", args: [String(first), String(last)], available: true }; },
    async renderPdfPageRange(_source: string, prefix: string, first: number) { return { binary: "pdftoppm", args: [prefix, String(first)], available: true }; },
    async run(plan: { binary?: string; args: string[] }) {
      if (plan.binary === "pdfinfo") {
        const [first, last] = plan.args.map(Number) as [number, number];
        pdfinfo.push([first, last]);
        const size = options.size ?? A4;
        const lines = Array.from({ length: last - first + 1 }, (_, i) => `Page ${String(first + i).padStart(4)} size: ${size.widthPt} x ${size.heightPt} pts`);
        return { stdout: [`Pages:           ${last}`, ...lines].join("\n"), stderr: "" };
      }
      await writeFile(`${plan.args[0]}-${plan.args[1]}.png`, "png");
      return { stdout: "", stderr: "" };
    },
  };
  const sources = new PdfSourceCache({
    async downloadToTempFile(_key: string, pattern: string) {
      const root = await mkdtemp(path.join(tmpdir(), "page-size-reuse-"));
      roots.push(root);
      const file = path.join(root, pattern.replace("*", "source"));
      await writeFile(file, options.bytes ?? SOURCE_BYTES);
      return file;
    },
  } as never);
  const cache = new PdfRasterCache(runner as never, storage as never, sources, {
    pageSizeMemo: options.memo ?? new PdfPageSizeMemo(),
    pageSizeReuse: options.reuse ?? true,
    pageFactsSizes: options.facts ?? false,
  });
  return { cache, sources, pdfinfo };
}

/** render-images (two shards of the classified pages), then vision-extract (single pages at a vision long edge, at once). */
async function renderImagesThenVision(cache: PdfRasterCache, document: Document): Promise<void> {
  await cache.renderSelectedPages({ document, runId: "run-1", pageNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  await cache.renderSelectedPages({ document, runId: "run-1", pageNumbers: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20] });
  await Promise.all([3, 7, 15, 22, 29].map((pageNumber) => cache.renderSelectedPages({ document, runId: "run-1", pageNumbers: [pageNumber], maxLongEdgePx: 1_600 })));
}

function captureBilledAreas(): PageEquivalentRow[] {
  const rows: PageEquivalentRow[] = [];
  configurePageAreaSink({ async record(args) { rows.push(...args.rows); return null; }, async authorize() {} });
  return rows;
}

describe("raster page size reuse (render-images then vision-extract)", () => {
  it("runs one pdfinfo where it ran one per render call, and bills the same areas", async () => {
    const beforeRows = captureBilledAreas();
    const before = worker(sharedStorage(), { reuse: false });
    await renderImagesThenVision(before.cache, makeDocument());
    const afterRows = captureBilledAreas();
    const after = worker(sharedStorage());
    await renderImagesThenVision(after.cache, makeDocument());

    // Before: one pdfinfo per contiguous range of each call (2 render-images shards + 5 vision pages). After: one block.
    expect(before.pdfinfo).toHaveLength(7);
    expect(after.pdfinfo).toEqual([[1, 30]]);
    const byPage = (rows: PageEquivalentRow[]) => [...rows].sort((a, b) => a.pageNumber - b.pageNumber);
    expect(byPage(afterRows)).toEqual(byPage(beforeRows));
    expect(afterRows.every((row) => row.area === 2)).toBe(true);
    await before.sources.clear();
    await after.sources.clear();
  });

  it("lets another worker reuse the run's stored sizes without a pdfinfo", async () => {
    const storage = sharedStorage();
    const first = worker(storage);
    await first.cache.renderSelectedPages({ document: makeDocument(), runId: "run-1", pageNumbers: [1, 2] });
    const second = worker(storage);
    const rows = captureBilledAreas();
    await second.cache.renderSelectedPages({ document: makeDocument(), runId: "run-1", pageNumbers: [17, 29], maxLongEdgePx: 1_288 });
    expect(first.pdfinfo).toEqual([[1, 30]]);
    expect(second.pdfinfo).toEqual([]);
    expect(rows.map((row) => row.area)).toEqual([2, 2]);
    await first.sources.clear();
    await second.sources.clear();
  });

  it("does not reuse sizes for another run, another document or other source bytes", async () => {
    const storage = sharedStorage();
    const memo = new PdfPageSizeMemo();
    const first = worker(storage, { memo });
    await first.cache.renderSelectedPages({ document: makeDocument(), runId: "run-1", pageNumbers: [1] });
    const otherRun = worker(storage, { memo });
    await otherRun.cache.renderSelectedPages({ document: makeDocument({ runId: "run-2" }), runId: "run-2", pageNumbers: [1] });
    const otherDocument = worker(storage, { memo });
    await otherDocument.cache.renderSelectedPages({ document: makeDocument({ id: "doc-2" }), runId: "run-1", pageNumbers: [1] });
    const otherOrg = worker(storage, { memo });
    await otherOrg.cache.renderSelectedPages({ document: makeDocument({ userId: "user-9" }), runId: "run-1", pageNumbers: [1] });
    const otherBytes = worker(storage, { memo, bytes: "a different upload under the same key" });
    await otherBytes.cache.renderSelectedPages({ document: makeDocument({ id: "doc-3" }), runId: "run-1", pageNumbers: [1] });
    for (const measured of [first, otherRun, otherDocument, otherOrg, otherBytes]) {
      expect(measured.pdfinfo).toEqual([[1, 30]]);
      await measured.sources.clear();
    }
  });

  it("keeps per-range pdfinfo calls and stores nothing with reuse off", async () => {
    const storage = sharedStorage();
    const off = worker(storage, { reuse: false });
    await off.cache.renderSelectedPages({ document: makeDocument(), runId: "run-1", pageNumbers: [2, 3, 9] });
    expect(off.pdfinfo.sort((a, b) => a[0] - b[0])).toEqual([[2, 3], [9, 9]]);
    expect([...storage.objects.keys()].some((key) => key.includes("/page-sizes/"))).toBe(false);
    await off.sources.clear();
  });
});

describe("raster page size reuse: stored sizes that fail closed to pdfinfo", () => {
  const document = makeDocument();
  const binding = pageSizeBinding(document, "run-1", SOURCE_SHA)!;
  const key = pageSizesArtifactKey(document, binding, "pdfinfo");
  /** A forged size that would under-bill (a quarter of the real page) if it were trusted. */
  const small = new Map(Array.from({ length: 30 }, (_, i) => [i + 1, { widthPt: 300, heightPt: 400 }] as const));

  it.each([
    ["another document's sizes copied over", () => serializePageSizes({ ...binding, documentId: "doc-2" }, "pdfinfo", small)],
    ["another organization's sizes for the same bytes", () => serializePageSizes({ ...binding, userId: "user-9" }, "pdfinfo", small)],
    ["another run's sizes", () => serializePageSizes({ ...binding, runId: "run-2" }, "pdfinfo", small)],
    ["sizes of other source bytes", () => serializePageSizes({ ...binding, sourceSha256: "c".repeat(64) }, "pdfinfo", small)],
    ["an oversized artifact", () => Buffer.alloc(64 * 1024, 32)],
    ["a malformed artifact", () => Buffer.from("{")],
    ["a page outside the document", () => Buffer.from(serializePageSizes(binding, "pdfinfo", new Map([[1, A4]])).toString("utf8").replace("[[1,", "[[31,"))],
    ["a page facts artifact under the pdfinfo key", () => serializePageSizes(binding, "page-facts", new Map([[1, { widthPt: 300, heightPt: 400 }]]))],
  ])("ignores %s and measures with pdfinfo", async (_label, body) => {
    const storage = sharedStorage();
    storage.objects.set(key, body());
    const rows = captureBilledAreas();
    const w = worker(storage);
    await w.cache.renderSelectedPages({ document, runId: "run-1", pageNumbers: [1, 2] });
    expect(w.pdfinfo).toEqual([[1, 30]]);
    expect(rows.map((row) => row.area)).toEqual([2, 2]);
    // The refused artifact is replaced by this run's own measurement.
    const stored = JSON.parse(storage.objects.get(key)!.toString("utf8")) as { pages: number[][] };
    expect(stored.pages[0]).toEqual([1, A4.widthPt, A4.heightPt]);
    await w.sources.clear();
  });

  it("measures only the pages a partial artifact does not list", async () => {
    const storage = sharedStorage();
    storage.objects.set(key, serializePageSizes(binding, "pdfinfo", new Map([[1, A4], [2, A4]])));
    const w = worker(storage);
    await w.cache.renderSelectedPages({ document, runId: "run-1", pageNumbers: [1, 2] });
    expect(w.pdfinfo).toEqual([]);
    await w.cache.renderSelectedPages({ document, runId: "run-1", pageNumbers: [3] });
    expect(w.pdfinfo).toEqual([[1, 30]]);
    await w.sources.clear();
  });
});

describe("raster page size reuse: Doppler page facts (DOCSLURP_PAGE_FACTS_RASTER_SIZES)", () => {
  /** Facts for 30 pages: A4 everywhere except page 4 (no line), page 5 (out of range) and page 6 (US Letter, ambiguous). */
  function documentFacts() {
    const pages = Array.from({ length: 30 }, (_, i) => i + 1).filter((page) => page !== 4).map((page) => ({
      schema: "doppler-page-facts/1", type: "page", page, parseWarnings: [], unusualFeatures: [],
      geometry: page === 5 ? { widthPt: 20_000, heightPt: 841.89, rotation: 0, userUnit: 1 }
        : page === 6 ? { widthPt: 612, heightPt: 792, rotation: 0, userUnit: 1 }
        : { widthPt: 841.89, heightPt: 595.28, rotation: 90, userUnit: 1 },
    }));
    const lines = [docLine({ pageCount: 30, level: "basic" }), ...pages, { schema: "doppler-page-facts/1", type: "run", pagesTotal: 30, pagesFailed: 0, ms: 1 }];
    const parsed = parseDopplerPageFacts(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", { pageCount: 30 });
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.facts;
  }

  it("renders and bills settled pages from the facts with no pdfinfo; other pages fall back", async () => {
    const storage = sharedStorage();
    const document = makeDocument();
    const stored = await storePageFactsRasterSizes({ storage, document, runId: "run-1", sourceSha256: SOURCE_SHA, facts: documentFacts(), memo: new PdfPageSizeMemo() });
    expect(stored).toEqual({ stored: 27, skipped: { "out-of-range": 1, ambiguous: 1 } });

    const factsRows = captureBilledAreas();
    const onWorker = worker(storage, { facts: true });
    await onWorker.cache.renderSelectedPages({ document, runId: "run-1", pageNumbers: [1, 2, 3, 7, 30] });
    expect(onWorker.pdfinfo).toEqual([]);
    // The facts' A4 (595.28 x 841.89) bills what pdfinfo's (595.276 x 841.89) does.
    expect(factsRows.map((row) => row.area)).toEqual([2, 2, 2, 2, 2]);

    // A page the facts do not settle (missing, out of range, ambiguous) is measured by pdfinfo (each in a fresh run store,
    // since the first pdfinfo measurement would otherwise serve the others).
    for (const pageNumber of [4, 5, 6]) {
      const own = sharedStorage();
      await storePageFactsRasterSizes({ storage: own, document, runId: "run-1", sourceSha256: SOURCE_SHA, facts: documentFacts(), memo: new PdfPageSizeMemo() });
      const fallback = worker(own, { facts: true });
      await fallback.cache.renderSelectedPages({ document, runId: "run-1", pageNumbers: [pageNumber] });
      expect(fallback.pdfinfo).toEqual([[1, 30]]);
      await fallback.sources.clear();
    }
    await onWorker.sources.clear();
  });

  it("ignores stored facts sizes with the flag off", async () => {
    const storage = sharedStorage();
    const document = makeDocument();
    await storePageFactsRasterSizes({ storage, document, runId: "run-1", sourceSha256: SOURCE_SHA, facts: documentFacts(), memo: new PdfPageSizeMemo() });
    const off = worker(storage, { facts: false });
    await off.cache.renderSelectedPages({ document, runId: "run-1", pageNumbers: [1] });
    expect(off.pdfinfo).toEqual([[1, 30]]);
    await off.sources.clear();
  });

  it("never serves facts measured on other bytes", async () => {
    const storage = sharedStorage();
    const document = makeDocument();
    await storePageFactsRasterSizes({ storage, document, runId: "run-1", sourceSha256: "d".repeat(64), facts: documentFacts(), memo: new PdfPageSizeMemo() });
    const w = worker(storage, { facts: true });
    await w.cache.renderSelectedPages({ document, runId: "run-1", pageNumbers: [1] });
    expect(w.pdfinfo).toEqual([[1, 30]]);
    await w.sources.clear();
  });

  it("stores nothing without a complete binding", async () => {
    const storage = sharedStorage();
    expect(await storePageFactsRasterSizes({ storage, document: makeDocument({ userId: "" }), runId: "run-1", sourceSha256: SOURCE_SHA, facts: documentFacts(), memo: new PdfPageSizeMemo() })).toBeNull();
    expect(storage.objects.size).toBe(0);
  });
});

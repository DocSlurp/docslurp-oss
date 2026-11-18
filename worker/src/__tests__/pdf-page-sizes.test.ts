import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { pageAreaEquivalentsPt } from "@docslurp/shared";

import { parseDopplerPageFacts, type DopplerPageFactsDocument } from "../lib/doppler-page-facts.js";
import { parsePdfPageSizes } from "../pipeline/pdf-asset-cache.js";
import {
  PAGE_SIZES_SCHEMA,
  PdfPageSizeMemo,
  pageSizeBinding,
  pageSizeBlocks,
  pageSizesArtifactKey,
  pageSizesArtifactMaxBytes,
  pageSizesFromDopplerFacts,
  parsePageSizesArtifact,
  readPageFactsRasterSizes,
  readPageSizeReuse,
  serializePageSizes,
  sharedBlockMeasurement,
  type PageSizeBinding,
  type PdfPageSize,
} from "../pipeline/pdf-page-sizes.js";
import { pageBoxPdf, type PageBoxSpec } from "../test/page-box-pdf.js";
import { docLine } from "../test/doppler-page-facts-fixture.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function binding(overrides: Partial<PageSizeBinding> = {}): PageSizeBinding {
  return { runId: "run-1", userId: "user-1", documentId: "doc-1", sourceKey: "sources/doc-1.pdf", sourceSha256: SHA_A, pageCount: 10, ...overrides };
}

const letter = { widthPt: 612, heightPt: 792 };
const a4 = { widthPt: 595.276, heightPt: 841.89 };

/** Doppler page facts for `pages` (geometry per page), through the strict reader. */
function facts(pages: Array<{ page: number; geometry?: Record<string, unknown>; parseWarnings?: string[]; error?: string }>, doc: Record<string, unknown> = {}, pageCount = pages.length): DopplerPageFactsDocument {
  const lines = [
    docLine({ pageCount, level: "basic", ...doc }),
    ...pages.map(({ page, geometry, parseWarnings = [], error }) => ({
      schema: "doppler-page-facts/1", type: "page", page,
      ...(error ? { error } : { geometry, parseWarnings, unusualFeatures: [] }),
      ...(error ? { parseWarnings: ["page-failed"], unusualFeatures: [] } : {}),
    })),
    { schema: "doppler-page-facts/1", type: "run", pagesTotal: pageCount, pagesFailed: 0, ms: 1 },
  ];
  const parsed = parseDopplerPageFacts(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", { pageCount });
  if (!parsed.ok) throw new Error(`facts refused: ${parsed.reason}`);
  return parsed.facts;
}

describe("page size binding and flags", () => {
  it("binds only a complete run-scoped source with a SHA-256 and a bounded page count", () => {
    const document = { id: "doc-1", userId: "user-1", sourceKey: "sources/doc-1.pdf", pageCount: 10 };
    expect(pageSizeBinding(document, "run-1", SHA_A)).toEqual(binding());
    expect(pageSizeBinding(document, undefined, SHA_A)).toBeNull();
    expect(pageSizeBinding({ ...document, userId: "" }, "run-1", SHA_A)).toBeNull();
    expect(pageSizeBinding({ ...document, sourceKey: "" }, "run-1", SHA_A)).toBeNull();
    expect(pageSizeBinding(document, "run-1", "not-a-hash")).toBeNull();
    expect(pageSizeBinding(document, "run-1", SHA_A.toUpperCase())).toBeNull();
    expect(pageSizeBinding({ ...document, pageCount: 0 }, "run-1", SHA_A)).toBeNull();
    expect(pageSizeBinding({ ...document, pageCount: 100_001 }, "run-1", SHA_A)).toBeNull();
    expect(pageSizeBinding({ ...document, pageCount: Number.NaN }, "run-1", SHA_A)).toBeNull();
  });

  it("reuses by default and takes page facts sizes only when asked", () => {
    expect(readPageSizeReuse({})).toBe(true);
    expect(readPageSizeReuse({ DOCSLURP_RASTER_PAGE_SIZE_REUSE: "off" })).toBe(false);
    expect(readPageFactsRasterSizes({})).toBe(false);
    expect(readPageFactsRasterSizes({ DOCSLURP_PAGE_FACTS_RASTER_SIZES: "1" })).toBe(false);
    expect(readPageFactsRasterSizes({ DOCSLURP_PAGE_FACTS_RASTER_SIZES: "on" })).toBe(true);
    // Facts sizes ride on reuse: with reuse off nothing stored is read.
    expect(readPageFactsRasterSizes({ DOCSLURP_PAGE_FACTS_RASTER_SIZES: "on", DOCSLURP_RASTER_PAGE_SIZE_REUSE: "off" })).toBe(false);
  });

  it("keys each artifact by run, document, measuring source and source hash", () => {
    const document = { id: "doc-1", userId: "user-1", runId: "run-1" };
    expect(pageSizesArtifactKey(document, binding(), "pdfinfo")).toBe(`user-1/run-1/page-sizes/doc-1/pdfinfo-${SHA_A}.json`);
    expect(pageSizesArtifactKey(document, binding({ sourceSha256: SHA_B }), "page-facts")).toBe(`user-1/run-1/page-sizes/doc-1/page-facts-${SHA_B}.json`);
    expect(pageSizesArtifactKey({ ...document, artifactRoot: "user-1/root-9" }, binding(), "pdfinfo")).toBe(`user-1/root-9/page-sizes/doc-1/pdfinfo-${SHA_A}.json`);
  });

  it("groups pages into aligned blocks clamped to the document", () => {
    expect(pageSizeBlocks([3, 1, 2], 10)).toEqual([{ first: 1, last: 10 }]);
    expect(pageSizeBlocks([1, 9_000, 4_097], 10_000)).toEqual([{ first: 1, last: 4_096 }, { first: 4_097, last: 8_192 }, { first: 8_193, last: 10_000 }]);
    expect(pageSizeBlocks([0, -1, 1.5], 10)).toEqual([]);
  });
});

describe("page size artifact", () => {
  const sizes = new Map<number, PdfPageSize>([[1, letter], [2, a4], [10, { widthPt: 20_000, heightPt: 20_000 }]]);

  it("round-trips a bound artifact", () => {
    const bytes = serializePageSizes(binding(), "pdfinfo", sizes);
    expect(parsePageSizesArtifact(bytes, binding(), "pdfinfo")).toEqual({ ok: true, sizes });
  });

  it("never stores an unusable size", () => {
    const bytes = serializePageSizes(binding(), "pdfinfo", new Map([[1, letter], [2, { widthPt: 0, heightPt: 0 }], [11, letter], [3, { widthPt: Number.NaN, heightPt: 1 }]]));
    expect(parsePageSizesArtifact(bytes, binding(), "pdfinfo")).toEqual({ ok: true, sizes: new Map([[1, letter]]) });
  });

  it.each([
    ["another document", binding({ documentId: "doc-2" })],
    ["another run", binding({ runId: "run-2" })],
    ["another requester", binding({ userId: "user-2" })],
    ["another source key", binding({ sourceKey: "sources/other.pdf" })],
    ["other source bytes", binding({ sourceSha256: SHA_B })],
    ["another page count", binding({ pageCount: 11 })],
  ])("refuses an artifact written for %s", (_label, reader) => {
    const bytes = serializePageSizes(binding(), "pdfinfo", sizes);
    expect(parsePageSizesArtifact(bytes, reader, "pdfinfo")).toEqual({ ok: false, reason: "binding" });
  });

  it("refuses an artifact from the other measuring source", () => {
    const bytes = serializePageSizes(binding(), "pdfinfo", new Map([[1, a4]]));
    expect(parsePageSizesArtifact(bytes, binding(), "page-facts")).toEqual({ ok: false, reason: "schema" });
  });

  const tampered = (mutate: (record: Record<string, unknown>) => void): Buffer => {
    const record = JSON.parse(serializePageSizes(binding(), "pdfinfo", sizes).toString("utf8")) as Record<string, unknown>;
    mutate(record);
    return Buffer.from(JSON.stringify(record));
  };

  it.each([
    ["a page past the page count", (r: Record<string, unknown>) => { (r.pages as unknown[]).push([11, 612, 792]); }, "page"],
    ["page zero", (r: Record<string, unknown>) => { (r.pages as unknown[]).push([0, 612, 792]); }, "page"],
    ["a fractional page", (r: Record<string, unknown>) => { (r.pages as unknown[]).push([4.5, 612, 792]); }, "page"],
    ["a duplicate page", (r: Record<string, unknown>) => { (r.pages as unknown[]).push([1, 1, 1]); }, "page"],
    ["a zero side", (r: Record<string, unknown>) => { (r.pages as unknown[])[0] = [1, 0, 792]; }, "page"],
    ["a negative side", (r: Record<string, unknown>) => { (r.pages as unknown[])[0] = [1, -612, 792]; }, "page"],
    ["a side past the bound", (r: Record<string, unknown>) => { (r.pages as unknown[])[0] = [1, 2_000_000, 792]; }, "page"],
    ["a string side", (r: Record<string, unknown>) => { (r.pages as unknown[])[0] = [1, "612", 792]; }, "page"],
    ["an extra entry field", (r: Record<string, unknown>) => { (r.pages as unknown[])[0] = [1, 612, 792, 1]; }, "page"],
    ["more entries than pages", (r: Record<string, unknown>) => { r.pages = Array.from({ length: 11 }, (_, i) => [i + 1, 612, 792]); }, "page"],
    ["no page list", (r: Record<string, unknown>) => { delete r.pages; }, "page"],
    ["another schema", (r: Record<string, unknown>) => { r.schema = "docslurp-pdf-page-sizes/2"; }, "schema"],
    ["a missing hash", (r: Record<string, unknown>) => { delete r.sourceSha256; }, "binding"],
  ])("refuses a tampered artifact with %s", (_label, mutate, reason) => {
    expect(parsePageSizesArtifact(tampered(mutate), binding(), "pdfinfo")).toEqual({ ok: false, reason });
  });

  it("refuses malformed and oversized artifacts", () => {
    expect(parsePageSizesArtifact(Buffer.from("{not json"), binding(), "pdfinfo")).toEqual({ ok: false, reason: "malformed" });
    expect(parsePageSizesArtifact(Buffer.from("[]"), binding(), "pdfinfo")).toEqual({ ok: false, reason: "malformed" });
    expect(parsePageSizesArtifact(Buffer.alloc(pageSizesArtifactMaxBytes(10) + 1, 32), binding(), "pdfinfo")).toEqual({ ok: false, reason: "oversized" });
  });

  it("bounds page facts artifacts to the facts' side range", () => {
    const bytes = serializePageSizes(binding(), "pdfinfo", new Map([[1, { widthPt: 20_000, heightPt: 792 }]]));
    const asFacts = Buffer.from(bytes.toString("utf8").replace('"source":"pdfinfo"', '"source":"page-facts"'));
    expect(parsePageSizesArtifact(asFacts, binding(), "page-facts")).toEqual({ ok: false, reason: "page" });
  });
});

describe("PdfPageSizeMemo", () => {
  it("serves only the exact binding and measuring source", () => {
    const memo = new PdfPageSizeMemo();
    memo.set(binding(), "pdfinfo", new Map([[1, letter], [2, a4]]));
    expect(memo.get(binding(), "pdfinfo", [1, 2, 3])).toEqual(new Map([[1, letter], [2, a4]]));
    for (const other of [binding({ runId: "run-2" }), binding({ userId: "user-2" }), binding({ documentId: "doc-2" }), binding({ sourceSha256: SHA_B }), binding({ sourceKey: "x" }), binding({ pageCount: 11 })]) {
      expect(memo.get(other, "pdfinfo", [1, 2]).size).toBe(0);
    }
    expect(memo.get(binding(), "page-facts", [1, 2]).size).toBe(0);
  });

  it("drops invalid sizes and pages outside the document", () => {
    const memo = new PdfPageSizeMemo();
    memo.set(binding(), "pdfinfo", new Map([[1, { widthPt: 0, heightPt: 792 }], [11, letter], [2, letter]]));
    memo.set(binding(), "page-facts", new Map([[1, { widthPt: 20_000, heightPt: 20_000 }], [2, { widthPt: 0.5, heightPt: 0.5 }], [3, a4]]));
    expect(memo.get(binding(), "pdfinfo", [1, 2, 11])).toEqual(new Map([[2, letter]]));
    expect(memo.get(binding(), "page-facts", [1, 2, 3])).toEqual(new Map([[3, a4]]));
  });

  it("stays within its page bound, evicting the least recently used document", () => {
    const memo = new PdfPageSizeMemo(25, 100);
    const pages = (n: number) => new Map(Array.from({ length: n }, (_, i) => [i + 1, letter] as const));
    memo.set(binding({ documentId: "a", pageCount: 10 }), "pdfinfo", pages(10));
    memo.set(binding({ documentId: "b", pageCount: 10 }), "pdfinfo", pages(10));
    memo.get(binding({ documentId: "a", pageCount: 10 }), "pdfinfo", [1]);
    memo.set(binding({ documentId: "c", pageCount: 10 }), "pdfinfo", pages(10));
    expect(memo.size).toEqual({ documents: 2, pages: 20 });
    expect(memo.get(binding({ documentId: "b", pageCount: 10 }), "pdfinfo", [1]).size).toBe(0);
    expect(memo.get(binding({ documentId: "a", pageCount: 10 }), "pdfinfo", [1]).size).toBe(1);
    // One document larger than the bound is not kept at all.
    const small = new PdfPageSizeMemo(5, 100);
    small.set(binding({ documentId: "big", pageCount: 10 }), "pdfinfo", pages(10));
    expect(small.size).toEqual({ documents: 0, pages: 0 });
  });

  it("stays within its document bound", () => {
    const memo = new PdfPageSizeMemo(1_000, 3);
    for (const id of ["a", "b", "c", "d", "e"]) memo.set(binding({ documentId: id }), "pdfinfo", new Map([[1, letter]]));
    expect(memo.size.documents).toBe(3);
  });
});

describe("sharedBlockMeasurement", () => {
  it("runs one measurement for concurrent requests of one block", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const measure = async () => { runs += 1; await gate; return new Map([[1, letter]]); };
    const signal = new AbortController().signal;
    const block = { first: 1, last: 10 };
    const results = Promise.all([0, 1, 2].map(() => sharedBlockMeasurement(binding({ documentId: "shared" }), block, signal, measure)));
    release();
    const done = await results;
    expect(runs).toBe(1);
    expect(done.filter((result) => result.measured)).toHaveLength(1);
    expect(done.every((result) => result.sizes.get(1) === letter)).toBe(true);
  });

  it("never shares across bindings, and measures for itself after a shared failure", async () => {
    let runs = 0;
    let fail!: (error: Error) => void;
    const failing = () => { runs += 1; return new Promise<Map<number, PdfPageSize>>((_, reject) => { fail = reject; }); };
    const ok = async () => { runs += 1; return new Map([[1, a4]]); };
    const signal = new AbortController().signal;
    const first = sharedBlockMeasurement(binding({ documentId: "fail" }), { first: 1, last: 10 }, signal, failing);
    const second = sharedBlockMeasurement(binding({ documentId: "fail" }), { first: 1, last: 10 }, signal, ok);
    const other = await sharedBlockMeasurement(binding({ documentId: "fail", runId: "run-9" }), { first: 1, last: 10 }, signal, ok);
    fail(new Error("pdfinfo crashed"));
    await expect(first).rejects.toThrow("pdfinfo crashed");
    expect((await second).sizes.get(1)).toEqual(a4);
    expect(other.measured).toBe(true);
    expect(runs).toBe(3);
  });

  it("stops waiting when the waiter's own signal aborts", async () => {
    const never = () => new Promise<Map<number, PdfPageSize>>(() => undefined);
    const owner = sharedBlockMeasurement(binding({ documentId: "abort" }), { first: 1, last: 10 }, new AbortController().signal, never);
    const controller = new AbortController();
    const waiter = sharedBlockMeasurement(binding({ documentId: "abort" }), { first: 1, last: 10 }, controller.signal, never);
    controller.abort(new Error("cancelled"));
    await expect(waiter).rejects.toThrow("cancelled");
    void owner;
  });
});

describe("pageSizesFromDopplerFacts", () => {
  it("takes unambiguous pages in pdfinfo's orientation", () => {
    const result = pageSizesFromDopplerFacts(facts([
      { page: 1, geometry: { widthPt: 595.28, heightPt: 841.89, rotation: 0, userUnit: 1 } },
      { page: 2, geometry: { widthPt: 841.89, heightPt: 595.28, rotation: 90, userUnit: 1 } },
      { page: 3, geometry: { widthPt: 841.89, heightPt: 595.28, rotation: 270, userUnit: 2 } },
      { page: 4, geometry: { widthPt: 612, heightPt: 1008, rotation: 180, userUnit: 1 } },
    ]), 4);
    expect(result.sizes).toEqual(new Map([
      [1, { widthPt: 595.28, heightPt: 841.89 }],
      [2, { widthPt: 595.28, heightPt: 841.89 }],
      [3, { widthPt: 595.28, heightPt: 841.89 }],
      [4, { widthPt: 612, heightPt: 1008 }],
    ]));
  });

  it("leaves a page on a billing boundary to pdfinfo (US Letter, Tabloid)", () => {
    const result = pageSizesFromDopplerFacts(facts([
      { page: 1, geometry: { widthPt: 612, heightPt: 792, rotation: 0, userUnit: 1 } },
      { page: 2, geometry: { widthPt: 792, heightPt: 1224, rotation: 0, userUnit: 1 } },
      { page: 3, geometry: { widthPt: 611.98, heightPt: 792, rotation: 0, userUnit: 1 } },
    ]), 3);
    // 612 x 792 could be 612.004 x 792 to pdfinfo, which bills 2 standard pages: ambiguous. 611.98 cannot reach 612.
    expect([...result.sizes.keys()]).toEqual([3]);
    expect(result.skipped).toEqual({ ambiguous: 2 });
  });

  it("takes nothing from failed, low-confidence, out-of-range or geometry-less pages", () => {
    const result = pageSizesFromDopplerFacts(facts([
      { page: 1, error: "failed" },
      { page: 2, geometry: { widthPt: 595.28, heightPt: 841.89, rotation: 0, userUnit: 1 }, parseWarnings: ["xref-repaired-earlier"] },
      { page: 3, geometry: { widthPt: 595.28, heightPt: 841.89, rotation: 0, userUnit: 1 }, parseWarnings: ["xref-repaired"] },
      { page: 4, geometry: { widthPt: 20_000, heightPt: 841.89, rotation: 0, userUnit: 1 } },
      { page: 5, geometry: { widthPt: 0.5, heightPt: 841.89, rotation: 0, userUnit: 1 } },
      { page: 6, geometry: { widthPt: 0, heightPt: 0, rotation: 0, userUnit: 1 } },
      { page: 7 },
      { page: 8, geometry: { widthPt: 595.28, heightPt: 841.89, rotation: 0, userUnit: 1 } },
    ]), 8);
    expect([...result.sizes.keys()]).toEqual([8]);
    expect(result.skipped).toEqual({ failed: 1, xref: 2, "out-of-range": 3, "no-geometry": 1 });
  });

  it.each([
    ["could not be opened", { error: "damaged" }],
    ["is locked", { locked: true }],
    ["needs a user password", { encryption: "user-password-required" }],
    ["had its cross-reference table rebuilt", { xref: "repaired" }],
  ])("takes nothing from a document that %s", (_label, doc) => {
    const result = pageSizesFromDopplerFacts(facts([{ page: 1, geometry: { widthPt: 595.28, heightPt: 841.89, rotation: 0, userUnit: 1 } }], doc), 1);
    expect(result.sizes.size).toBe(0);
  });

  it("ignores pages outside the host's own page count", () => {
    const parsed = facts([{ page: 1, geometry: { widthPt: 595.28, heightPt: 841.89, rotation: 0, userUnit: 1 } }, { page: 2, geometry: { widthPt: 595.28, heightPt: 841.89, rotation: 0, userUnit: 1 } }]);
    expect([...pageSizesFromDopplerFacts(parsed, 1).sizes.keys()]).toEqual([1]);
  });

  it("never bills less than pdfinfo for any facts value within the rounding band", () => {
    // Every 2-decimal facts value around boundaries, against every true size it could stand for (±0.005) as pdfinfo prints it.
    const sides = [611.97, 611.98, 611.99, 612, 612.01, 791.99, 792, 792.01, 595.28, 841.89, 1223.99, 1224, 1224.01];
    for (const w of sides) {
      for (const h of sides) {
        const result = pageSizesFromDopplerFacts(facts([{ page: 1, geometry: { widthPt: w, heightPt: h, rotation: 0, userUnit: 1 } }]), 1);
        const kept = result.sizes.get(1);
        if (!kept) continue;
        for (const dw of [-0.005, -0.001, 0, 0.001, 0.0049, 0.005]) {
          for (const dh of [-0.005, -0.001, 0, 0.001, 0.0049, 0.005]) {
            const printed = (value: number) => Number(value.toPrecision(6));
            expect(pageAreaEquivalentsPt(kept.widthPt, kept.heightPt)).toBeGreaterThanOrEqual(pageAreaEquivalentsPt(printed(w + dw), printed(h + dh)));
          }
        }
      }
    }
  });
});

interface EquivalenceCase {
  spec: PageBoxSpec;
  pdfinfo: Record<string, { widthPt: number; heightPt: number; rotate: number } | null>;
  facts: { geometry: { widthPt: number; heightPt: number; rotation: number; userUnit: number }; parseWarnings: string[] } | null;
  px144: Record<string, [number, number] | null>;
  px150cap1600: Record<string, [number, number] | null>;
}
const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/page-box-equivalence.json", import.meta.url), "utf8")) as Record<string, EquivalenceCase>;
const cases = Object.entries(fixture).filter(([name]) => name !== "_meta");

describe("page box equivalence: pdfinfo, pdftoppm -cropbox and Doppler page facts (recorded)", () => {
  it("covers rotation, UserUnit, CropBox edge cases and malformed boxes", () => {
    expect(cases.map(([name]) => name)).toEqual(expect.arrayContaining([
      "rot90", "rot270", "rot45", "userUnit2", "cropOffsetSameSize", "cropLargerOffset", "cropLargerOneAxis", "cropContainsMedia",
      "cropDisjoint", "mediaMissing", "mediaZero", "mediaThreeNumbers", "mediaInherited", "cropInherited", "huge", "boundary612_004",
    ]));
  });

  it.each(cases)("%s: both Poppler builds print the same size and render the same pixels", (_name, entry) => {
    const [first, ...rest] = Object.values(entry.pdfinfo);
    for (const other of rest) expect(other).toEqual(first);
    const [px, ...pxRest] = Object.values(entry.px144);
    for (const other of pxRest) expect(other).toEqual(px);
  });

  it.each(cases)("%s: facts geometry is pdfinfo's CropBox (sides swapped for 90/270, rounded to 0.01 pt)", (_name, entry) => {
    const info = Object.values(entry.pdfinfo)[0]!;
    const g = entry.facts!.geometry;
    const swapped = g.rotation === 90 || g.rotation === 270;
    const [w, h] = swapped ? [g.heightPt, g.widthPt] : [g.widthPt, g.heightPt];
    // pdfinfo prints %g (6 significant digits), the facts 2 decimals: both are within their rounding of the same box.
    expect(Math.abs(w - info.widthPt)).toBeLessThanOrEqual(0.0051);
    expect(Math.abs(h - info.heightPt)).toBeLessThanOrEqual(0.0051);
  });

  it.each(cases)("%s: a page the facts settle bills what pdfinfo bills and renders within a pixel of its size", (_name, entry) => {
    const parsed = facts([{ page: 1, geometry: entry.facts!.geometry, parseWarnings: entry.facts!.parseWarnings }]);
    const kept = pageSizesFromDopplerFacts(parsed, 1).sizes.get(1);
    if (!kept) return;
    const info = Object.values(entry.pdfinfo)[0]!;
    expect(pageAreaEquivalentsPt(kept.widthPt, kept.heightPt)).toBe(pageAreaEquivalentsPt(info.widthPt, info.heightPt));
    // pdftoppm -cropbox at 144 dpi: 2 px per point, the page's rotation applied.
    const rendered = [...Object.values(entry.px144)[0]!].sort((a, b) => a - b);
    const expected = [kept.widthPt * 2, kept.heightPt * 2].sort((a, b) => a - b);
    for (const index of [0, 1]) expect(Math.abs(rendered[index]! - expected[index]!)).toBeLessThanOrEqual(1);
  });

  it("records which cases the facts settle and why the rest go to pdfinfo", () => {
    const settled = cases.filter(([, entry]) => pageSizesFromDopplerFacts(facts([{ page: 1, geometry: entry.facts!.geometry, parseWarnings: entry.facts!.parseWarnings }]), 1).sizes.size === 1).map(([name]) => name);
    expect(settled).toEqual(["a4", "userUnit2rot90", "cropInside", "cropOffsetSameSize", "cropLargerOneAxis", "cropReversed", "mediaInherited", "cropInherited", "frac3"]);
  });

  it("measures a CropBox wider and taller than the MediaBox as the MediaBox, not the intersection", () => {
    // Poppler's PageAttrs: an axis where the CropBox is larger takes the MediaBox's span, then the boxes are intersected.
    // [100 -50 800 900] over [0 0 612 792] is 612 x 792 (the intersection would be 512 x 792) in pdfinfo, pdftoppm and facts.
    const entry = fixture.cropLargerOffset!;
    expect(Object.values(entry.pdfinfo)[0]).toMatchObject({ widthPt: 612, heightPt: 792 });
    expect(entry.facts!.geometry).toMatchObject({ widthPt: 612, heightPt: 792 });
    expect(Object.values(entry.px144)[0]).toEqual([1224, 1584]);
    expect(fixture.cropLargerOneAxis!.facts!.geometry).toMatchObject({ widthPt: 612, heightPt: 500 });
    // Same size, offset: an ordinary intersection.
    expect(fixture.cropOffsetSameSize!.facts!.geometry).toMatchObject({ widthPt: 512, heightPt: 692 });
  });
});

const popplerAvailable = ["pdfinfo", "pdftoppm"].every((binary) => spawnSync(binary, ["-v"]).error === undefined);

describe.skipIf(!popplerAvailable)("page box equivalence: this host's Poppler", () => {
  it.each(cases.filter(([name]) => name !== "huge"))("%s: pdfinfo through parsePdfPageSizes and pdftoppm -cropbox match the recorded builds", async (name, entry) => {
    const root = await mkdtemp(path.join(tmpdir(), "page-box-"));
    try {
      const source = path.join(root, `${name}.pdf`);
      await writeFile(source, pageBoxPdf(entry.spec));
      const info = spawnSync("pdfinfo", ["-f", "1", "-l", "1", source], { encoding: "utf8" });
      const sizes = parsePdfPageSizes(info.stdout, 1, 1);
      const recorded = Object.values(entry.pdfinfo)[0]!;
      expect(sizes.get(1)).toEqual({ widthPt: recorded.widthPt, heightPt: recorded.heightPt });
      spawnSync("pdftoppm", ["-png", "-cropbox", "-r", "144", "-f", "1", "-l", "1", source, path.join(root, "r")]);
      const png = (await readdir(root)).find((file) => file.startsWith("r-") && file.endsWith(".png"));
      const bytes = png ? await readFile(path.join(root, png)) : null;
      expect(bytes && bytes.length >= 24 ? [bytes.readUInt32BE(16), bytes.readUInt32BE(20)] : null).toEqual(Object.values(entry.px144)[0]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("serializes with the documented schema", () => {
  expect(JSON.parse(serializePageSizes(binding(), "pdfinfo", new Map([[1, letter]])).toString("utf8"))).toMatchObject({ schema: PAGE_SIZES_SCHEMA, pages: [[1, 612, 792]] });
});

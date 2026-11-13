/**
 * Doppler #44's walker-parity page facts (per-grid thin-rule counts, `unlistedRuledGrids`, words centred inside images):
 * the strict reader, the contract the layout mapping implements, and routing-decision parity with the layout walker.
 *
 * The contract (Doppler's docslurp/page-facts/README.md, "Reading them as the walker's grids"): a page's walker grids are
 * known only when `gridsTruncated` is false, `unlistedRuledGrids` is 0, every grid has `hRules` and `parseWarnings` has no
 * `xref-repaired`; they are the grids with `connected && hRules >= 2 && vRules >= 3`, of `hRules - 1` rows and `vRules - 1`
 * columns. It covers facts from one pdftotext run without `-glyphs`.
 */
import { describe, expect, it } from "vitest";

import { acceptSandboxedPdfResult, sandboxedPdfLayoutFacts } from "../extractors/plugins.js";
import { acceptSandboxedPdfBatchEvent, batchFileJob, type SandboxedPdfBatchJob } from "../extractors/sandboxed-pdf-batch.js";
import { pageFactsForResend } from "../extractors/sandboxed-pdf-page-facts.js";
import { buildAdaptiveRoutingDecisionSurface } from "../stages/classify-route.js";
import { SCHEMA, docLine, jsonl, runLine, textPage } from "../test/doppler-page-facts-fixture.js";
import { dopplerPageFactsJsonl, parseDopplerPageFacts, withoutWalkerParityFacts, type DopplerPageFactsDocument } from "./doppler-page-facts.js";
import { pageImageEvidenceFromDopplerFacts } from "./doppler-page-facts-evidence.js";
import { pageLayoutFactsFromDopplerFacts, unclippedPlacement } from "./doppler-page-facts-layout.js";
import { buildPageImageEvidence, findSparsePages, summarizeImageListing, type PageImageEvidence } from "./page-image-evidence.js";
import type { PageLayoutFacts } from "./page-layout-facts.js";

function parse(input: unknown, pageCount = 1): DopplerPageFactsDocument {
  const result = parseDopplerPageFacts(input, { pageCount });
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.facts;
}

const W = 612, H = 792;
const base = textPage(1);
const baseVectors = base.vectors as Record<string, unknown>;
const baseImages = base.images as Record<string, unknown>;
const baseItem = (baseImages.items as Array<Record<string, unknown>>)[0]!;

/** A fully ruled 6 x 4 table: 7 horizontal and 5 vertical thin-rule lines, one connected set. */
const WALKER = { bbox: [72, 100, 540, 400], rows: 6, columns: 4, coverage: 0.29, hRules: 7, vRules: 5, outerSides: 4, connected: true };
/** Shaded zebra rows the grid search sees as a 10-row table; no thin rules join them. */
const ZEBRA = { bbox: [72, 450, 540, 700], rows: 10, columns: 3, coverage: 0.24, hRules: 0, vRules: 0, outerSides: 0, connected: false };

/** One page with #44 vectors (a complete thin-rule search by default) and image item overrides. */
function page(over: { vectors?: Record<string, unknown>; item?: Record<string, unknown>; extra?: Record<string, unknown> } = {}): Record<string, unknown> {
  return textPage(1, {
    vectors: { ...baseVectors, hRules: 40, vRules: 40, grids: [WALKER], gridsTruncated: false, unlistedRuledGrids: 0, ...over.vectors },
    images: { ...baseImages, items: [{ ...baseItem, ...over.item }] },
    ...over.extra,
  });
}
const one = (line: Record<string, unknown>) => parse(jsonl([docLine({ pageCount: 1 }), line, runLine({ pagesEmitted: 1 })]));
const layoutOf = (line: Record<string, unknown>) => pageLayoutFactsFromDopplerFacts(one(line)).get(1)!;

/** The walker's union_coverage (pdf_layout_facts.py), cell by cell, as an independent check of `unionCoverage`. */
function walkerUnion(boxes: number[][], w = W, h = H): number {
  const n = 200;
  const covered = new Set<number>();
  for (const [x0, y0, x1, y1] of boxes) {
    const c0 = Math.max(0, Math.trunc(x0! / w * n)), c1 = Math.min(n, Math.ceil(x1! / w * n));
    const r0 = Math.max(0, Math.trunc(y0! / h * n)), r1 = Math.min(n, Math.ceil(y1! / h * n));
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) covered.add(r * n + c);
  }
  return Math.round(covered.size / (n * n) * 10_000) / 10_000;
}

describe("doppler #44 facts: strict reader", () => {
  it("keeps valid thin-rule counts, unlistedRuledGrids and centred counts, and round-trips them", () => {
    const facts = one(page({ vectors: { grids: [WALKER, ZEBRA], unlistedRuledGrids: 0 }, item: { visibleWordsInside: 1, invisibleWordsInside: 0, visibleWordsCentredInside: 3, invisibleWordsCentredInside: 0 } }));
    const v = facts.pages.get(1)!.vectors!;
    expect(v.unlistedRuledGrids).toBe(0);
    expect(v.grids![0]).toMatchObject({ hRules: 7, vRules: 5, outerSides: 4, connected: true });
    expect(v.grids![1]).toMatchObject({ hRules: 0, vRules: 0, outerSides: 0, connected: false });
    expect(facts.pages.get(1)!.images!.items![0]).toMatchObject({ visibleWordsCentredInside: 3, invisibleWordsCentredInside: 0 });
    expect(parse(dopplerPageFactsJsonl(facts)).pages).toEqual(facts.pages);
  });

  it("hostile thin-rule fields make the whole vectors family unknown, never a partial or older-build reading", () => {
    const g = (over: Record<string, unknown>) => ({ grids: [{ ...WALKER, ...over }] });
    const { hRules: _h, ...noH } = WALKER;
    const { connected: _c, ...noConnected } = WALKER;
    const hostile: Array<[string, Record<string, unknown>]> = [
      ["NaN hRules", g({ hRules: Number.NaN })], ["negative vRules", g({ vRules: -1 })], ["fractional hRules", g({ hRules: 2.5 })],
      ["hRules past 4,096", g({ hRules: 4_097 })], ["string hRules", g({ hRules: "7" })], ["null hRules", g({ hRules: null })],
      ["outerSides 5", g({ outerSides: 5 })], ["outerSides -1", g({ outerSides: -1 })], ["fractional outerSides", g({ outerSides: 1.5 })],
      ["string connected", g({ connected: "true" })], ["numeric connected", g({ connected: 1 })],
      ["hRules missing from the set", { grids: [noH] }], ["connected missing from the set", { grids: [noConnected] }],
      ["hRules alone", { grids: [{ bbox: WALKER.bbox, rows: 6, columns: 4, coverage: 0.29, hRules: 7 }] }],
      ["unlisted negative", { unlistedRuledGrids: -1 }], ["unlisted fractional", { unlistedRuledGrids: 0.5 }],
      ["unlisted string", { unlistedRuledGrids: "0" }], ["unlisted huge", { unlistedRuledGrids: 2_049 }], ["unlisted null", { unlistedRuledGrids: null }],
      ["counts without unlistedRuledGrids", { unlistedRuledGrids: undefined }],
    ];
    for (const [name, over] of hostile) {
      const line = page({ vectors: over });
      if (has(over, "unlistedRuledGrids") && over.unlistedRuledGrids === undefined) delete (line.vectors as Record<string, unknown>).unlistedRuledGrids;
      const facts = one(line);
      expect(facts.pages.get(1)!.vectors, name).toBeUndefined();
      expect(pageLayoutFactsFromDopplerFacts(facts).get(1)!.grids, name).toBeNull();
    }
    // More distinct lines than the page has rules (what a -glyphs run can write: stencil-mask rules count for the grid
    // only): the thin-rule counts go, the family stands, and the grid reads as an older build's (unknown).
    for (const rules of [{ hRules: 6, vRules: 40 }, { hRules: 40, vRules: 4 }]) {
      const facts = one(page({ vectors: rules }));
      const v = facts.pages.get(1)!.vectors!;
      expect(v.unlistedRuledGrids).toBeUndefined();
      expect(v.grids![0]!.hRules).toBeUndefined();
      expect(v.grids![0]!.rows).toBe(6);
      expect(pageLayoutFactsFromDopplerFacts(facts).get(1)!.grids).toBeNull();
    }
    // unlistedRuledGrids with no list to qualify.
    const { grids: _g, ...noList } = page().vectors as Record<string, unknown>;
    expect(one(textPage(1, { vectors: noList })).pages.get(1)!.vectors).toBeUndefined();
  });

  it("hostile centred counts are dropped (unknown), never 0 and never mixed with another pair", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["one of the pair", { visibleWordsCentredInside: 3 }], ["negative", { visibleWordsCentredInside: -1, invisibleWordsCentredInside: 0 }],
      ["NaN", { visibleWordsCentredInside: Number.NaN, invisibleWordsCentredInside: 0 }],
      ["fractional", { visibleWordsCentredInside: 0.5, invisibleWordsCentredInside: 0 }],
      ["string", { visibleWordsCentredInside: "0", invisibleWordsCentredInside: 0 }],
      ["past the page's visible words", { visibleWordsCentredInside: 411, invisibleWordsCentredInside: 0 }],
      ["past the page's invisible words", { visibleWordsCentredInside: 0, invisibleWordsCentredInside: 1 }],
    ];
    for (const [name, over] of cases) {
      const item = one(page({ item: over })).pages.get(1)!.images!.items![0]!;
      expect(item.visibleWordsCentredInside, name).toBeUndefined();
      expect(item.invisibleWordsCentredInside, name).toBeUndefined();
    }
    // Fewer centred than wholly inside is a contradiction: both pairs go, and the image's words inside are unknown.
    const contradiction = one(page({ item: { visibleWordsInside: 3, invisibleWordsInside: 0, visibleWordsCentredInside: 1, invisibleWordsCentredInside: 0 } }));
    expect(contradiction.pages.get(1)!.images!.items![0]!.visibleWordsInside).toBeUndefined();
    expect(pageLayoutFactsFromDopplerFacts(contradiction).get(1)!.images![0]!.wordsInside).toBeNull();
    // Without the text family nothing bounds them.
    const { text: _t, ...noText } = page({ item: { visibleWordsCentredInside: 0, invisibleWordsCentredInside: 0 } });
    expect(one(noText).pages.get(1)!.images!.items![0]!.visibleWordsCentredInside).toBeUndefined();
  });
});

function has(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

describe("doppler #44 facts: the walker-grid contract", () => {
  it("known: walker grids map one to one to the walker's (rows hRules - 1, columns vRules - 1); others are not walker grids", () => {
    const tick = { ...WALKER, bbox: [300, 720, 340, 760], rows: 1, columns: 1, coverage: 0.003, hRules: 2, vRules: 2, connected: true };
    const lines = { ...WALKER, bbox: [72, 420, 540, 440], rows: 1, columns: 1, coverage: 0.02, hRules: 1, vRules: 3, connected: true };
    const stray = { ...WALKER, bbox: [72, 40, 540, 90], hRules: 3, vRules: 4, connected: false, coverage: 0.07 };
    const layout = layoutOf(page({ vectors: { grids: [WALKER, ZEBRA, tick, lines, stray] } }));
    // Coverage stays unknown: Doppler's box spans its grid search's group, not the walker's connected rules.
    expect(layout.grids).toEqual([{ rows: 6, columns: 4, coverage: null }]);
    expect(layout.tableCoverage).toBeNull();
    // Only non-walker grids on a known page: no walker grid.
    expect(layoutOf(page({ vectors: { grids: [ZEBRA, stray] } }))).toMatchObject({ grids: [], tableCoverage: 0 });
    // A complete, empty list.
    expect(layoutOf(page({ vectors: { grids: [] } }))).toMatchObject({ grids: [], tableCoverage: 0 });
  });

  it("known: the rows and columns are the walker's even where Doppler's own search says otherwise; coverage never is", () => {
    // A table ruled cell by cell: the grid search sees one column; the thin rules give the walker's 5 rows x 3 columns.
    const cellByCell = { bbox: [72, 100, 400, 300], rows: 5, columns: 1, coverage: 0.13, hRules: 6, vRules: 4, outerSides: 4, connected: true };
    const second = { ...WALKER, bbox: [300, 450, 576, 760], rows: 9, columns: 2, hRules: 10, vRules: 3, coverage: 0.18 };
    const layout = layoutOf(page({ vectors: { grids: [cellByCell, second] } }));
    expect(layout.grids!.map((g) => [g.rows, g.columns])).toEqual([[5, 3], [9, 2]]);
    expect(layout.tableCoverage).toBeNull();
    // Council #382 M1: decorative shaded bands the grid search groups over 60% of the page, with a small ruled 1 x 2 table
    // inside. The walker's grid is the tiny table; Doppler's box is the whole group. Never a coverage that makes it heavy.
    const banded = { bbox: [36, 100, 576, 650], rows: 12, columns: 2, coverage: 0.61, hRules: 2, vRules: 3, outerSides: 0, connected: true };
    const bandedLayout = layoutOf(page({ vectors: { grids: [banded] } }));
    expect(bandedLayout).toMatchObject({ grids: [{ rows: 1, columns: 2, coverage: null }], tableCoverage: null });
  });

  it("unknown: each condition the contract names leaves every grid on the page unknown (null)", () => {
    const unknown: Array<[string, Parameters<typeof page>[0]]> = [
      ["gridsTruncated", { vectors: { gridsTruncated: true } }],
      ["unlistedRuledGrids 1", { vectors: { unlistedRuledGrids: 1 } }],
      ["a grid without counts", { vectors: { grids: [WALKER, { bbox: [72, 450, 540, 700], rows: 3, columns: 3, coverage: 0.24 }] } }],
      ["xref-repaired", { extra: { parseWarnings: ["xref-repaired"] } }],
      ["xref-repaired-earlier", { extra: { parseWarnings: ["xref-repaired-earlier"] } }],
      ["drawing cap", { vectors: { limitHit: true } }],
    ];
    for (const [name, over] of unknown) {
      const layout = layoutOf(page(over));
      expect(layout.grids, name).toBeNull();
      expect(layout.tableCoverage, name).toBeNull();
    }
    // The thin-rule search was incomplete: Doppler leaves out unlistedRuledGrids and the counts, and sets gridsTruncated.
    const { unlistedRuledGrids: _u, ...incomplete } = page({ vectors: { grids: [{ bbox: WALKER.bbox, rows: 6, columns: 4, coverage: 0.29 }], gridsTruncated: true } }).vectors as Record<string, unknown>;
    expect(layoutOf(textPage(1, { vectors: incomplete })).grids).toBeNull();
    // xref-repaired on a #44 page leaves even the page-level rule proof unknown, as the contract says.
    expect(layoutOf(page({ vectors: { hRules: 1, grids: [] }, extra: { parseWarnings: ["xref-repaired"] } })).grids).toBeNull();
  });

  it("unknown: an older build's absence rule never applies to a #44 page the contract leaves unknown", () => {
    // Lined paper plus a pale ruled table the grid search skipped (luminance above 0.97): the walker has a grid there.
    const lined = { bbox: [72, 72, 540, 720], rows: 30, columns: 1, coverage: 0.8, hRules: 31, vRules: 0, outerSides: 0, connected: false };
    expect(layoutOf(page({ vectors: { grids: [lined], unlistedRuledGrids: 1 } })).grids).toBeNull();
    // The same list without #44 fields (an older build) keeps #378's reading.
    expect(layoutOf(textPage(1, { vectors: { ...baseVectors, hRules: 40, vRules: 40, grids: [{ bbox: lined.bbox, rows: 30, columns: 1, coverage: 0.8 }], gridsTruncated: false } })).grids).toEqual([]);
    // The page-level rule proof still stands: below 2 horizontal or 3 vertical rules there is no walker grid at all.
    expect(layoutOf(page({ vectors: { hRules: 31, vRules: 2, grids: [{ ...lined, vRules: 0 }], unlistedRuledGrids: 0 } }))).toMatchObject({ grids: [], tableCoverage: 0 });
  });

  it("words inside: centred counts are the walker's wordsInside whenever present; truncation leaves images unknown", () => {
    // A 264 x 300 pt box that its 264 x 300 samples at 72 dpi fill: the whole placement.
    const at = (item: Record<string, unknown>, ratio = 0.2) => layoutOf(page({
      item: { bbox: [36, 300, 300, 600], px: [264, 300], dpi: [72, 72], ...item }, extra: { text: { ...(base.text as object), textOverImageRatio: ratio } },
    })).images![0]!.wordsInside;
    // A caption line straddling the bottom edge: the walker counts it by its centre, as the centred count does.
    expect(at({ visibleWordsInside: 0, invisibleWordsInside: 0, visibleWordsCentredInside: 4, invisibleWordsCentredInside: 0 })).toBe(4);
    // A low count stands without #378's ratio-and-cells proof: it is the walker's own test.
    expect(at({ visibleWordsInside: 0, invisibleWordsInside: 0, visibleWordsCentredInside: 1, invisibleWordsCentredInside: 0 })).toBe(1);
    expect(at({ visibleWordsCentredInside: 7, invisibleWordsCentredInside: 0 })).toBe(7);
    // Council #382 M2: a clipped image's box is smaller than its placement, where the walker counts: a low count is unknown.
    // Here a full-page scan clipped to the top 60% (px / dpi give 612 x 792, the box is 612 x 475).
    const clipped = { bbox: [0, 0, 612, 475], px: [2550, 3300], dpi: [300, 300] };
    expect(at({ ...clipped, visibleWordsCentredInside: 0, invisibleWordsCentredInside: 0 })).toBeNull();
    expect(at({ ...clipped, visibleWordsCentredInside: 2, invisibleWordsCentredInside: 0 })).toBeNull();
    // A high count only blocks a read: it stands.
    expect(at({ ...clipped, visibleWordsCentredInside: 40, invisibleWordsCentredInside: 0 })).toBe(40);
    // The whole-box fallback is held to the same test.
    expect(at({ ...clipped, visibleWordsInside: 0, invisibleWordsInside: 0 }, 0)).toBeNull();
    expect(unclippedPlacement({ bbox: [0, 0, 300, 264], px: [264, 300], dpi: [72, 72] })).toBe(true); // turned 90°
    expect(unclippedPlacement({ bbox: [0, 0, 264, 300], px: [264, 300], dpi: [0, 72] })).toBe(false);
    // Visible and invisible add up (an OCR layer over a scan counts its invisible words, as the walker's boxes do).
    const ocr = layoutOf(page({
      item: { bbox: [36, 300, 300, 600], px: [264, 300], dpi: [72, 72], visibleWordsCentredInside: 2, invisibleWordsCentredInside: 5 },
      extra: { text: { ...(base.text as object), wordCount: 415, invisibleWordCount: 5, invisibleCharCount: 30, charCount: 2430, textLayer: "mixed" } },
    })).images![0]!.wordsInside;
    expect(ocr).toBe(7);
    // Without the centred pair, #378's whole-box rule (here: unknown, text centres over the image).
    expect(at({ visibleWordsInside: 0, invisibleWordsInside: 0 })).toBeNull();
    const truncated = textPage(1, { images: { ...baseImages, itemsTruncated: true, items: [{ ...baseItem, visibleWordsCentredInside: 0, invisibleWordsCentredInside: 0 }] } });
    expect(layoutOf(truncated).images).toBeNull();
    // Fewer items than images: the list is unknown too.
    const short = textPage(1, { images: { ...baseImages, imageCount: 2, items: [{ ...baseItem, visibleWordsCentredInside: 0, invisibleWordsCentredInside: 0 }] } });
    expect(layoutOf(short).images).toBeNull();
  });

  it("facts of a -glyphs run (pdftomarkdown --math) lose the walker-parity fields and map as an older build", () => {
    const line = page({ vectors: { grids: [WALKER] }, item: { bbox: [36, 300, 300, 600], px: [264, 300], dpi: [72, 72], visibleWordsInside: 0, invisibleWordsInside: 0, visibleWordsCentredInside: 1, invisibleWordsCentredInside: 0 }, extra: { text: { ...(base.text as object), textOverImageRatio: 0.2 } } });
    const facts = one(line);
    expect(pageLayoutFactsFromDopplerFacts(facts).get(1)!.grids).toHaveLength(1);
    expect(pageLayoutFactsFromDopplerFacts(facts).get(1)!.images![0]!.wordsInside).toBe(1);
    const stripped = withoutWalkerParityFacts(facts);
    expect(facts.pages.get(1)!.vectors!.unlistedRuledGrids).toBe(0); // the input is not changed
    const mapped = pageLayoutFactsFromDopplerFacts(stripped).get(1)!;
    expect(mapped.grids).toBeNull();
    expect(mapped.images![0]!.wordsInside).toBeNull();
    expect(dopplerPageFactsJsonl(stripped)).not.toMatch(/unlistedRuledGrids|CentredInside|outerSides|"connected"/);

    // Through acceptance: a single-file run (no --math) keeps them; a math batch strips them, and hands on only the strip.
    const raw = jsonl([docLine({ pageCount: 1 }), line, runLine({ pagesEmitted: 1 })]);
    const env = process.env.DOCSLURP_DOPPLER_PAGE_FACTS;
    process.env.DOCSLURP_DOPPLER_PAGE_FACTS = "use";
    try {
      const single = { input: "/a", output: "/b" };
      acceptSandboxedPdfResult(single, { exitCode: 0, stdout: "", stderr: "", pageFacts: raw }, 1);
      expect(sandboxedPdfLayoutFacts(single)!.get(1)!.grids).toHaveLength(1);
      for (const math of [false, true]) {
        const job: SandboxedPdfBatchJob = {
          scope: { orgId: "org-a", runId: "run-1" }, options: { math, figures: false },
          files: [{ index: 0, documentId: "doc-0", input: "/w/in/0.pdf", output: "/w/out/0.md", bytes: 100, estimatedPages: 1 }],
        };
        acceptSandboxedPdfBatchEvent(job, { index: 0, phase: "text", pages: 1, result: { exitCode: 0, stdout: "", stderr: "", pageFacts: raw } });
        const file = batchFileJob(job, 0)!;
        expect(sandboxedPdfLayoutFacts(file)!.get(1)!.grids, `math ${math}`).toEqual(math ? null : [{ rows: 6, columns: 4, coverage: null }]);
        // The first pass hands on canonical lines: a served math result cannot bring the fields back.
        const served = { input: "/c", output: "/d" };
        acceptSandboxedPdfResult(served, { exitCode: 0, stdout: "", stderr: "", pageFacts: pageFactsForResend(file)! }, 1);
        expect(sandboxedPdfLayoutFacts(served)!.get(1)!.grids === null, `served math ${math}`).toBe(math);
      }
    } finally {
      if (env === undefined) delete process.env.DOCSLURP_DOPPLER_PAGE_FACTS; else process.env.DOCSLURP_DOPPLER_PAGE_FACTS = env;
    }
  });
});

// ── Decision parity: one description per page, measured by the walker (and the pdfimages probe) and by #44 facts ──

interface TruthImage {
  bbox: [number, number, number, number];
  px: [number, number];
  ppi: number;
  filter: "dct" | "ccitt" | "flate";
  bpc: number;
  colorSpace: "gray" | "rgb";
  streamBytes: number;
  obj: number;
  /** Words whose centre is inside (the walker's count, and Doppler's centred count). */
  wordsInside: number;
  /** Words whose whole box is inside (Doppler's whole-box count), when it differs. */
  wholeWordsInside?: number;
}
interface DopplerGrid { bbox: [number, number, number, number]; rows: number; columns: number; hRules: number; vRules: number; connected: boolean }
interface TruthPage {
  name: string;
  words: number;
  invisibleWords?: number;
  images: TruthImage[];
  /** The walker's ruled grids (pdf_layout_facts.ruled_grids over the run's XHTML). */
  walker: Array<{ bbox: [number, number, number, number]; rows: number; columns: number }>;
  /** What Doppler's grid search lists, with its thin-rule counts; and the page's rule counts. */
  doppler: DopplerGrid[];
  rules: [number, number];
  text: string;
}

const prose = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 97}`).join(" ");
const logo: TruthImage = { bbox: [36, 36, 108, 72], px: [300, 150], ppi: 300, filter: "flate", bpc: 8, colorSpace: "rgb", streamBytes: 9000, obj: 42, wordsInside: 0 };
const placed = (x: number, y: number, px: [number, number], ppi: number): [number, number, number, number] => [x, y, x + px[0] / ppi * 72, y + px[1] / ppi * 72];
/** A fully ruled grid as both see it: Doppler's search and the walker agree. */
const ruled = (bbox: [number, number, number, number], rows: number, columns: number) => ({
  walker: [{ bbox, rows, columns }], doppler: [{ bbox, rows, columns, hRules: rows + 1, vRules: columns + 1, connected: true }],
});
const scanFigure = (obj: number, wordsInside: number, extra: Partial<TruthImage> = {}): TruthImage => ({
  bbox: placed(72, 300, [1950, 1250], 300), px: [1950, 1250], ppi: 300, filter: "ccitt", bpc: 1, colorSpace: "gray", streamBytes: 40_000, obj, wordsInside, ...extra,
});

const TRUTH: TruthPage[] = [
  { name: "prose", words: 420, images: [logo], walker: [], doppler: [], rules: [2, 0], text: prose(420) },
  { name: "ruled table flattened to prose (rows)", words: 300, images: [logo], ...ruled([72, 120, 540, 420], 8, 4), rules: [9, 5], text: prose(300) },
  { name: "large two-row grid (coverage)", words: 260, images: [logo], ...ruled([36, 100, 576, 700], 2, 3), rules: [3, 4], text: prose(260) },
  { name: "small grid", words: 260, images: [logo], ...ruled([72, 120, 300, 200], 2, 2), rules: [3, 3], text: prose(260) },
  {
    name: "two ruled tables, neither heavy alone", words: 260, images: [logo], rules: [8, 8], text: prose(260),
    walker: [{ bbox: [36, 60, 576, 230], rows: 3, columns: 3 }, { bbox: [36, 400, 576, 580], rows: 3, columns: 3 }],
    doppler: [{ bbox: [36, 60, 576, 230], rows: 3, columns: 3, hRules: 4, vRules: 4, connected: true }, { bbox: [36, 400, 576, 580], rows: 3, columns: 3, hRules: 4, vRules: 4, connected: true }],
  },
  {
    // The grid search sees one column; the thin rules (and the walker) see 6 rows x 3 columns: #378 called this [].
    name: "table ruled cell by cell", words: 300, images: [logo], rules: [7, 4], text: prose(300),
    walker: [{ bbox: [72, 100, 400, 300], rows: 6, columns: 3 }], doppler: [{ bbox: [72, 100, 400, 300], rows: 6, columns: 1, hRules: 7, vRules: 4, connected: true }],
  },
  {
    // Shaded rows with column lines and one header rule: the grid search lists 10 rows; the walker finds no grid.
    name: "zebra table with column lines", words: 300, images: [logo], rules: [3, 4], text: prose(300), walker: [],
    doppler: [{ bbox: [72, 100, 540, 500], rows: 10, columns: 3, hRules: 1, vRules: 4, connected: true }],
  },
  {
    name: "underlines and ticks the search grouped", words: 300, images: [logo], rules: [5, 3], text: prose(300), walker: [],
    doppler: [{ bbox: [72, 100, 540, 700], rows: 4, columns: 2, hRules: 5, vRules: 3, connected: false }],
  },
  { name: "lined paper (one column)", words: 220, images: [logo], walker: [], rules: [31, 0], text: prose(220), doppler: [{ bbox: [72, 72, 540, 720], rows: 30, columns: 1, hRules: 31, vRules: 0, connected: false }] },
  { name: "Markdown table", words: 200, images: [logo], walker: [], doppler: [], rules: [0, 0], text: `${prose(150)}\n\n| a | b |\n|---|---|\n${Array.from({ length: 6 }, (_, i) => `| ${i} | x |`).join("\n")}` },
  { name: "mixed scan: bilevel figure beside text", words: 240, walker: [], doppler: [], rules: [0, 0], text: prose(240), images: [logo, scanFigure(50, 0)] },
  { name: "mixed scan: low-bpp DCT scan beside text", words: 240, walker: [], doppler: [], rules: [0, 0], text: prose(240), images: [logo, scanFigure(51, 0, { filter: "dct", bpc: 8, streamBytes: 243_750 })] },
  { name: "photo beside text", words: 240, walker: [], doppler: [], rules: [0, 0], text: prose(240), images: [logo, scanFigure(52, 0, { filter: "dct", bpc: 8, colorSpace: "rgb", streamBytes: 1_200_000 })] },
  { name: "scan with a caption over it", words: 240, walker: [], doppler: [], rules: [0, 0], text: prose(240), images: [logo, scanFigure(53, 12)] },
  // #378 could not tell these two apart from whole-box counts; centred counts are the walker's.
  { name: "labels overrunning a bilevel figure", words: 240, walker: [], doppler: [], rules: [0, 0], text: prose(240), images: [logo, scanFigure(54, 3, { wholeWordsInside: 0 })] },
  { name: "scan with one word over it", words: 240, walker: [], doppler: [], rules: [0, 0], text: prose(240), images: [logo, scanFigure(55, 1)] },
  { name: "sparse full-page scan", words: 0, walker: [], doppler: [], rules: [0, 0], text: "", images: [logo, { bbox: [0, 0, W, H], px: [2550, 3300], ppi: 300, filter: "ccitt", bpc: 1, colorSpace: "gray", streamBytes: 90_000, obj: 60, wordsInside: 0 }] },
  {
    name: "OCR'd scan (invisible layer)", words: 300, invisibleWords: 300, walker: [], doppler: [], rules: [0, 0], text: prose(300),
    images: [{ bbox: [0, 0, W, H], px: [2550, 3300], ppi: 300, filter: "ccitt", bpc: 1, colorSpace: "gray", streamBytes: 90_000, obj: 61, wordsInside: 300 }],
  },
  { name: "blank", words: 0, images: [], walker: [], doppler: [], rules: [0, 0], text: "" },
];

const share = (b: number[]) => Math.round(((b[2]! - b[0]!) * (b[3]! - b[1]!)) / (W * H) * 10_000) / 10_000;

function walkerLayout(truth: TruthPage, repeated: Set<number>): PageLayoutFacts {
  const encoding = { dct: "jpeg", ccitt: "ccitt", flate: "image" } as const;
  return {
    images: truth.images.map((image) => ({
      bbox: image.bbox, coverage: share(image.bbox), widthPx: image.px[0], heightPx: image.px[1], bitsPerComponent: image.bpc,
      colorSpace: image.colorSpace, encoding: encoding[image.filter], ppi: [image.ppi, image.ppi],
      bytesPerPixel: Math.round(image.streamBytes / (image.px[0] * image.px[1]) * 1e5) / 1e5, repeated: repeated.has(image.obj),
      wordsInside: image.wordsInside,
    })),
    tables: null,
    words: truth.words,
    grids: truth.walker.map((g) => ({ rows: g.rows, columns: g.columns, coverage: walkerUnion([g.bbox]) })),
    tableCoverage: walkerUnion(truth.walker.map((g) => g.bbox)),
    widthPt: W, heightPt: H, invisibleWords: truth.invisibleWords ?? 0,
    textLayer: truth.words === 0 ? "none" : truth.invisibleWords === truth.words ? "invisible" : truth.invisibleWords ? "mixed" : "visible",
  };
}

function factsLine(truth: TruthPage, n: number, vectors: Record<string, unknown> = {}): Record<string, unknown> {
  const invisible = truth.invisibleWords ?? 0;
  const visible = truth.words - invisible;
  const layer = truth.words === 0 ? "none" : invisible === 0 ? "visible" : visible === 0 ? "invisible" : "mixed";
  const area = (b: number[]) => ((b[2]! - b[0]!) * (b[3]! - b[1]!)) / (W * H);
  const split = (count: number) => [Math.min(count, visible), Math.max(0, count - visible)];
  return {
    schema: SCHEMA, type: "page", page: n,
    geometry: { widthPt: W, heightPt: H, rotation: 0, userUnit: 1 },
    text: {
      charCount: truth.words * 6, visibleCharCount: visible * 6, invisibleCharCount: invisible * 6, wordCount: truth.words,
      visibleWordCount: visible, invisibleWordCount: invisible, textLayer: layer, textCoverage: 0.3,
      textOverImageRatio: truth.words === 0 ? 0 : Math.min(1, truth.images.reduce((sum, i) => sum + i.wordsInside, 0) / truth.words),
    },
    images: {
      imageCount: truth.images.length, imageCoverage: Math.min(1, truth.images.reduce((s, i) => s + area(i.bbox), 0)),
      largestImageCoverage: Math.max(0, ...truth.images.map((i) => area(i.bbox))), fullPageImage: truth.images.some((i) => area(i.bbox) >= 0.85),
      scan: "none", truncated: false, itemsTruncated: false,
      items: truth.images.map((image, i) => {
        const [wholeVisible, wholeInvisible] = split(image.wholeWordsInside ?? image.wordsInside);
        const [centredVisible, centredInvisible] = split(image.wordsInside);
        return {
          index: i + 1, bbox: image.bbox, coverage: Math.round(area(image.bbox) * 4096) / 4096, px: image.px, dpi: [image.ppi, image.ppi],
          filter: image.filter, bpc: image.bpc, colorSpace: image.colorSpace, imageMask: false, softMask: false, mask: false, decode: false,
          inline: false, obj: image.obj, copy: "decode", visibleWordsInside: wholeVisible, invisibleWordsInside: wholeInvisible,
          visibleWordsCentredInside: centredVisible, invisibleWordsCentredInside: centredInvisible,
          bytesPerPixel: Math.round(image.streamBytes / (image.px[0] * image.px[1]) * 1e6) / 1e6,
        };
      }),
    },
    vectors: {
      paths: 40, filled: 0, stroked: 40, coverage: 0.2, hRules: truth.rules[0], vRules: truth.rules[1], ruleGridScore: truth.doppler.length ? 1 : 0,
      shadings: 0, patterns: 0, clips: 0, figureClusters: 0, clusters: [], clustersTruncated: false, limitHit: false,
      grids: truth.doppler.map((g) => ({ ...g, coverage: Math.round(area(g.bbox) * 10_000) / 10_000, outerSides: g.connected ? 4 : 0 })),
      gridsTruncated: false, unlistedRuledGrids: 0, ...vectors,
    },
    parseWarnings: [], unusualFeatures: [],
  };
}

function probeEvidence(pages: TruthPage[]): PageImageEvidence[] {
  const rows = pages.flatMap((truth, i) => truth.images.map((image) =>
    `${i + 1} 0 image ${image.px[0]} ${image.px[1]} ${image.colorSpace} 1 ${image.bpc} ${image.filter === "dct" ? "jpeg" : image.filter === "flate" ? "image" : image.filter} no ${image.obj} 0 ${image.ppi} ${image.ppi} 10K 1%`));
  const listing = summarizeImageListing(["page num type", "----", ...rows].join("\n"), {
    pageAreas: new Map(pages.map((_, i) => [i + 1, W * H])), pagesInScope: pages.length,
  });
  return buildPageImageEvidence({ sparsePages: findSparsePages(pages.map((p) => p.text)), listing });
}

function walkerRepeated(pages: TruthPage[]): Set<number> {
  const seen = new Map<number, number>();
  for (const truth of pages) for (const obj of new Set(truth.images.map((i) => i.obj))) seen.set(obj, (seen.get(obj) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n >= Math.max(3, Math.ceil(0.2 * pages.length))).map(([obj]) => obj));
}

function decisions(layout: Map<number, PageLayoutFacts>, evidence: PageImageEvidence[] | null, pages: TruthPage[]) {
  const surface = buildAdaptiveRoutingDecisionSurface({
    documentId: "doc", filename: "parity.pdf", text: pages.map((p) => p.text).join("\f"), pageCount: pages.length, routingV2: true,
    evidence: { source: "page-image-evidence", artifactUri: "s3://parity" },
    pageLayout: layout, ...(evidence ? { pageImageEvidence: new Map(evidence.map((e) => [e.pageNumber, e])) } : {}),
  });
  return surface.pages.map((entry, i) => ({ page: pages[i]!.name, route: entry.route, ocr: entry.ocrDecision, signals: entry.signals }));
}

function factsDocument(pages: TruthPage[], vectors: (truth: TruthPage) => Record<string, unknown> = () => ({})) {
  return parse(jsonl([docLine({ pageCount: pages.length }), ...pages.map((t, i) => factsLine(t, i + 1, vectors(t))), runLine({ pagesEmitted: pages.length })]), pages.length);
}

/**
 * Synthetic parity: both sides are built from one description of each page, so this checks that the mapping feeds every
 * routing consumer the walker feeds, the same way. Whether Doppler's counts equal the walker's on real PDFs is Doppler's
 * own parity test (test_walker_parity.py, 0 known-and-wrong pages); the contract is what makes this description honest.
 */
describe("decision parity: #44 facts route like the walker, ruled tables included", () => {
  const repeated = walkerRepeated(TRUTH);
  const walker = new Map(TRUTH.map((t, i) => [i + 1, walkerLayout(t, repeated)]));
  const fromWalker = decisions(walker, probeEvidence(TRUTH), TRUTH);

  it("makes the same decisions as the walker except where only coverage decides, and is never looser there", () => {
    const facts = factsDocument(TRUTH);
    const mapped = pageLayoutFactsFromDopplerFacts(facts);
    const factsEvidence = pageImageEvidenceFromDopplerFacts({ facts, pageCount: TRUTH.length, pageTexts: TRUTH.map((t) => t.text) });
    // The layout itself: grids and table coverage are the walker's on every page.
    TRUTH.forEach((t, i) => {
      expect(mapped.get(i + 1)!.grids?.map((g) => [g.rows, g.columns]), t.name).toEqual(walker.get(i + 1)!.grids!.map((g) => [g.rows, g.columns]));
      // Table coverage is known only without walker grids (0); with them it is unknown (Doppler's boxes are not the walker's).
      expect(mapped.get(i + 1)!.tableCoverage, t.name).toBe(t.walker.length === 0 ? 0 : null);
      expect(mapped.get(i + 1)!.images?.map((im) => im.wordsInside), t.name).toEqual(walker.get(i + 1)!.images!.map((im) => im.wordsInside));
    });
    const fromFacts = decisions(mapped, factsEvidence, TRUTH);
    // Coverage-only table pages: the walker's grids cover 40% of the page with fewer than 5 rows each. Facts miss them.
    const coverageOnly = new Set(["large two-row grid (coverage)", "two ruled tables, neither heavy alone"]);
    const same = (list: typeof fromFacts) => list.filter((d) => !coverageOnly.has(d.page));
    expect(same(fromFacts)).toEqual(same(fromWalker));
    fromFacts.forEach((d, i) => {
      if (d.route === "table-heavy") expect(fromWalker[i]!.route, d.page).toBe("table-heavy");
      if (d.ocr?.authorized) expect(fromWalker[i]!.ocr?.authorized, d.page).toBe(true);
    });
    for (const name of coverageOnly) expect(fromFacts.find((d) => d.page === name)!.route, name).not.toBe("table-heavy");

    // The comparison is not vacuous: the decisions the new fields feed fire both ways.
    const byName = Object.fromEntries(fromWalker.map((d) => [d.page, d]));
    for (const name of ["ruled table flattened to prose (rows)", "large two-row grid (coverage)", "two ruled tables, neither heavy alone", "table ruled cell by cell", "Markdown table"]) {
      expect(byName[name]!.route, name).toBe("table-heavy");
    }
    for (const name of ["small grid", "zebra table with column lines", "underlines and ticks the search grouped", "lined paper (one column)", "prose"]) {
      expect(byName[name]!.route, name).not.toBe("table-heavy");
    }
    for (const name of ["mixed scan: bilevel figure beside text", "mixed scan: low-bpp DCT scan beside text", "scan with one word over it", "sparse full-page scan"]) {
      expect(byName[name]!.ocr?.authorized, name).toBe(true);
    }
    for (const name of ["photo beside text", "scan with a caption over it", "labels overrunning a bilevel figure", "prose", "blank"]) {
      expect(byName[name]!.ocr?.authorized ?? false, name).toBe(false);
    }
  });

  it("where the contract leaves grids unknown, facts are never looser than the walker", () => {
    for (const vectors of [{ unlistedRuledGrids: 1 }, { gridsTruncated: true }]) {
      const facts = factsDocument(TRUTH, () => vectors);
      const fromFacts = decisions(pageLayoutFactsFromDopplerFacts(facts), pageImageEvidenceFromDopplerFacts({ facts, pageCount: TRUTH.length, pageTexts: TRUTH.map((t) => t.text) }), TRUTH);
      fromFacts.forEach((d, i) => {
        if (d.route === "table-heavy") expect(fromWalker[i]!.route, d.page).toBe("table-heavy");
        if (d.ocr?.authorized) expect(fromWalker[i]!.ocr?.authorized, d.page).toBe(true);
      });
      // A drawn table flattened to prose is missed, never invented.
      const ruledPage = TRUTH.findIndex((t) => t.name.startsWith("ruled table"));
      expect(fromFacts[ruledPage]!.route, JSON.stringify(vectors)).not.toBe("table-heavy");
    }
  });

  it("xref-repaired pages fall back to unknown grids, never a table route the walker would not take", () => {
    const lines = TRUTH.map((t, i) => ({ ...factsLine(t, i + 1), parseWarnings: ["xref-repaired"] }));
    const facts = parse(jsonl([docLine({ pageCount: TRUTH.length }), ...lines, runLine({ pagesEmitted: TRUTH.length })]), TRUTH.length);
    const mapped = pageLayoutFactsFromDopplerFacts(facts);
    // Every page's grids are unknown, the page-level rule proof's included (the contract's condition).
    TRUTH.forEach((t, i) => expect(mapped.get(i + 1)!.grids, t.name).toBeNull());
    decisions(mapped, null, TRUTH).forEach((d, i) => {
      if (d.route === "table-heavy") expect(fromWalker[i]!.route, d.page).toBe("table-heavy");
    });
  });
});

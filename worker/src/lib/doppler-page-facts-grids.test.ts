/**
 * Doppler page facts' ruled grids, words inside images and bytes per pixel (added within doppler-page-facts/1): the strict
 * reader, the layout mapping, and parity with the layout walker's routing decisions on synthetic pages.
 */
import { describe, expect, it } from "vitest";

import { parseDopplerPageFacts, type DopplerPageFactsDocument } from "./doppler-page-facts.js";
import { pageLayoutFactsFromDopplerFacts, rasterUnionCoverage } from "./doppler-page-facts-layout.js";
import { dopplerFactsCoverEvidence, pageImageEvidenceFromDopplerFacts } from "./doppler-page-facts-evidence.js";
import { buildPageImageEvidence, findSparsePages, summarizeImageListing, type PageImageEvidence } from "./page-image-evidence.js";
import type { PageLayoutFacts } from "./page-layout-facts.js";
import { buildAdaptiveRoutingDecisionSurface } from "../stages/classify-route.js";
import { SCHEMA, docLine, jsonl, runLine, textPage } from "../test/doppler-page-facts-fixture.js";

function parse(input: unknown, pageCount = 1): DopplerPageFactsDocument {
  const result = parseDopplerPageFacts(input, { pageCount });
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.facts;
}

const base = textPage(1);
const vectors = base.vectors as Record<string, unknown>;
const images = base.images as Record<string, unknown>;
const item = (images.items as Array<Record<string, unknown>>)[0]!;

/** One page (612 x 792) with the given vectors and image item overrides. */
function page(over: { vectors?: Record<string, unknown>; item?: Record<string, unknown>; extra?: Record<string, unknown> } = {}): Record<string, unknown> {
  return textPage(1, {
    vectors: { ...vectors, ...over.vectors },
    images: { ...images, items: [{ ...item, ...over.item }] },
    ...over.extra,
  });
}
const one = (line: Record<string, unknown>) => parse(jsonl([docLine({ pageCount: 1 }), line, runLine({ pagesEmitted: 1 })]));
const layoutOf = (line: Record<string, unknown>) => pageLayoutFactsFromDopplerFacts(one(line)).get(1)!;

const TABLE = { bbox: [72, 100, 540, 400], rows: 6, columns: 4, coverage: 0.29 };

describe("doppler page facts: ruled grids", () => {
  it("golden: maps grids to PageTables with their coverage, and tableCoverage to the union of their boxes", () => {
    const second = { bbox: [72, 500, 300, 700], rows: 2, columns: 3, coverage: 0.09 };
    const layout = layoutOf(page({ vectors: { grids: [TABLE, second], gridsTruncated: false } }));
    // The coverage is measured from the box on the walker's 200 x 200 raster, not taken from the guest.
    expect(layout.grids).toEqual([{ rows: 6, columns: 4, coverage: 0.2964 }, { rows: 2, columns: 3, coverage: 0.0969 }]);
    expect(layout.tableCoverage).toBe(0.3933);
    // Overlapping grids count once.
    expect(layoutOf(page({ vectors: { grids: [TABLE, TABLE], gridsTruncated: false } })).tableCoverage).toBe(0.2964);
  });

  it("golden: an empty, complete list proves there is no grid", () => {
    const layout = layoutOf(page({ vectors: { grids: [], gridsTruncated: false } }));
    expect(layout.grids).toEqual([]);
    expect(layout.tableCoverage).toBe(0);
  });

  it("drops one-column grids (parallel rules: weak evidence, below the walker's minimum grid)", () => {
    const lined = { bbox: [72, 72, 540, 720], rows: 30, columns: 1, coverage: 0.8 };
    const layout = layoutOf(page({ vectors: { grids: [lined, TABLE], gridsTruncated: false } }));
    expect(layout.grids).toEqual([{ rows: 6, columns: 4, coverage: 0.2964 }]);
    expect(layout.tableCoverage).toBe(0.2964);
  });

  it("truncation gives unknown, never []", () => {
    for (const grids of [[], [TABLE]]) {
      const layout = layoutOf(page({ vectors: { hRules: 0, vRules: 0, grids, gridsTruncated: true } }));
      expect(layout.grids).toBeNull();
      expect(layout.tableCoverage).toBeNull();
    }
    // The flag alone (grouping cut short) is unknown too.
    expect(layoutOf(page({ vectors: { hRules: 0, gridsTruncated: true } })).grids).toBeNull();
    // At the drawing cap.
    expect(layoutOf(page({ vectors: { grids: [], gridsTruncated: false, limitHit: true } })).grids).toBeNull();
  });

  it("absent (an older build) gives unknown, unless the rule counts prove there is no grid", () => {
    const known = layoutOf(page());
    expect(known.grids).toBeNull();
    expect(known.tableCoverage).toBeNull();
    expect(layoutOf(page({ vectors: { hRules: 1 } })).grids).toEqual([]);
    expect(layoutOf(page({ vectors: { hRules: 1 } })).tableCoverage).toBeNull();
    const { vectors: _v, ...noVectors } = page();
    expect(layoutOf(noVectors).grids).toBeNull();
  });

  it("leaves grids unknown on a page whose CropBox differs from its MediaBox (the boxes are in MediaBox space)", () => {
    const geometry = { widthPt: 500, heightPt: 700, rotation: 0, userUnit: 1, mediaBox: [0, 0, 612, 792], cropBox: [50, 50, 550, 750] };
    const layout = layoutOf(page({ vectors: { grids: [TABLE], gridsTruncated: false }, extra: { geometry } }));
    expect(layout.grids).toBeNull();
    expect(layout.tableCoverage).toBeNull();
  });

  it("hostile: a bad list, a grid off the page, or a list without its flag makes vectors unknown", () => {
    const hostile: Array<[string, Record<string, unknown>]> = [
      ["NaN rows", { grids: [{ ...TABLE, rows: Number.NaN }], gridsTruncated: false }],
      ["negative columns", { grids: [{ ...TABLE, columns: -2 }], gridsTruncated: false }],
      ["zero rows", { grids: [{ ...TABLE, rows: 0 }], gridsTruncated: false }],
      ["fractional rows", { grids: [{ ...TABLE, rows: 2.5 }], gridsTruncated: false }],
      ["huge rows", { grids: [{ ...TABLE, rows: 1e9 }], gridsTruncated: false }],
      ["coverage over 1", { grids: [{ ...TABLE, coverage: 1.5 }], gridsTruncated: false }],
      ["string bbox", { grids: [{ ...TABLE, bbox: "0 0 1 1" }], gridsTruncated: false }],
      ["bbox off the right", { grids: [{ ...TABLE, bbox: [72, 100, 614, 400] }], gridsTruncated: false }],
      ["bbox off the top", { grids: [{ ...TABLE, bbox: [72, -2, 540, 400] }], gridsTruncated: false }],
      ["bbox inverted", { grids: [{ ...TABLE, bbox: [540, 100, 72, 400] }], gridsTruncated: false }],
      ["bbox far away", { grids: [{ ...TABLE, bbox: [1e8, 1e8, 1e8 + 10, 1e8 + 10] }], gridsTruncated: false }],
      ["65 grids", { grids: Array.from({ length: 65 }, () => TABLE), gridsTruncated: false }],
      ["not a list", { grids: { 0: TABLE }, gridsTruncated: false }],
      ["no flag", { grids: [TABLE] }],
      ["string flag", { grids: [TABLE], gridsTruncated: "false" }],
    ];
    for (const [name, over] of hostile) {
      const facts = one(page({ vectors: over }));
      expect(facts.pages.get(1)!.vectors, name).toBeUndefined();
      expect(pageLayoutFactsFromDopplerFacts(facts).get(1)!.grids, name).toBeNull();
    }
    // Within the 1 pt slack the box stands; the coverage is clipped to the page.
    const edge = layoutOf(page({ vectors: { grids: [{ ...TABLE, bbox: [-1, -1, 613, 793] }], gridsTruncated: false } }));
    expect(edge.grids).toEqual([{ rows: 6, columns: 4, coverage: 1 }]);
    // Without a geometry there is no page to bound a box by.
    const { geometry: _g, ...noGeometry } = page({ vectors: { grids: [TABLE], gridsTruncated: false } });
    expect(one(noGeometry).pages.get(1)!.vectors).toBeUndefined();
    // On a rotated page the box is bounded by the rotated MediaBox.
    const rotated = { widthPt: 792, heightPt: 612, rotation: 90, userUnit: 1 };
    expect(one(page({ vectors: { grids: [{ ...TABLE, bbox: [72, 100, 780, 600] }], gridsTruncated: false }, extra: { geometry: rotated } })).pages.get(1)!.vectors?.grids).toHaveLength(1);
    expect(one(page({ vectors: { grids: [{ ...TABLE, bbox: [72, 100, 600, 780] }], gridsTruncated: false }, extra: { geometry: rotated } })).pages.get(1)!.vectors).toBeUndefined();
  });

  it("round-trips through the canonical lines", async () => {
    const { dopplerPageFactsJsonl } = await import("./doppler-page-facts.js");
    const facts = one(page({ vectors: { grids: [TABLE], gridsTruncated: false }, item: { visibleWordsInside: 1, invisibleWordsInside: 0, bytesPerPixel: 0.05 } }));
    expect(parse(dopplerPageFactsJsonl(facts)).pages).toEqual(facts.pages);
  });

  it("measures the union on the walker's raster in bounded work for many overlapping boxes", () => {
    const boxes = Array.from({ length: 64 }, (_, i) => [i * 5, i * 7, i * 5 + 300, i * 7 + 200] as [number, number, number, number]);
    const started = performance.now();
    for (let i = 0; i < 2_000; i += 1) rasterUnionCoverage(boxes, 612, 792);
    // About 0.1 ms a page of 64 overlapping grids; the bound leaves room for a loaded CI host.
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(rasterUnionCoverage([[0, 0, 612, 792]], 612, 792)).toBe(1);
    expect(rasterUnionCoverage([], 612, 792)).toBe(0);
    // The walker's own values (pdf_layout_facts.py union_coverage), ties rounded half to even as Python does.
    expect(rasterUnionCoverage([[0, 0, 25, 50]], 200, 200)).toBe(0.0312);
    expect(rasterUnionCoverage([[0, 0, 75, 50]], 200, 200)).toBe(0.0938);
    // Two boxes side by side and one inside them: 0.5 of the page.
    expect(rasterUnionCoverage([[0, 0, 306, 396], [306, 0, 612, 396], [10, 10, 20, 20]], 612, 792)).toBe(0.5);
  });
});

describe("doppler page facts: words inside and bytes per pixel", () => {
  it("golden: wordsInside is visible + invisible; bytesPerPixel one to one", () => {
    const image = layoutOf(page({ item: { visibleWordsInside: 3, invisibleWordsInside: 0, bytesPerPixel: 0.123456 } })).images![0]!;
    expect(image.wordsInside).toBe(3);
    expect(image.bytesPerPixel).toBe(0.123456);
    const scan = layoutOf(textPage(1, {
      text: { ...(base.text as object), visibleWordCount: 10, invisibleWordCount: 400, textLayer: "mixed" },
      images: { ...images, items: [{ ...item, visibleWordsInside: 2, invisibleWordsInside: 395, bytesPerPixel: 0 }] },
    })).images![0]!;
    expect(scan.wordsInside).toBe(397);
    // A real 0 stays 0: only absence is unknown.
    expect(scan.bytesPerPixel).toBe(0);
  });

  it("whole-box counts stand only when the page's centre-based text over images agrees (the walker counts centres)", () => {
    const text = base.text as Record<string, unknown>;
    const at = (ratio: number | undefined, inside: number) => {
      const t = { ...text };
      if (ratio === undefined) delete t.textOverImageRatio; else t.textOverImageRatio = ratio;
      return layoutOf(textPage(1, { text: t, images: { ...images, items: [{ ...item, visibleWordsInside: inside, invisibleWordsInside: 0 }] } })).images![0]!.wordsInside;
    };
    // 410 words, 2400 characters: about 5.85 characters a word.
    expect(at(0, 0)).toBe(0);
    expect(at(5.85 / 2400, 0)).toBe(0);             // one word's worth over images: within the allowance
    expect(at(3 * 5.86 / 2400, 0)).toBeNull();      // three words over images, none counted inside: a straddling label
    expect(at(3 * 5.86 / 2400, 3)).toBe(3);
    expect(at(undefined, 0)).toBeNull();            // no ratio (no oddtext family): unknown
  });

  it("absent gives unknown (null), never 0", () => {
    const image = layoutOf(page()).images![0]!;
    expect(image.wordsInside).toBeNull();
    expect(image.bytesPerPixel).toBeNull();
    // One of the pair alone is no count.
    expect(layoutOf(page({ item: { visibleWordsInside: 3 } })).images![0]!.wordsInside).toBeNull();
    expect(layoutOf(page({ item: { invisibleWordsInside: 3 } })).images![0]!.wordsInside).toBeNull();
  });

  it("truncation leaves the whole image list unknown", () => {
    const layout = layoutOf(page({ item: { visibleWordsInside: 0, invisibleWordsInside: 0, bytesPerPixel: 0.01 }, extra: {} }));
    expect(layout.images).toHaveLength(1);
    const truncated = layoutOf(textPage(1, { images: { ...images, itemsTruncated: true, items: [{ ...item, visibleWordsInside: 0, invisibleWordsInside: 0, bytesPerPixel: 0.01 }] } }));
    expect(truncated.images).toBeNull();
  });

  it("hostile: NaN, negative, fractional or contradicting values are unknown; an oversized list is unknown", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["NaN bpp", { bytesPerPixel: Number.NaN }], ["negative bpp", { bytesPerPixel: -0.1 }], ["huge bpp", { bytesPerPixel: 1e12 }],
      ["string bpp", { bytesPerPixel: "0.01" }], ["inline bpp", { inline: true, bytesPerPixel: 0.01 }],
    ];
    for (const [name, over] of cases) expect(layoutOf(page({ item: over })).images![0]!.bytesPerPixel, name).toBeNull();
    const words: Array<[string, Record<string, unknown>]> = [
      ["negative", { visibleWordsInside: -1, invisibleWordsInside: 0 }], ["fractional", { visibleWordsInside: 1.5, invisibleWordsInside: 0 }],
      ["NaN", { visibleWordsInside: Number.NaN, invisibleWordsInside: 0 }],
      ["more visible than the page", { visibleWordsInside: 411, invisibleWordsInside: 0 }],
      ["more invisible than the page", { visibleWordsInside: 0, invisibleWordsInside: 1 }],
    ];
    for (const [name, over] of words) expect(layoutOf(page({ item: over })).images![0]!.wordsInside, name).toBeNull();
    // Without the text family the counts cannot be bounded: unknown.
    const { text: _t, ...noText } = page({ item: { visibleWordsInside: 0, invisibleWordsInside: 0 } });
    expect(one(noText).pages.get(1)!.images!.items![0]!.visibleWordsInside).toBeUndefined();
    // 33 items: the list is unknown.
    const many = textPage(1, { images: { ...images, imageCount: 33, items: Array.from({ length: 33 }, (_, i) => ({ ...item, index: i + 1, bytesPerPixel: 0.01 })) } });
    expect(layoutOf(many).images).toBeNull();
  });

  it("xref-repaired-earlier: px, dpi, bytesPerPixel, words inside and grids are unknown, so none can select a read", () => {
    const scanLike = { visibleWordsInside: 0, invisibleWordsInside: 0, bytesPerPixel: 0.02, bbox: [72, 300, 540, 700], coverage: 0.39, px: [1950, 1667], dpi: [300, 300], filter: "dct" };
    const vectorsWithGrid = { grids: [TABLE], gridsTruncated: false };
    const ok = layoutOf(page({ item: scanLike, vectors: vectorsWithGrid }));
    expect([ok.images![0]!.widthPx, ok.images![0]!.heightPx, ok.images![0]!.ppi, ok.images![0]!.bytesPerPixel, ok.images![0]!.wordsInside]).toEqual([1950, 1667, [300, 300], 0.02, 0]);
    expect(ok.grids).toHaveLength(1);
    const low = layoutOf(page({ item: scanLike, vectors: vectorsWithGrid, extra: { parseWarnings: ["xref-repaired-earlier"] } }));
    const image = low.images![0]!;
    expect([image.widthPx, image.heightPx, image.ppi, image.bytesPerPixel, image.wordsInside]).toEqual([0, 0, [null, null], null, null]);
    expect(low.grids).toBeNull();
    expect(low.tableCoverage).toBeNull();
    // An unknown warning value is still dropped, as the contract asks.
    expect(one(page({ extra: { parseWarnings: ["xref-repaired-earlier", "from-the-future"] } })).pages.get(1)!.parseWarnings).toEqual(["xref-repaired-earlier"]);
  });

  it("xref-repaired-earlier on any page: no page-image evidence for the document (its furniture rule is shared)", () => {
    const scan = (warnings: string[]) => jsonl([docLine({ pageCount: 1 }), textPage(1, {
      text: { ...(base.text as object), charCount: 0, visibleCharCount: 0, wordCount: 0, visibleWordCount: 0, textLayer: "none" },
      images: { ...images, items: [{ ...item, bbox: [0, 0, 612, 792], coverage: 1, px: [2550, 3300], obj: 9 }] },
      parseWarnings: warnings,
    }), runLine({ pagesEmitted: 1 })]);
    const known = pageImageEvidenceFromDopplerFacts({ facts: parse(scan([])), pageCount: 1, pageTexts: [""] })!;
    expect(known[0]).toMatchObject({ imagesKnown: true, imageCount: 1, largestImageCoverage: 1 });
    expect(dopplerFactsCoverEvidence(parse(scan(["xref-repaired-earlier"])), 1)).toEqual({ covered: false, reason: "xref-repaired-earlier" });
    expect(pageImageEvidenceFromDopplerFacts({ facts: parse(scan(["xref-repaired-earlier"])), pageCount: 1, pageTexts: [""] })).toBeNull();
    // Without evidence classify-route reads the sparse page as unknown: no read.
    const surface = (evidence: PageImageEvidence[] | null) => buildAdaptiveRoutingDecisionSurface({
      documentId: "d", filename: "f.pdf", text: "", pageCount: 1, routingV2: true,
      evidence: { source: "page-image-evidence", artifactUri: "s3://x" },
      ...(evidence ? { pageImageEvidence: new Map(evidence.map((e) => [e.pageNumber, e])) } : {}),
    });
    expect(surface(known).pages[0]!.ocrDecision?.authorized).toBe(true);
    expect(surface(null).pages[0]?.ocrDecision?.authorized ?? false).toBe(false);
  });

  it("per grid, the page's rules must allow it: shaded panels or sideless column lines larger than the rules are dropped", () => {
    // 8 horizontal and 5 vertical rules on the page: a 6 x 4 table fits; 8 shaded panel bands with 2 columns do not.
    const panels = { bbox: [72, 420, 540, 760], rows: 8, columns: 2, coverage: 0.3 };
    const layout = layoutOf(page({ vectors: { grids: [TABLE, panels], gridsTruncated: false } }));
    expect(layout.grids).toEqual([{ rows: 6, columns: 4, coverage: 0.2964 }]);
    const wide = { ...TABLE, columns: 5 };
    expect(layoutOf(page({ vectors: { grids: [wide], gridsTruncated: false } })).grids).toEqual([]);
  });
});

// ── Parity: the same synthetic page, measured by the walker (and the pdfimages probe) and by Doppler's facts ──

interface TruthImage {
  bbox: [number, number, number, number];
  px: [number, number];
  ppi: number;
  filter: "dct" | "ccitt" | "jbig2" | "flate";
  bpc: number;
  colorSpace: "gray" | "rgb";
  streamBytes: number;
  obj: number;
  /** Words whose centre is inside (the walker's count). */
  wordsInside: number;
  /** Words whose whole box is inside (Doppler's count), when it differs: a label straddling the edge. */
  wholeWordsInside?: number;
}
interface TruthPage {
  name: string;
  words: number;
  invisibleWords?: number;
  images: TruthImage[];
  /** Ruled grids: rows, columns and box. Columns 1 is Doppler-only (the walker never finds one). */
  grids: Array<{ bbox: [number, number, number, number]; rows: number; columns: number }>;
  /** What Doppler's own search reports instead, when it differs from the walker's (shaded boxes, sideless column lines). */
  doppler?: { grids: TruthPage["grids"]; hRules: number; vRules: number };
  text: string;
}

const W = 612, H = 792;
const prose = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 97}`).join(" ");
const logo: TruthImage = { bbox: [36, 36, 108, 72], px: [300, 150], ppi: 300, filter: "flate", bpc: 8, colorSpace: "rgb", streamBytes: 9000, obj: 42, wordsInside: 0 };
/** A placed image's box from its pixels and ppi (the probe's coverage rule reads it the same way). */
const placed = (x: number, y: number, px: [number, number], ppi: number): [number, number, number, number] => [x, y, x + px[0] / ppi * 72, y + px[1] / ppi * 72];

const TRUTH: TruthPage[] = [
  { name: "prose", words: 420, images: [logo], grids: [], text: prose(420) },
  { name: "ruled table flattened to prose (rows)", words: 300, images: [logo], grids: [{ bbox: [72, 120, 540, 420], rows: 8, columns: 4 }], text: prose(300) },
  { name: "large two-row grid (coverage)", words: 260, images: [logo], grids: [{ bbox: [36, 100, 576, 700], rows: 2, columns: 3 }], text: prose(260) },
  { name: "small grid", words: 260, images: [logo], grids: [{ bbox: [72, 120, 300, 200], rows: 2, columns: 2 }], text: prose(260) },
  { name: "lined paper (one column)", words: 220, images: [logo], grids: [{ bbox: [72, 72, 540, 720], rows: 30, columns: 1 }], text: prose(220) },
  { name: "Markdown table", words: 200, images: [logo], grids: [], text: `${prose(150)}\n\n| a | b |\n|---|---|\n${Array.from({ length: 6 }, (_, i) => `| ${i} | x |`).join("\n")}` },
  {
    name: "mixed scan: bilevel figure beside text", words: 240, grids: [], text: prose(240),
    images: [logo, { bbox: placed(72, 300, [1950, 1250], 300), px: [1950, 1250], ppi: 300, filter: "ccitt", bpc: 1, colorSpace: "gray", streamBytes: 40_000, obj: 50, wordsInside: 0 }],
  },
  {
    name: "mixed scan: low-bpp DCT scan beside text", words: 240, grids: [], text: prose(240),
    images: [logo, { bbox: placed(72, 300, [1950, 1250], 300), px: [1950, 1250], ppi: 300, filter: "dct", bpc: 8, colorSpace: "gray", streamBytes: 243_750, obj: 51, wordsInside: 1 }],
  },
  {
    name: "photo beside text", words: 240, grids: [], text: prose(240),
    images: [logo, { bbox: placed(72, 300, [1950, 1250], 300), px: [1950, 1250], ppi: 300, filter: "dct", bpc: 8, colorSpace: "rgb", streamBytes: 1_200_000, obj: 52, wordsInside: 0 }],
  },
  {
    name: "scan with a caption over it", words: 240, grids: [], text: prose(240),
    images: [logo, { bbox: placed(72, 300, [1950, 1250], 300), px: [1950, 1250], ppi: 300, filter: "ccitt", bpc: 1, colorSpace: "gray", streamBytes: 40_000, obj: 53, wordsInside: 12 }],
  },
  {
    name: "sparse full-page scan", words: 0, grids: [], text: "",
    images: [logo, { bbox: [0, 0, W, H], px: [2550, 3300], ppi: 300, filter: "ccitt", bpc: 1, colorSpace: "gray", streamBytes: 90_000, obj: 60, wordsInside: 0 }],
  },
  {
    name: "OCR'd scan (invisible layer)", words: 300, invisibleWords: 300, grids: [], text: prose(300),
    images: [{ bbox: [0, 0, W, H], px: [2550, 3300], ppi: 300, filter: "ccitt", bpc: 1, colorSpace: "gray", streamBytes: 90_000, obj: 61, wordsInside: 300 }],
  },
  {
    name: "two-column page with a centre divider", words: 400, images: [logo], grids: [], text: prose(400),
    doppler: { grids: [{ bbox: [36, 72, 576, 720], rows: 3, columns: 2 }], hRules: 4, vRules: 1 },
  },
  {
    name: "labels overrunning a bilevel figure", words: 240, grids: [], text: prose(240),
    images: [logo, { bbox: placed(72, 300, [1950, 1250], 300), px: [1950, 1250], ppi: 300, filter: "ccitt", bpc: 1, colorSpace: "gray", streamBytes: 40_000, obj: 54, wordsInside: 3, wholeWordsInside: 0 }],
  },
  { name: "blank", words: 0, images: [], grids: [], text: "" },
  { name: "sparse page with a logo only", words: 6, images: [logo], grids: [], text: prose(6) },
];

/** What the walker writes for a page (pdf_layout_facts.py layout_facts, with no Markdown table box matched). */
function walkerLayout(truth: TruthPage, repeated: Set<number>): PageLayoutFacts {
  const encoding = { dct: "jpeg", ccitt: "ccitt", jbig2: "jbig2", flate: "image" } as const;
  const grids = truth.grids.filter((g) => g.columns >= 2);
  return {
    images: truth.images.map((image) => ({
      bbox: image.bbox, coverage: Math.round(((image.bbox[2] - image.bbox[0]) * (image.bbox[3] - image.bbox[1])) / (W * H) * 10_000) / 10_000,
      widthPx: image.px[0], heightPx: image.px[1], bitsPerComponent: image.bpc, colorSpace: image.colorSpace, encoding: encoding[image.filter],
      ppi: [image.ppi, image.ppi], bytesPerPixel: Math.round(image.streamBytes / (image.px[0] * image.px[1]) * 1e5) / 1e5,
      repeated: repeated.has(image.obj), wordsInside: image.wordsInside,
    })),
    tables: null,
    words: truth.words,
    grids: grids.map((g) => ({ rows: g.rows, columns: g.columns, coverage: rasterUnionCoverage([g.bbox], W, H) })),
    tableCoverage: rasterUnionCoverage(grids.map((g) => g.bbox), W, H),
    widthPt: W, heightPt: H, invisibleWords: truth.invisibleWords ?? 0,
    textLayer: truth.words === 0 ? "none" : truth.invisibleWords === truth.words ? "invisible" : truth.invisibleWords ? "mixed" : "visible",
  };
}

/** The same page as Doppler's facts line. */
function factsLine(truth: TruthPage, n: number, warnings: string[] = []): Record<string, unknown> {
  const invisible = truth.invisibleWords ?? 0;
  const visible = truth.words - invisible;
  const layer = truth.words === 0 ? "none" : invisible === 0 ? "visible" : visible === 0 ? "invisible" : "mixed";
  const area = (b: number[]) => ((b[2]! - b[0]!) * (b[3]! - b[1]!)) / (W * H);
  return {
    schema: SCHEMA, type: "page", page: n,
    geometry: { widthPt: W, heightPt: H, rotation: 0, userUnit: 1 },
    text: {
      charCount: truth.words * 6, visibleCharCount: visible * 6, invisibleCharCount: invisible * 6, wordCount: truth.words,
      visibleWordCount: visible, invisibleWordCount: invisible, textLayer: layer, textCoverage: 0.3,
      // Characters by centre over images: every centre-inside word, 6 characters each.
      textOverImageRatio: truth.words === 0 ? 0 : Math.min(1, truth.images.reduce((sum, i) => sum + i.wordsInside, 0) / truth.words),
    },
    images: {
      imageCount: truth.images.length, imageCoverage: Math.min(1, truth.images.reduce((s, i) => s + area(i.bbox), 0)),
      largestImageCoverage: Math.max(0, ...truth.images.map((i) => area(i.bbox))), fullPageImage: truth.images.some((i) => area(i.bbox) >= 0.85),
      scan: "none", truncated: false, itemsTruncated: false,
      items: truth.images.map((image, i) => ({
        index: i + 1, bbox: image.bbox, coverage: Math.round(area(image.bbox) * 4096) / 4096, px: image.px, dpi: [image.ppi, image.ppi],
        filter: image.filter, bpc: image.bpc, colorSpace: image.colorSpace, imageMask: false, softMask: false, mask: false, decode: false,
        inline: false, obj: image.obj, copy: "decode",
        visibleWordsInside: Math.min(image.wholeWordsInside ?? image.wordsInside, visible),
        invisibleWordsInside: Math.max(0, (image.wholeWordsInside ?? image.wordsInside) - visible),
        bytesPerPixel: Math.round(image.streamBytes / (image.px[0] * image.px[1]) * 1e6) / 1e6,
      })),
    },
    vectors: {
      paths: 40, filled: 0, stroked: 40, coverage: 0.2,
      hRules: truth.doppler?.hRules ?? truth.grids.reduce((s, g) => s + g.rows + 1, 0),
      vRules: truth.doppler?.vRules ?? truth.grids.reduce((s, g) => s + (g.columns > 1 ? g.columns + 1 : 0), 0), ruleGridScore: truth.grids.length ? 1 : 0,
      shadings: 0, patterns: 0, clips: 0, figureClusters: 0, clusters: [], clustersTruncated: false, limitHit: false,
      grids: (truth.doppler?.grids ?? truth.grids).map((g) => ({ ...g, coverage: Math.round(area(g.bbox) * 10_000) / 10_000 })), gridsTruncated: false,
    },
    parseWarnings: warnings, unusualFeatures: [],
  };
}

/** The pdfimages probe's evidence for the sparse pages, from the listing the same pages give. */
function probeEvidence(pages: TruthPage[]): PageImageEvidence[] {
  const rows = pages.flatMap((truth, i) => truth.images.map((image) =>
    `${i + 1} 0 image ${image.px[0]} ${image.px[1]} ${image.colorSpace} 1 ${image.bpc} ${image.filter === "dct" ? "jpeg" : image.filter === "flate" ? "image" : image.filter} no ${image.obj} 0 ${image.ppi} ${image.ppi} 10K 1%`));
  const listing = summarizeImageListing(["page num type", "----", ...rows].join("\n"), {
    pageAreas: new Map(pages.map((_, i) => [i + 1, W * H])), pagesInScope: pages.length,
  });
  return buildPageImageEvidence({ sparsePages: findSparsePages(pages.map((p) => p.text)), listing });
}

/** Furniture as the walker finds it: objects on at least max(3, 20%) of the pages. */
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

/**
 * Synthetic parity: both sides are built from one description of each page, so this checks that the mapping feeds every
 * routing consumer the walker feeds, the same way, including where Doppler's own measures differ (TruthPage.doppler,
 * wholeWordsInside). It does not measure how often Doppler and the walker agree on real PDFs: that is a corpus benchmark.
 */
describe("parity: facts-mapped layout routes like the walker's", () => {
  it("makes the same classify-route and page-image decisions on synthetic pages (table-heavy, mixed scan, raster, blank)", () => {
    const facts = parse(jsonl([docLine({ pageCount: TRUTH.length }), ...TRUTH.map((t, i) => factsLine(t, i + 1)), runLine({ pagesEmitted: TRUTH.length })]), TRUTH.length);
    const repeated = walkerRepeated(TRUTH);
    const walker = new Map(TRUTH.map((t, i) => [i + 1, walkerLayout(t, repeated)]));
    const mapped = pageLayoutFactsFromDopplerFacts(facts);
    const factsEvidence = pageImageEvidenceFromDopplerFacts({ facts, pageCount: TRUTH.length, pageTexts: TRUTH.map((t) => t.text) });

    const fromWalker = decisions(walker, probeEvidence(TRUTH), TRUTH);
    const fromFacts = decisions(mapped, factsEvidence, TRUTH);
    expect(fromFacts).toEqual(fromWalker);

    // The synthetic pages exercise every decision the new fields feed (so parity is not vacuous).
    const byName = Object.fromEntries(fromFacts.map((d) => [d.page, d]));
    expect(byName["ruled table flattened to prose (rows)"]!.route).toBe("table-heavy");
    expect(byName["large two-row grid (coverage)"]!.route).toBe("table-heavy");
    expect(byName["small grid"]!.route).not.toBe("table-heavy");
    expect(byName["lined paper (one column)"]!.route).not.toBe("table-heavy");
    expect(byName["Markdown table"]!.route).toBe("table-heavy");
    expect(byName["mixed scan: bilevel figure beside text"]!.ocr?.authorized).toBe(true);
    expect(byName["mixed scan: low-bpp DCT scan beside text"]!.ocr?.authorized).toBe(true);
    expect(byName["photo beside text"]!.ocr?.authorized).toBe(false);
    expect(byName["scan with a caption over it"]!.ocr?.authorized).toBe(false);
    expect(byName["sparse full-page scan"]!.ocr?.authorized).toBe(true);
    expect(byName["prose"]!.ocr?.authorized).toBe(false);
    expect(byName["blank"]!.ocr?.authorized).toBe(false);
    // Where Doppler's own measures differ from the walker's, the mapping falls back so the decision still matches.
    expect(byName["two-column page with a centre divider"]!.route).not.toBe("table-heavy");
    expect(byName["labels overrunning a bilevel figure"]!.ocr?.authorized).toBe(false);
    expect(mapped.get(TRUTH.findIndex((t) => t.name.startsWith("labels overrunning")) + 1)!.images!.every((i) => i.wordsInside === null)).toBe(true);
  });

  it("without the new fields (an older build) facts never fire a mixed-scan read and miss the drawn tables: the gap #42 closes", () => {
    const strip = (line: Record<string, unknown>) => {
      const v = { ...(line.vectors as Record<string, unknown>) };
      delete v.grids; delete v.gridsTruncated;
      const im = line.images as Record<string, unknown>;
      const items = (im.items as Array<Record<string, unknown>>).map(({ visibleWordsInside: _a, invisibleWordsInside: _b, bytesPerPixel: _c, ...rest }) => rest);
      return { ...line, vectors: v, images: { ...im, items } };
    };
    const facts = parse(jsonl([docLine({ pageCount: TRUTH.length }), ...TRUTH.map((t, i) => strip(factsLine(t, i + 1))), runLine({ pagesEmitted: TRUTH.length })]), TRUTH.length);
    const old = decisions(pageLayoutFactsFromDopplerFacts(facts), pageImageEvidenceFromDopplerFacts({ facts, pageCount: TRUTH.length, pageTexts: TRUTH.map((t) => t.text) }), TRUTH);
    const byName = Object.fromEntries(old.map((d) => [d.page, d]));
    expect(byName["mixed scan: bilevel figure beside text"]!.ocr?.authorized).toBe(false);
    expect(byName["ruled table flattened to prose (rows)"]!.route).not.toBe("table-heavy");
  });

  it("xref-repaired-earlier pages fall back to unknown and never authorize a read the walker would", () => {
    const lines = TRUTH.map((t, i) => factsLine(t, i + 1, ["xref-repaired-earlier"]));
    const facts = parse(jsonl([docLine({ pageCount: TRUTH.length }), ...lines, runLine({ pagesEmitted: TRUTH.length })]), TRUTH.length);
    const low = decisions(pageLayoutFactsFromDopplerFacts(facts), pageImageEvidenceFromDopplerFacts({ facts, pageCount: TRUTH.length, pageTexts: TRUTH.map((t) => t.text) }), TRUTH);
    expect(low.filter((d) => d.ocr?.authorized)).toEqual([]);
  });
});

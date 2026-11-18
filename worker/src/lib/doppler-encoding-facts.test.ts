/**
 * Doppler's math and table encoding facts (`mathtables`): the bit layout (pinned: Doppler's order is an API), the reader's
 * validation of the packed words, what each bit means for routing (unknown is never "no math" or "no table"), the stored
 * form, and evidence routing with DOCSLURP_ENCODING_FACTS_ROUTING on and off.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DOPPLER_ENCODING_COUNTS, DOPPLER_MATH_FLAGS, DOPPLER_TABLE_FLAGS, decodeDopplerEncodingCounts, decodeDopplerFlags, dopplerCountBucket,
  dopplerFlagBit, encodingRouteFromFlags, pageEncodingRoute, parsePageEncodingRoute, type DopplerMathFlag, type DopplerTableFlag,
} from "./doppler-encoding-facts.js";
import { dopplerPageFactsJsonl, dopplerPageFactsRequest, parseDopplerPageFacts, withoutWalkerParityFacts, type DopplerPageFacts } from "./doppler-page-facts.js";
import { pageLayoutFactsFromDopplerPage, routingFactsWithDopplerFacts, withEncodingRoutes } from "./page-evidence-doppler.js";
import { parsePageLayoutFacts, type PageLayoutFacts } from "./page-layout-facts.js";
import { buildRoutingPageFacts } from "../pipeline/page-facts.js";
import { acceptSandboxedPdfResult, sandboxedPdfLayoutFacts, type SandboxedPdfJob } from "../extractors/plugins.js";
import { buildAdaptiveRoutingDecisionSurface, classifyAdaptivePage, encodingReadDecision, encodingReadPageCap, pageReadReason } from "../stages/classify-route.js";
import { docLine, jsonl, runLine, textPage } from "../test/doppler-page-facts-fixture.js";

const word = <T extends string>(names: readonly T[], flags: readonly T[]) => flags.reduce((sum, flag) => sum + dopplerFlagBit(names, flag), 0);
const mathWord = (...flags: DopplerMathFlag[]) => word(DOPPLER_MATH_FLAGS, flags);
const tableWord = (...flags: DopplerTableFlag[]) => word(DOPPLER_TABLE_FLAGS, flags);
/** encodingCounts from nibbles by name. */
function counts(nibbles: Partial<Record<(typeof DOPPLER_ENCODING_COUNTS)[number], number>> = {}): number {
  return DOPPLER_ENCODING_COUNTS.reduce((sum, name, i) => sum + (nibbles[name] ?? 0) * 16 ** i, 0);
}

/** A page line with the three words (and whatever else). */
function encodedPage(n: number, words: { mathBits: number; tableBits: number; encodingCounts: number }, extra: Record<string, unknown> = {}) {
  return textPage(n, { ...words, ...extra });
}
function parsePage(line: Record<string, unknown>, pageCount = 1): DopplerPageFacts | undefined {
  const parsed = parseDopplerPageFacts(jsonl([docLine({ pageCount }), line, runLine({ pagesEmitted: 1 })]), { pageCount });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.facts.pages.get(line.page as number);
}
function route(mathFlags: DopplerMathFlag[], tableFlags: DopplerTableFlag[], mathRead = false, unreadable = 0) {
  return encodingRouteFromFlags(mathFlags, tableFlags, mathRead, unreadable);
}

describe("bit layout (Doppler's order is an API: names are appended, never moved)", () => {
  it("pins every mathBits position", () => {
    expect(DOPPLER_MATH_FLAGS).toEqual([
      "text-math", "stacked-math", "actualtext-tex", "alt-tex", "mathml", "raster-strips", "glyph-outlines", "type3-bitmap-font",
      "math-font-no-unicode", "plain-unicode-math", "formula-struct", "math-matrix", "analysis-truncated",
    ]);
    expect(dopplerFlagBit(DOPPLER_MATH_FLAGS, "text-math")).toBe(1);
    expect(dopplerFlagBit(DOPPLER_MATH_FLAGS, "raster-strips")).toBe(32);
    expect(dopplerFlagBit(DOPPLER_MATH_FLAGS, "math-font-no-unicode")).toBe(256);
    expect(dopplerFlagBit(DOPPLER_MATH_FLAGS, "analysis-truncated")).toBe(4096);
  });

  it("pins every tableBits position", () => {
    expect(DOPPLER_TABLE_FLAGS).toEqual([
      "rule-grid", "hrule-open", "booktabs", "whitespace", "shaded-rows", "tagged-table", "raster-table-like", "outlined-text-grid",
      "math-grid", "analysis-truncated",
    ]);
    expect(dopplerFlagBit(DOPPLER_TABLE_FLAGS, "booktabs")).toBe(4);
    expect(dopplerFlagBit(DOPPLER_TABLE_FLAGS, "raster-table-like")).toBe(64);
    expect(dopplerFlagBit(DOPPLER_TABLE_FLAGS, "math-grid")).toBe(256);
    expect(dopplerFlagBit(DOPPLER_TABLE_FLAGS, "analysis-truncated")).toBe(512);
  });

  it("pins the 13 encodingCounts nibbles", () => {
    expect(DOPPLER_ENCODING_COUNTS).toHaveLength(13);
    expect(DOPPLER_ENCODING_COUNTS.indexOf("mathStrips")).toBe(3);
    expect(DOPPLER_ENCODING_COUNTS.indexOf("glyphOutlineClusters")).toBe(4);
    expect(DOPPLER_ENCODING_COUNTS.indexOf("formulas")).toBe(5);
    expect(DOPPLER_ENCODING_COUNTS.indexOf("ruledGrids")).toBe(8);
    expect(DOPPLER_ENCODING_COUNTS.indexOf("structureTables")).toBe(11);
    expect(DOPPLER_ENCODING_COUNTS.indexOf("mathRegions")).toBe(12);
  });

  it("decodes words, including the 32-bit word's top bit and bits this build does not name", () => {
    expect(decodeDopplerFlags(0, DOPPLER_MATH_FLAGS)).toEqual({ flags: [], unknownBits: 0 });
    expect(decodeDopplerFlags(2307, DOPPLER_MATH_FLAGS).flags).toEqual(["text-math", "stacked-math", "math-font-no-unicode", "math-matrix"]);
    expect(decodeDopplerFlags(2 ** 31 + 1, DOPPLER_TABLE_FLAGS)).toEqual({ flags: ["rule-grid"], unknownBits: 2 ** 31 });
    expect(decodeDopplerFlags(2 ** 13, DOPPLER_MATH_FLAGS)).toEqual({ flags: [], unknownBits: 2 ** 13 });
    // Not a word: unknown, never an empty word.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2 ** 32]) expect(decodeDopplerFlags(bad, DOPPLER_MATH_FLAGS).unknownBits).not.toBe(0);
  });

  it("decodes the log2 buckets of encodingCounts, up to all 52 bits", () => {
    const decoded = decodeDopplerEncodingCounts(0x4010000000206);
    expect(decoded.mathFontChars).toEqual({ bucket: 6, min: 32, max: 63 });
    expect(decoded.unreadableMathGlyphs).toEqual({ bucket: 2, min: 2, max: 3 });
    expect(decoded.whitespaceTables).toEqual({ bucket: 1, min: 1, max: 1 });
    expect(decoded.ruledGrids).toEqual({ bucket: 0, min: 0, max: 0 });
    expect(decoded.mathRegions).toEqual({ bucket: 4, min: 8, max: 15 });
    expect(decoded.mathStrips).toEqual({ bucket: 0, min: 0, max: 0 });
    const all = decodeDopplerEncodingCounts(2 ** 52 - 1);
    expect(Object.values(all).every((b) => b.bucket === 15 && b.min === 2 ** 14 && b.max === null)).toBe(true);
    expect(dopplerCountBucket(15)).toEqual({ bucket: 15, min: 16384, max: null });
    expect(() => decodeDopplerEncodingCounts(2 ** 52)).toThrow();
    expect(() => decodeDopplerEncodingCounts(-1)).toThrow();
  });
});

describe("the reader keeps the words only when they are whole and consistent", () => {
  afterEach(() => vi.restoreAllMocks());
  const booktabs = { mathBits: 0, tableBits: tableWord("booktabs"), encodingCounts: counts({ ruleTables: 1 }) };

  it("reads the cheap form (three integers) and the full level's readable fields", () => {
    const page = parsePage(encodedPage(1, booktabs, {
      mathFlags: [], tableFlags: ["booktabs", "a-name-from-a-newer-build"],
      mathRegions: [{ kind: "text", bbox: [72, 100, 200, 120] }], mathRegionsTruncated: false,
      mathLayout: { readableGlyphs: 0, unreadableGlyphs: 0, stackedRegions: 0, fractionBars: 0, matrixRegions: 0 },
      tableLayout: { ruledGrids: 0, whitespaceTables: 0, shadedRowTables: 0, rasterTableLike: 0, outlinedTextGrids: 0, mathGrids: 0 },
      structure: { formulas: 0, tables: 0, tableRows: 0, tableCells: 0, spannedCells: 0, mathml: 0, mathmlFiles: 0, altText: 0,
        altTextTexLike: 0, actualText: 0, actualTextTexLike: 0, markedActualText: 0, markedActualTextTexLike: 0, truncated: false, unknown: false },
    }))!;
    expect(page).toMatchObject({ ...booktabs, tableFlags: ["booktabs"], mathFlags: [], mathRegions: [{ kind: "text", bbox: [72, 100, 200, 120] }] });
    expect(page.structure?.tables).toBe(0);
    expect(page.tableLayout?.ruledGrids).toBe(0);
  });

  it("keeps the released structure family: only the ActualText counts, the tree counts absent (unknown, never 0)", () => {
    // What d317bea writes on every page at `full` (the per-page structure-tree walk was removed in #51's review).
    const page = parsePage(encodedPage(1, booktabs, { structure: { actualText: 3, actualTextTexLike: 1, truncated: false } }))!;
    expect(page.structure).toEqual({ actualText: 3, actualTextTexLike: 1, truncated: false });
    expect(page.structure?.formulas).toBeUndefined();
    // The three released keys are required: a structure without them, or with a bad value, is dropped (unknown).
    expect(parsePage(encodedPage(1, booktabs, { structure: { actualText: 3, truncated: false } }))!.structure).toBeUndefined();
    expect(parsePage(encodedPage(1, booktabs, { structure: { actualText: -1, actualTextTexLike: 0, truncated: false } }))!.structure).toBeUndefined();
    // A TeX-like count above its total is not a fact: the released pair drops the family; an optional pair is left out.
    expect(parsePage(encodedPage(1, booktabs, { structure: { actualText: 1, actualTextTexLike: 2, truncated: false } }))!.structure).toBeUndefined();
    expect(parsePage(encodedPage(1, booktabs, { structure: { actualText: 2, actualTextTexLike: 2, truncated: false } }))!.structure)
      .toEqual({ actualText: 2, actualTextTexLike: 2, truncated: false });
    expect(parsePage(encodedPage(1, booktabs, { structure: { actualText: 2, actualTextTexLike: 1, truncated: false, altText: 1, altTextTexLike: 3, markedActualText: 4, markedActualTextTexLike: 4 } }))!.structure)
      .toEqual({ actualText: 2, actualTextTexLike: 1, truncated: false, markedActualText: 4, markedActualTextTexLike: 4 });
    expect(parsePage(encodedPage(1, booktabs, { structure: { actualText: 2, actualTextTexLike: 1, truncated: false, altTextTexLike: 1 } }))!.structure)
      .toEqual({ actualText: 2, actualTextTexLike: 1, truncated: false });
    // A bad optional count is left out; the rest stays.
    expect(parsePage(encodedPage(1, booktabs, { structure: { actualText: 0, actualTextTexLike: 0, truncated: true, formulas: "x" } }))!.structure)
      .toEqual({ actualText: 0, actualTextTexLike: 0, truncated: true });
  });

  it("reads mathtables' fields inside the other families", () => {
    const base = textPage(1);
    const page = parsePage({
      ...base, ...booktabs,
      text: { ...(base.text as object), unicodeMath: { greek: 3, scripts: 0, operators: 4, mathAlphanumeric: 0, arrows: 1, letterlike: 0, plainRatio: 0.002 } },
      fonts: { ...(base.fonts as object), mathClasses: { texType1: 40, otfMath: 0, officeMath: 0, webMath: 0, symbol: 0, type3Bitmap: 0, text: 2000 } },
      images: { ...(base.images as Record<string, unknown>), mathStrips: 0, items: [{ ...((base.images as { items: object[] }).items[0]), stripLike: false, inTextFlow: true }] },
      vectors: { ...(base.vectors as object), glyphOutlineClusters: 0, ruleTablesTruncated: false,
        ruleTables: [{ bbox: [72, 200, 540, 300], rows: 5, columns: 4, hRules: 3, style: "booktabs" }] },
    })!;
    expect(page.text?.unicodeMath?.operators).toBe(4);
    expect(page.fonts?.mathClasses?.texType1).toBe(40);
    expect(page.images?.mathStrips).toBe(0);
    expect(page.images?.items?.[0]).toMatchObject({ stripLike: false, inTextFlow: true });
    expect(page.vectors?.ruleTables).toEqual([{ bbox: [72, 200, 540, 300], rows: 5, columns: 4, hRules: 3, style: "booktabs" }]);
  });

  it("drops all three words when one is missing, out of range or not an integer (unknown, never zero)", () => {
    for (const bad of [
      { mathBits: 0, tableBits: 4 }, { ...booktabs, mathBits: -1 }, { ...booktabs, tableBits: 2 ** 32 }, { ...booktabs, encodingCounts: 2 ** 52 },
      { ...booktabs, mathBits: 1.5 }, { ...booktabs, tableBits: "4" },
    ]) {
      const page = parsePage(textPage(1, bad))!;
      expect(page.mathBits).toBeUndefined();
      expect(page.tableBits).toBeUndefined();
      expect(page.encodingCounts).toBeUndefined();
    }
  });

  it("drops the words when the full level's names contradict them", () => {
    expect(parsePage(encodedPage(1, booktabs, { tableFlags: ["rule-grid"] }))!.tableBits).toBeUndefined();
    expect(parsePage(encodedPage(1, booktabs, { mathFlags: ["text-math"] }))!.mathBits).toBeUndefined();
    expect(parsePage(encodedPage(1, booktabs, { tableFlags: "booktabs" }))!.tableBits).toBeUndefined();
  });

  it("drops the words when a flag defined by a count contradicts its nibble", () => {
    const strips = { mathBits: mathWord("raster-strips"), tableBits: 0, encodingCounts: counts({ mathStrips: 2 }) };
    expect(parsePage(encodedPage(1, strips))!.mathBits).toBe(32);
    expect(parsePage(encodedPage(1, { ...strips, encodingCounts: 0 }))!.mathBits).toBeUndefined();
    expect(parsePage(encodedPage(1, { mathBits: 0, tableBits: 0, encodingCounts: counts({ glyphOutlineClusters: 1 }) }))!.mathBits).toBeUndefined();
    expect(parsePage(encodedPage(1, { mathBits: 0, tableBits: tableWord("tagged-table"), encodingCounts: 0 }))!.tableBits).toBeUndefined();
    expect(parsePage(encodedPage(1, { mathBits: mathWord("formula-struct"), tableBits: 0, encodingCounts: 0 }))!.mathBits).toBeUndefined();
  });

  it("keeps a bit this build does not name (the route reads it as unknown)", () => {
    const page = parsePage(encodedPage(1, { mathBits: 2 ** 20, tableBits: 0, encodingCounts: 0 }))!;
    expect(page.mathBits).toBe(2 ** 20);
    expect(pageEncodingRoute(page)).toEqual({ status: "unknown", reason: "unknown-bits" });
  });

  it("drops math regions and rule tables off the page, keeping the words", () => {
    const base = textPage(1);
    const page = parsePage({
      ...base, ...booktabs, mathRegions: [{ kind: "raster", bbox: [0, 0, 900, 50] }],
      vectors: { ...(base.vectors as object), ruleTables: [{ bbox: [0, 0, 700, 50], rows: 2, columns: 2, hRules: 2, style: "open" }] },
    })!;
    expect(page.mathRegions).toBeUndefined();
    expect(page.vectors?.ruleTables).toBeUndefined();
    expect(page.tableBits).toBe(4);
    // A malformed region list is unknown as a whole, never truncated.
    expect(parsePage(encodedPage(1, booktabs, { mathRegions: [{ kind: "glyph", bbox: [1, 1, 2, 2] }] }))!.mathRegions).toBeUndefined();
  });

  it("re-serializes the words and readable fields, and a math run keeps them", () => {
    const parsed = parseDopplerPageFacts(jsonl([docLine({ pageCount: 1, include: ["mathtables"] }), encodedPage(1, booktabs, { tableFlags: ["booktabs"] }), runLine({ pagesEmitted: 1 })]), { pageCount: 1 });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.facts.doc.include).toEqual(["mathtables"]);
    const again = parseDopplerPageFacts(dopplerPageFactsJsonl(parsed.facts), { pageCount: 1 });
    if (!again.ok) throw new Error(again.reason);
    expect(again.facts.pages.get(1)).toEqual(parsed.facts.pages.get(1));
    expect(withoutWalkerParityFacts(parsed.facts).pages.get(1)).toMatchObject(booktabs);
  });

  it("asks providers for mathtables unless page facts are off", () => {
    expect(dopplerPageFactsRequest({})).toEqual({ include: ["mathtables"] });
    expect(dopplerPageFactsRequest({ DOCSLURP_DOPPLER_PAGE_FACTS: "off" })).toBeUndefined();
  });
});

describe("what each encoding means for routing", () => {
  const page = (mathFlags: DopplerMathFlag[], tableFlags: DopplerTableFlag[], extra: Partial<DopplerPageFacts> = {}): DopplerPageFacts => ({
    page: 1, parseWarnings: [], unusualFeatures: [], mathBits: mathWord(...mathFlags), tableBits: tableWord(...tableFlags), encodingCounts: 0, ...extra,
  });

  it("text-layer tables: rule-grid, booktabs, hrule-open, whitespace, shaded-rows, tagged-table", () => {
    for (const flag of ["rule-grid", "booktabs", "hrule-open", "whitespace", "shaded-rows", "tagged-table"] as const) {
      expect(route([], [flag]).table).toBe("text-layer");
    }
  });

  it("math-grid is never a table; outlined text grids need a read; a raster table shape is a candidate only", () => {
    expect(route(["math-matrix"], ["math-grid"])).toMatchObject({ table: "none", mathGrid: true });
    expect(route([], ["math-grid", "booktabs"])).toMatchObject({ table: "text-layer", mathGrid: true });
    expect(route([], ["outlined-text-grid"]).table).toBe("vision");
    expect(route([], ["raster-table-like"])).toMatchObject({ table: "none", rasterTableCandidate: true });
    // The text layer reads a table it holds, even beside an outlined one.
    expect(route([], ["whitespace", "outlined-text-grid"]).table).toBe("text-layer");
  });

  it("math only a read recovers: raster strips, glyph outlines, Type 3 bitmap fonts, unmapped math glyphs", () => {
    for (const flag of ["raster-strips", "glyph-outlines", "type3-bitmap-font"] as const) {
      expect(route([flag], []).math).toBe("vision");
    }
    // Unmapped math glyphs need a read only when there are enough of them (bucket 5: 16 or more), not a few delimiter pieces.
    expect(route(["math-font-no-unicode"], [], false, 5).math).toBe("vision");
    expect(route(["math-font-no-unicode"], [], false, 2).math).toBe("text");
    // The math reader handles unmapped glyphs (and reports what it cannot read); a TeX or MathML source covers them too.
    expect(route(["math-font-no-unicode", "text-math"], [], true, 15).math).toBe("text");
    expect(route(["math-font-no-unicode", "actualtext-tex"], [], false, 15).math).toBe("source");
    // Pixels and outlines have no glyphs to read, math reader or not.
    expect(route(["raster-strips"], [], true).math).toBe("vision");
  });

  it("text math and sources keep the text layer", () => {
    for (const flag of ["text-math", "plain-unicode-math", "stacked-math", "formula-struct"] as const) expect(route([flag], []).math).toBe("text");
    for (const flag of ["actualtext-tex", "alt-tex", "mathml"] as const) expect(route([flag], []).math).toBe("source");
    expect(route([], []).math).toBe("none");
  });

  it("analysis-truncated in either word is unknown, never 'no table' or 'no math'", () => {
    expect(pageEncodingRoute(page(["analysis-truncated"], []))).toEqual({ status: "unknown", reason: "truncated" });
    expect(pageEncodingRoute(page([], ["analysis-truncated"]))).toEqual({ status: "unknown", reason: "truncated" });
    expect(pageEncodingRoute(page([], ["booktabs", "analysis-truncated"]))).toEqual({ status: "unknown", reason: "truncated" });
  });

  it("absent words, a failed page and a low-confidence page are unknown", () => {
    expect(pageEncodingRoute({ page: 1, parseWarnings: [], unusualFeatures: [] })).toEqual({ status: "unknown", reason: "absent" });
    expect(pageEncodingRoute({ ...page([], []), failed: true })).toEqual({ status: "unknown", reason: "failed" });
    expect(pageEncodingRoute(page([], [], { parseWarnings: ["xref-repaired-earlier"] }))).toEqual({ status: "unknown", reason: "low-confidence" });
    // As gridFacts: a rebuilt cross-reference table or a drawing cap leaves the drawing incomplete.
    expect(pageEncodingRoute(page([], [], { parseWarnings: ["xref-repaired"] }))).toEqual({ status: "unknown", reason: "xref-repaired" });
    expect(pageEncodingRoute(page([], [], { parseWarnings: ["limit-hit"] }))).toEqual({ status: "unknown", reason: "drawing-limit" });
    expect(pageEncodingRoute(page([], [], { unusualFeatures: ["drawing-limit"] }))).toEqual({ status: "unknown", reason: "drawing-limit" });
    expect(pageEncodingRoute(page([], []))).toMatchObject({ status: "known", route: { table: "none", math: "none" } });
  });

  it("stores the flags and re-derives the route from them (a stored route never says more than its flags)", () => {
    const stored = JSON.parse(JSON.stringify(route(["raster-strips"], ["booktabs"])));
    expect(parsePageEncodingRoute(stored)).toEqual(route(["raster-strips"], ["booktabs"]));
    expect(parsePageEncodingRoute({ ...stored, math: "none", table: "none" })).toEqual(route(["raster-strips"], ["booktabs"]));
    expect(parsePageEncodingRoute({ ...route(["text-math"], []), math: "vision" })!.math).toBe("text");
    expect(parsePageEncodingRoute({ ...stored, mathFlags: ["analysis-truncated"] })).toBeUndefined();
    expect(parsePageEncodingRoute({ ...stored, tableFlags: ["not-a-flag"] })).toBeUndefined();
    expect(parsePageEncodingRoute({ ...stored, mathRead: "yes" })).toBeUndefined();
    expect(parsePageEncodingRoute({ ...stored, unreadableMathGlyphs: 16 })).toBeUndefined();
    expect(parsePageEncodingRoute(JSON.parse(JSON.stringify(route(["math-font-no-unicode"], [], false, 6))))!.math).toBe("vision");
    expect(parsePageEncodingRoute([])).toBeUndefined();
  });
});

describe("layout facts and stored rows carry the encodings", () => {
  afterEach(() => vi.restoreAllMocks());
  const words = { mathBits: mathWord("raster-strips"), tableBits: tableWord("whitespace"), encodingCounts: counts({ mathStrips: 1, whitespaceTables: 1 }) };

  it("maps a page's encodings onto its layout facts and through the stored artifact", () => {
    const page = parsePage(encodedPage(1, words))!;
    const layout = pageLayoutFactsFromDopplerPage(page)!;
    expect(layout.encodings).toMatchObject({ table: "text-layer", math: "vision", mathFlags: ["raster-strips"], tableFlags: ["whitespace"] });
    const stored = parsePageLayoutFacts({ version: "pdf-layout-facts@1", pages: [{ pageNumber: 1, known: true, ...layout }] });
    expect(stored.get(1)?.encodings).toEqual(layout.encodings);
    const tampered = parsePageLayoutFacts({ version: "pdf-layout-facts@1", pages: [{ pageNumber: 1, known: true, ...layout, encodings: { mathFlags: "x" } }] });
    expect(tampered.get(1)).not.toHaveProperty("encodings");
  });

  it("attaches encodings to a walker layout, and replaces stale ones where the facts are unknown", () => {
    const parsed = parseDopplerPageFacts(jsonl([docLine({ pageCount: 2 }), encodedPage(1, words), encodedPage(2, { mathBits: mathWord("analysis-truncated"), tableBits: 0, encodingCounts: 0 }), runLine({ pagesEmitted: 2 })]), { pageCount: 2 });
    if (!parsed.ok) throw new Error(parsed.reason);
    const walker = (n: number): PageLayoutFacts => ({ images: [], tables: [], words: 10, grids: [], tableCoverage: 0, ...(n === 2 ? { encodings: route([], ["booktabs"]) } : {}) });
    const { layout, known } = withEncodingRoutes(new Map([[1, walker(1)], [2, walker(2)]]), parsed.facts);
    expect(known).toBe(1);
    expect(layout.get(1)?.encodings?.table).toBe("text-layer");
    expect(layout.get(2)).not.toHaveProperty("encodings");
  });

  it("a provider result's layout carries them in use mode only; a math run's unmapped glyphs are the math reader's", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", "use");
    const unmapped = { mathBits: mathWord("math-font-no-unicode", "text-math"), tableBits: 0, encodingCounts: counts({ mathFontChars: 3, unreadableMathGlyphs: 6 }) };
    const layoutFacts = { version: "pdf-layout-facts@1", pages: [{ pageNumber: 1, known: true, images: [], tables: [], words: 40, grids: null, tableCoverage: null }] };
    const pageFacts = jsonl([docLine({ pageCount: 1 }), encodedPage(1, unmapped), runLine({ pagesEmitted: 1 })]);
    const plain: SandboxedPdfJob = { input: "/a", output: "/b" };
    acceptSandboxedPdfResult(plain, { exitCode: 0, stdout: "", stderr: "", layoutFacts, pageFacts }, 1);
    expect(sandboxedPdfLayoutFacts(plain)?.get(1)?.encodings).toMatchObject({ math: "vision", mathRead: false });
    const math: SandboxedPdfJob = { input: "/a", output: "/b" };
    acceptSandboxedPdfResult(math, { exitCode: 0, stdout: "", stderr: "", layoutFacts, pageFacts }, 1, { glyphs: true });
    expect(sandboxedPdfLayoutFacts(math)?.get(1)?.encodings).toMatchObject({ math: "text", mathRead: true });
    // `store` (the default) never steers routing: the facts are parsed and stored, the layout carries no encodings.
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", "store");
    const stored: SandboxedPdfJob = { input: "/a", output: "/b" };
    acceptSandboxedPdfResult(stored, { exitCode: 0, stdout: "", stderr: "", layoutFacts, pageFacts }, 1);
    expect(sandboxedPdfLayoutFacts(stored)?.get(1)).not.toHaveProperty("encodings");
    vi.unstubAllEnvs();
  });

  it("stores the three words per page, all or none", () => {
    const parsed = parseDopplerPageFacts(jsonl([docLine({ pageCount: 2 }), encodedPage(1, words), textPage(2), runLine({ pagesEmitted: 2 })]), { pageCount: 2 });
    if (!parsed.ok) throw new Error(parsed.reason);
    const routing = routingFactsWithDopplerFacts(undefined, parsed.facts)!;
    expect(routing.get(1)).toMatchObject(words);
    expect(routing.get(2)).not.toHaveProperty("mathBits");
    const rows = buildRoutingPageFacts({ documentId: "d", runId: "r", pageCount: 2, layoutFacts: routing });
    expect(rows[0]).toMatchObject({ pageNumber: 1, ...words });
    expect(rows[1]).not.toHaveProperty("mathBits");
    // A partial or out-of-range set is not written.
    const partial = buildRoutingPageFacts({ documentId: "d", runId: "r", pageCount: 1, layoutFacts: new Map([[1, { mathBits: 1, tableBits: 2 ** 32, encodingCounts: 0 }]]) });
    expect(partial).toEqual([]);
  });
});

describe("evidence routing by encodings (DOCSLURP_ENCODING_FACTS_ROUTING)", () => {
  const prose = "A plain paragraph of prose about quarterly results, with nothing laid out in columns.\n\nAnother paragraph follows here, and the team expects the new office in London to open in spring.";
  const walkerPage = (extra: Partial<PageLayoutFacts> = {}): PageLayoutFacts => ({ images: [], tables: [], words: 60, grids: [], tableCoverage: 0, widthPt: 612, heightPt: 792, ...extra });
  const surface = (layout: PageLayoutFacts, encodingRouting: boolean) => buildAdaptiveRoutingDecisionSurface({
    documentId: "doc", filename: "doc.pdf", text: prose, pageCount: 1, evidence: { source: "canonical-document", artifactUri: "s3://x" },
    pageLayout: new Map([[1, layout]]), routingV2: true, encodingRouting,
  }).pages[0]!;

  it("never settles an unknown ruled grid as no table: a prose-cell table has no table bit (council #467)", () => {
    const unknownGrids = walkerPage({ grids: null, tableCoverage: null, gridsUnknown: true });
    expect(classifyAdaptivePage(1, prose, { layout: unknownGrids }).route).toBe("table-heavy");
    for (const encodings of [route([], []), route(["math-matrix"], ["math-grid"]), route([], ["raster-table-like"])]) {
      const page = classifyAdaptivePage(1, prose, { layout: unknownGrids, encodings });
      expect(page.route).toBe("table-heavy");
      expect(page.signals).toContain("grids-unknown");
    }
    const textTable = classifyAdaptivePage(1, prose, { layout: unknownGrids, encodings: route([], ["booktabs"]) });
    expect(textTable.route).toBe("table-heavy");
    expect(textTable.signals).toEqual(expect.arrayContaining(["grids-unknown", "encoding-table:booktabs"]));
  });

  it("adds a table route for a text-layer table no grid showed", () => {
    expect(classifyAdaptivePage(1, prose, { layout: walkerPage() }).route).not.toBe("table-heavy");
    for (const flag of ["booktabs", "hrule-open", "whitespace", "shaded-rows", "tagged-table", "rule-grid"] as const) {
      const page = classifyAdaptivePage(1, prose, { layout: walkerPage(), encodings: route([], [flag]) });
      expect(page.route).toBe("table-heavy");
      expect(page.signals).toContain(`encoding-table:${flag}`);
    }
  });

  it("never takes a grid out of the table count: a ruled notation table can read as math-grid alone (council #467)", () => {
    const grid = walkerPage({ grids: [{ rows: 6, columns: 3, coverage: null }] });
    expect(classifyAdaptivePage(1, prose, { layout: grid }).route).toBe("table-heavy");
    const withMathGrid = classifyAdaptivePage(1, prose, { layout: grid, encodings: route(["math-matrix", "text-math"], ["math-grid"]) });
    expect(withMathGrid.route).toBe("table-heavy");
    expect(withMathGrid.signals).toEqual(expect.arrayContaining(["encoding-math-grid", "encoding-math:text"]));
  });

  it("never relabels a page: math encodings are signals only", () => {
    const page = classifyAdaptivePage(1, prose, { layout: walkerPage(), encodings: route(["text-math", "stacked-math"], []) });
    expect(page.route).toBe(classifyAdaptivePage(1, prose, { layout: walkerPage() }).route);
    expect(page.signals).toContain("encoding-math:text");
  });

  it("reads a page whose math only a read recovers, or whose table is drawn as outlines; flag off, the page is not read", () => {
    const strips = walkerPage({ encodings: route(["raster-strips"], []) });
    const on = surface(strips, true);
    expect(on.ocrDecision?.authorized).toBe(true);
    expect(on.ocrDecision?.signals).toEqual(expect.arrayContaining(["ocr-authorized:encoding-math-unreadable", "encoding-math-read:raster-strips"]));
    expect(pageReadReason(on.ocrDecision!.signals)).toBe("encoding");
    expect(surface(strips, false).ocrDecision?.authorized).toBe(false);
    const outlines = surface(walkerPage({ encodings: route([], ["outlined-text-grid"]) }), true);
    expect(outlines.ocrDecision?.authorized).toBe(true);
    expect(outlines.route).toBe("table-heavy");
    expect(outlines.ocrDecision?.signals).toContain("ocr-authorized:encoding-table-outlines");
  });

  it("never reads for a raster table shape, text math or a source alone", () => {
    for (const encodings of [route([], ["raster-table-like"]), route(["text-math", "stacked-math"], []), route(["actualtext-tex"], []), route(["math-font-no-unicode"], [], true, 15), route(["math-font-no-unicode"], [], false, 2)]) {
      const page = surface(walkerPage({ encodings }), true);
      expect(page.ocrDecision?.authorized).toBe(false);
    }
    expect(surface(walkerPage({ encodings: route([], ["raster-table-like"]) }), true).signals).toContain("encoding-table-raster-candidate");
  });

  it("only adds a read: an authorized decision is returned as it is", () => {
    const authorized = { authorized: true, confidence: 0.9, signals: ["ocr-authorized:no-native-text"] };
    expect(encodingReadDecision(authorized, route(["raster-strips"], []))).toBe(authorized);
    const declined = { authorized: false, confidence: 0.5, signals: [] };
    expect(encodingReadDecision(declined, null)).toBe(declined);
    expect(encodingReadDecision(declined, route([], [])).authorized).toBe(false);
  });

  it("flag off: stored encodings change nothing", () => {
    const layout = walkerPage({ encodings: route(["raster-strips"], ["booktabs"]) });
    const off = surface(layout, false);
    expect(off.route).not.toBe("table-heavy");
    expect(off.ocrDecision?.authorized).toBe(false);
    expect(off.signals.some((signal) => signal.startsWith("encoding"))).toBe(false);
    const on = surface(layout, true);
    expect(on.route).toBe("table-heavy");
    expect(on.ocrDecision?.authorized).toBe(true);
  });

  it("caps every read the encodings caused, table-unreliable reads on encoding-only table routes included (council #467)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const pageCount = 60;
    const cap = encodingReadPageCap(pageCount);
    // A small ragged pipe table: unreliable on a table route, nothing on a prose route.
    const ragged = ["Quarterly expansion notes for the London office.", "", "| Office | Seats |", "| --- | --- |", "| London | 40 | new |", "", "The move ends in spring."].join("\n");
    const longProse = "The expansion plan for the London office continues after the earnings beat. ".repeat(200);
    for (const text of [ragged, longProse]) {
      for (const flags of [["whitespace"], ["tagged-table"], ["outlined-text-grid"]] as DopplerTableFlag[][]) {
        const layout = new Map<number, PageLayoutFacts>();
        for (let n = 1; n <= pageCount; n += 1) layout.set(n, walkerPage({ words: 200, encodings: route([], flags) }));
        const run = (encodingRouting: boolean) => buildAdaptiveRoutingDecisionSurface({
          documentId: "doc", filename: "doc.pdf", text: Array.from({ length: pageCount }, () => text).join("\n\f\n"), pageCount,
          evidence: { source: "canonical-document", artifactUri: "s3://x" }, pageLayout: layout, routingV2: true, encodingRouting,
        }).pages;
        const off = run(false);
        const on = run(true);
        const reads = (pages: typeof on) => pages.filter((page) => page.ocrDecision?.authorized).length;
        expect(reads(on) - reads(off), `${flags} ${text.length}`).toBeLessThanOrEqual(cap);
        for (const page of on.filter((p) => p.signals.includes("encoding-read-capped"))) {
          expect(page.ocrDecision?.authorized).toBe(false);
          expect(page.extractorHint).not.toBe("vision-rescue");
          expect(page.route).toBe(off[page.pageNumber - 1]!.route);
        }
        // Without a read, no page carries a vision-rescue hint the encodings alone gave it.
        for (const page of on) if (!page.ocrDecision?.authorized) expect(page.extractorHint === "vision-rescue" && off[page.pageNumber - 1]!.extractorHint !== "vision-rescue").toBe(false);
      }
    }
   }, 60_000);

  it("an encoding read keeps the page's own route (a code page is not relabelled degraded)", () => {
    const code = "```python\ndef total(rows):\n    return sum(row.amount for row in rows)\n```\n\nfunction add(a, b) { return a + b; }\nconst x = add(1, 2);\nimport os\nclass Ledger:\n    pass";
    const surfaceOf = (encodingRouting: boolean) => buildAdaptiveRoutingDecisionSurface({
      documentId: "doc", filename: "doc.pdf", text: code, pageCount: 1, evidence: { source: "canonical-document", artifactUri: "s3://x" },
      pageLayout: new Map([[1, walkerPage({ encodings: route(["glyph-outlines"], []) })]]), routingV2: true, encodingRouting,
    }).pages[0]!;
    const on = surfaceOf(true);
    expect(on.ocrDecision?.authorized).toBe(true);
    expect(on.route).toBe(surfaceOf(false).route);
  });

  it("caps encoding-only reads per document: no native text first, then the most unreadable math", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const pageCount = 10;   // cap: 3 + floor(10 * 0.05) = 3
    expect(encodingReadPageCap(pageCount)).toBe(3);
    const layout = new Map<number, PageLayoutFacts>();
    for (let n = 1; n <= pageCount; n += 1) {
      const unreadable = n === 4 ? 9 : n === 7 ? 12 : 6;
      layout.set(n, walkerPage({ words: n === 9 ? 0 : 60, encodings: route(["math-font-no-unicode"], [], false, unreadable) }));
    }
    const pages = buildAdaptiveRoutingDecisionSurface({
      documentId: "doc", filename: "doc.pdf", text: Array.from({ length: pageCount }, () => prose).join("\f"), pageCount,
      evidence: { source: "canonical-document", artifactUri: "s3://x" }, pageLayout: layout, routingV2: true, encodingRouting: true,
    }).pages;
    const read = pages.filter((page) => page.ocrDecision?.authorized).map((page) => page.pageNumber);
    expect(read).toEqual([4, 7, 9]);
    const capped = pages.filter((page) => page.signals.includes("encoding-read-capped")).map((page) => page.pageNumber);
    expect(capped).toEqual([1, 2, 3, 5, 6, 8, 10]);
    expect(pages.every((page) => !(page.ocrDecision?.signals ?? []).includes("ocr-authorized:encoding-math-unreadable") || read.includes(page.pageNumber))).toBe(true);
  });
});

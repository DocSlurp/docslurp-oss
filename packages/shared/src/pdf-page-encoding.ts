/*
 * How math and tables are encoded on a PDF page, as a bit mask per page: content-free structural facts the offline
 * profiler (`@docslurp/estimate`) measures and the worker can measure the same way. One bit per distinction, so a page
 * can carry several (a tagged table drawn with horizontal rules beside a stacked formula in a math font).
 *
 * The bit positions are a contract: the profiler reads them from `profiler-rules.json` (generated from this table),
 * the server's strict profile validation refuses any bit not listed here, and `pdf-page-encoding.test.ts` pins every
 * position. Add a distinction by taking an unused bit; never move or reuse one.
 *
 * A profile carries the masks as a histogram (`pageEncodings`: distinct mask and the sampled pages that have it), not as
 * a per-page array, so it keeps no page order. `pdfPageEncodingPages` turns it back into a count per distinction.
 */

export const PDF_PAGE_ENCODING_BITS = {
  /** Glyphs shown from a math-class font (TeX math families, an OpenType MATH table or a *Math name, web math fonts) that has a Unicode mapping. */
  mathFont: 0,
  /** Two-dimensional math: math-font glyphs stacked over each other (baselines more than `stackedMinBaselineEm` apart, overlapping across), or a fraction bar with text right above and below it. */
  stackedMath: 1,
  /** Recoverable formula source: TeX-like ActualText on the page, a tagged formula with TeX-like Alt or ActualText, a MathML associated file or MathML structure, a MathML file associated with the page, or one associated with the document on a page that shows math. */
  mathSource: 2,
  /** Marked content with ActualText (any replacement text). */
  actualText: 3,
  /** A raster formula strip: a short, wide image in a page of text (`stripMin/MaxHeightPt`, `stripMinAspect`, under `stripMaxPageShare`). */
  formulaStrip: 4,
  /** Glyph outlines: at least `outlineMinClusters` small clusters of filled, curve-dense paths (text or math drawn as outlines). */
  glyphOutlines: 5,
  /** Glyphs shown from a Type 3 font whose glyph procedures paint images (bitmap fonts, as old TeX-to-PostScript routes make). */
  type3BitmapFont: 6,
  /** Glyphs shown from a math-class font without a Unicode mapping (its text layer reads as glyph ids). */
  unmappedMathFont: 7,
  /** A ruled grid (horizontal and vertical rules meeting): the layout walker's grid rule. */
  ruleGrid: 8,
  /** A table drawn with horizontal rules only (booktabs style): `ruleTableMinRules` rules of one width bracket rows with column gaps, no vertical rules. */
  horizontalRuleTable: 9,
  /** A /Table structure element marked on this page. */
  taggedTable: 10,
  /** A /Formula structure element marked on this page. */
  taggedFormula: 11,
  /** A table-shaped image in a page of text: lossless, wide, at least `tableImageMinHeightPt` tall. A short one is also a formula strip by shape, and a chart in a PNG looks the same. */
  tableImage: 12,
  /** A matrix-like grid of math-font glyphs: two or more rows with two or more aligned columns (not a table). */
  mathGrid: 13,
  /** The page was not read to the end, or one of its caps was reached: its bits are a lower bound. */
  partial: 15,
} as const;

export type PdfPageEncoding = keyof typeof PDF_PAGE_ENCODING_BITS;

/** Every bit a mask may carry; any other bit is refused. */
export const PDF_PAGE_ENCODING_KNOWN_MASK: number = Object.values(PDF_PAGE_ENCODING_BITS).reduce<number>((mask, bit) => mask | (1 << bit), 0);

/** Thresholds of the encoding facts (points, em and shares of the visible page). */
export const PDF_PAGE_ENCODING_RULES = {
  /** Formula strips: placed height, width over height, share of the page and of its width; a page of text has at least `stripMinPageChars` glyphs. */
  stripMinHeightPt: 8,
  stripMaxHeightPt: 100,
  stripMinAspect: 1.6,
  stripMaxPageShare: 0.06,
  stripMaxWidthShare: 0.85,
  stripMinPageChars: 10,
  /** Glyph-outline clusters: filled paths with curves, merged when their boxes come within `outlineGapPt`; a cluster no larger than `outlineMaxSidePt` with `outlineMinCurves` curves and `outlineMinCurvesPerPath` per path; `outlineMinClusters` a page. */
  outlineGapPt: 1.5,
  outlineMaxSidePt: 120,
  outlineMinCurves: 6,
  outlineMinCurvesPerPath: 4,
  outlineMinClusters: 3,
  /** Stacked math: baselines more than this many em apart (and under `stackedMaxBaselineEm`) with overlapping runs. */
  stackedMinBaselineEm: 0.3,
  stackedMaxBaselineEm: 3,
  /** Fraction bars: a horizontal rule at most this long with text within `fractionBarReachEm` above and below. */
  fractionBarMaxLengthPt: 300,
  fractionBarReachEm: 1.5,
  /** Horizontal-rule tables: rules at least `ruleTableMinRuleLengthPt` long sharing their ends within `ruleTableEndTolerancePt`. */
  ruleTableMinRules: 3,
  ruleTableMinRuleLengthPt: 40,
  ruleTableEndTolerancePt: 2,
  /** Table-shaped images: placed height, share of the page, of its width, aspect range, and native words on the page. */
  tableImageMinHeightPt: 48,
  tableImageMinPageShare: 0.05,
  tableImageMaxPageShare: 0.6,
  tableImageMinWidthShare: 0.4,
  tableImageMinAspect: 0.8,
  tableImageMaxAspect: 8,
  tableImageMinPageWords: 30,
  /** Structure-tree walk caps: elements visited and nesting depth; past either the tagged counts are lower bounds. */
  structMaxElements: 50_000,
  structMaxDepth: 64,
} as const;

/**
 * The per-page stat stream (`@docslurp/estimate` `profileWithPageStats`, one JSON object per sampled page, never part of
 * the file profile): `{ page, mask, counts }`, where `counts` packs one 4-bit bucket per entry below, entry `i` in bits
 * `4i..4i+3`. A bucket is 0 for none and otherwise `min(15, floor(log2(n)) + 1)`: 1 for 1, 2 for 2-3, 3 for 4-7, ...,
 * 15 for 16,384 and more.
 */
export const PDF_PAGE_STAT_COUNTS = [
  /** Native words. */
  "words",
  /** Glyphs shown. */
  "glyphs",
  /** Glyphs shown from math-class fonts. */
  "mathGlyphs",
  /** Significant image placements. */
  "images",
  /** Path construction operations. */
  "pathOperations",
  /** Ruling lines (thin horizontal or vertical strokes and filled rectangles). */
  "rules",
  /** Glyph-outline clusters that qualify (see `glyphOutlines`). */
  "outlineClusters",
  /** Formula-strip images. */
  "stripImages",
] as const;

/** The 4-bit log2 bucket of a count (`PDF_PAGE_STAT_COUNTS`). */
export function pdfPageStatBucket(count: number): number {
  return count < 1 ? 0 : Math.min(15, Math.floor(Math.log2(count)) + 1);
}

/** Unpack a page stat `counts` word into each entry's bucket. */
export function unpackPdfPageStatCounts(counts: number): Record<(typeof PDF_PAGE_STAT_COUNTS)[number], number> {
  return Object.fromEntries(PDF_PAGE_STAT_COUNTS.map((name, index) => [name, Math.floor(counts / 16 ** index) % 16])) as Record<(typeof PDF_PAGE_STAT_COUNTS)[number], number>;
}

/** Distinct masks a histogram holds at most: one per sampled page, so it is never lossy. */
export const PDF_PAGE_ENCODING_MAX_ENTRIES = 24;

/** Sampled pages whose mask carries `encoding`, from a `pageEncodings` histogram. */
export function pdfPageEncodingPages(histogram: readonly (readonly [number, number])[] | undefined, encoding: PdfPageEncoding): number | undefined {
  if (!histogram) return undefined;
  const bit = 1 << PDF_PAGE_ENCODING_BITS[encoding];
  return histogram.reduce((total, [mask, pages]) => total + ((mask & bit) !== 0 ? pages : 0), 0);
}

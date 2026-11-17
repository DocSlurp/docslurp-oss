import { describe, expect, it } from "vitest";

import { buildProfilerRules } from "./estimate-profiler-rules.js";
import {
  PDF_PAGE_ENCODING_BITS,
  PDF_PAGE_ENCODING_KNOWN_MASK,
  PDF_PAGE_STAT_COUNTS,
  pdfPageEncodingPages,
  pdfPageStatBucket,
  unpackPdfPageStatCounts,
} from "./pdf-page-encoding.js";

describe("PDF page encoding masks", () => {
  it("pin every bit position (a position is never moved or reused)", () => {
    expect(PDF_PAGE_ENCODING_BITS).toEqual({
      mathFont: 0, stackedMath: 1, mathSource: 2, actualText: 3, formulaStrip: 4, glyphOutlines: 5, type3BitmapFont: 6, unmappedMathFont: 7,
      ruleGrid: 8, horizontalRuleTable: 9, taggedTable: 10, taggedFormula: 11, tableImage: 12, mathGrid: 13, partial: 15,
    });
    expect(new Set(Object.values(PDF_PAGE_ENCODING_BITS)).size).toBe(Object.keys(PDF_PAGE_ENCODING_BITS).length);
    expect(PDF_PAGE_ENCODING_KNOWN_MASK).toBe(0xbfff);
  });

  it("pin the per-page stat count order and its 4-bit log2 buckets", () => {
    expect(PDF_PAGE_STAT_COUNTS).toEqual(["words", "glyphs", "mathGlyphs", "images", "pathOperations", "rules", "outlineClusters", "stripImages"]);
    expect([0, 1, 2, 3, 4, 7, 8, 16_383, 16_384, 1e12].map(pdfPageStatBucket)).toEqual([0, 1, 2, 2, 3, 3, 4, 14, 15, 15]);
    expect(unpackPdfPageStatCounts(0xf0000016)).toEqual({ words: 6, glyphs: 1, mathGlyphs: 0, images: 0, pathOperations: 0, rules: 0, outlineClusters: 0, stripImages: 15 });
  });

  it("are what the profiler reads from its rules", () => {
    const rules = buildProfilerRules();
    expect(rules.pageEncoding.bits).toEqual(PDF_PAGE_ENCODING_BITS);
    expect(rules.pageEncoding.statCounts).toEqual([...PDF_PAGE_STAT_COUNTS]);
  });

  it("count the pages with a distinction from the histogram", () => {
    const histogram: [number, number][] = [[0, 10], [0b11, 3], [0b1, 2], [1 << 9, 1]];
    expect(pdfPageEncodingPages(histogram, "mathFont")).toBe(5);
    expect(pdfPageEncodingPages(histogram, "stackedMath")).toBe(3);
    expect(pdfPageEncodingPages(histogram, "horizontalRuleTable")).toBe(1);
    expect(pdfPageEncodingPages(histogram, "partial")).toBe(0);
    expect(pdfPageEncodingPages(undefined, "mathFont")).toBeUndefined();
  });
});

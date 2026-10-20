import { describe, expect, it } from "vitest";

import { calibrateSegments, readPrintedPageNumber, resolvePrintedPage, segmentsFromPageLabels } from "../deferred/page-labels.js";

const roman = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];
const frontMatterLabels = [...roman, ...Array.from({ length: 300 }, (_, i) => String(i + 1))];

describe("segmentsFromPageLabels", () => {
  it("splits roman front matter from the arabic body that restarts at 1", () => {
    const segments = segmentsFromPageLabels(frontMatterLabels);
    expect(segments).toEqual([
      { physicalStart: 1, physicalEnd: 12, printedStart: 1, style: "roman", offset: 0 },
      { physicalStart: 13, physicalEnd: 312, printedStart: 1, style: "arabic", offset: 12 },
    ]);
  });

  it("resolves printed labels to physical pages", () => {
    const segments = segmentsFromPageLabels(frontMatterLabels);
    expect(resolvePrintedPage("12", segments)).toBe(24);
    expect(resolvePrintedPage("xii", segments)).toBe(12);
    expect(resolvePrintedPage("301", segments)).toBeNull();
    expect(resolvePrintedPage("", segments)).toBeNull();
  });

  it("starts a new segment when the arabic sequence jumps", () => {
    const labels = ["1", "2", "3", "7", "8"];
    expect(segmentsFromPageLabels(labels).map((s) => [s.physicalStart, s.physicalEnd, s.offset])).toEqual([[1, 3, 0], [4, 5, -3]]);
  });
});

describe("calibrateSegments", () => {
  it("derives one offset from agreeing observations", () => {
    const segments = calibrateSegments([
      { physicalPage: 20, printed: "8" },
      { physicalPage: 30, printed: "18" },
      { physicalPage: 40, printed: "28" },
    ], 200);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ offset: 12, style: "arabic", physicalStart: 20, physicalEnd: 200 });
    expect(resolvePrintedPage("18", segments)).toBe(30);
  });

  it("creates a new segment after a plate gap", () => {
    const segments = calibrateSegments([
      { physicalPage: 20, printed: "8" },
      { physicalPage: 30, printed: "18" },
      { physicalPage: 40, printed: "28" },
      { physicalPage: 100, printed: "86" },
      { physicalPage: 110, printed: "96" },
      { physicalPage: 120, printed: "106" },
    ], 200);
    expect(segments.map((s) => s.offset)).toEqual([12, 14]);
    expect(segments[0]!.physicalEnd).toBe(99);
    expect(resolvePrintedPage("96", segments)).toBe(110);
  });

  it("ignores a lone stray observation", () => {
    const segments = calibrateSegments([
      { physicalPage: 20, printed: "8" },
      { physicalPage: 25, printed: "99" },
      { physicalPage: 30, printed: "18" },
      { physicalPage: 40, printed: "28" },
    ], 100);
    expect(segments.map((s) => s.offset)).toEqual([12]);
  });

  it("returns no segments without two agreeing observations", () => {
    expect(calibrateSegments([{ physicalPage: 5, printed: "3" }], 50)).toEqual([]);
  });
});

describe("readPrintedPageNumber", () => {
  it("reads a standalone footer number", () => {
    expect(readPrintedPageNumber("Chapter 3\n...\n\n  147  ")).toBe("147");
  });
  it("reads roman and decorated numbers, ignores prose", () => {
    expect(readPrintedPageNumber("Preface\nSome text\nxiv")).toBe("xiv");
    expect(readPrintedPageNumber("- 12 -\nBody text here and more\nMore body text")).toBe("12");
    expect(readPrintedPageNumber("Body line one\nBody line two\nThe mix of things")).toBeNull();
    expect(readPrintedPageNumber("mix")).toBeNull();
  });
});

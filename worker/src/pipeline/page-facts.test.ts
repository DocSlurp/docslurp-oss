import { describe, expect, it, vi } from "vitest";

import {
  buildPdfPageFacts,
  buildVisionPageFacts,
  parsePdfImagesList,
  plainTextBytes,
  recordPageFacts,
  splitFormFeedPages,
} from "./page-facts.js";

const IMAGES_LIST = `page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio
--------------------------------------------------------------------------------------------
   1     0 image     640   480  rgb     3   8  jpeg   no        12  0    72    72 20.1K 2.2%
   2     1 image    2550  3300  gray    1   1  ccitt  no        20  0   300   300 57.2K 5.6%
   2     2 smask    2550  3300  gray    1   8  image  no        21  0   300   300  1.2K 0.0%
   4     3 image     100   100  rgb     3   8  image  no        30  0    72    72  1.1K 3.7%
   4     4 image     100   100  rgb     3   8  image  no        31  0    72    72  1.1K 3.7%
`;

describe("page facts", () => {
  it("counts collapsed plain-text bytes, so layout padding is not text", () => {
    expect(plainTextBytes("   \n\n  ")).toBe(0);
    expect(plainTextBytes("  Hello   world \n")).toBe(11);
    expect(plainTextBytes("é")).toBe(2);
  });

  it("keeps empty pages in place when splitting on form feeds", () => {
    expect(splitFormFeedPages("one\f\fthree\f", 3)).toEqual(["one", "", "three"]);
    expect(splitFormFeedPages("one\ftwo", 2)).toEqual(["one", "two"]);
    // Misaligned output records nothing rather than shifting pages.
    expect(splitFormFeedPages("one\ftwo\f", 3)).toBeNull();
  });

  it("parses pdfimages -list, ignoring masks", () => {
    expect([...parsePdfImagesList(IMAGES_LIST)]).toEqual([[1, 1], [2, 1], [4, 2]]);
  });

  it("builds per-page rows for a mixed PDF", () => {
    const rows = buildPdfPageFacts({
      documentId: "doc", runId: "run", pageCount: 4,
      pageText: "Born digital page with text\f\fAnother text page\f\f",
      imagesList: IMAGES_LIST,
    });
    expect(rows.map((row) => [row.pageNumber, row.textBytes, row.imageCount])).toEqual([
      [1, 27, 1], [2, 0, 1], [3, 17, 0], [4, 0, 2],
    ]);
    expect(rows[0]!.factsSource).toBe("pdftotext+pdfimages");
  });

  it("records images without text when the text layer does not line up", () => {
    const rows = buildPdfPageFacts({ documentId: "doc", runId: "run", pageCount: 2, pageText: "a\fb\fc\fd", imagesList: "" });
    expect(rows.map((row) => [row.textBytes, row.imageCount, row.factsSource])).toEqual([
      [null, 0, "pdfimages"], [null, 0, "pdfimages"],
    ]);
    expect(buildPdfPageFacts({ documentId: "doc", runId: "run", pageCount: 2, pageText: null, imagesList: null })).toEqual([]);
  });

  it("labels vision outcomes per page", () => {
    const rows = buildVisionPageFacts({
      documentId: "doc", runId: "run", pageCount: 6,
      selected: [2, 3, 5, 6], processed: [{ pageNumber: 2, text: "scanned words" }], cap: 3,
    });
    expect(rows.map((row) => row.visionStatus)).toEqual([
      "not-selected", "extracted", "failed", "not-selected", "failed", "over-cap",
    ]);
    expect(rows[1]!.visionTextBytes).toBe(13);
    expect(buildVisionPageFacts({ documentId: "d", runId: "r", pageCount: 2, selected: [], processed: [], cap: 0, costCapped: true })
      .map((row) => row.visionStatus)).toEqual(["cost-cap", "cost-cap"]);
  });

  it("marks the pages beyond the cap of a priority-ordered selection as over-cap", () => {
    // Vision puts raster-only pages (5, 6) ahead of a text page it also selected (1); cap 2 keeps 5 and 6.
    const rows = buildVisionPageFacts({
      documentId: "doc", runId: "run", pageCount: 6,
      selected: [5, 6, 1], processed: [{ pageNumber: 5, text: "a" }, { pageNumber: 6, text: "b" }], cap: 2,
    });
    expect(rows.map((row) => row.visionStatus)).toEqual([
      "over-cap", "not-selected", "not-selected", "not-selected", "extracted", "extracted",
    ]);
  });

  it("never throws when the write fails", async () => {
    const store = { upsertPageFacts: vi.fn(async () => { throw new Error("db down"); }) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(recordPageFacts(store, [{ documentId: "d", runId: "r", pageNumber: 1, textBytes: 1 }])).resolves.toBeUndefined();
    expect(store.upsertPageFacts).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

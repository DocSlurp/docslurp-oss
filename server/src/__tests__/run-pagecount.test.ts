import { describe, expect, it } from "vitest";

import { estimateNonPdfPageCount, parsePdfInfoPageCount } from "../services/source-metadata.js";

describe("parsePdfInfoPageCount", () => {
  it("extracts the page count from pdfinfo output", () => {
    expect(
      parsePdfInfoPageCount(`Title: sample.pdf
Pages:          14
Encrypted:      no`)
    ).toBe(14);
  });

  it("returns null when pdfinfo output has no page count", () => {
    expect(parsePdfInfoPageCount("Title: sample.pdf")).toBeNull();
  });
});

describe("estimateNonPdfPageCount", () => {
  it("uses line and character heuristics for text formats", () => {
    const text = Array.from({ length: 180 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(estimateNonPdfPageCount("text/plain", Buffer.from(text))).toBe(3);
  });

  it("defaults binary formats to a single page", () => {
    expect(estimateNonPdfPageCount("application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from([1, 2, 3]))).toBe(1);
  });
});

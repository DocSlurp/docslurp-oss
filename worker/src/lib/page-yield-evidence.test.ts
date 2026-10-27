import { describe, expect, it } from "vitest";
import { authorizeStructuredOcr, buildAdaptiveRoutingDecisionSurface } from "../stages/classify-route.js";
import { embeddedImageBytesByPage, pageTextYield } from "./page-yield-evidence.js";

const row = (page: number, object: number, size: string, type = "image") =>
  `${page} 0 ${type} 1000 1000 rgb 3 8 image no ${object} 0 150 150 ${size} 1%`;

describe("embedded image storage evidence", () => {
  it("counts masks, excludes repeated objects per page, and keeps shared pages separate", () => {
    const result = embeddedImageBytesByPage([
      row(1, 10, "2K"), row(1, 10, "2K"), row(1, 11, "512B", "smask"),
      row(2, 10, "2K"), row(2, 12, "1.5M"),
    ].join("\n"));
    expect([...result]).toEqual([[1, 2560], [2, 2048 + 1.5 * 1024 ** 2]]);
  });
  it("does not turn missing, hostile, or truncated sizes into zero-byte evidence", () => {
    for (const size of ["?", "-10", "Infinity", "1e999", "999999999999999999999G"]) {
      expect(embeddedImageBytesByPage(row(1, 10, size)).get(1)).toBeNull();
    }
    expect(embeddedImageBytesByPage(Array.from({ length: 100_001 }, () => row(1, 10, "1K")).join("\n")).size).toBe(0);
  });
  it("counts inline occurrences separately and ignores non-data headers", () => {
    const inline = row(1, 10, "123").replace("10 0", "[inline] -");
    expect([...embeddedImageBytesByPage(`page num type\n${inline}\n${inline}`)]).toEqual([[1, 246]]);
  });
});

const complexity = {
  textLength: 2000, textCoverage: 0.2, hasSubstantialImages: false,
  imageCoverage: 0, largestImageCoverage: 0, fullPageImage: false,
  isGarbled: false, pageArea: 100_000, needsOcr: false, reasons: [],
};

describe("page text yield", () => {
  it("escalates gross text loss even when the remaining text looks plausible", () => {
    expect(authorizeStructuredOcr(complexity, "A readable sentence survived.")).toMatchObject({
      authorized: true, signals: expect.arrayContaining(["ocr-authorized:structured-text-yield-deficit"]),
    });
  });
  it("does not confuse UTF-8 bytes with expected characters", () => {
    const evidence = pageTextYield("漢".repeat(1000), 1000);
    expect(evidence).toMatchObject({ actualTextBytes: 3000, actualCharacters: 1000, substantialDeficit: false });
  });
  it("ignores image payloads and frontmatter when measuring actual yield", () => {
    const text = `---\ntitle: ${"x".repeat(2000)}\n---\n![scan](data:image/png;base64,${"A".repeat(4000)})\nA sentence.`;
    expect(pageTextYield(text, 2000)).toMatchObject({ actualTextBytes: 21, substantialDeficit: true });
  });
  it("handles hostile unclosed image markup without backtracking", () => {
    const text = "![".repeat(100_000);
    expect(pageTextYield(text, 2000).actualCharacters).toBe(text.length);
  });
  it.each(["none", "leading", "trailing"])("does not spend on fabricated page slicing (%s delimiter)", (delimiter) => {
    const text = "Readable text. ".repeat(145);
    const result = buildAdaptiveRoutingDecisionSurface({
      documentId: "doc", filename: "doc.pdf",
      text: delimiter === "leading" ? `\f${text}` : delimiter === "trailing" ? `${text}\f` : text,
      pageCount: 10,
      structuredComplexity: new Map([[1, complexity]]),
      evidence: { source: "canonical-document", artifactUri: "s3://bucket/canonical" },
    });
    expect(result.status).toBe("ready");
    expect(result.pages).toHaveLength(10);
    expect(result.pages[0]?.signals).not.toContain("ocr-authorized:structured-text-yield-deficit");
  });
  it("does not escalate short pages, healthy text, unknown expectations, or image bytes alone", () => {
    expect(authorizeStructuredOcr({ ...complexity, textLength: 30 }, "A title").authorized).toBe(false);
    expect(authorizeStructuredOcr(complexity, "Readable text. ".repeat(100)).authorized).toBe(false);
    for (const expected of [NaN, Infinity, -1, 1.5, Number.MAX_VALUE]) {
      expect(pageTextYield("short", expected).substantialDeficit).toBe(false);
    }
    for (const textCoverage of [NaN, Infinity, -1, 2]) {
      expect(authorizeStructuredOcr({ ...complexity, textCoverage }, "Short text").authorized).toBe(false);
    }
    expect(authorizeStructuredOcr({ ...complexity, textCoverage: 0.01 }, "Short text", {
      pageNumber: 1, wordCount: 2, imageCount: 1, imageCoverage: 0.01,
      largestImageCoverage: 0.01, embeddedImageBytes: 100_000_000,
    }).authorized).toBe(false);
  });
});

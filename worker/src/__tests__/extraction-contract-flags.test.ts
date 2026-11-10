import { describe, expect, it } from "vitest";

import { buildExtractionContract } from "../lib/extraction-contract.js";

const contractOf = (markdown: string, pageCount = 1) =>
  buildExtractionContract({ documentId: "d", markdown, extractor: "test", strategy: "test", extractionTimeMs: 1, pageCount });

describe("extraction contract flags", () => {
  it("does not read a table of contents out of a substring of a heading", () => {
    for (const heading of ["Stockton Notes", "Network Protocol", "The Octocat Story", "Contents of the Box Were Damaged"]) {
      expect(contractOf(`# ${heading}\nBody.`).hasToC).toBe(false);
    }
  });

  it("recognizes a table of contents by its title in other languages", () => {
    for (const heading of ["Table of Contents", "Inhaltsverzeichnis", "Sommaire", "Содержание", "目次", "目录"]) {
      expect(contractOf(`# ${heading}\n1. Intro`).hasToC).toBe(true);
    }
  });

  it("recognizes a table of contents by its dot-leader entries even without a heading", () => {
    const toc = ["Intro ........ 1", "Scope ........ 3", "Terms ........ 5", "Payment ........ 8", "Appendix ........ 12"].join("\n");
    expect(contractOf(toc).hasToC).toBe(true);
    expect(contractOf("Intro ........ 1\nBody text\nScope ........ 3").hasToC).toBe(false);
  });

  it("does not claim a QR code because a page mentions one", () => {
    expect(contractOf("Scan the QR code below to pay.\n![QR Code](qr.png)").hasQRCodes).toBe(false);
  });

  it("estimates tokens for CJK text instead of counting whitespace words", () => {
    const japanese = "請求書の支払期限は来月末日です。".repeat(10);
    expect(contractOf(japanese).metadata.tokenCount).toBeGreaterThan(100);
  });

  it("gives headers no page when the form feeds do not match the page count", () => {
    const text = "# Alpha\nbody\f# Beta\nbody";
    expect(contractOf(text, 2).headers.map((h) => h.pageNumber)).toEqual([1, 2]);
    expect(contractOf(text, 5).headers.map((h) => h.pageNumber)).toEqual([null, null]);
  });
});

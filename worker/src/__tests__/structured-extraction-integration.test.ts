import { describe, expect, it } from "vitest";

import { buildCanonicalChunksFromDocument } from "../lib/canonical-document.js";
import { parseDocumentExtractionResult } from "../lib/document-extraction-adapter.js";
import { buildCanonicalDocumentFromStructuredExtraction } from "../lib/structured-canonical.js";

describe("structured extraction to canonical integration", () => {
  it("preserves one-pass LiteParse geometry through canonical chunks", () => {
    const extraction = parseDocumentExtractionResult({
      adapter: "liteparse",
      version: "2.6.0",
      markdown: "# Accounts\n\n| Name | Balance |\n| --- | --- |\n| Acme | $42 |",
      rawText: "Accounts Name Balance Acme $42",
      pages: [{
        pageNumber: 1,
        width: 612,
        height: 792,
        text: "Accounts Name Balance Acme $42",
        markdown: "# Accounts\n\n| Name | Balance |\n| --- | --- |\n| Acme | $42 |",
        textItems: [
          {
            text: "Accounts",
            x: 24,
            y: 30,
            width: 90,
            height: 18,
            fontName: "Inter-Bold",
            fontSize: 16,
            confidence: 0.99,
            rotation: 0,
            words: [{ text: "Accounts", x: 24, y: 30, width: 90, height: 18 }],
          },
          {
            text: "Name Balance Acme $42",
            x: 24,
            y: 80,
            width: 260,
            height: 72,
            confidence: 0.98,
            rotation: 0,
            words: [],
          },
        ],
        complexity: {
          textLength: 31,
          textCoverage: 0.04,
          hasSubstantialImages: false,
          imageBlockCount: 0,
          imageCoverage: 0,
          largestImageCoverage: 0,
          fullPageImage: false,
          isGarbled: false,
          pageArea: 484_704,
          needsOcr: true,
          reasons: ["sparse-text"],
        },
      }],
      diagnostics: { latencyMs: 8, ocrEnabled: false },
    });

    const canonical = buildCanonicalDocumentFromStructuredExtraction({
      documentId: "doc-integration",
      extractor: extraction.adapter,
      sourceArtifactUri: "s3://sources/document.pdf",
      parserArtifactUri: "s3://artifacts/document.liteparse.json",
      pages: extraction.pages,
    });
    const chunks = buildCanonicalChunksFromDocument(canonical, extraction.rawText);
    const table = canonical.blocks.find((block) => block.type === "table");
    const tableChunk = chunks.find((chunk) => chunk.tableGranularity === "table");

    expect(table?.bbox).toEqual({ x: 24, y: 80, width: 260, height: 72 });
    expect(tableChunk?.regionCoordinateSpace).toBe("page-top-left-points");
    expect(tableChunk?.sourceTrace).toMatchObject({
      extractor: "liteparse",
      sourceArtifactUri: "s3://sources/document.pdf",
      parserArtifactUri: "s3://artifacts/document.liteparse.json",
      pageNumbers: [1],
    });
  });

});

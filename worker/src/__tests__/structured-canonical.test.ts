import { describe, expect, it } from "vitest";

import { buildCanonicalChunksFromDocument } from "../lib/canonical-document.js";
import { buildCanonicalDocumentFromStructuredExtraction } from "../lib/structured-canonical.js";

describe("buildCanonicalDocumentFromStructuredExtraction", () => {
  it("builds typed blocks and attaches many-to-one geometry from the same parser result", () => {
    const document = buildCanonicalDocumentFromStructuredExtraction({
      documentId: "doc-structured",
      extractor: "liteparse",
      sourceArtifactUri: "s3://source/document.pdf",
      parserArtifactUri: "s3://artifacts/liteparse.json",
      pages: [{
        pageNumber: 1,
        width: 612,
        height: 792,
        markdown: "# Revenue\nNorth America grew 20%.",
        text: "Revenue North America grew 20%.",
        textItems: [
          {
            text: "Revenue",
            x: 20,
            y: 30,
            width: 100,
            height: 20,
            fontName: "Inter-Bold",
            fontSize: 18,
            confidence: 0.99,
          },
          {
            text: "North America",
            x: 20,
            y: 70,
            width: 120,
            height: 12,
            fontName: "Inter",
            fontSize: 11,
            confidence: 0.96,
            words: [
              { text: "North", x: 20, y: 70, width: 45, height: 12 },
              { text: "America", x: 70, y: 70, width: 70, height: 12 },
            ],
          },
          {
            text: "grew 20%.",
            x: 145,
            y: 70,
            width: 70,
            height: 12,
            fontName: "Inter",
            fontSize: 11,
            confidence: 0.94,
          },
        ],
      }],
    });

    expect(document.generator).toBe("structured-extraction-block-tree@v1");
    expect(document.source.parser).toBe("liteparse");
    expect(document.blocks.map((block) => block.type)).toEqual(["heading", "paragraph"]);
    expect(document.blocks[0]?.bbox).toEqual({ x: 20, y: 30, width: 100, height: 20 });
    expect(document.blocks[1]?.bbox).toEqual({ x: 20, y: 70, width: 195, height: 12 });
    expect(document.blocks[1]?.metadata.parserTextItemCount).toBe(2);
    expect(document.blocks[1]?.metadata.wordBoxes).toHaveLength(2);
    expect(document.blocks[1]?.metadata.bboxCoordinateSpace).toBe("page-top-left-points");
  });

  it("preserves structured table geometry and source trace on derived chunks", () => {
    const document = buildCanonicalDocumentFromStructuredExtraction({
      documentId: "doc-table",
      extractor: "liteparse",
      sourceArtifactUri: "s3://source/table.pdf",
      parserArtifactUri: "s3://artifacts/table.liteparse.json",
      pages: [{
        pageNumber: 1,
        width: 612,
        height: 792,
        markdown: "| Item | Total |\n| --- | --- |\n| Seats | $120 |",
        text: "Item Total Seats $120",
        textItems: [{
          text: "Item Total Seats $120",
          x: 40,
          y: 100,
          width: 260,
          height: 80,
        }],
      }],
    });

    const table = document.blocks.find((block) => block.type === "table");
    expect(table?.bbox).toEqual({ x: 40, y: 100, width: 260, height: 80 });

    const chunks = buildCanonicalChunksFromDocument(document, "fallback");
    const tableChunk = chunks.find((chunk) => chunk.tableGranularity === "table");
    expect(tableChunk?.regionBoxes?.[0]).toMatchObject({ pageNumber: 1, x: 40, y: 100 });
    expect(tableChunk?.sourceTrace).toMatchObject({
      extractor: "liteparse",
      parserArtifactUri: "s3://artifacts/table.liteparse.json",
      sourceArtifactUri: "s3://source/table.pdf",
      pageNumbers: [1],
    });
  });

  it("does not invent geometry when structured text cannot be aligned exactly", () => {
    const document = buildCanonicalDocumentFromStructuredExtraction({
      documentId: "doc-unmatched",
      extractor: "liteparse",
      pages: [{
        pageNumber: 1,
        width: 100,
        height: 100,
        markdown: "Expected canonical text",
        text: "Different parser text",
        textItems: [{ text: "Different parser text", x: 1, y: 2, width: 3, height: 4 }],
      }],
    });

    expect(document.blocks[0]?.bbox).toBeNull();
    expect(document.blocks[0]?.metadata.structuredEvidenceMatched).toBe(false);
  });

  it("keeps explicit non-contiguous page numbers", () => {
    const document = buildCanonicalDocumentFromStructuredExtraction({
      documentId: "doc-pages",
      extractor: "liteparse",
      pages: [{
        pageNumber: 3,
        width: 100,
        height: 100,
        markdown: "Third page",
        text: "Third page",
        textItems: [{ text: "Third page", x: 1, y: 2, width: 30, height: 4 }],
      }],
    });

    expect(document.blocks[0]?.pageNumber).toBe(3);
    expect(document.stats.pageCount).toBe(3);
  });
});

import { describe, expect, it } from "vitest";

import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import {
  enrichCanonicalDocumentWithBestParser,
  enrichCanonicalDocumentWithNativePdf,
  scoreParserEnrichments
} from "../lib/parser-canonical.js";

describe("enrichCanonicalDocumentWithNativePdf", () => {
  it("adds parser page numbers and bounding boxes to aligned canonical blocks", () => {
    const base = buildCanonicalDocumentFromMarkdown({
      documentId: "doc-1",
      text: "# Intro\nHello world.\n\nSecond paragraph.",
      pageCount: 1,
      extractor: "pandoc"
    });

    const enriched = enrichCanonicalDocumentWithNativePdf(base, {
      pages: [
        {
          blocks: [
            {
              bbox: [10, 20, 110, 40],
              lines: [
                {
                  spans: [{ text: "# Intro", size: 18, font: "Helvetica-Bold" }]
                }
              ]
            },
            {
              bbox: [10, 50, 210, 90],
              lines: [
                {
                  spans: [{ text: "Hello world.", size: 12, font: "Helvetica" }]
                }
              ]
            },
            {
              bbox: [10, 100, 260, 140],
              lines: [
                {
                  spans: [{ text: "Second paragraph.", size: 12, font: "Helvetica" }]
                }
              ]
            }
          ]
        }
      ]
    }, "s3://bucket/doc-1.native-pdf.json");

    expect(enriched.source.parser).toBe("native-pdf");
    expect(enriched.source.parserArtifactUri).toBe("s3://bucket/doc-1.native-pdf.json");
    expect(enriched.blocks[0]?.bbox).toEqual({ x: 10, y: 20, width: 100, height: 20 });
    expect(enriched.blocks[1]?.pageNumber).toBe(1);
    expect(enriched.blocks[0]?.metadata.bboxCoordinateSpace).toBe("page-top-left-points");
    expect(enriched.blocks[1]?.metadata.parserMatched).toBe(true);
  });

  it("leaves unmatched blocks intact when parser text cannot be aligned", () => {
    const base = buildCanonicalDocumentFromMarkdown({
      documentId: "doc-2",
      text: "Alpha paragraph.",
      pageCount: 1,
      extractor: "pandoc"
    });

    const enriched = enrichCanonicalDocumentWithNativePdf(base, {
      pages: [{ blocks: [{ bbox: [0, 0, 10, 10], lines: [{ spans: [{ text: "Different text" }] }] }] }]
    });

    expect(enriched.blocks[0]?.bbox).toBeNull();
    expect(enriched.blocks[0]?.metadata.parserMatched).toBe(false);
  });

  it("picks the parser candidate with the strongest alignment coverage", () => {
    const base = buildCanonicalDocumentFromMarkdown({
      documentId: "doc-3",
      text: "# Intro\nHello world.",
      pageCount: 1,
      extractor: "pandoc"
    });

    const enriched = enrichCanonicalDocumentWithBestParser(base, [
      {
        parser: "unstructured",
        artifactUri: "s3://bucket/doc-3.unstructured.json",
        payload: [
          {
            type: "Title",
            text: "# Intro",
            metadata: {
              page_number: 1
            }
          }
        ]
      },
      {
        parser: "native-pdf",
        artifactUri: "s3://bucket/doc-3.native-pdf.json",
        payload: {
          pages: [
            {
              blocks: [
                {
                  bbox: [0, 0, 50, 10],
                  lines: [{ spans: [{ text: "# Intro" }] }]
                },
                {
                  bbox: [0, 12, 100, 22],
                  lines: [{ spans: [{ text: "Hello world." }] }]
                }
              ]
            }
          ]
        }
      }
    ]);

    expect(enriched.source.parser).toBe("native-pdf");
    expect(enriched.blocks.filter((block) => block.metadata.parserMatched === true)).toHaveLength(2);
  });

  it("returns parser scoring summaries for later benchmark persistence", () => {
    const base = buildCanonicalDocumentFromMarkdown({
      documentId: "doc-4",
      text: "Alpha paragraph.",
      pageCount: 1,
      extractor: "pandoc"
    });

    const scores = scoreParserEnrichments(base, [
      {
        parser: "unstructured",
        artifactUri: "s3://bucket/doc-4.unstructured.json",
        payload: [
          {
            type: "NarrativeText",
            text: "Alpha paragraph.",
            metadata: { page_number: 1 }
          }
        ]
      }
    ]);

    expect(scores).toHaveLength(1);
    expect(scores[0]?.parser).toBe("unstructured");
    expect(scores[0]?.matchRatio).toBeGreaterThan(0);
  });

  it("keeps missing unstructured page numbers as null instead of coercing to page 1", () => {
    const base = buildCanonicalDocumentFromMarkdown({
      documentId: "doc-5",
      text: "Alpha paragraph.",
      pageCount: 1,
      extractor: "pandoc"
    });

    const enriched = enrichCanonicalDocumentWithBestParser(base, [
      {
        parser: "unstructured",
        artifactUri: "s3://bucket/doc-5.unstructured.json",
        payload: [
          {
            type: "NarrativeText",
            text: "Alpha paragraph.",
            metadata: {}
          }
        ]
      }
    ]);

    expect(enriched.blocks[0]?.pageNumber).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { buildCanonicalChunksFromDocument } from "../lib/canonical-document.js";
import { buildExtractionContract } from "../lib/extraction-contract.js";
import { reconcileCanonicalArtifacts } from "../lib/canonical-reconciliation.js";

function baseline() {
  const markdown = "# First\n\nweak scan one\f# Second\n\nkeep this\f# Third\n\nweak scan three";
  const canonicalDocument = buildCanonicalDocumentFromMarkdown({
    documentId: "doc-1",
    text: markdown,
    pageCount: 3,
    extractor: "baseline",
  });
  const extractionContract = buildExtractionContract({
    documentId: "doc-1",
    markdown,
    extractor: "baseline",
    strategy: "fast",
    extractionTimeMs: 10,
    pageCount: 3,
    canonicalDocument,
  });
  return { canonicalDocument, extractionContract };
}

describe("Canonical Reconciliation Module", () => {
  it("preserves explicit visual relationships through canonical and contract rebuilding", () => {
    const markdown = [
      "## Chart", "", "Horizontal axis: elapsed time (s); ticks: 0, 5, 10.",
      "Vertical axis: pressure (kPa); ticks: 0, 20, 40.",
      "Series: inlet (solid), outlet (dashed). Unlabeled values are unknown.", "",
      "| Printed time (s) | Printed inlet pressure (kPa) |",
      "| --- | --- |", "| 5 | 20 |", "", "## Diagram", "",
      "- Enclosure contains pump and valve.",
      "- Pump → valve: supply.", "- Valve → pump: return.",
    ].join("\n");
    const result = reconcileCanonicalArtifacts({
      ...baseline(),
      replacements: [{ pageNumber: 3, markdown, source: {
        adapter: "vision", model: "synthetic", confidence: 0.9,
        confidenceBasis: "page-triage", reason: "figure-content",
      } }],
    });
    expect(result.changedPages).toEqual([3]);
    for (const fact of ["elapsed time (s)", "ticks: 0, 20, 40", "outlet (dashed)",
      "Unlabeled values are unknown", "| 5 | 20 |", "contains pump and valve",
      "Pump → valve: supply", "Valve → pump: return"]) {
      expect(result.markdown).toContain(fact);
      expect(result.extractionContract.markdown).toContain(fact);
      expect(result.rawText).toContain(fact);
    }
    expect(result.markdown.split("\f")[1]).toContain("keep this");
  });

  it.each(["", "Existing native text"])("handles missing triage confidence with native text %j", (text) => {
    const canonicalDocument = buildCanonicalDocumentFromMarkdown({
      documentId: "scan", text, pageCount: 1, extractor: "baseline",
    });
    const extractionContract = buildExtractionContract({
      documentId: "scan", markdown: text, pageCount: 1,
      extractor: "baseline", strategy: "fast", extractionTimeMs: 1, canonicalDocument,
    });
    const result = reconcileCanonicalArtifacts({
      canonicalDocument, extractionContract,
      replacements: [1].map((pageNumber) => ({
        pageNumber, markdown: "Recovered scanned paragraph",
        source: { adapter: "vision", model: "test", confidence: 0,
          confidenceBasis: "page-triage" as const, reason: "missing-page-triage-evidence" },
      })),
    });
    expect(result.changedPages).toEqual(text ? [] : [1]);
    expect(result.rawText).toContain(text || "Recovered scanned paragraph");
    expect(result.decisions[0].outcome).toBe(text ? "rejected" : "accepted");
  });

  it("replaces multiple weak pages while retaining untouched blocks and provenance", () => {
    const input = baseline();
    const untouchedIds = input.canonicalDocument.blocks
      .filter((block) => block.pageNumber === 2)
      .map((block) => block.id);
    const result = reconcileCanonicalArtifacts({
      ...input,
      replacements: [
        {
          pageNumber: 1,
          markdown: "# Recovered first\n\nFaithful OCR page one.",
          source: {
            adapter: "vision",
            model: "test-vision",
            confidence: 0.83,
            confidenceBasis: "page-triage",
            reason: "degraded-native-text",
            artifactUri: "s3://bucket/vision.json",
          },
        },
        {
          pageNumber: 3,
          markdown: "# Recovered third\n\nFaithful OCR page three.",
          source: {
            adapter: "vision",
            model: "test-vision",
            confidence: 0.91,
            confidenceBasis: "page-triage",
            reason: "scan-page",
          },
        },
      ],
    });

    expect(result.changedPages).toEqual([1, 3]);
    expect(result.markdown).toContain("Recovered first");
    expect(result.rawText).toContain("Faithful OCR page three.");
    expect(result.canonicalDocument.blocks.filter((block) => block.pageNumber === 2).map((block) => block.id))
      .toEqual(untouchedIds);
    expect(result.canonicalDocument.blocks.find((block) => block.pageNumber === 1)?.metadata.provenance)
      .toMatchObject({
        kind: "specialist-replacement",
        adapter: "vision",
        model: "test-vision",
        confidence: 0.83,
      });
    const reconciledChunk = buildCanonicalChunksFromDocument(
      result.canonicalDocument,
      "fallback",
    ).find((chunk) => chunk.pageNumber === 1);
    expect(reconciledChunk?.sourceTrace).toMatchObject({
      extractor: "vision",
      sourceArtifactUri: "s3://bucket/vision.json",
      pageNumbers: [1],
    });
  });

  it("rejects empty, unchanged, low-confidence, and out-of-range candidates without mutation", () => {
    const input = baseline();
    const result = reconcileCanonicalArtifacts({
      ...input,
      replacements: [
        {
          pageNumber: 1,
          markdown: "",
          source: { adapter: "vision", model: "m", confidence: 0.9, confidenceBasis: "page-triage", reason: "scan" },
        },
        {
          pageNumber: 2,
          markdown: "# Second\n\nkeep this",
          source: { adapter: "vision", model: "m", confidence: 0.9, confidenceBasis: "page-triage", reason: "scan" },
        },
        {
          pageNumber: 3,
          markdown: "better but uncertain",
          source: { adapter: "vision", model: "m", confidence: 0.2, confidenceBasis: "page-triage", reason: "scan" },
        },
        {
          pageNumber: 4,
          markdown: "not a real page",
          source: { adapter: "vision", model: "m", confidence: 0.9, confidenceBasis: "page-triage", reason: "scan" },
        },
      ],
    });

    expect(result.changedPages).toEqual([]);
    expect(result.canonicalDocument).toEqual(input.canonicalDocument);
    expect(result.decisions.map((decision) => decision.reason)).toEqual([
      "empty-specialist-output",
      "unchanged-specialist-output",
      "confidence-below-threshold",
      "page-out-of-range",
    ]);
  });

  it("makes reconciled page text visible through the downstream extraction contract", () => {
    const input = baseline();
    const result = reconcileCanonicalArtifacts({
      ...input,
      replacements: [
        {
          pageNumber: 1,
          markdown: "# Invoice\n\nTotal due: $42.00",
          source: {
            adapter: "vision",
            model: "test-vision",
            confidence: 0.88,
            confidenceBasis: "page-triage",
            reason: "weak-page-triage",
          },
        },
      ],
    });

    expect(result.extractionContract.markdown).toContain("Total due: $42.00");
    expect(result.extractionContract.rawText).toContain("Total due: $42.00");
    expect(result.extractionContract.metadata.strategy).toContain("canonical-reconciliation");
    expect(result.extractionContract.markdown).not.toContain("weak scan one");
  });
});

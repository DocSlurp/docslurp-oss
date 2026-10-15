import { describe, expect, it } from "vitest";

import {
  buildCorrectionProfileSummary,
  buildReviewFailureModes,
  calculateReviewSeverity,
  classifyCorrectionDocumentType,
  chunkCorrectionPage,
  deriveCorrectionPatternSignals,
  splitMarkdownIntoPages
} from "../services/document-review.js";

describe("splitMarkdownIntoPages", () => {
  it("splits markdown on explicit page breaks", () => {
    expect(splitMarkdownIntoPages("page one\fpage two")).toEqual(["page one", "page two"]);
  });

  it("splits markdown on horizontal rule separators", () => {
    expect(splitMarkdownIntoPages("page one\n---\npage two")).toEqual(["page one", "page two"]);
  });

  it("uses the shared fallback splitter when a target page count is provided", () => {
    const pages = splitMarkdownIntoPages("abcdefghij", 3);
    expect(pages).toHaveLength(3);
    expect(pages.join("")).toBe("abcdefghij");
  });
});

describe("chunkCorrectionPage", () => {
  it("keeps paragraph groups within the chunk size", () => {
    const chunks = chunkCorrectionPage("alpha\n\nbeta\n\ngamma", 10);
    expect(chunks).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns at least one chunk for non-empty pages", () => {
    expect(chunkCorrectionPage("single paragraph")).toEqual(["single paragraph"]);
  });
});

describe("calculateReviewSeverity", () => {
  it("weights low quality, retries, failures, schema errors, and cost", () => {
    expect(
      calculateReviewSeverity({
        plausibilityScore: 0.4,
        retries: 2,
        failedStages: 1,
        schemaErrors: 1,
        estimatedCostCents: 250
      })
    ).toBe(154);
  });
});

describe("classifyCorrectionDocumentType", () => {
  it("groups common file types into practical profile buckets", () => {
    expect(
      classifyCorrectionDocumentType({
        filename: "contract.pdf",
        mimeType: "application/pdf"
      })
    ).toEqual({ key: "pdf", label: "PDF documents" });

    expect(
      classifyCorrectionDocumentType({
        filename: "slides.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      })
    ).toEqual({ key: "presentation", label: "Presentations" });
  });
});

describe("deriveCorrectionPatternSignals", () => {
  it("captures correction patterns from markdown shape, structured patches, and notes", () => {
    expect(
      deriveCorrectionPatternSignals({
        correctedMarkdown: "| Header |\n| --- |\n| Value |\n\n1. First\n2. Second\n\n---\nPage 2",
        structuredData: { vendor: "DocSlurp" },
        notes: "OCR cleanup for table columns and page split",
        failureModes: buildReviewFailureModes({
          plausibilityScore: 0.4,
          retries: 1,
          failedStages: 1,
          schemaErrors: 1,
          failedStageNames: ["structured-extract"]
        })
      })
    ).toEqual(
      expect.arrayContaining([
        "markdown_rewrite",
        "structured_patch",
        "schema_repair",
        "table_structure",
        "list_cleanup",
        "page_segmentation",
        "ocr_cleanup",
        "layout_repair"
      ])
    );
  });
});

describe("buildCorrectionProfileSummary", () => {
  it("aggregates workspace correction history by document type and exposes reusable examples", () => {
    const summary = buildCorrectionProfileSummary({
      document: {
        id: "doc-current",
        workspace_id: "ws-1",
        filename: "invoice.pdf",
        mime_type: "application/pdf",
        extraction_mode: "balanced"
      },
      correction: {
        id: "corr-current",
        document_id: "doc-current",
        run_id: "run-1",
        user_id: "user-1",
        corrected_markdown: "Corrected invoice markdown",
        corrected_structured_data: { total: 42 },
        notes: "Fixed table headers and OCR typos",
        reindex_requested_at: "2026-03-10T10:00:00.000Z",
        reindex_completed_at: "2026-03-10T10:05:00.000Z",
        created_at: "2026-03-10T10:00:00.000Z",
        updated_at: "2026-03-10T10:05:00.000Z"
      },
      reviewSignal: {
        document_id: "doc-current",
        plausibility_score: 0.42,
        retries: 1,
        failed_stages: 1,
        schema_errors: 1,
        failed_stage_names: ["structured-extract"]
      },
      history: [
        {
          document_id: "doc-current",
          workspace_id: "ws-1",
          filename: "invoice.pdf",
          mime_type: "application/pdf",
          extraction_mode: "balanced",
          page_count: 4,
          correction_id: "corr-current",
          corrected_markdown: "Corrected invoice markdown",
          corrected_structured_data: { total: 42 },
          notes: "Fixed table headers and OCR typos",
          reindex_requested_at: "2026-03-10T10:00:00.000Z",
          reindex_completed_at: "2026-03-10T10:05:00.000Z",
          correction_created_at: "2026-03-10T10:00:00.000Z",
          correction_updated_at: "2026-03-10T10:05:00.000Z",
          plausibility_score: 0.42,
          retries: 1,
          failed_stages: 1,
          schema_errors: 1,
          failed_stage_names: ["structured-extract"]
        },
        {
          document_id: "doc-peer",
          workspace_id: "ws-1",
          filename: "invoice-2.pdf",
          mime_type: "application/pdf",
          extraction_mode: "balanced",
          page_count: 2,
          correction_id: "corr-peer",
          corrected_markdown: "| Item |\n| --- |\n| Value |",
          corrected_structured_data: null,
          notes: "Fixed table columns",
          reindex_requested_at: null,
          reindex_completed_at: null,
          correction_created_at: "2026-03-11T10:00:00.000Z",
          correction_updated_at: "2026-03-11T10:05:00.000Z",
          plausibility_score: 0.51,
          retries: 0,
          failed_stages: 0,
          schema_errors: 0,
          failed_stage_names: []
        },
        {
          document_id: "doc-other-type",
          workspace_id: "ws-1",
          filename: "meeting.mp3",
          mime_type: "audio/mpeg",
          extraction_mode: "balanced",
          page_count: 1,
          correction_id: "corr-audio",
          corrected_markdown: "Transcript fix",
          corrected_structured_data: null,
          notes: "Speaker labels",
          reindex_requested_at: null,
          reindex_completed_at: null,
          correction_created_at: "2026-03-11T12:00:00.000Z",
          correction_updated_at: "2026-03-11T12:05:00.000Z",
          plausibility_score: 0.8,
          retries: 0,
          failed_stages: 0,
          schema_errors: 0,
          failed_stage_names: []
        }
      ]
    });

    expect(summary.profileKey).toBe("ws-1:pdf");
    expect(summary.summary.correctedDocuments).toBe(2);
    expect(summary.summary.reindexedDocuments).toBe(1);
    expect(summary.summary.pendingReindexDocuments).toBe(1);
    expect(summary.recurringFailureModes.map((mode) => mode.code)).toEqual(
      expect.arrayContaining(["low_plausibility", "schema_validation", "stage:structured-extract"])
    );
    expect(summary.correctionPatterns.map((pattern) => pattern.key)).toEqual(
      expect.arrayContaining(["markdown_rewrite", "table_structure", "schema_repair"])
    );
    expect(summary.currentDocumentSignals).toEqual(
      expect.arrayContaining(["markdown_rewrite", "structured_patch", "schema_repair"])
    );
    expect(summary.examples).toHaveLength(1);
    expect(summary.examples[0]?.documentId).toBe("doc-peer");
    expect(summary.examples[0]?.correctedMarkdownPreview).toContain("| Item |");
  });
});

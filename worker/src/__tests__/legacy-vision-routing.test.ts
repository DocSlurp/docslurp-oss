import { describe, expect, it } from "vitest";
import {
  buildAdaptiveRoutingDecisionSurface,
  classifyAdaptivePage,
  classifyTextAndFilename,
  DRAWN_CONTENT_MIN_BYTES_PER_PAGE,
  selectLegacyVisionPages,
} from "../stages/classify-route.js";
import { findSparsePages, imageFilePageEvidence, nativePageWords, type PageImageEvidence } from "../lib/page-image-evidence.js";
import { shouldFailOpenVisionError } from "../stages/vision-extract.js";
import { VisionOutputRejectedError } from "../tools/vision-stream.js";
import { ProviderRetryableError } from "../lib/provider-retry.js";

// Generic OCR-shaped prose: word-shaped, plausible, and carrying no structure.
const OCR_PROSE = Array.from({ length: 12 }, (_, index) =>
  `Line ${index + 1} of recovered text where the reader moved along the page and noted what was seen there today.`,
).join("\n");

function surface(args: {
  text: string;
  pageCount?: number;
  evidence?: PageImageEvidence[];
  sourceBytesPerPage?: number | null;
}) {
  return buildAdaptiveRoutingDecisionSurface({
    documentId: "doc-1",
    filename: "upload.pdf",
    text: args.text,
    pageCount: args.pageCount ?? 1,
    evidence: { source: "canonical-document", artifactUri: "s3://bucket/canonical.json" },
    pageImageEvidence: new Map((args.evidence ?? []).map((page) => [page.pageNumber, page])),
    sourceBytesPerPage: args.sourceBytesPerPage ?? null,
  });
}

function selected(result: ReturnType<typeof surface>): number[] {
  if (result.status !== "ready") return [];
  return selectLegacyVisionPages(result.pages);
}

describe("OCR provenance in page triage", () => {
  it("counts a page's native words from its text layer, not from OCR text", () => {
    expect(nativePageWords(OCR_PROSE)).toBeGreaterThan(30);
    expect(nativePageWords(OCR_PROSE, "")).toBe(0);
    expect(nativePageWords(OCR_PROSE, null)).toBeGreaterThan(30);
    // Text layer present: the smaller count wins, so a born-digital page stays dense.
    expect(nativePageWords(OCR_PROSE, OCR_PROSE)).toBeGreaterThan(30);
  });

  it("treats an OCR'd page with an empty text layer as sparse", () => {
    expect([...findSparsePages([OCR_PROSE, OCR_PROSE], ["", OCR_PROSE]).keys()]).toEqual([1]);
    // Unknown text layer for a page (past the page-facts range) keeps the extracted count.
    expect([...findSparsePages([OCR_PROSE, OCR_PROSE], [""]).keys()]).toEqual([1]);
  });

  it("sends a scanned page with plausible OCR text to vision", () => {
    const scan: PageImageEvidence = { pageNumber: 1, wordCount: 0, imageCount: 1, imageCoverage: 1, largestImageCoverage: 1 };
    expect(selected(surface({ text: OCR_PROSE }))).toEqual([]);
    const routed = surface({ text: OCR_PROSE, evidence: [scan] });
    expect(selected(routed)).toEqual([1]);
    expect(routed.status === "ready" && routed.visionPolicy).toBe("aggressive");
  });

  it("sends an uploaded image to vision whatever its OCR text says", () => {
    expect(selected(surface({ text: OCR_PROSE, evidence: imageFilePageEvidence() }))).toEqual([1]);
  });

  it("keeps a table route for an OCR'd scan whose text keeps numeric rows", () => {
    const rows = ["Item Qty Price", "Bolts 12 4.50", "Nuts 30 2.10", "Washers 100 1.25", "Total 142 7.85"].join("\n");
    const routed = surface({
      text: rows,
      evidence: [{ pageNumber: 1, wordCount: 0, imageCount: 1, imageCoverage: 1, largestImageCoverage: 1 }],
    });
    expect(routed.status === "ready" && routed.pages[0]!.route).toBe("table-heavy");
    expect(selected(routed)).toEqual([1]);
  });
});

describe("documents without any extracted text", () => {
  const empty: PageImageEvidence = { pageNumber: 1, wordCount: 0, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0 };

  it("sends drawn-content pages (path-only text) to vision", () => {
    expect(selected(surface({ text: "", evidence: [empty], sourceBytesPerPage: DRAWN_CONTENT_MIN_BYTES_PER_PAGE * 20 }))).toEqual([1]);
  });

  it("keeps small blank documents out of vision", () => {
    expect(selected(surface({ text: "", evidence: [empty], sourceBytesPerPage: 900 }))).toEqual([]);
    expect(selected(surface({ text: "", evidence: [empty] }))).toEqual([]);
  });

  it("keeps a blank page blank beside pages with text", () => {
    const routed = surface({
      text: `${OCR_PROSE}\f`,
      pageCount: 2,
      evidence: [{ ...empty, pageNumber: 2 }],
      sourceBytesPerPage: DRAWN_CONTENT_MIN_BYTES_PER_PAGE * 20,
    });
    expect(selected(routed)).toEqual([]);
  });
});

describe("legacy vision page selector", () => {
  it("admits formula pages", () => {
    const formula = classifyAdaptivePage(1, [
      "The loss is defined as follows.",
      "L(x) = \\sum_i \\alpha_i (y_i - f(x_i))^2",
      "where f(x) = w^T x + b and the gradient is",
      "dL/dw = -2 \\sum_i \\alpha_i (y_i - f(x_i)) x_i",
    ].join("\n"));
    expect(formula.route).toBe("formula-heavy");
    expect(selectLegacyVisionPages([formula])).toEqual([1]);
  });

  it("lets the text route decide when raster evidence does not authorize OCR", () => {
    const chart = classifyAdaptivePage(1, "Figure 3: quarterly revenue chart with legend and axis labels, Q1 Q2 Q3 up 12%");
    expect(chart.extractorHint).toBe("vision-rescue");
    const minorImage = { ...chart, ocrDecision: { authorized: false, confidence: 0.8, signals: ["ocr-not-authorized:minor-images=1"] } };
    expect(selectLegacyVisionPages([minorImage])).toEqual([1]);
    const blank = { ...chart, ocrDecision: { authorized: false, confidence: 0.9, signals: ["ocr-not-authorized:blank-page"] } };
    expect(selectLegacyVisionPages([blank])).toEqual([]);
  });

  it("leaves dense prose pages on native text", () => {
    expect(selectLegacyVisionPages([classifyAdaptivePage(1, OCR_PROSE)])).toEqual([]);
  });
});

describe("document labels", () => {
  it("does not read invoice or contract terms out of longer words", () => {
    const notes = "Field observation log. We determine the conservation status of private plots and elevated terraces.";
    expect(classifyTextAndFilename(notes, "notes.pdf").label).toBe("generic");
  });

  it("still labels real invoices and contracts", () => {
    expect(classifyTextAndFilename("Invoice # 1042\nBilled to: Example Co\nSubtotal 40.00", "scan.pdf").label).toBe("invoice");
    expect(classifyTextAndFilename("Bill to Example Co. Amount due 40.00. VAT 8.00", "scan.pdf").label).toBe("invoice");
    expect(classifyTextAndFilename("This agreement between the parties is subject to governing law.", "a.pdf").label).toBe("contract");
  });
});

describe("rejected vision output", () => {
  it("fails open per page so the page keeps its text", () => {
    const rejected = new VisionOutputRejectedError("vision output rejected: leader-run", [], 10, 10, 0);
    expect(shouldFailOpenVisionError(rejected)).toBe(true);
    expect(shouldFailOpenVisionError(new Error("wrapped", { cause: rejected }))).toBe(true);
  });

  it("still retries throttling", () => {
    expect(shouldFailOpenVisionError(new ProviderRetryableError("429", "openrouter", 429, null, 3))).toBe(false);
  });
});

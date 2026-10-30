import { describe, expect, it } from "vitest";
import {
  buildAdaptiveRoutingDecisionSurface,
  classifyAdaptivePage,
  classifyTextAndFilename,
  CLASSIFY_TEXT_MAX_CHARS,
  DRAWN_CONTENT_MIN_BYTES_PER_PAGE,
  hasDistinctTerms,
  selectLegacyVisionPages,
} from "../stages/classify-route.js";
import {
  drawnBytesPerPage,
  findSparsePages,
  imageFilePageEvidence,
  nativePageWords,
  totalEmbeddedImageBytes,
  type PageImageEvidence,
} from "../lib/page-image-evidence.js";
import { shouldFailOpenVisionError } from "../stages/vision-extract.js";
import { VisionOutputRejectedError } from "../tools/vision-stream.js";
import { ProviderRetryableError } from "../lib/provider-retry.js";

// These cases run with legacy vision routing v2 on (VISION_ROUTING_V2); the gated changes are
// v2-only, so off must keep v1 routing (checked at the end).
const V2 = { routingV2: true } as const;

// Generic OCR-shaped prose: word-shaped, plausible, and carrying no structure.
const OCR_PROSE = Array.from({ length: 12 }, (_, index) =>
  `Line ${index + 1} of recovered text where the reader moved along the page and noted what was seen there today.`,
).join("\n");

function surface(args: {
  text: string;
  pageCount?: number;
  evidence?: PageImageEvidence[];
  drawnBytesPerPage?: number | null;
  routingV2?: boolean;
}) {
  return buildAdaptiveRoutingDecisionSurface({
    documentId: "doc-1",
    filename: "upload.pdf",
    text: args.text,
    pageCount: args.pageCount ?? 1,
    evidence: { source: "canonical-document", artifactUri: "s3://bucket/canonical.json" },
    pageImageEvidence: new Map((args.evidence ?? []).map((page) => [page.pageNumber, page])),
    drawnBytesPerPage: args.drawnBytesPerPage ?? null,
    routingV2: args.routingV2 ?? true,
  });
}

function selected(result: ReturnType<typeof surface>): number[] {
  if (result.status !== "ready") return [];
  return selectLegacyVisionPages(result.pages, V2);
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
    expect(selected(surface({ text: "", evidence: [empty], drawnBytesPerPage: DRAWN_CONTENT_MIN_BYTES_PER_PAGE * 20 }))).toEqual([1]);
  });

  it("keeps small blank documents out of vision", () => {
    expect(selected(surface({ text: "", evidence: [empty], drawnBytesPerPage: 900 }))).toEqual([]);
    expect(selected(surface({ text: "", evidence: [empty] }))).toEqual([]);
  });

  it("keeps a blank page blank beside pages with text", () => {
    const routed = surface({
      text: `${OCR_PROSE}\f`,
      pageCount: 2,
      evidence: [{ ...empty, pageNumber: 2 }],
      drawnBytesPerPage: DRAWN_CONTENT_MIN_BYTES_PER_PAGE * 20,
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
    ].join("\n"), V2);
    expect(formula.route).toBe("formula-heavy");
    expect(selectLegacyVisionPages([formula], V2)).toEqual([1]);
  });

  it("lets the text route decide when raster evidence does not authorize OCR", () => {
    const chart = classifyAdaptivePage(1, "Figure 3: quarterly revenue chart with legend and axis labels, Q1 Q2 Q3 up 12%", V2);
    expect(chart.extractorHint).toBe("vision-rescue");
    const minorImage = { ...chart, ocrDecision: { authorized: false, confidence: 0.8, signals: ["ocr-not-authorized:minor-images=1"] } };
    expect(selectLegacyVisionPages([minorImage], V2)).toEqual([1]);
    const blank = { ...chart, ocrDecision: { authorized: false, confidence: 0.9, signals: ["ocr-not-authorized:blank-page"] } };
    expect(selectLegacyVisionPages([blank], V2)).toEqual([]);
  });

  it("leaves dense prose pages on native text", () => {
    expect(selectLegacyVisionPages([classifyAdaptivePage(1, OCR_PROSE, V2)], V2)).toEqual([]);
  });

  it("admits text layers carrying Unicode math", () => {
    const page = classifyAdaptivePage(1, `${OCR_PROSE}\nWith key dimension 𝑑𝑘 = 64 the score is 𝑞 · 𝑘 / √𝑑𝑘 and Σ weights ≤ 1.`, V2);
    expect(page.route).toBe("formula-heavy");
    expect(selectLegacyVisionPages([page], V2)).toEqual([1]);
  });

  it("sends garbled text layers (fonts without a Unicode map) to vision", () => {
    const garbled = Array.from({ length: 8 }, (_, index) => `## ${index}KHPDWUL[SURGXFWFRPSDUHVHDFKTXHU\\ZLWK QRUPDOL]DWLRQ7KHUHVXOWLQJZHLJKWV`).join("\n");
    const page = classifyAdaptivePage(1, garbled, V2);
    expect(page.signals).toContain("garbled-text");
    expect(selectLegacyVisionPages([page], V2)).toEqual([1]);
    // Long identifiers inside ordinary prose do not trip it.
    expect(classifyAdaptivePage(1, `${OCR_PROSE} see ABCDEFGHIJKLMNOPQRSTUV123`, V2).signals).not.toContain("garbled-text");
  });
});

describe("pages whose text is drawn", () => {
  it("sends a page with OCR words but no text layer and no images to vision", () => {
    const empty: PageImageEvidence = { pageNumber: 1, wordCount: 0, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0 };
    const routed = surface({ text: OCR_PROSE, evidence: [empty] });
    expect(selected(routed)).toEqual([1]);
    expect(routed.status === "ready" && routed.pages[0]!.ocrDecision?.signals).toContain("ocr-authorized:drawn-content");
  });
});

describe("document labels", () => {
  it("does not read invoice or contract terms out of longer words", () => {
    const notes = "Field observation log. We determine the conservation status of private plots and elevated terraces.";
    expect(classifyTextAndFilename(notes, "notes.pdf", V2).label).toBe("generic");
  });

  it("still labels real invoices and contracts", () => {
    expect(classifyTextAndFilename("Invoice # 1042\nBilled to: Example Co\nSubtotal 40.00", "scan.pdf", V2).label).toBe("invoice");
    expect(classifyTextAndFilename("Bill to Example Co. Amount due 40.00. VAT 8.00", "scan.pdf", V2).label).toBe("invoice");
    expect(classifyTextAndFilename("This agreement between the parties is subject to governing law.", "a.pdf", V2).label).toBe("contract");
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

describe("routing v2 off (VISION_ROUTING_V2 default)", () => {
  it("keeps v1 page routes, labels and the v1 vision selector", () => {
    const garbled = Array.from({ length: 8 }, (_, index) => `## ${index}KHPDWUL[SURGXFWFRPSDUHVHDFKTXHU\\ZLWK QRUPDOL]DWLRQ7KHUHVXOWLQJZHLJKWV`).join("\n");
    expect(classifyAdaptivePage(1, garbled).signals).not.toContain("garbled-text");
    const unicodeMath = classifyAdaptivePage(1, `${OCR_PROSE}\nWith key dimension 𝑑𝑘 = 64 the score is 𝑞 · 𝑘 / √𝑑𝑘 and Σ weights ≤ 1.`);
    expect(unicodeMath.route).not.toBe("formula-heavy");
    const formula = classifyAdaptivePage(1, [
      "The loss is defined as follows.",
      "L(x) = \\sum_i \\alpha_i (y_i - f(x_i))^2",
      "where f(x) = w^T x + b and the gradient is",
      "dL/dw = -2 \\sum_i \\alpha_i (y_i - f(x_i)) x_i",
    ].join("\n"));
    expect(formula.route).toBe("formula-heavy");
    // v1 selector: no formula admission, and a page-evidence decision decides alone.
    expect(selectLegacyVisionPages([formula])).toEqual([]);
    const chart = classifyAdaptivePage(1, "Figure 3: quarterly revenue chart with legend and axis labels, Q1 Q2 Q3 up 12%");
    const minorImage = { ...chart, ocrDecision: { authorized: false, confidence: 0.8, signals: ["ocr-not-authorized:minor-images=1"] } };
    expect(selectLegacyVisionPages([minorImage])).toEqual([]);
    expect(selectLegacyVisionPages([chart])).toEqual([1]);
    const notes = "Field observation log. We determine the conservation status of private plots and elevated terraces.";
    expect(classifyTextAndFilename(notes, "notes.pdf").label).not.toBe("generic");
  });

  it("does not treat OCR words on a page without text layer or images as drawn content", () => {
    const empty: PageImageEvidence = { pageNumber: 1, wordCount: 0, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0 };
    const routed = surface({ text: OCR_PROSE, evidence: [empty], routingV2: false });
    expect(routed.status === "ready" && routed.pages[0]!.ocrDecision?.signals).toContain("ocr-not-authorized:blank-page");
    expect(selected(routed)).toEqual([]);
  });

  it("keeps the always-on textless-PDF fix: a document without text but heavy pages reaches vision", () => {
    const empty: PageImageEvidence = { pageNumber: 1, wordCount: 0, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0 };
    const routed = surface({ text: "", evidence: [empty], drawnBytesPerPage: DRAWN_CONTENT_MIN_BYTES_PER_PAGE * 4, routingV2: false });
    expect(routed.status === "ready" && routed.pages[0]!.ocrDecision?.signals).toContain("ocr-authorized:drawn-content");
    expect(selectLegacyVisionPages(routed.status === "ready" ? routed.pages : [])).toEqual([1]);
  });

  it("keeps the always-on rejected-output fail-open", () => {
    const rejected = new VisionOutputRejectedError("vision output rejected: leader-run", [], 10, 10, 0);
    expect(shouldFailOpenVisionError(rejected)).toBe(true);
  });
});

describe("drawn bytes per page", () => {
  const header = "page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio\n" +
    "--------------------------------------------------------------------------------------------\n";
  const row = (page: number, object: number, size: string, type = "image") =>
    `   ${page}     0 ${type}    1700  2200  rgb     3   8  jpeg   no       ${object}  0   200   200  ${size} 1.2%`;

  it("subtracts every embedded image in the file, once per image object", () => {
    // A logo (object 7) on both pages is stored once; a full-page photo on page 2.
    const listing = header + [row(1, 7, "10K"), row(2, 7, "10K"), row(2, 9, "2.0M")].join("\n");
    expect(totalEmbeddedImageBytes(listing)).toBe(10 * 1024 + 2 * 1024 ** 2);
    // A 2 MB photo on page 2 does not make blank page 1 look drawn.
    expect(drawnBytesPerPage(2 * 1024 ** 2 + 12 * 1024, totalEmbeddedImageBytes(listing), 2)).toBe(1024);
  });

  it("is unknown when the file size or any image size is unknown", () => {
    expect(totalEmbeddedImageBytes(header + row(1, 7, "??"))).toBeNull();
    expect(drawnBytesPerPage(null, 0, 1)).toBeNull();
    expect(drawnBytesPerPage(4096, null, 1)).toBeNull();
    expect(drawnBytesPerPage(4096, 0, 2)).toBe(2048);
  });
});

describe("bounded text scans", () => {
  it("finds distinct terms without materializing every match", () => {
    expect(hasDistinctTerms("vat vat vat", /\bvat\b/gi, 2)).toBe(false);
    expect(hasDistinctTerms("VAT then a subtotal", /\b(?:vat|subtotal)\b/gi, 2)).toBe(true);
    // Not global as passed: still walks every match.
    expect(hasDistinctTerms("vat and subtotal", /\b(?:vat|subtotal)\b/i, 2)).toBe(true);
  });

  it("classifies a multi-megabyte upload in bounded time and memory", () => {
    // 16 MB of one repeated term: the old Set([...matchAll]) built millions of match objects.
    const huge = "vat ".repeat(4 * 1024 * 1024);
    const before = process.memoryUsage().heapUsed;
    const started = performance.now();
    const label = classifyTextAndFilename(huge, "upload.pdf", V2);
    const page = classifyAdaptivePage(1, huge, V2);
    const elapsed = performance.now() - started;
    const grown = process.memoryUsage().heapUsed - before;
    expect(label.signals).not.toContain("body:invoice-terms");
    expect(page.pageNumber).toBe(1);
    expect(elapsed).toBeLessThan(5_000);
    // The input string itself is ~16 MB (Latin-1); a lowercase copy of the prefix is all we add.
    expect(grown).toBeLessThan(200 * 1024 * 1024);
  });

  it("reads the label from the opening text only in v2", () => {
    const late = `${"plain words ".repeat(CLASSIFY_TEXT_MAX_CHARS / 12 + 10)} invoice subtotal amount due`;
    expect(classifyTextAndFilename(late, "upload.pdf", V2).label).toBe("generic");
    expect(classifyTextAndFilename(late, "upload.pdf").label).toBe("invoice");
  });
});

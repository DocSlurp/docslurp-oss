import { describe, expect, it, vi } from "vitest";
import type { AdaptiveRoutingArtifact } from "@docslurp/shared";

import { buildPageInputs, nativePlausibility, parseProbeOutput, type ProbeRow } from "./page-input.js";

function row(pageNumber: number, extra: Partial<ProbeRow> = {}): ProbeRow {
  return {
    pageNumber, pageCount: 2, charCount: 2000, wordCount: 330, textCoverage: 0.4, fontCount: 2,
    unmappedGlyphRatio: 0, mathGlyphRatio: 0.01, tableRuleScore: 0, imageCoverage: 0.3, largestImageCoverage: 0.3,
    fullPageImage: false, vectorDrawingCount: 4, uncoveredVectorRatio: 0, garbled: false, textLayerStatus: "ok",
    imageCount: 1,
    textFacts: { wordCount: 330, imageCount: 1, imageCoverage: 0.3, textLayerStatus: "ok" },
    images: [{ bbox: [10, 20, 210, 120], coverage: 0.3 }],
    smallestFontPt: 9, widthPt: 612, heightPt: 792, rotation: 0, probeMs: 4.2,
    ...extra,
  };
}

const routing = {
  documentId: "d", label: "x", confidence: 0.9, signals: [], suggestedPlaybook: null, documentComplexity: "mixed",
  dominantRoutes: [], visionPolicy: "selective", specializedContentSummary: [],
  pages: [{
    pageNumber: 2, route: "chart-or-figure", confidence: 0.8, textDensityScore: 0.12, signals: [],
    extractorHint: "vision-rescue", specializedContent: [{ kind: "formula", confidence: 0.7, signals: [] }],
    ocrDecision: { authorized: true, confidence: 0.6, signals: [] },
  }],
} as unknown as AdaptiveRoutingArtifact;

describe("buildPageInputs", () => {
  it("maps probe JSON lines to PageInput and merges the classify-route heuristic", async () => {
    const stdout = [JSON.stringify(row(1)), "", "warning: not json", JSON.stringify(row(2))].join("\n");
    const probe = vi.fn(async () => stdout);
    const pages = await buildPageInputs({ pdfPath: "/tmp/x.pdf", pages: "1-2", routing, probe });
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ pdfPath: "/tmp/x.pdf", pages: "1-2" }));
    expect(pages).toHaveLength(2);
    expect(pages[0]!.features.heuristic).toMatchObject({ route: "straightforward-text", extractorHint: null, ocrAuthorized: null, textDensityScore: 0.4 });
    expect(pages[1]!.features.heuristic).toEqual({
      route: "chart-or-figure", extractorHint: "vision-rescue", specializedKinds: ["formula"], ocrAuthorized: true, textDensityScore: 0.12,
    });
    expect(pages[0]!.images).toEqual([{ index: 0, bbox: { x: 10, y: 20, width: 200, height: 100 }, coverage: 0.3 }]);
    expect(pages[0]!.textFacts).toEqual({ wordCount: 330, imageCount: 1, imageCoverage: 0.3, textLayerStatus: "ok" });
    expect(pages[0]!.features.provenance).toEqual({ probe: "pymupdf-probe", probeMs: 4.2 });
    expect(pages[0]!.thumbnail).toBeUndefined();
  });

  it("threads hidden-text signals and the OCR-layer agreement into textFacts", async () => {
    const scan = row(1, {
      textLayerStatus: "suspect",
      textFacts: { wordCount: 330, imageCount: 1, imageCoverage: 1, textLayerStatus: "suspect" },
      invisibleTextRatio: 1,
      textOverImageRatio: 0.98,
      ocrLayerCheck: { agreement: 0, tokens: 120, cpuMs: 800, wallMs: 830 },
    });
    const probe = vi.fn(async () => JSON.stringify(scan));
    const [page] = await buildPageInputs({ pdfPath: "/tmp/s.pdf", probe });
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ verifyOcrLayer: true }));
    expect(page!.textFacts).toMatchObject({ textLayerStatus: "suspect", invisibleTextRatio: 1, textOverImageRatio: 0.98, ocrLayerAgreement: 0 });
    expect(nativePlausibility({ textLayerStatus: "ocr-layer", garbled: false, unmappedGlyphRatio: 0 })).toBeLessThan(0.5);
  });

  it("rejects an empty probe", async () => {
    await expect(buildPageInputs({ pdfPath: "x", probe: async () => "" })).rejects.toThrow(/no rows/);
  });

  it("parses only JSON object lines", () => {
    expect(parseProbeOutput('{"pageNumber":1}\nnope\n')).toHaveLength(1);
  });

  it("scores native plausibility from status, garbling and unmapped glyphs", () => {
    expect(nativePlausibility({ textLayerStatus: "absent", garbled: false, unmappedGlyphRatio: 0 })).toBe(0);
    expect(nativePlausibility({ textLayerStatus: "ok", garbled: true, unmappedGlyphRatio: 0 })).toBe(0.1);
    expect(nativePlausibility({ textLayerStatus: "ok", garbled: false, unmappedGlyphRatio: 0 })).toBe(1);
    expect(nativePlausibility({ textLayerStatus: "ok", garbled: false, unmappedGlyphRatio: 0.1 })).toBeCloseTo(0.5, 10);
  });

  it("carries unusualFeatures and maps the locked-document row to a valid page", async () => {
    const locked = { pageNumber: 0, pageCount: 0, locked: true, textLayerStatus: "unknown", unusualFeatures: ["encrypted-user-password"], needsAttention: true,
      textFacts: { line: "document locked", textLayerStatus: "unknown" } };
    const stdout = [JSON.stringify(row(1, { unusualFeatures: ["acroform-filled"], needsAttention: true })), JSON.stringify(row(2)), JSON.stringify(locked)].join("\n");
    const pages = await buildPageInputs({ pdfPath: "/tmp/x.pdf", probe: async () => stdout });
    expect(pages[0]!.unusualFeatures).toEqual(["acroform-filled"]);
    expect(pages[1]!.unusualFeatures).toBeUndefined();
    expect(pages[2]!.unusualFeatures).toEqual(["encrypted-user-password"]);
    expect(pages[2]!.textFacts.textLayerStatus).toBe("unknown");
  });
});

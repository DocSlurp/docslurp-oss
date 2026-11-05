import { BLANK_PAGE_SIGNAL, DRAWN_CONTENT_SIGNAL, GARBLED_TEXT_LAYER_SIGNAL, TEXT_LAYER_DISAGREES_SIGNAL, type AdaptivePageRoutingEntry } from "@docslurp/shared";
import { describe, expect, it } from "vitest";

import type { PageImageEvidence } from "../lib/page-image-evidence.js";
import { pageReadReason, summarizeRoutingDecisions } from "./classify-route.js";

const page = (pageNumber: number, ocrDecision?: { authorized: boolean; signals: string[] }) =>
  ({ pageNumber, ocrDecision: ocrDecision && { confidence: 0.9, ...ocrDecision } }) as unknown as AdaptivePageRoutingEntry;
const evidence = (pageNumber: number, extra: Partial<PageImageEvidence> = {}): PageImageEvidence =>
  ({ pageNumber, wordCount: 0, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0, ...extra });

describe("routing decision stats", () => {
  it("names why a page was read", () => {
    expect(pageReadReason(["ocr-authorized:raster-page-without-text"])).toBe("raster");
    expect(pageReadReason([GARBLED_TEXT_LAYER_SIGNAL])).toBe("garbled");
    expect(pageReadReason([TEXT_LAYER_DISAGREES_SIGNAL])).toBe("garbled");
    expect(pageReadReason([DRAWN_CONTENT_SIGNAL])).toBe("drawn");
    expect(pageReadReason(["ocr-authorized:structured-text-yield-deficit", "text-yield:expected-chars=9"])).toBe("yield-deficit");
    expect(pageReadReason(["something-else"])).toBe("other");
  });

  it("counts reads by reason, blank pages, repeated-image pages, text-layer verdicts and measured pages", () => {
    const pages = [
      page(1, { authorized: true, signals: ["ocr-authorized:raster-page-without-text"] }),
      page(2, { authorized: true, signals: [GARBLED_TEXT_LAYER_SIGNAL] }),
      page(3, { authorized: true, signals: [DRAWN_CONTENT_SIGNAL] }),
      page(4, { authorized: false, signals: [BLANK_PAGE_SIGNAL] }),
      page(5, { authorized: false, signals: ["ocr-not-authorized"] }),
      page(6),
    ];
    const images = new Map<number, PageImageEvidence>([
      [1, evidence(1)],
      [2, evidence(2, { textLayer: { verdict: "garbled", reasons: [], source: "text-layer" } })],
      [4, evidence(4, { repeatedImageCount: 2, textLayer: { verdict: "ok", reasons: [], source: "text-layer" } })],
      [5, evidence(5, { textLayer: { verdict: "suspect", reasons: [], source: "text-layer", matchesOcr: false } })],
      [6, evidence(6, { textLayer: { verdict: "suspect", reasons: [], source: "text-layer", matchesOcr: null } })],
    ]);
    expect(summarizeRoutingDecisions(pages, { intakePageCount: 7, measuredPages: 5, imageEvidence: images })).toEqual({
      intakePages: 7,
      measuredPages: 5,
      pagesRead: 3,
      pagesReadByReason: { raster: 1, garbled: 1, drawn: 1, "yield-deficit": 0, other: 0 },
      blankPages: 1,
      repeatedImagePages: 1,
      textLayerVerdicts: { garbled: 1, ok: 1, suspect: 2 },
      textLayerOcrChecked: 1,
      textLayerOcrDisagrees: 1,
    });
  });

  it("reports zeros without page evidence", () => {
    expect(summarizeRoutingDecisions([], { intakePageCount: 3, measuredPages: 0 })).toMatchObject({
      pagesRead: 0, blankPages: 0, repeatedImagePages: 0, textLayerVerdicts: {}, measuredPages: 0, intakePages: 3,
    });
  });
});

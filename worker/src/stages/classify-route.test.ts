import { BLANK_PAGE_SIGNAL, DRAWN_CONTENT_SIGNAL, GARBLED_TEXT_LAYER_SIGNAL, TEXT_LAYER_DISAGREES_SIGNAL, type AdaptivePageRoutingEntry } from "@docslurp/shared";
import { describe, expect, it } from "vitest";

import type { PageImageEvidence } from "../lib/page-image-evidence.js";
import { classifyAdaptivePage, pageReadReason, summarizeRoutingDecisions } from "./classify-route.js";

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

describe("layout-preserving text (pdftotext -layout)", () => {
  // A layout extractor keeps columns as runs of spaces: an indented schedule is laid out, not nested code.
  it("does not read column-aligned, indented rows as source code", () => {
    const text = [
      "Shipping schedule",
      "Orders ship from the north depot for every region listed below.",
      "  Route A        Monday         Harbor gate        09:00",
      "  Route B        Wednesday      Rail yard          11:30",
      "  Route C        Friday         Airport cargo      14:15",
      "Return the signed manifest to the dispatcher.",
    ].join("\n");
    const page = classifyAdaptivePage(1, text);
    expect(page.route).not.toBe("code-heavy");
    expect(page.signals).not.toContain("code:indentation");
  });

  it("still reads indented source code as code", () => {
    const text = [
      "Example listing",
      "export function total(items) {",
      "  const sum = items.reduce((acc, item) => acc + item.price, 0);",
      "  return sum;",
      "}",
      "import { total } from './total';",
    ].join("\n");
    expect(classifyAdaptivePage(1, text).route).toBe("code-heavy");
  });

  it("reads rows of space-aligned numeric cells as a table", () => {
    const text = [
      "Station readings",
      "Hourly averages per station during the survey week.",
      " Station        Temp C      Humidity      Wind kph",
      " Lakeside       18.2        64            12",
      " Ridge          14.9        71            22",
      " Valley         20.4        58            7",
      " Harbor         17.1        80            15",
    ].join("\n");
    const page = classifyAdaptivePage(1, text);
    expect(page.route).toBe("table-heavy");
    expect(page.extractorHint).toBe("layout-aware");
  });

  it("does not read aligned prose columns without numbers as a table", () => {
    const text = [
      "Team roster",
      " Alice          design lead       west office",
      " Bruno          platform          east office",
      " Chen           research          remote",
    ].join("\n");
    expect(classifyAdaptivePage(1, text).route).not.toBe("table-heavy");
  });
});

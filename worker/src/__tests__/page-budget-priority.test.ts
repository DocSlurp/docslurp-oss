import { describe, expect, it } from "vitest";

import { DRAWN_CONTENT_SIGNAL, SPARSE_FULL_PAGE_IMAGE_SIGNAL, STAMPED_RASTER_SIGNAL } from "@docslurp/shared";

import { pageLacksNativeText, prioritizePagesWithoutNativeText } from "../stages/classify-route.js";

const page = (pageNumber: number, signals: string[], authorized = true) => ({
  pageNumber,
  ocrDecision: { authorized, confidence: 0.9, signals },
});

describe("pages whose content is only pixels keep their place under a page budget", () => {
  it.each([
    ["no native text", "ocr-authorized:no-native-text"],
    ["a raster page without text", "ocr-authorized:raster-page-without-text"],
    ["drawn content", DRAWN_CONTENT_SIGNAL],
    ["a stamped scan", STAMPED_RASTER_SIGNAL],
    ["a full-page image with sparse text", SPARSE_FULL_PAGE_IMAGE_SIGNAL],
  ])("%s is prioritized", (_name, signal) => {
    expect(pageLacksNativeText(page(1, [signal]))).toBe(true);
  });

  it("does not prioritize a page read for another reason, or one that is not authorized", () => {
    expect(pageLacksNativeText(page(1, ["ocr-authorized:garbled-text-layer"]))).toBe(false);
    expect(pageLacksNativeText(page(1, [STAMPED_RASTER_SIGNAL], false))).toBe(false);
  });

  it("puts stamped and sparse scans ahead of other pages when a budget truncates the selection", () => {
    const pages = [
      page(1, ["ocr-authorized:garbled-text-layer"]),
      page(2, [STAMPED_RASTER_SIGNAL]),
      page(3, ["ocr-authorized:garbled-text-layer"]),
      page(4, [SPARSE_FULL_PAGE_IMAGE_SIGNAL]),
      page(5, ["ocr-authorized:no-native-text"]),
    ];
    expect(prioritizePagesWithoutNativeText(pages).slice(0, 3).map((entry) => entry.pageNumber)).toEqual([2, 4, 5]);
  });
});

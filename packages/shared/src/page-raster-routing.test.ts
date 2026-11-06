import { describe, expect, it } from "vitest";

import {
  MIXED_SCAN_IMAGE_SIGNAL,
  PAGE_RASTER_ROUTING,
  decidePageRaster,
  mixedScanImage,
  pageWordCount,
  scanLikeImage,
  type PageLayoutImage,
  type PageRasterFacts,
} from "./page-raster-routing.js";

const none = { count: 0, coverage: 0, largestCoverage: 0 };
const page = (nativeWords: number | null, images: PageRasterFacts["images"], rest: Partial<PageRasterFacts> = {}) =>
  decidePageRaster({ nativeWords, images, ...rest });

describe("pageWordCount", () => {
  it("counts spaced scripts by runs and unspaced scripts by characters", () => {
    expect(pageWordCount("The quick brown fox")).toBe(4);
    expect(pageWordCount("Быстрая коричневая лиса прыгает")).toBe(4);
    expect(pageWordCount("Γρήγορη καφέ αλεπού")).toBe(3);
    expect(pageWordCount("سريع بني ثعلب")).toBe(3);
    expect(pageWordCount("한국어 문장 입니다")).toBe(3);
    // 21 Han characters at two to the word; the old whitespace count saw one run
    expect(pageWordCount("委员会审议了季度报告并同意执行新的时间表前提")).toBe(11);
    expect(pageWordCount("# | --- | ** a x")).toBe(0);
  });
});

describe("decidePageRaster", () => {
  it("a page with a text layer and no images is a text page, however short", () => {
    expect(page(3, none)).toMatchObject({ read: false, kind: "native-text" });
    expect(page(0, none, { textLayer: { verdict: "empty" } })).toMatchObject({ read: false, kind: "blank" });
  });

  it("a blank page and one with only insignificant images are blank and never read", () => {
    const blank = page(0, none);
    expect(blank).toMatchObject({ read: false, kind: "blank" });
    expect(blank.signals).toContain("ocr-not-authorized:blank-page");
  });

  it("a page without text and with a page-sized image is a scan; the same words as a stamp keep it a scan", () => {
    expect(page(0, { count: 1, coverage: 0.98, largestCoverage: 0.98 })).toMatchObject({ read: true, kind: "raster" });
    expect(page(0, { count: 4, coverage: 0.4, largestCoverage: 0.1 })).toMatchObject({ read: true, kind: "raster" });
    expect(page(PAGE_RASTER_ROUTING.stampTextMaxWords, { count: 1, coverage: 0.6, largestCoverage: 0.6 })).toMatchObject({ read: true });
    expect(page(PAGE_RASTER_ROUTING.stampTextMaxWords + 1, { count: 1, coverage: 0.6, largestCoverage: 0.6 })).toMatchObject({ read: false });
    expect(page(20, { count: 1, coverage: 0.9, largestCoverage: 0.9 })).toMatchObject({ read: true });
  });

  it("minor images do not make a text page a scan", () => {
    expect(page(12, { count: 2, coverage: 0.2, largestCoverage: 0.15 })).toMatchObject({ read: false, kind: "native-text" });
    expect(page(0, { count: 1, coverage: 0.1, largestCoverage: 0.1 })).toMatchObject({ read: false });
  });

  it("a text page with the sparse threshold of words is not read whatever its images", () => {
    expect(page(PAGE_RASTER_ROUTING.sparsePageWords, null)).toMatchObject({ read: false, kind: "native-text" });
  });

  it("unknown facts are never read as zero", () => {
    expect(page(null, none)).toMatchObject({ read: false, kind: "unknown" });
    expect(page(0, null)).toMatchObject({ read: false, kind: "unknown" });
  });

  it("drawn content nominates a text-less page, also with unrelated minor images", () => {
    expect(page(0, none, { drawnContent: true })).toMatchObject({ read: true, kind: "drawn-content" });
    expect(page(0, { count: 1, coverage: 0.1, largestCoverage: 0.1 }, { drawnContent: true })).toMatchObject({ read: true, kind: "drawn-content" });
    expect(page(40, none, { drawnContent: true })).toMatchObject({ read: false });
  });

  it("a garbled text layer is read even when it has plenty of words", () => {
    expect(page(400, null, { textLayer: { verdict: "garbled" } })).toMatchObject({ read: true, kind: "garbled-text-layer" });
  });

  it("a suspect text layer is read only when an OCR of the page disagrees", () => {
    expect(page(400, null, { textLayer: { verdict: "suspect", matchesOcr: false } })).toMatchObject({ read: true });
    expect(page(400, null, { textLayer: { verdict: "suspect", matchesOcr: true } })).toMatchObject({ read: false, kind: "native-text" });
    const unverified = page(400, null, { textLayer: { verdict: "suspect", matchesOcr: null } });
    expect(unverified.read).toBe(false);
    expect(unverified.signals).toContain("ocr-not-authorized:text-layer-unverified");
  });
});

describe("mixed text and scan pages (owner rule 2026-11-05)", () => {
  const scan = (over: Partial<PageLayoutImage> = {}): PageLayoutImage => ({
    bbox: [72, 200, 540, 600], coverage: 0.4, widthPx: 1700, heightPx: 1450, bitsPerComponent: 8, colorSpace: "gray",
    encoding: "image", ppi: [260, 260], bytesPerPixel: 0.03, repeated: false, wordsInside: 0, ...over,
  });
  const words = PAGE_RASTER_ROUTING.sparsePageWords + 40;
  const decide = (layoutImages: PageLayoutImage[] | null) => page(words, { count: 1, coverage: 0.4, largestCoverage: 0.4 }, { layoutImages });

  it("reads a large scan placed beside native text, and returns its region", () => {
    expect(decide([scan()])).toMatchObject({ read: true, kind: "raster", signals: [MIXED_SCAN_IMAGE_SIGNAL], region: [72, 200, 540, 600] });
    expect(decide([scan({ encoding: "ccitt", bitsPerComponent: 1, bytesPerPixel: null })])).toMatchObject({ read: true });
  });

  it("does not read a logo or letterhead, a photo, a small image, or an image with native text over it", () => {
    expect(decide([scan({ repeated: true })])).toMatchObject({ read: false, kind: "native-text" });
    expect(decide([scan({ bytesPerPixel: 2.9, colorSpace: "rgb" })]).read).toBe(false);
    expect(decide([scan({ bytesPerPixel: 0.6, colorSpace: "gray" })]).read).toBe(false);
    expect(decide([scan({ coverage: 0.19 })]).read).toBe(false);
    expect(decide([scan({ widthPx: 180 })]).read).toBe(false);
    expect(decide([scan({ ppi: [40, 40] })]).read).toBe(false);
    expect(decide([scan({ wordsInside: 3 })]).read).toBe(false);
    expect(decide([scan({ wordsInside: 2 })]).read).toBe(true);
  });

  it("unknown layout, placement or word boxes never authorize a read", () => {
    expect(decide(null).read).toBe(false);
    expect(decide([scan({ bbox: null, coverage: null })]).read).toBe(false);
    expect(decide([scan({ wordsInside: null })]).read).toBe(false);
    expect(decide([scan({ ppi: [null, null] })]).read).toBe(false);
  });

  it("picks the largest qualifying image", () => {
    expect(mixedScanImage([scan({ coverage: 0.25, bbox: [0, 0, 1, 1] }), scan()])?.bbox).toEqual([72, 200, 540, 600]);
    expect(scanLikeImage(scan({ bytesPerPixel: 0.4, colorSpace: "gray" }))).toBe(false);
  });
});

import { decidePageRaster } from "@docslurp/shared";
import { describe, expect, it } from "vitest";

import { dopplerFactsCoverEvidence, dopplerFactsTextDisagreement, pageFactRowsFromDopplerFacts, pageImageEvidenceFromDopplerFacts } from "./doppler-page-facts-evidence.js";
import { parseDopplerPageFacts, type DopplerPageFactsDocument } from "./doppler-page-facts.js";
import { buildPageImageEvidence, findSparsePages, summarizeImageListing } from "./page-image-evidence.js";
import { buildPdfPageFacts } from "../pipeline/page-facts.js";
import { docLine, jsonl, runLine, scanPage, textPage } from "../test/doppler-page-facts-fixture.js";

const LETTER = { widthPt: 612, heightPt: 792, rotation: 0, userUnit: 1 };

/** One drawn image: the facts item and the `pdfimages -list` row a probe of the same page would print. */
interface Drawn { px: [number, number]; dpi: number; bbox: [number, number, number, number]; obj?: number; filter?: string; mask?: boolean }

function item(index: number, image: Drawn): Record<string, unknown> {
  const [x0, y0, x1, y1] = image.bbox;
  return {
    index, bbox: image.bbox, coverage: Math.min(1, ((x1 - x0) * (y1 - y0)) / (612 * 792)), px: image.px, dpi: [image.dpi, image.dpi],
    filter: image.filter ?? "flate", bpc: 8, colorSpace: "rgb", imageMask: image.mask === true, softMask: false, mask: false, decode: false,
    inline: image.obj === undefined, ...(image.obj !== undefined ? { obj: image.obj } : {}), copy: "render",
  };
}

function listingRow(page: number, num: number, image: Drawn): string {
  const type = image.mask ? "stencil" : "image";
  const [obj, id] = image.obj === undefined ? ["0", "0"] : [String(image.obj), "0"];
  return `${page} ${num} ${type} ${image.px[0]} ${image.px[1]} rgb 3 8 image no ${obj} ${id} ${image.dpi} ${image.dpi} 10.0K 1.0%`;
}

/** A page with `words` words of text layer (visible) and the given images. */
function page(number: number, words: number, images: Drawn[]): Record<string, unknown> {
  const base = textPage(number);
  const items = images.map((image, i) => item(i + 1, image));
  const coverage = Math.min(1, items.reduce((sum, entry) => sum + (entry.coverage as number), 0));
  return {
    ...base, geometry: LETTER,
    text: { ...(base.text as object), charCount: words * 6, visibleCharCount: words * 6, wordCount: words, visibleWordCount: words, textLayer: words > 0 ? "visible" : "none" },
    images: {
      imageCount: items.length, imageCoverage: coverage, largestImageCoverage: Math.max(0, ...items.map((entry) => entry.coverage as number)),
      fullPageImage: false, scan: "none", maskCount: 0, inlineCount: 0, items, itemsTruncated: false, truncated: false,
    },
  };
}

function parse(lines: Array<Record<string, unknown> | string>, pageCount: number): DopplerPageFactsDocument {
  const parsed = parseDopplerPageFacts(jsonl(lines), { pageCount });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.facts;
}

// A logo on every page (furniture), a full-page scan, a tiled scan, an image too small in pixels to read, a stencil mask just
// under the significant share (96 x 96 pt, 1.9% of the page).
const LOGO: Drawn = { px: [600, 300], dpi: 300, bbox: [36, 36, 180, 108], obj: 42 };
const SCAN: Drawn = { px: [2550, 3300], dpi: 300, bbox: [0, 0, 612, 792], obj: 7, filter: "ccitt" };
const TILE_TOP: Drawn = { px: [2550, 1650], dpi: 300, bbox: [0, 396, 612, 792], obj: 8 };
const TILE_BOTTOM: Drawn = { px: [2550, 1650], dpi: 300, bbox: [0, 0, 612, 396], obj: 9 };
const TINY: Drawn = { px: [20, 20], dpi: 2, bbox: [0, 0, 612, 792] };
const STENCIL: Drawn = { px: [400, 400], dpi: 300, bbox: [100, 100, 196, 196], obj: 11, mask: true };
const DOC: Array<[number, Drawn[]]> = [[410, [LOGO]], [0, [LOGO, SCAN]], [420, [LOGO]], [0, [LOGO, TILE_TOP, TILE_BOTTOM, STENCIL]], [3, [LOGO, TINY]]];

describe("Doppler page facts as page-image evidence", () => {
  const facts = parse([docLine({ pageCount: 5 }), ...DOC.map(([words, images], i) => page(i + 1, words, images)), runLine({ pagesEmitted: 5 })], 5);
  const pageTexts = DOC.map(([words]) => Array.from({ length: words }, (_, i) => `word${i}`).join(" "));

  it("matches what the pdfimages probe derives from the same pages (sparse pages, significance, furniture, coverage)", () => {
    const listing = ["page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio", "-".repeat(90),
      ...DOC.flatMap(([, images], i) => images.map((image, n) => listingRow(i + 1, n, image)))].join("\n");
    const areas = new Map(DOC.map((_, i) => [i + 1, 612 * 792]));
    const probe = buildPageImageEvidence({ sparsePages: findSparsePages(pageTexts), listing: summarizeImageListing(listing, { pageAreas: areas, pagesInScope: 5 }) });
    const fromFacts = pageImageEvidenceFromDopplerFacts({ facts, pageCount: 5, pageTexts });
    const shape = (pages: Array<Record<string, unknown>> | null) => (pages ?? []).map(({ pageNumber, wordCount, imageCount, imageCoverage, largestImageCoverage, repeatedImageCount, imagesKnown }) =>
      ({ pageNumber, wordCount, imageCount, imageCoverage, largestImageCoverage, repeatedImageCount, imagesKnown }));
    expect(shape(fromFacts as never)).toEqual(shape(probe as never));
    expect(shape(fromFacts as never)).toEqual([
      { pageNumber: 2, wordCount: 0, imageCount: 1, imageCoverage: 1, largestImageCoverage: 1, repeatedImageCount: 1, imagesKnown: true },
      { pageNumber: 4, wordCount: 0, imageCount: 2, imageCoverage: 1, largestImageCoverage: 0.5, repeatedImageCount: 1, imagesKnown: true },
      { pageNumber: 5, wordCount: 3, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0, repeatedImageCount: 1, imagesKnown: true },
    ]);
  });

  it("matches the probe's per-page ingest-report image counts (image rows only) and never invents a text size", () => {
    const listing = DOC.flatMap(([, images], i) => images.map((image, n) => listingRow(i + 1, n, image))).join("\n");
    const probe = buildPdfPageFacts({ documentId: "d", runId: "r", pageCount: 5, pageText: null, imagesList: listing });
    const rows = pageFactRowsFromDopplerFacts({ facts, pageCount: 5, pageTexts, documentId: "d", runId: "r" });
    expect(rows.map((row) => row.imageCount)).toEqual(probe.map((row) => row.imageCount));
    // Text bytes: 0 without a text layer, else the extracted page's (whitespace-collapsed) bytes, never a size from facts.
    expect(rows.map((row) => [row.wordCount, row.textBytes])).toEqual([[410, pageTexts[0]!.length], [0, 0], [420, pageTexts[2]!.length], [0, 0], [3, pageTexts[4]!.length]]);
  });

  it("routes the scans to a read and the text pages to native text, as the probe's evidence would", () => {
    const pages = new Map((pageImageEvidenceFromDopplerFacts({ facts, pageCount: 5, pageTexts }) ?? []).map((entry) => [entry.pageNumber, entry]));
    const decide = (n: number) => {
      const entry = pages.get(n);
      return decidePageRaster({ nativeWords: entry?.wordCount ?? DOC[n - 1]![0], images: entry ? { count: entry.imageCount, coverage: entry.imageCoverage, largestCoverage: entry.largestImageCoverage } : null });
    };
    expect([1, 2, 3, 4, 5].map((n) => [decide(n).read, decide(n).kind])).toEqual([
      [false, "native-text"], [true, "raster"], [false, "native-text"], [true, "raster"], [false, "native-text"],
    ]);
  });

  it("refuses facts that do not cover every page of the host's count, naming why", () => {
    expect(dopplerFactsCoverEvidence(undefined, 5)).toEqual({ covered: false, reason: "no-facts" });
    // Bounded by another count than the host's now says: never trusted for this document.
    expect(dopplerFactsCoverEvidence(facts, 6)).toEqual({ covered: false, reason: "page-count-mismatch" });
    expect(dopplerFactsCoverEvidence(facts, 0)).toEqual({ covered: false, reason: "page-count" });
    expect(dopplerFactsCoverEvidence(facts, 5)).toEqual({ covered: true, pages: 5 });
    const truncated = parse([docLine({ pageCount: 2 }), page(1, 0, [SCAN]), { ...page(2, 0, [SCAN]), images: { ...(page(2, 0, [SCAN]).images as object), truncated: true } }, runLine({ pagesEmitted: 2 })], 2);
    expect(dopplerFactsCoverEvidence(truncated, 2)).toEqual({ covered: false, reason: "images-family-incomplete" });
    // Fewer items than the image count says: the list is not complete.
    const short = parse([docLine({ pageCount: 1 }), { ...page(1, 0, [SCAN]), images: { ...(page(1, 0, [SCAN]).images as object), imageCount: 2 } }, runLine({ pagesEmitted: 1 })], 1);
    expect(dopplerFactsCoverEvidence(short, 1)).toEqual({ covered: false, reason: "images-family-incomplete" });
    expect(pageImageEvidenceFromDopplerFacts({ facts: truncated, pageCount: 2, pageTexts: ["", ""] })).toBeNull();
    expect(pageFactRowsFromDopplerFacts({ facts: truncated, pageCount: 2, pageTexts: ["", ""], documentId: "d", runId: "r" })).toEqual([]);
    const noGeometry = parse([docLine({ pageCount: 1 }), (() => { const p = page(1, 0, [SCAN]); delete p.geometry; return p; })(), runLine({ pagesEmitted: 1 })], 1);
    expect(dopplerFactsCoverEvidence(noGeometry, 1)).toEqual({ covered: false, reason: "geometry-missing" });
    // Text that does not line up with the page count builds no evidence.
    expect(pageImageEvidenceFromDopplerFacts({ facts, pageCount: 5, pageTexts: ["one"] })).toBeNull();
  });

  it("reports a garbled extracted page even when it is not sparse, and nothing at all for a clean born-digital document", () => {
    const clean = parse([docLine({ pageCount: 2 }), textPage(1), scanPage(2), runLine({ pagesEmitted: 2 })], 2);
    expect(pageImageEvidenceFromDopplerFacts({ facts: clean, pageCount: 2, pageTexts: ["Plain readable words here", "More readable words"] })).toBeNull();
    const garbled = "�".repeat(400);
    const pages = pageImageEvidenceFromDopplerFacts({ facts: clean, pageCount: 2, pageTexts: ["Plain readable words here", garbled] });
    expect(pages).toEqual([expect.objectContaining({ pageNumber: 2, wordCount: 300, textLayer: expect.objectContaining({ verdict: "garbled", source: "extracted" }) })]);
  });

  it("refuses facts that call a page sparse while the extraction read it as text (not OCR), and builds nothing from them", () => {
    // Facts claim page 1 has no words and a full-page image; the extraction read 40 words of text from it.
    const forged = parse([docLine({ pageCount: 2 }), page(1, 0, [SCAN]), page(2, 0, [SCAN]), runLine({ pagesEmitted: 2 })], 2);
    const texts = [Array.from({ length: 40 }, (_, i) => `word${i}`).join(" "), ""];
    expect(dopplerFactsTextDisagreement(forged, texts)).toBe(1);
    expect(pageImageEvidenceFromDopplerFacts({ facts: forged, pageCount: 2, pageTexts: texts })).toBeNull();
    expect(pageFactRowsFromDopplerFacts({ facts: forged, pageCount: 2, pageTexts: texts, documentId: "d", runId: "r" })).toEqual([]);
    // A page the provider OCR'd has words from its pixels, not its layer: that is agreement, as the probe reads it.
    expect(dopplerFactsTextDisagreement(forged, texts, new Set([1]))).toBeNull();
    expect(pageImageEvidenceFromDopplerFacts({ facts: forged, pageCount: 2, pageTexts: texts, ocrPages: new Set([1]) })?.map((p) => p.pageNumber)).toEqual([1, 2]);
  });

  it("never counts more of the page than an image's own box covers (a forged coverage on a small box)", () => {
    const small = { ...item(1, { px: [2000, 2000], dpi: 300, bbox: [0, 0, 20, 20], obj: 5 }), coverage: 1 };
    const forged = parse([docLine({ pageCount: 1 }), { ...page(1, 0, []), images: { imageCount: 1, imageCoverage: 1, largestImageCoverage: 1, fullPageImage: true, scan: "single", items: [small], itemsTruncated: false, truncated: false } }, runLine({ pagesEmitted: 1 })], 1);
    const [evidence] = pageImageEvidenceFromDopplerFacts({ facts: forged, pageCount: 1, pageTexts: [""] }) ?? [];
    expect(evidence).toMatchObject({ pageNumber: 1, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0 });
    expect(decidePageRaster({ nativeWords: 0, images: { count: 0, coverage: 0, largestCoverage: 0 } }).read).toBe(false);
  });
});

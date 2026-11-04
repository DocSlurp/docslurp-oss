/**
 * Per-page raster evidence for page triage: which pages with no (or almost no) native
 * text carry image content, and how much of the page it covers.
 *
 * A page whose text layer is empty is either blank or holds its content as pixels (a
 * scan, a photographed page, a flattened export). Text heuristics cannot tell the two
 * apart, so without this evidence a raster-only page in a mostly born-digital PDF was
 * routed as plain text and never reached vision, leaving it unsearchable. Poppler's
 * `pdfimages -list` reports every image drawn on a page with its pixel size and placement
 * resolution, without decoding it, which gives the placed area of each image.
 *
 * Only pages with sparse native text are inspected, so born-digital documents pay nothing.
 */

import { open } from "node:fs/promises";
import { PAGE_RASTER_ROUTING, assessTextLayer, pageWordCount, type TextLayerVerdict } from "@docslurp/shared";

import type { CommandRunner } from "../tools/runner.js";
import { embeddedImageBytesByPage, pdfImagesListFields } from "./page-yield-evidence.js";

/** Pages with fewer native words than this are "sparse" and get raster evidence. */
export const SPARSE_PAGE_WORDS = PAGE_RASTER_ROUTING.sparsePageWords;
/** Images covering less than this share of the page (logos, bullets, rules, tracking pixels) are ignored. */
export const MIN_SIGNIFICANT_IMAGE_COVERAGE = PAGE_RASTER_ROUTING.minSignificantImageCoverage;
/** Images with a shorter side than this (in pixels) carry no readable content. */
export const MIN_SIGNIFICANT_IMAGE_PIXELS = PAGE_RASTER_ROUTING.minSignificantImagePixels;
/**
 * `pdfimages -list` lines read before the listing is declared too long: pages after the last one read are then
 * unknown, never "no images". Rows are folded into per-page totals as they stream, so a page of 100,000 tiny images
 * costs a counter, not memory, and cannot hide the scans after it.
 */
export const MAX_IMAGE_ROWS = 2_000_000;
/** Significant images kept per page for repeated-image detection; the rest still add to the page's coverage. */
const MAX_TRACKED_IMAGES_PER_PAGE = 64;
/** Distinct image objects tracked for repeat detection per document. */
const MAX_TRACKED_OBJECTS = 200_000;

/** The text layer's own quality for a page, from `assessTextLayer` and (suspect layers only) an OCR cross-check. */
export interface PageTextLayerEvidence {
  verdict: TextLayerVerdict;
  reasons: string[];
  /** Whether an OCR of the page agrees with a suspect layer (precision and recall); null when not checked. */
  matchesOcr?: boolean | null;
  /** Where the checked text came from: the PDF's own layer (pdftotext) or the extractor's output. */
  source: "text-layer" | "extracted";
}

export interface PageImageEvidence {
  pageNumber: number;
  /** False when the image listing did not reach this page: its image facts are unknown, not zero. */
  imagesKnown?: boolean;
  /** Images of any size drawn on the page, and how many of the significant ones are repeated page furniture. */
  anyImageCount?: number;
  repeatedImageCount?: number;
  textLayer?: PageTextLayerEvidence | null;
  /** Approximate embedded image/mask storage, deduplicated within this page; null if unknown.
   * Not expected text bytes and not additive across pages (shared PDF objects).
   */
  embeddedImageBytes?: number | null;
  /** Words in the page's native text (as extracted). */
  wordCount: number;
  /** Significant images drawn on the page. */
  imageCount: number;
  /** Placed area of significant images over page area, capped at 1 (overlaps count twice). */
  imageCoverage: number;
  /** Largest single significant image over page area, capped at 1. */
  largestImageCoverage: number;
}

export interface PageImageEvidenceArtifact {
  documentId: string;
  source: "pdfimages" | "image-file";
  /**
   * Source file bytes minus the bytes of every embedded image in the file, over page count, or
   * null when the image listing did not cover every page. Without any extracted text, a large
   * figure suggests drawn content (vector glyphs, outlined text). It is only a hint: padding,
   * metadata, attachments and fonts also count, so vision-extract confirms each such page's
   * render is not blank before calling a model (`renderLooksBlank`).
   */
  drawnBytesPerPage?: number | null;
  sparsePageWords: number;
  pages: PageImageEvidence[];
}

/** One image drawn on a page, as `pdfimages -list` reports it. */
export interface PdfImageRow {
  pageNumber: number;
  type: string;
  width: number;
  height: number;
  xPpi: number;
  yPpi: number;
  /** `object:generation` of the image XObject, or null for inline images and images without an object reference. */
  objectKey: string | null;
}

/** Parse one `pdfimages -list` line. Masks (`smask`, `mask`) describe another image's alpha and are skipped. */
export function parsePdfImagesRow(line: string): PdfImageRow | null {
  const fields = pdfImagesListFields(line);
  if (fields.length < 14 || !/^\d+$/.test(fields[0]!)) return null;
  const type = fields[2]!;
  if (type !== "image" && type !== "stencil") return null;
  const [pageNumber, width, height, xPpi, yPpi] = [fields[0], fields[3], fields[4], fields[12], fields[13]].map(Number);
  if (![pageNumber, width, height, xPpi, yPpi].every((value) => Number.isFinite(value) && value! > 0)) return null;
  const objectKey = /^\d+$/.test(fields[10] ?? "") && /^\d+$/.test(fields[11] ?? "") && fields[10] !== "0" ? `${fields[10]}:${fields[11]}` : null;
  return { pageNumber: pageNumber!, type, width: width!, height: height!, xPpi: xPpi!, yPpi: yPpi!, objectKey };
}

/** Parse `pdfimages -list` output into rows (tests and small listings; evidence uses `summarizeImageListing`). */
export function parsePdfImagesList(stdout: string, maxRows = MAX_IMAGE_ROWS): PdfImageRow[] {
  const rows: PdfImageRow[] = [];
  for (const line of stdout.split("\n")) {
    if (rows.length >= maxRows) break;
    const row = parsePdfImagesRow(line);
    if (row) rows.push(row);
  }
  return rows;
}

/** Parse `pdfinfo -f -l` per-page size lines into page areas in square points. */
export function parsePdfPageAreas(stdout: string): Map<number, number> {
  const areas = new Map<number, number>();
  for (const match of stdout.matchAll(/^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gm)) {
    const area = Number(match[2]) * Number(match[3]);
    if (Number.isFinite(area) && area > 0) areas.set(Number(match[1]), area);
  }
  return areas;
}

/** Significant, non-repeated image totals of one page. */
export interface PageImageTotals {
  /** Images of any size, masks excluded. */
  anyImageCount: number;
  imageCount: number;
  imageCoverage: number;
  largestImageCoverage: number;
  /** Significant images skipped as repeated page furniture. */
  repeatedImageCount: number;
}

export interface ImageListingSummary {
  pages: Map<number, PageImageTotals>;
  /** Last page the listing was read to when it was too long; pages after it are unknown. Null: read to the end. */
  truncatedAfterPage: number | null;
}

/**
 * Fold a `pdfimages -list` listing into per-page totals, one streaming pass plus one pass over each page's tracked
 * images.
 *
 * - An image is significant when its shorter side has `minSignificantImagePixels` pixels and its placed area
 *   (pixels / ppi * 72 points) covers `minSignificantImageCoverage` of the page.
 * - A significant image whose object is drawn on at least `repeatedImageMinPages` pages, and on at least
 *   `repeatedImageMinShare` of the `pagesInScope` pages, is page furniture (logo, letterhead, slide background) and
 *   leaves the totals: a scan is a different image on every page. Inline images have no object identity and are
 *   never repeated.
 * - Totals are per page and the line limit is document-wide only for pages not yet read, so a page of 100,000
 *   tiny images costs one counter and cannot hide later pages.
 */
export function summarizeImageListing(
  stdout: string,
  options: { pageAreas: Map<number, number>; defaultPageArea?: number; pagesInScope: number; maxLines?: number },
): ImageListingSummary {
  const maxLines = options.maxLines ?? MAX_IMAGE_ROWS;
  const tracked = new Map<number, { rows: Array<{ key: string | null; coverage: number }>; overflowCount: number; overflowCoverage: number; overflowLargest: number; any: number }>();
  const objectPages = new Map<string, { pages: number; last: number }>();
  let truncatedAfterPage: number | null = null;
  let lastPage = 0;
  let lines = 0;
  for (const line of stdout.split("\n")) {
    if (++lines > maxLines) {
      truncatedAfterPage = Math.max(0, lastPage - 1);
      // The page being read when the limit hit is incomplete as well.
      tracked.delete(lastPage);
      break;
    }
    const row = parsePdfImagesRow(line);
    if (!row) continue;
    lastPage = row.pageNumber;
    const entry = tracked.get(row.pageNumber) ?? { rows: [], overflowCount: 0, overflowCoverage: 0, overflowLargest: 0, any: 0 };
    tracked.set(row.pageNumber, entry);
    entry.any += 1;
    const pageArea = options.pageAreas.get(row.pageNumber) ?? options.defaultPageArea;
    if (!pageArea || Math.min(row.width, row.height) < MIN_SIGNIFICANT_IMAGE_PIXELS) continue;
    // Placed size in points: pixels / (pixels per inch) * 72 points per inch.
    const coverage = Math.min(1, ((row.width / row.xPpi) * 72 * ((row.height / row.yPpi) * 72)) / pageArea);
    if (!(coverage >= MIN_SIGNIFICANT_IMAGE_COVERAGE)) continue;
    if (row.objectKey !== null) {
      const seen = objectPages.get(row.objectKey);
      if (seen) {
        if (seen.last !== row.pageNumber) { seen.pages += 1; seen.last = row.pageNumber; }
      } else if (objectPages.size < MAX_TRACKED_OBJECTS) {
        objectPages.set(row.objectKey, { pages: 1, last: row.pageNumber });
      }
    }
    if (entry.rows.length < MAX_TRACKED_IMAGES_PER_PAGE) entry.rows.push({ key: row.objectKey, coverage });
    else {
      entry.overflowCount += 1;
      entry.overflowCoverage += coverage;
      entry.overflowLargest = Math.max(entry.overflowLargest, coverage);
    }
  }
  const scope = Math.max(1, options.pagesInScope);
  const repeated = new Set<string>();
  for (const [key, seen] of objectPages) {
    if (seen.pages >= PAGE_RASTER_ROUTING.repeatedImageMinPages && seen.pages / scope >= PAGE_RASTER_ROUTING.repeatedImageMinShare) repeated.add(key);
  }
  const pages = new Map<number, PageImageTotals>();
  for (const [pageNumber, entry] of tracked) {
    const totals: PageImageTotals = { anyImageCount: entry.any, imageCount: entry.overflowCount, imageCoverage: entry.overflowCoverage, largestImageCoverage: entry.overflowLargest, repeatedImageCount: 0 };
    for (const image of entry.rows) {
      if (image.key !== null && repeated.has(image.key)) { totals.repeatedImageCount += 1; continue; }
      totals.imageCount += 1;
      totals.imageCoverage += image.coverage;
      totals.largestImageCoverage = Math.max(totals.largestImageCoverage, image.coverage);
    }
    totals.imageCoverage = Math.min(1, totals.imageCoverage);
    pages.set(pageNumber, totals);
  }
  return { pages, truncatedAfterPage };
}

/** Evidence for the given sparse pages (page number to native words) from an image listing summary. */
export function buildPageImageEvidence(args: {
  sparsePages: Map<number, number>;
  listing: ImageListingSummary;
}): PageImageEvidence[] {
  return [...args.sparsePages]
    .map(([pageNumber, wordCount]) => {
      const known = args.listing.truncatedAfterPage === null || pageNumber <= args.listing.truncatedAfterPage;
      const totals = args.listing.pages.get(pageNumber);
      return {
        pageNumber,
        wordCount,
        imagesKnown: known,
        anyImageCount: known ? totals?.anyImageCount ?? 0 : 0,
        repeatedImageCount: known ? totals?.repeatedImageCount ?? 0 : 0,
        imageCount: known ? totals?.imageCount ?? 0 : 0,
        imageCoverage: round(known ? totals?.imageCoverage ?? 0 : 0),
        largestImageCoverage: round(known ? totals?.largestImageCoverage ?? 0 : 0),
      };
    })
    .sort((left, right) => left.pageNumber - right.pageNumber);
}

/**
 * Sparse pages (page number to native word count) from page-aligned texts. Returns an empty map when no page is
 * sparse. `textLayerPages` are the PDF's own layer per page (null where unknown).
 */
export function findSparsePages(pageTexts: string[], textLayerPages?: Array<string | null> | null): Map<number, number> {
  const sparse = new Map<number, number>();
  pageTexts.forEach((text, index) => {
    const words = nativePageWords(text, textLayerPages?.[index]);
    if (words < SPARSE_PAGE_WORDS) sparse.set(index + 1, words);
  });
  return sparse;
}

/**
 * Native words on a page. Extracted text can come from OCR of a raster (Tesseract inside the extractor), which is
 * word-shaped yet says nothing about the text layer: a scan with OCR text is still a raster page. When the PDF's own
 * text layer is known (page facts' pdftotext run), it alone is the native text; otherwise the extracted text stands
 * in for it (an OCR'd scan past the page-facts range then reads as text, the cheap side).
 */
export function nativePageWords(extractedText: string, textLayerText?: string | null): number {
  return pageEvidenceWordCount(typeof textLayerText === "string" ? textLayerText : extractedText);
}

/**
 * Bytes of every distinct embedded image in a `pdfimages -list` listing (an image object drawn
 * on several pages counts once, as it is stored once), or null when any row's size is unknown or
 * the listing is implausibly long.
 */
export function totalEmbeddedImageBytes(stdout: string): number | null {
  const seen = new Set<string>();
  let total = 0;
  let rows = 0;
  for (const line of stdout.split("\n")) {
    const f = pdfImagesListFields(line);
    if (!/^\d+$/.test(f[0] ?? "")) continue;
    if (++rows > 100_000) return null;
    if (!["image", "mask", "smask", "stencil"].includes(f[2] ?? "")) return null;
    const size = /^(\d+(?:\.\d+)?)([BKMG]?)$/.exec(f[14] ?? "");
    const bytes = size ? Math.round(Number(size[1]) * 1024 ** ("BKMG".indexOf(size[2] || "B"))) : NaN;
    if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
    const id = /^\d+$/.test(f[10] ?? "") && /^\d+$/.test(f[11] ?? "") ? `${f[10]}:${f[11]}` : `inline:${rows}`;
    if (seen.has(id)) continue;
    seen.add(id);
    total += bytes;
  }
  return Number.isSafeInteger(total) ? total : null;
}

/**
 * Drawn bytes per page: (file bytes - all embedded image bytes) / pages, or null when either is
 * unknown. See `PageImageEvidenceArtifact.drawnBytesPerPage`.
 */
export function drawnBytesPerPage(fileBytes: number | null, imageBytes: number | null, pageCount: number): number | null {
  if (fileBytes === null || imageBytes === null || !Number.isFinite(fileBytes) || fileBytes < 0) return null;
  return Math.round(Math.max(0, fileBytes - imageBytes) / Math.max(1, pageCount));
}

/**
 * Whether a PNG page render (pdftoppm, RGB) is blank: its compressed size is within 5% of a white
 * page of the same pixel count (about 3.6 KB per megapixel plus 0.75 KB of headers at 72 to 300
 * dpi; one short line of anti-aliased text adds 15 to 35%). A page holding only a few solid bars
 * also reads as blank; it has nothing for vision to transcribe. The size of our own render needs no decoding
 * and cannot be inflated by bytes the PDF carries but never draws (padding, metadata,
 * attachments, unused fonts). Unknown dimensions or a non-PNG raster are never called blank.
 */
export function renderLooksBlank(raster: { sizeBytes: number; widthPx: number | null; heightPx: number | null; mimeType: string }): boolean {
  if (raster.mimeType !== "image/png" || !raster.widthPx || !raster.heightPx || !(raster.sizeBytes > 0)) return false;
  const megapixels = (raster.widthPx * raster.heightPx) / 1e6;
  const whitePageBytes = 3.6 * 1024 * megapixels + 0.75 * 1024;
  return raster.sizeBytes <= whitePageBytes * BLANK_RENDER_TOLERANCE;
}

const BLANK_RENDER_TOLERANCE = 1.05;

/**
 * Ink check for a page nominated only by drawn-content bytes: `ink` goes to vision; `blank` and
 * `unknown` do not. Fails closed: a render whose type, size or pixel dimensions cannot be
 * confirmed is never sent, since the nomination itself is only a byte-count hint.
 */
export function inkCheckVerdict(raster: { sizeBytes: number; widthPx: number | null; heightPx: number | null; mimeType: string }): "ink" | "blank" | "unknown" {
  if (raster.mimeType !== "image/png" || !raster.widthPx || !raster.heightPx || !(raster.sizeBytes > 0)) return "unknown";
  return renderLooksBlank(raster) ? "blank" : "ink";
}

/**
 * Size and pixel dimensions of a PNG on disk, read from the file itself (24 header bytes), so a
 * cached render needs no manifest: the file is the one vision would receive. Nulls when it is not
 * a PNG.
 */
export async function readPngFileFacts(filePath: string): Promise<{ sizeBytes: number; widthPx: number | null; heightPx: number | null }> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, 24, 0);
    const png = bytesRead === 24 && header.readUInt32BE(0) === 0x89504e47 && header.toString("ascii", 12, 16) === "IHDR";
    return { sizeBytes: size, widthPx: png ? header.readUInt32BE(16) : null, heightPx: png ? header.readUInt32BE(20) : null };
  } finally {
    await handle.close();
  }
}

/**
 * Evidence for an uploaded image file: one page with no text layer whose content is a single
 * full-page raster. Any text extracted for it came from OCR.
 */
export function imageFilePageEvidence(): PageImageEvidence[] {
  return [{ pageNumber: 1, wordCount: 0, imageCount: 1, imageCoverage: 1, largestImageCoverage: 1, embeddedImageBytes: null }];
}

/** Native words on a page by Unicode script (`pageWordCount`): the one word counter routing and billing share. */
export function pageEvidenceWordCount(text: string): number {
  return pageWordCount(text);
}

/**
 * Page texts when `text` is page-aligned: one form-feed section per page, a single-page
 * document, or no text at all. Null when page boundaries are unknown (sliced text would
 * put the wrong words on the wrong page).
 */
export function pageAlignedTexts(text: string, pageCount: number): string[] | null {
  const pages = Math.max(1, Math.floor(pageCount));
  if (!text.trim()) return Array.from({ length: pages }, () => "");
  if (pages === 1) return [text];
  if (!text.includes("\f")) return null;
  // Do not use splitTextIntoPages here: its equal-length fallback invents boundaries.
  const split = text.replace(/\r\n/g, "\n").split("\f").map((page) => page.trim());
  while (split.length > pages && split[split.length - 1] === "") split.pop();
  return split.length === pages ? split : null;
}

const EVIDENCE_TIMEOUT_MS = 20_000;
/** Pages whose image listing is read for repeat detection beyond the sparse pages (furniture shows on every page). */
const LISTING_SCOPE_PAGES = 1000;
/** Suspect text layers checked against an OCR of the page per document, spread over the suspect pages. */
export const TEXT_LAYER_OCR_SAMPLE_PAGES = 6;
/** Characters of a page's text the quality assessment reads. */
const ASSESSED_PAGE_CHARS = 65_536;

/**
 * Whether suspect text layers match an OCR of their pages: a verdict for the pages given, `null` per page when the
 * check could not run (no OCR, no language data, a render failure). Supplied by the stage that owns the sandbox.
 */
export type TextLayerVerifier = (pages: Array<{ pageNumber: number; text: string }>, signal?: AbortSignal) => Promise<Map<number, boolean | null>>;

/**
 * Verdict for suspect pages from a sample: up to `TEXT_LAYER_OCR_SAMPLE_PAGES` pages spread over them are checked and
 * the rest take the sample's verdict when it is unanimous over at least two checked pages; otherwise they stay
 * unchecked (null). A glyph substitution is a property of a font, so it shows on every page that font set.
 */
export async function verifySuspectPages(
  suspect: Array<{ pageNumber: number; text: string }>,
  verify: TextLayerVerifier,
  signal?: AbortSignal,
): Promise<Map<number, boolean | null>> {
  const verdicts = new Map<number, boolean | null>();
  if (suspect.length === 0) return verdicts;
  const count = Math.min(TEXT_LAYER_OCR_SAMPLE_PAGES, suspect.length);
  const sample = Array.from({ length: count }, (_, i) => suspect[Math.floor((i * suspect.length) / count)]!);
  const checked = await verify(sample, signal);
  const results = sample.map((page) => checked.get(page.pageNumber) ?? null);
  for (const [index, page] of sample.entries()) verdicts.set(page.pageNumber, results[index]!);
  const known = results.filter((result): result is boolean => result !== null);
  const unanimous = known.length >= 2 && known.every((result) => result === known[0]) ? known[0]! : null;
  for (const page of suspect) if (!verdicts.has(page.pageNumber)) verdicts.set(page.pageNumber, unanimous);
  return verdicts;
}

/**
 * Evidence for the pages of a PDF that need it, or null when no page does or the Poppler tools are unavailable or fail
 * (callers then keep text-only triage):
 *
 * - sparse pages (few native words): significant, non-repeated image coverage from `pdfimages -list` and page sizes;
 * - pages whose text layer is garbled or suspect (`assessTextLayer`), sparse or not, with an OCR cross-check of a
 *   sample of the suspect ones.
 */
export async function collectPageImageEvidence(args: {
  runner: Pick<CommandRunner, "listPdfImages" | "pdfPageSizes" | "run">;
  sourcePath: string;
  pageTexts: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * A `pdfimages -list` run another step already started for pages 1..lastPage (the ingest
   * report's page facts). Reused when it covers every sparse page and succeeded.
   */
  sharedImagesList?: { lastPage: number; stdout: Promise<string | null> };
  /**
   * The PDF's own text layer per page (form-feed split pdftotext output from page facts), when known; null for
   * pages past its range, which keep the extracted text.
   */
  textLayerPages?: Array<string | null> | null;
  /** OCR cross-check for suspect text layers; absent leaves them unchecked (not read, never billed). */
  verifyTextLayer?: TextLayerVerifier;
}): Promise<PageImageEvidence[] | null> {
  const layerOf = (index: number): { text: string; source: "text-layer" | "extracted" } => {
    const layer = args.textLayerPages?.[index];
    return typeof layer === "string" ? { text: layer, source: "text-layer" } : { text: args.pageTexts[index] ?? "", source: "extracted" };
  };
  const sparsePages = findSparsePages(args.pageTexts, args.textLayerPages);
  const layers = new Map<number, PageTextLayerEvidence>();
  const suspectPages: Array<{ pageNumber: number; text: string }> = [];
  args.pageTexts.forEach((_, index) => {
    const { text, source } = layerOf(index);
    const assessment = assessTextLayer(text.length > ASSESSED_PAGE_CHARS ? text.slice(0, ASSESSED_PAGE_CHARS) : text);
    if (assessment.verdict === "ok" || assessment.verdict === "empty") return;
    layers.set(index + 1, { verdict: assessment.verdict, reasons: assessment.reasons, source, ...(assessment.verdict === "suspect" ? { matchesOcr: null } : {}) });
    if (assessment.verdict === "suspect") suspectPages.push({ pageNumber: index + 1, text });
  });
  if (sparsePages.size === 0 && layers.size === 0) return null;

  let evidence = new Map<number, PageImageEvidence>();
  if (sparsePages.size > 0) {
    const pageNumbers = [...sparsePages.keys()];
    const last = Math.max(...pageNumbers);
    const scopeLast = Math.min(Math.max(last, Math.min(args.pageTexts.length, LISTING_SCOPE_PAGES)), Math.max(1, args.pageTexts.length));
    const timeoutMs = args.timeoutMs ?? EVIDENCE_TIMEOUT_MS;
    const withTimeout = () => {
      const timeout = AbortSignal.timeout(timeoutMs);
      return args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
    };
    let listing: string | null = null;
    let listedTo = scopeLast;
    if (args.sharedImagesList && args.sharedImagesList.lastPage >= last) {
      listing = await args.sharedImagesList.stdout.catch(() => null);
      listedTo = args.sharedImagesList.lastPage;
    }
    if (listing === null) {
      const listPlan = await args.runner.listPdfImages(args.sourcePath, 1, scopeLast);
      if (!listPlan.available) return null;
      listing = (await args.runner.run(listPlan, withTimeout())).stdout;
      listedTo = scopeLast;
    }
    let pageAreas = new Map<number, number>();
    if (/^\s*\d+\s/m.test(listing)) {
      const sizePlan = await args.runner.pdfPageSizes(args.sourcePath, 1, listedTo);
      if (sizePlan.available) pageAreas = parsePdfPageAreas((await args.runner.run(sizePlan, withTimeout())).stdout);
    }
    const summary = summarizeImageListing(listing, { pageAreas, defaultPageArea: US_LETTER_AREA, pagesInScope: listedTo });
    const imageBytes = embeddedImageBytesByPage(listing);
    for (const page of buildPageImageEvidence({ sparsePages, listing: summary })) {
      evidence.set(page.pageNumber, { ...page, embeddedImageBytes: imageBytes.get(page.pageNumber) ?? null });
    }
  }

  if (args.verifyTextLayer && suspectPages.length > 0) {
    const verdicts = await verifySuspectPages(suspectPages, args.verifyTextLayer, args.signal).catch(() => new Map<number, boolean | null>());
    for (const [pageNumber, matches] of verdicts) {
      const layer = layers.get(pageNumber);
      if (layer) layer.matchesOcr = matches;
    }
  }
  for (const [pageNumber, layer] of layers) {
    const existing = evidence.get(pageNumber);
    if (existing) existing.textLayer = layer;
    else {
      const { text } = layerOf(pageNumber - 1);
      evidence.set(pageNumber, { pageNumber, wordCount: pageWordCount(text), imageCount: 0, imageCoverage: 0, largestImageCoverage: 0, textLayer: layer });
    }
  }
  evidence = new Map([...evidence].sort(([left], [right]) => left - right));
  return [...evidence.values()];
}

/** Fallback page area (US Letter, 612 x 792 pt) when page sizes are unavailable. */
const US_LETTER_AREA = 612 * 792;

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

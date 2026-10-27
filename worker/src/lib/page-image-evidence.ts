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

import type { CommandRunner } from "../tools/runner.js";
import { embeddedImageBytesByPage } from "./page-yield-evidence.js";

/** Pages with fewer native words than this are "sparse" and get raster evidence. */
export const SPARSE_PAGE_WORDS = 30;
/** Images covering less than this share of the page (logos, bullets, rules, tracking pixels) are ignored. */
export const MIN_SIGNIFICANT_IMAGE_COVERAGE = 0.02;
/** Images with a shorter side than this (in pixels) carry no readable content. */
export const MIN_SIGNIFICANT_IMAGE_PIXELS = 32;
/** Parsing stops after this many `pdfimages` rows; the rest of a hostile list is ignored. */
export const MAX_IMAGE_ROWS = 100_000;

export interface PageImageEvidence {
  pageNumber: number;
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
  source: "pdfimages";
  sparsePageWords: number;
  pages: PageImageEvidence[];
}

export interface PdfImageRow {
  pageNumber: number;
  type: string;
  width: number;
  height: number;
  xPpi: number;
  yPpi: number;
}

/** Parse `pdfimages -list` output. Masks (`smask`, `mask`) describe another image's alpha and are skipped. */
export function parsePdfImagesList(stdout: string, maxRows = MAX_IMAGE_ROWS): PdfImageRow[] {
  const rows: PdfImageRow[] = [];
  for (const line of stdout.split("\n")) {
    if (rows.length >= maxRows) break;
    const fields = line.trim().split(/\s+/);
    // page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio
    if (fields.length < 14 || !/^\d+$/.test(fields[0]!)) continue;
    const type = fields[2]!;
    if (type !== "image" && type !== "stencil") continue;
    const [pageNumber, width, height, xPpi, yPpi] = [fields[0], fields[3], fields[4], fields[12], fields[13]].map(Number);
    if (![pageNumber, width, height, xPpi, yPpi].every((value) => Number.isFinite(value) && value! > 0)) continue;
    rows.push({ pageNumber: pageNumber!, type, width: width!, height: height!, xPpi: xPpi!, yPpi: yPpi! });
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

/** Evidence for the given sparse pages from parsed image rows and page areas. */
export function buildPageImageEvidence(args: {
  sparsePages: Map<number, number>;
  images: PdfImageRow[];
  pageAreas: Map<number, number>;
  defaultPageArea?: number;
}): PageImageEvidence[] {
  const evidence = new Map<number, PageImageEvidence>();
  for (const [pageNumber, wordCount] of args.sparsePages) {
    evidence.set(pageNumber, { pageNumber, wordCount, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0 });
  }
  for (const image of args.images) {
    const entry = evidence.get(image.pageNumber);
    if (!entry) continue;
    if (Math.min(image.width, image.height) < MIN_SIGNIFICANT_IMAGE_PIXELS) continue;
    const pageArea = args.pageAreas.get(image.pageNumber) ?? args.defaultPageArea;
    if (!pageArea) continue;
    // Placed size in points: pixels / (pixels per inch) * 72 points per inch.
    const placedArea = (image.width / image.xPpi) * 72 * ((image.height / image.yPpi) * 72);
    const coverage = Math.min(1, placedArea / pageArea);
    if (coverage < MIN_SIGNIFICANT_IMAGE_COVERAGE) continue;
    entry.imageCount += 1;
    entry.imageCoverage = Math.min(1, entry.imageCoverage + coverage);
    entry.largestImageCoverage = Math.max(entry.largestImageCoverage, coverage);
  }
  return [...evidence.values()]
    .map((entry) => ({
      ...entry,
      imageCoverage: round(entry.imageCoverage),
      largestImageCoverage: round(entry.largestImageCoverage),
    }))
    .sort((left, right) => left.pageNumber - right.pageNumber);
}

/**
 * Sparse pages (page number → native word count) from page-aligned texts. Returns an
 * empty map when no page is sparse.
 */
export function findSparsePages(pageTexts: string[]): Map<number, number> {
  const sparse = new Map<number, number>();
  pageTexts.forEach((text, index) => {
    const words = pageEvidenceWordCount(text);
    if (words < SPARSE_PAGE_WORDS) sparse.set(index + 1, words);
  });
  return sparse;
}

/**
 * Approximate native words on a page: letter/digit runs of 2+ characters (so Markdown
 * syntax and stray glyphs do not count), or letters/digits / 6 for scripts written
 * without spaces (CJK), whichever is larger.
 */
export function pageEvidenceWordCount(text: string): number {
  const runs = (text.match(/[\p{L}\p{N}]{2,}/gu) ?? []).length;
  const characters = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return Math.max(runs, Math.floor(characters / 6));
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

/**
 * Raster evidence for the sparse pages of a PDF, or null when no page is sparse or the
 * Poppler tools are unavailable or fail (callers then keep text-only triage).
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
}): Promise<PageImageEvidence[] | null> {
  const sparsePages = findSparsePages(args.pageTexts);
  if (sparsePages.size === 0) return null;
  const pageNumbers = [...sparsePages.keys()];
  const first = Math.min(...pageNumbers);
  const last = Math.max(...pageNumbers);
  const timeoutMs = args.timeoutMs ?? EVIDENCE_TIMEOUT_MS;
  const withTimeout = () => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
  };
  let listing: string | null = null;
  if (args.sharedImagesList && args.sharedImagesList.lastPage >= last) {
    listing = await args.sharedImagesList.stdout.catch(() => null);
  }
  if (listing === null) {
    const listPlan = await args.runner.listPdfImages(args.sourcePath, first, last);
    if (!listPlan.available) return null;
    listing = (await args.runner.run(listPlan, withTimeout())).stdout;
  }
  const images = parsePdfImagesList(listing).filter((image) => sparsePages.has(image.pageNumber));
  let pageAreas = new Map<number, number>();
  if (images.length > 0) {
    const sizePlan = await args.runner.pdfPageSizes(args.sourcePath, first, last);
    if (sizePlan.available) {
      pageAreas = parsePdfPageAreas((await args.runner.run(sizePlan, withTimeout())).stdout);
    }
  }
  const imageBytes = embeddedImageBytesByPage(listing);
  return buildPageImageEvidence({ sparsePages, images, pageAreas, defaultPageArea: US_LETTER_AREA })
    .map((page) => ({ ...page, embeddedImageBytes: imageBytes.get(page.pageNumber) ?? null }));
}

/** Fallback page area (US Letter, 612 x 792 pt) when page sizes are unavailable. */
const US_LETTER_AREA = 612 * 792;

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

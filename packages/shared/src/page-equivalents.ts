import { measuredTextPages } from "./media-upload-estimate.js";

/**
 * Page equivalents: what a page costs to process, measured from what was actually extracted or rendered, never from the
 * document's metadata. A page counts as the larger of 1, the text rule over its extracted text (the rule Office and text
 * files are counted by: TEXT_PAGE_LINES lines or TEXT_PAGE_CHARS characters a page), and its rendered area against a
 * standard page (capped per real page). Packing a book onto one page (tiny or invisible text, text outside the visible box,
 * a 200-inch page) counts as the pages it holds. This is a measurement only; prices are applied elsewhere.
 */

/** The standard page an area is measured against: US Letter, in square points. */
export const STANDARD_PAGE_AREA_PT2 = 612 * 792;
/** Most standard pages one real page's area may count as: rendering and OCR are pixel-bounded per page (raster caps). */
export const PAGE_AREA_EQUIVALENTS_CAP = 8;
/**
 * DPI an uploaded image's pixels are read at to give it a page area: the standard scan resolution, so a Letter page scanned
 * at 300 dpi (2550 x 3300 px) is one page.
 */
export const IMAGE_AREA_DPI = 300;
/** A page whose text counts as more than this many pages is reported as dense (possible hidden or stuffed text). */
export const DENSE_PAGE_EQUIVALENTS = 3;

/**
 * The dense-page allowance for paged documents (PDF pages, image frames), owner decision 2026-11-05: a page whose text counts
 * as this many pages or fewer bills as 1; above it, the page bills its full text volume (the text rule, rounded up). Dense
 * papers, contracts and statements stay one page each; stuffed pages are still caught. Area equivalents and their cap are not
 * affected, and Office, EPUB, HTML and text files keep the whole-document text rule (no allowance). The pricing provider may
 * set its own (`pageEquivalentAllowance`); this is core's default.
 */
export const DEFAULT_PAGE_EQUIVALENT_ALLOWANCE = 3;

/** Text equivalents one paged-document page bills under `allowance`: 1 up to the allowance, its full volume above it. */
export function billedPageEquivalents(textEquivalents: number, allowance: number = DEFAULT_PAGE_EQUIVALENT_ALLOWANCE): number {
  const text = Math.max(1, Math.floor(textEquivalents) || 1);
  return text > Math.max(1, Math.floor(allowance) || 1) ? text : 1;
}

/** Pages of text on one extracted page by the text rule (never sampled), at least 1. */
export function pageTextEquivalents(pageText: string): number {
  return pageText.trim() ? Math.max(1, measuredTextPages(pageText)) : 1;
}

/** Standard pages one rendered page's area counts as: its pixels at `dpi` back to points, against a Letter page, 1..cap. */
export function pageAreaEquivalents(widthPx: number, heightPx: number, dpi: number): number {
  if (![widthPx, heightPx, dpi].every((value) => Number.isFinite(value) && value > 0)) return 1;
  const areaPt2 = (widthPx * 72 / dpi) * (heightPx * 72 / dpi);
  return Math.min(PAGE_AREA_EQUIVALENTS_CAP, Math.max(1, Math.ceil(areaPt2 / STANDARD_PAGE_AREA_PT2 - 1e-9)));
}

/** Standard pages a page of `widthPt` x `heightPt` points counts as, 1..cap. */
export function pageAreaEquivalentsPt(widthPt: number, heightPt: number): number {
  return pageAreaEquivalents(widthPt, heightPt, 72);
}

/**
 * Area equivalents of an uploaded image frame: its pixels as the OCR read takes them (scaled down so the long edge is at
 * most `readLongEdge`, the OCR boundary's cap, when given), against a Letter page at IMAGE_AREA_DPI, capped per frame. An
 * ordinary upload (a scan, a phone photo) is one page; only a read cap above the default lets one frame count as more.
 */
export function imageAreaEquivalents(widthPx: number, heightPx: number, readLongEdge?: number): number {
  const longEdge = Math.max(widthPx, heightPx);
  const scale = readLongEdge && readLongEdge > 0 && longEdge > readLongEdge ? readLongEdge / longEdge : 1;
  return pageAreaEquivalents(widthPx * scale, heightPx * scale, IMAGE_AREA_DPI);
}

/** One page's equivalents: the larger of its text and its area, at least 1. */
export function pageEquivalents(text: number, area = 1): number {
  return Math.max(1, Math.floor(text) || 1, Math.floor(area) || 1);
}

/** What one paged-document page bills: the larger of its billed text (under the allowance) and its full area, at least 1. */
export function billedPagePageEquivalents(text: number, area = 1, allowance: number = DEFAULT_PAGE_EQUIVALENT_ALLOWANCE): number {
  return Math.max(billedPageEquivalents(text, allowance), Math.floor(area) || 1, 1);
}

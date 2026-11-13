/**
 * Doppler page facts (`doppler-page-facts/1`, already validated by lib/doppler-page-facts.ts) as `PageLayoutFacts`, so
 * classify-route and page-image evidence read them unchanged. Pure: no I/O, no clock.
 *
 * Field by field (PageLayoutFacts ← facts):
 * - `words` ← `text.wordCount` (every word of the text layer, visible or not, as the walker's word boxes count them).
 *   Unknown (null) without the `text` family.
 * - `invisibleWords` ← `text.invisibleWordCount`; `textLayer` ← `text.textLayer` (same four values). Absent without `text`.
 * - `widthPt`/`heightPt` ← `geometry.widthPt`/`heightPt` (the CropBox, rotation applied). The walker measures CropBox ∩
 *   MediaBox, so the two differ only for a CropBox reaching outside the MediaBox. Absent outside 1..14,400 pt, as the
 *   layout reader bounds them.
 * - `images` ← `images.items` (`images-detail` family): `bbox`, `coverage`, `px` → `widthPx`/`heightPx`, `bpc` →
 *   `bitsPerComponent`, `dpi` → `ppi` (non-positive → null), `filter` → `encoding` and `colorSpace` in the walker's
 *   `pdfimages -list` vocabulary, `repeated` from `obj` across the pages given (the walker's furniture rule).
 *   `wordsInside` ← `visibleWordsInside` + `invisibleWordsInside` (the walker counts every text-layer word whose centre is
 *   inside; Doppler a word whose whole box is, within 1 pt), null when the pair is absent; a count of at most
 *   `mixedScanMaxWordsInside` stands only when the page's centre-based `textOverImageRatio` is 0 and the image's grid cells
 *   cover its whole box (`wordsInside`), so it is never lower than the walker's.
 *   `coverage` is capped by the image's own box over the page. `bytesPerPixel` ← `bytesPerPixel`
 *   one to one, null when absent (never 0). Both are routing hints from what the file says: never a billing input.
 *   Null (unknown) when the list was not computed, is truncated, or holds fewer items than `imageCount`.
 * - `grids` ← `[]` when there is no walker grid: fewer than 2 horizontal or 3 vertical rules on the page, or a complete
 *   `vectors.grids` list without a grid of two or more columns (one column is parallel rules: form lines, lined paper).
 *   A grid Doppler found is unknown (null): its search is not the walker's (shaded boxes count as rules, column lines need
 *   no outer sides) and the facts carry no rule positions to tell which grids the walker would find. Null too when the list
 *   is truncated or absent (older builds), or at the drawing cap; never a guessed grid.
 * - `tables` ← null: tables come from the extractor's Markdown. `tableCoverage` ← 0 with a `[]` known from the list, else null.
 * - A failed page (`error: failed`) is omitted: unknown. A page marked `xref-repaired-earlier` (any of its facts may come
 *   from an object the file holds twice) keeps only its size: images, words, grids and table coverage are unknown.
 */
import { PAGE_RASTER_ROUTING, type PageLayoutImage } from "@docslurp/shared";

import { dopplerPageExtent, dopplerPageFactsLowConfidence, type Box, type DopplerColorSpace, type DopplerImageFilter, type DopplerImageItem, type DopplerPageFacts, type DopplerPageFactsDocument, type DopplerScan, type DopplerTextLayer } from "./doppler-page-facts.js";
import type { PageLayoutFacts } from "./page-layout-facts.js";

/** The walker's `pdfimages -list` encodings (worker/scripts/pdf_layout_facts.py LISTING_ENCODINGS). */
const ENCODING: Record<DopplerImageFilter, string> = {
  dct: "jpeg", jpx: "jpx", jbig2: "jbig2", ccitt: "ccitt", rl: "rle", flate: "image", lzw: "image", none: "image", other: "other",
};
/** The walker's `pdfimages -list` colour spaces (LISTING_COLORS). */
const COLOR: Record<DopplerColorSpace, string> = {
  gray: "gray", rgb: "rgb", cmyk: "cmyk", lab: "lab", indexed: "index", icc1: "icc", icc3: "icc", icc4: "icc", sep: "sep",
  devn: "devn", none: "-", other: "other",
};
/** The walker's furniture rule (PAGE_RASTER_ROUTING.repeatedImageMinPages / repeatedImageMinShare). */
const REPEATED_MIN_PAGES = 3;
const REPEATED_MIN_SHARE = 0.2;
/** The layout reader's page-side bounds (parsePageLayoutFacts). */
const MIN_SIDE_PT = 1;
const MAX_SIDE_PT = 14_400;
/** The walker's minimum ruled grid: 2 distinct horizontals and 3 distinct verticals. */
const GRID_MIN_H = 2;
const GRID_MIN_V = 3;
/** The walker's minimum grid in columns (3 distinct verticals). */
const GRID_MIN_COLUMNS = 2;
/** Doppler's coverage grid (64 x 64 cells a page) for `textOverImageRatio`. */
const COVERAGE_GRID = 64;

/** Image objects drawn on enough of the `considered` pages to be page furniture (the walker's and the probe's rule). */
export function repeatedDopplerImageObjects(pages: Iterable<DopplerPageFacts>, considered: number): Set<number> {
  const seen = new Map<number, Set<number>>();
  for (const page of pages) {
    for (const item of page.images?.items ?? []) {
      if (item.obj === undefined) continue;
      const set = seen.get(item.obj) ?? new Set<number>();
      set.add(page.page);
      seen.set(item.obj, set);
    }
  }
  const floor = Math.max(REPEATED_MIN_PAGES, Math.ceil(REPEATED_MIN_SHARE * Math.max(1, considered)));
  return new Set([...seen].filter(([, set]) => set.size >= floor).map(([obj]) => obj));
}

function layoutImages(page: DopplerPageFacts, repeated: Set<number>): PageLayoutImage[] | null {
  const images = page.images;
  if (!images?.items || images.truncated || images.itemsTruncated || images.items.length < images.imageCount) return null;
  // Low confidence (an earlier page rebuilt the xref): sizes and stream ratios are unknown, so they authorize nothing.
  const extent = dopplerPageExtent(page.geometry);
  return images.items.map((item) => ({
    bbox: [...item.bbox] as [number, number, number, number],
    coverage: boxCappedCoverage(item.coverage, item.bbox, extent),
    widthPx: item.px[0],
    heightPx: item.px[1],
    bitsPerComponent: item.bpc ?? null,
    colorSpace: COLOR[item.colorSpace],
    encoding: ENCODING[item.filter],
    ppi: [item.dpi[0] > 0 ? item.dpi[0] : null, item.dpi[1] > 0 ? item.dpi[1] : null],
    bytesPerPixel: item.bytesPerPixel ?? null,
    repeated: item.obj !== undefined && repeated.has(item.obj),
    wordsInside: wordsInside(page, item),
  }));
}

/**
 * An image's share of its page, never more than its own box allows: the reported coverage capped by the box clipped to the
 * page (as page-image evidence caps it), so a forged coverage on a small box cannot pass for a large scan. Null (unknown)
 * without a page extent.
 */
function boxCappedCoverage(coverage: number, bbox: Box, extent: [number, number] | null): number | null {
  if (!extent || !(extent[0] > 0 && extent[1] > 0)) return null;
  const [w, h] = extent;
  const x = Math.max(0, Math.min(w, bbox[2]) - Math.max(0, bbox[0])), y = Math.max(0, Math.min(h, bbox[3]) - Math.max(0, bbox[1]));
  return Math.min(coverage, Math.round((x * y) / (w * h) * 10_000) / 10_000);
}

/**
 * An image's words inside as the walker would count them, or null. Doppler counts a word inside only when its whole box is
 * (within 1 pt); the walker when its centre is, so a word straddling the edge (a label overrunning a figure) counts for
 * the walker only and a facts count can be lower. Only a low count matters: `mixedScanImage` reads an image with at most
 * `mixedScanMaxWordsInside` words inside. So a count above that stands (the walker's is at least as high). A count at or
 * below it stands only when no word's centre can be inside the image uncounted: the page's `text.textOverImageRatio` (characters
 * whose centre is in a cell of the image's 64 x 64 grid, a cell being the image's when its centre is inside the box) is 0,
 * and the image's marked cells cover its whole box (`gridCoversBox`), so no strip inside an edge escapes the ratio.
 * Otherwise (or without the ratio, the pair or a page extent) the count is unknown: stricter than the walker, never looser.
 */
function wordsInside(page: DopplerPageFacts, item: DopplerImageItem): number | null {
  if (item.visibleWordsInside === undefined || item.invisibleWordsInside === undefined) return null;
  const count = item.visibleWordsInside + item.invisibleWordsInside;
  if (count > PAGE_RASTER_ROUTING.mixedScanMaxWordsInside) return count;
  const extent = dopplerPageExtent(page.geometry);
  return page.text?.textOverImageRatio === 0 && extent !== null && gridCoversBox(item.bbox, extent) ? count : null;
}

/**
 * Whether the cells of a 64 x 64 grid over a `w` x `h` page whose centres lie strictly inside `box` cover the whole box
 * (clipped to the page): each edge must lie at or before the centre of the cell it falls in, on the inside. A centre on the
 * edge is taken as outside, the stricter reading.
 */
export function gridCoversBox(box: Box, [w, h]: [number, number]): boolean {
  if (!(w > 0 && h > 0)) return false;
  const axis = (lo: number, hi: number, side: number): boolean => {
    const cell = side / COVERAGE_GRID;
    const a = Math.max(0, lo), b = Math.min(side, hi);
    if (!(b > a)) return false;
    const first = Math.floor(a / cell - 0.5) + 1;  // the first cell whose centre is > a
    const last = Math.ceil(b / cell - 0.5) - 1;    // the last cell whose centre is < b
    return last >= first && first * cell <= a && (last + 1) * cell >= b;
  };
  return axis(box[0], box[2], w) && axis(box[1], box[3], h);
}

function gridFacts(page: DopplerPageFacts): Pick<PageLayoutFacts, "grids" | "tableCoverage"> {
  const v = page.vectors;
  // Low confidence (`xref-repaired-earlier`): the rules may have been read from another object: unknown.
  if (!v || v.limitHit || v.gridsTruncated || dopplerPageFactsLowConfidence(page)) return { grids: null, tableCoverage: null };
  // No walker grid: fewer than the walker's minimum rules (2 horizontal, 3 vertical) on the page.
  if (v.hRules < GRID_MIN_H || v.vRules < GRID_MIN_V) return { grids: [], tableCoverage: v.grids === undefined ? null : 0 };
  // An older build: rule counts can prove there is no grid, never where one is.
  if (v.grids === undefined) return { grids: null, tableCoverage: null };
  // A complete list with no grid of two or more columns: Doppler's search found no table the walker could (one column is
  // parallel rules: form lines, lined paper). Finding none can only mean fewer table routes than the walker, never more.
  if (v.grids.every((g) => g.columns < GRID_MIN_COLUMNS)) return { grids: [], tableCoverage: 0 };
  // Doppler found a grid. Its search is not the walker's (shaded boxes count as rules, column lines need no outer sides),
  // and the facts carry no rule positions to tell which of the page's rules bound which grid, so its rows and box cannot
  // stand for the walker's grid: unknown, never a guessed table. Needs per-grid rule counts in the contract.
  return { grids: null, tableCoverage: null };
}

/** One page's layout facts, or null when the page is unknown (failed). `repeated`: furniture image objects of the document. */
export function pageLayoutFactsFromDopplerPage(page: DopplerPageFacts, repeated: Set<number> = new Set()): PageLayoutFacts | null {
  if (page.failed) return null;
  if (dopplerPageFactsLowConfidence(page)) {
    // Low confidence (`xref-repaired-earlier`): any fact of the page may come from the other body of an object the file
    // holds twice. Nothing on it steers routing: images, words, grids are unknown; the page size is kept (never billed).
    const low: PageLayoutFacts = { images: null, tables: null, words: null, grids: null, tableCoverage: null };
    const g = page.geometry;
    if (g && g.widthPt >= MIN_SIDE_PT && g.widthPt <= MAX_SIDE_PT && g.heightPt >= MIN_SIDE_PT && g.heightPt <= MAX_SIDE_PT) { low.widthPt = g.widthPt; low.heightPt = g.heightPt; }
    return low;
  }
  const out: PageLayoutFacts = {
    images: layoutImages(page, repeated),
    tables: null,
    words: page.text?.wordCount ?? null,
    ...gridFacts(page),
  };
  const g = page.geometry;
  const side = (n: number) => n >= MIN_SIDE_PT && n <= MAX_SIDE_PT;
  if (g && side(g.widthPt) && side(g.heightPt)) { out.widthPt = g.widthPt; out.heightPt = g.heightPt; }
  if (page.text) { out.invisibleWords = page.text.invisibleWordCount; out.textLayer = page.text.textLayer; }
  return out;
}

/** Every known page's layout facts, keyed by page number. Pages that are unknown in the facts are absent here too. */
export function pageLayoutFactsFromDopplerFacts(facts: Pick<DopplerPageFactsDocument, "pages">): Map<number, PageLayoutFacts> {
  const repeated = repeatedDopplerImageObjects(facts.pages.values(), facts.pages.size);
  const out = new Map<number, PageLayoutFacts>();
  for (const [number, page] of [...facts.pages].sort(([a], [b]) => a - b)) {
    const layout = pageLayoutFactsFromDopplerPage(page, repeated);
    if (layout) out.set(number, layout);
  }
  return out;
}

/** A page's routing facts as document_page_facts stores them (buildRoutingPageFacts): closed enums only. */
export interface PageRoutingFacts {
  textLayer?: DopplerTextLayer | null;
  scanClass?: DopplerScan | null;
}

/**
 * The routing facts (`text_layer`, `scan_class`) for document_page_facts: the layout facts' text layer where they have one,
 * else the page facts' `text.textLayer`; the scan class from the page facts' `images.scan` (layout facts have none). A
 * failed or unknown page contributes nothing. Undefined when neither source knows anything.
 */
export function routingFactsWithDopplerFacts(
  layout: ReadonlyMap<number, Pick<PageLayoutFacts, "textLayer">> | undefined,
  facts: Pick<DopplerPageFactsDocument, "pages"> | undefined,
): Map<number, PageRoutingFacts> | undefined {
  const out = new Map<number, PageRoutingFacts>();
  for (const [page, entry] of layout ?? []) if (entry.textLayer) out.set(page, { textLayer: entry.textLayer });
  for (const [page, entry] of facts?.pages ?? []) {
    if (entry.failed) continue;
    const known = out.get(page) ?? {};
    const textLayer = known.textLayer ?? entry.text?.textLayer;
    const scanClass = entry.images?.scan;
    if (textLayer || scanClass) out.set(page, { ...(textLayer ? { textLayer } : {}), ...(scanClass ? { scanClass } : {}) });
  }
  return out.size > 0 ? out : undefined;
}

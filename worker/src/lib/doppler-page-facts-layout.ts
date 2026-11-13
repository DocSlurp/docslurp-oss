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
 *   `mixedScanMaxWordsInside` stands only on a page whose centre-based `textOverImageRatio` is 0 (`wordsInside`).
 *   `coverage` is capped by the image's own box over the page. `bytesPerPixel` ← `bytesPerPixel`
 *   one to one, null when absent (never 0). Both are routing hints from what the file says: never a billing input.
 *   Null (unknown) when the list was not computed, is truncated, or holds fewer items than `imageCount`.
 * - `grids` ← `vectors.grids` as `PageTable`s (rows, columns, coverage of the box clipped to the page; the type has no box),
 *   keeping only grids of two or more columns: the walker's minimum grid (2 horizontals, 3 verticals). A one-column grid
 *   (parallel rules: form lines, lined paper) is weak evidence and not a table. Doppler's search also builds grids from
 *   shaded boxes and from inner column lines without outer sides, so on a page with fewer than 2 horizontal or 3 vertical
 *   rules (where the walker finds no grid) the grids are `[]` whatever the list says; elsewhere the page needs crossing
 *   rules (`ruleGridScore` > 0) and the kept grids together must fit its rule counts. Unknown (null) when the list is truncated,
 *   at the drawing cap, or on a page whose CropBox differs from its MediaBox (the boxes are in MediaBox space). Without the
 *   list (older builds): `[]` only when the rule counts prove there is no grid (fewer than 2 horizontal or 3 vertical rules,
 *   no cap hit), otherwise null, never a guessed grid.
 * - `tables` ← null: tables come from the extractor's Markdown. `tableCoverage` ← the union of the kept grid boxes over the
 *   page on the walker's 200 x 200 raster (overlaps once) when the grids are known from the list, else null. The walker's
 *   value also covers the Markdown tables' boxes, so this is never larger than the walker's.
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
/** The walker's union-coverage raster (pdf_layout_facts.py COVERAGE_RASTER). */
const COVERAGE_RASTER = 200;

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
 * `mixedScanMaxWordsInside` words inside. So a count above that stands (the walker's is at least as high), and a count at
 * or below it stands only when the page's `text.textOverImageRatio` is 0: no character's centre lies in any image's cells,
 * which reach past every image's edge, so no word's centre is inside any image and the walker's count is 0 as well.
 * Otherwise (or without the ratio, or the pair) the count is unknown. Conservative: a caption beside a figure can make a
 * count unknown and so skip a read the walker would make; never the reverse.
 */
function wordsInside(page: DopplerPageFacts, item: DopplerImageItem): number | null {
  if (item.visibleWordsInside === undefined || item.invisibleWordsInside === undefined) return null;
  const count = item.visibleWordsInside + item.invisibleWordsInside;
  if (count > PAGE_RASTER_ROUTING.mixedScanMaxWordsInside) return count;
  return page.text?.textOverImageRatio === 0 ? count : null;
}

/** The page's width and height when its grid boxes can be placed on it (CropBox = MediaBox, sides in range), else null. */
function gridPage(page: DopplerPageFacts): [number, number] | null {
  const g = page.geometry;
  if (!g || !(g.widthPt >= MIN_SIDE_PT && g.widthPt <= MAX_SIDE_PT && g.heightPt >= MIN_SIDE_PT && g.heightPt <= MAX_SIDE_PT)) return null;
  if (g.cropBox && g.mediaBox && g.cropBox.some((v, i) => Math.abs(v - g.mediaBox![i]!) > 0.5)) return null;
  return [g.widthPt, g.heightPt];
}

/**
 * Share of a `w` x `h` page covered by the union of `boxes`, on the walker's COVERAGE_RASTER grid (union_coverage: a box
 * marks every cell it touches; overlaps count once), rounded to 4 places. Bands between the boxes' row edges, then merged
 * column intervals per band: at most 2·n bands of n intervals, whatever the boxes.
 */
export function rasterUnionCoverage(boxes: readonly Box[], w: number, h: number): number {
  const n = COVERAGE_RASTER;
  // Cell spans [c0, c1) x [r0, r1), sorted by c0 (insertion sort: at most 64 boxes a page).
  const c0s = new Int32Array(boxes.length), c1s = new Int32Array(boxes.length), r0s = new Int32Array(boxes.length), r1s = new Int32Array(boxes.length);
  const edges = new Int32Array(boxes.length * 2);
  let count = 0, edgeCount = 0;
  for (const [x0, y0, x1, y1] of boxes) {
    const c0 = Math.max(0, Math.trunc(x0 / w * n)), r0 = Math.max(0, Math.trunc(y0 / h * n));
    const c1 = Math.min(n, Math.ceil(x1 / w * n)), r1 = Math.min(n, Math.ceil(y1 / h * n));
    if (!(c1 > c0 && r1 > r0)) continue;
    let i = count++;
    while (i > 0 && c0s[i - 1]! > c0) { c0s[i] = c0s[i - 1]!; c1s[i] = c1s[i - 1]!; r0s[i] = r0s[i - 1]!; r1s[i] = r1s[i - 1]!; i -= 1; }
    c0s[i] = c0; c1s[i] = c1; r0s[i] = r0; r1s[i] = r1;
    edges[edgeCount++] = r0; edges[edgeCount++] = r1;
  }
  const rows = edges.subarray(0, edgeCount).sort();
  let covered = 0;
  for (let e = 0; e + 1 < rows.length; e += 1) {
    const top = rows[e]!, bottom = rows[e + 1]!;
    if (bottom === top) continue;
    let width = 0, end = -1;
    for (let i = 0; i < count; i += 1) {
      if (r0s[i]! > top || r1s[i]! < bottom) continue;
      const c0 = c0s[i]!, c1 = c1s[i]!;
      if (c0 > end) { width += c1 - c0; end = c1; } else if (c1 > end) { width += c1 - end; end = c1; }
    }
    covered += width * (bottom - top);
  }
  return roundLikePython(covered, n * n);
}

/**
 * Python's `round(cells / total, 4)`, which the walker uses: the double's exact decimal value rounded half to even.
 * `toFixed` rounds the exact value too, but breaks a tie away from zero; a tie needs `cells / total` to be exact in binary
 * and to end in 5 at the fifth place, which is decided on the integers.
 */
function roundLikePython(cells: number, total: number): number {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const den = total / gcd(cells, total);
  const exact = (den & (den - 1)) === 0;
  const scaled = cells * 10_000;
  if (exact && scaled % total !== 0 && (2 * scaled) % total === 0) {
    const down = Math.floor(scaled / total);
    return (down % 2 === 0 ? down : down + 1) / 10_000;
  }
  return Number((cells / total).toFixed(4));
}

function gridFacts(page: DopplerPageFacts): Pick<PageLayoutFacts, "grids" | "tableCoverage"> {
  const v = page.vectors;
  // Low confidence (`xref-repaired-earlier`): the rules may have been read from another object: unknown.
  if (!v || v.limitHit || v.gridsTruncated || dopplerPageFactsLowConfidence(page)) return { grids: null, tableCoverage: null };
  // The walker's grid needs 2 horizontal and 3 vertical rules on the page. Doppler's search also builds grids from shaded
  // boxes and from inner column lines without outer sides (a two-column page's centre divider), which the walker never
  // reads as a table: on a page without the walker's minimum rules there is no walker grid, whatever the list says.
  const noWalkerGrid = v.hRules < GRID_MIN_H || v.vRules < GRID_MIN_V;
  if (v.grids === undefined) {
    // An older build: rule counts can prove there is no grid, never where one is.
    return { grids: noWalkerGrid ? [] : null, tableCoverage: null };
  }
  if (noWalkerGrid) return { grids: [], tableCoverage: 0 };
  const size = gridPage(page);
  if (!size) return { grids: null, tableCoverage: null };
  const [w, h] = size;
  const clip = (b: Box): Box => [Math.min(w, Math.max(0, b[0])), Math.min(h, Math.max(0, b[1])), Math.min(w, Math.max(0, b[2])), Math.min(h, Math.max(0, b[3]))];
  // The walker's grid is built from thin rules that cross. Doppler's search also counts shaded boxes (two bands each) and
  // column lines without outer sides, which the page's rule counts (thin rules only) do not hold. So the page must have
  // crossing rules (`ruleGridScore` > 0), and the kept grids together must fit its rules: each takes rows + 1 horizontal
  // and columns + 1 vertical rules (outer sides included) from the page's counts, in the search's order, and a grid the
  // rules left cannot pay for is dropped. Rule positions are not in the facts, so a crafted page can still place unrelated
  // rules to pay for a shaded grid; it could equally draw a real grid for the walker.
  let hLeft = v.ruleGridScore > 0 ? v.hRules : 0, vLeft = v.ruleGridScore > 0 ? v.vRules : 0;
  const kept: Array<(typeof v.grids)[number]> = [];
  for (const g of v.grids) {
    if (g.columns < GRID_MIN_COLUMNS || g.rows + 1 > hLeft || g.columns + 1 > vLeft) continue;
    hLeft -= g.rows + 1;
    vLeft -= g.columns + 1;
    kept.push({ ...g, bbox: clip(g.bbox) });
  }
  return {
    grids: kept.map((g) => ({ rows: g.rows, columns: g.columns, coverage: rasterUnionCoverage([g.bbox], w, h) })),
    tableCoverage: rasterUnionCoverage(kept.map((g) => g.bbox), w, h),
  };
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

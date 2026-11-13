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
 *   inside; Doppler a word whose whole box is, within 1 pt), null when the pair is absent. `bytesPerPixel` ← `bytesPerPixel`
 *   one to one, null when absent (never 0). Both are routing hints from what the file says: never a billing input. On a page
 *   marked `xref-repaired-earlier` (its facts may come from an object the file holds twice) the image's `px` (→ 0, as the
 *   layout reader reads an unknown size), `dpi` and `bytesPerPixel` are unknown, so they cannot select a mixed-scan read.
 *   Null (unknown) when the list was not computed, is truncated, or holds fewer items than `imageCount`.
 * - `grids` ← `vectors.grids` as `PageTable`s (rows, columns, coverage of the box clipped to the page; the type has no box),
 *   keeping only grids of two or more columns: the walker's minimum grid (2 horizontals, 3 verticals). A one-column grid
 *   (parallel rules: form lines, lined paper) is weak evidence and not a table. Unknown (null) when the list is truncated,
 *   at the drawing cap, or on a page whose CropBox differs from its MediaBox (the boxes are in MediaBox space). Without the
 *   list (older builds): `[]` only when the rule counts prove there is no grid (fewer than 2 horizontal or 3 vertical rules,
 *   no cap hit), otherwise null, never a guessed grid.
 * - `tables` ← null: tables come from the extractor's Markdown. `tableCoverage` ← the union of the kept grid boxes over the
 *   page on the walker's 200 x 200 raster (overlaps once) when the grids are known from the list, else null. The walker's
 *   value also covers the Markdown tables' boxes, so this is never larger than the walker's.
 * - A failed page (`error: failed`) is omitted: unknown.
 */
import type { PageLayoutImage } from "@docslurp/shared";

import { dopplerPageImageSizesUntrusted, type Box, type DopplerColorSpace, type DopplerImageFilter, type DopplerPageFacts, type DopplerPageFactsDocument, type DopplerScan, type DopplerTextLayer } from "./doppler-page-facts.js";
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
  const sizesUnknown = dopplerPageImageSizesUntrusted(page);
  return images.items.map((item) => ({
    bbox: [...item.bbox] as [number, number, number, number],
    coverage: item.coverage,
    widthPx: sizesUnknown ? 0 : item.px[0],
    heightPx: sizesUnknown ? 0 : item.px[1],
    bitsPerComponent: item.bpc ?? null,
    colorSpace: COLOR[item.colorSpace],
    encoding: ENCODING[item.filter],
    ppi: sizesUnknown ? [null, null] : [item.dpi[0] > 0 ? item.dpi[0] : null, item.dpi[1] > 0 ? item.dpi[1] : null],
    bytesPerPixel: sizesUnknown ? null : item.bytesPerPixel ?? null,
    repeated: item.obj !== undefined && repeated.has(item.obj),
    wordsInside: item.visibleWordsInside !== undefined && item.invisibleWordsInside !== undefined ? item.visibleWordsInside + item.invisibleWordsInside : null,
  }));
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
  const cells = boxes.map(([x0, y0, x1, y1]) => [
    Math.max(0, Math.trunc(x0 / w * n)), Math.max(0, Math.trunc(y0 / h * n)),
    Math.min(n, Math.ceil(x1 / w * n)), Math.min(n, Math.ceil(y1 / h * n)),
  ] as const).filter(([c0, r0, c1, r1]) => c1 > c0 && r1 > r0).sort((a, b) => a[0] - b[0]);
  const edges = [...new Set(cells.flatMap(([, r0, , r1]) => [r0, r1]))].sort((a, b) => a - b);
  let covered = 0;
  for (let i = 0; i + 1 < edges.length; i += 1) {
    const top = edges[i]!, bottom = edges[i + 1]!;
    let width = 0, end = -1;
    for (const [c0, r0, c1, r1] of cells) {
      if (r0 > top || r1 < bottom) continue;
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
  if (!v || v.limitHit || v.gridsTruncated) return { grids: null, tableCoverage: null };
  if (v.grids === undefined) {
    // An older build: rule counts can prove there is no grid, never where one is.
    return { grids: v.hRules < GRID_MIN_H || v.vRules < GRID_MIN_V ? [] : null, tableCoverage: null };
  }
  const size = gridPage(page);
  if (!size) return { grids: null, tableCoverage: null };
  const [w, h] = size;
  const clip = (b: Box): Box => [Math.min(w, Math.max(0, b[0])), Math.min(h, Math.max(0, b[1])), Math.min(w, Math.max(0, b[2])), Math.min(h, Math.max(0, b[3]))];
  const kept = v.grids.filter((g) => g.columns >= GRID_MIN_COLUMNS).map((g) => ({ ...g, bbox: clip(g.bbox) }));
  return {
    grids: kept.map((g) => ({ rows: g.rows, columns: g.columns, coverage: rasterUnionCoverage([g.bbox], w, h) })),
    tableCoverage: rasterUnionCoverage(kept.map((g) => g.bbox), w, h),
  };
}

/** One page's layout facts, or null when the page is unknown (failed). `repeated`: furniture image objects of the document. */
export function pageLayoutFactsFromDopplerPage(page: DopplerPageFacts, repeated: Set<number> = new Set()): PageLayoutFacts | null {
  if (page.failed) return null;
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

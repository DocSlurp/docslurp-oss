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
 *   `wordsInside` ← `visibleWordsCentredInside` + `invisibleWordsCentredInside` (Doppler #44: words whose box centre is
 *   inside, the walker's own test), else an older build's whole-box `visibleWordsInside` + `invisibleWordsInside`, only
 *   when above `mixedScanMaxWordsInside`; a lower count, or none, is null. Doppler's box is clipped (and a rotated image
 *   clipped to its own size looks unclipped), so a low count can be below the walker's: facts never select a mixed-scan read.
 *   `coverage` is capped by the image's own box over the page. `bytesPerPixel` ← `bytesPerPixel`
 *   one to one, null when absent (never 0). Both are routing hints from what the file says: never a billing input.
 *   Null (unknown) when the list was not computed, is truncated, or holds fewer items than `imageCount`.
 * - `grids` ← `[]` when there is no walker grid: fewer than 2 horizontal or 3 vertical rules on the page. Otherwise:
 *   - with thin-rule counts (Doppler #44: `unlistedRuledGrids` on the page or counts on a grid), the walker's grids are
 *     known only when `gridsTruncated` is false, `unlistedRuledGrids` is 0, every grid has `hRules` and the page has no
 *     `xref-repaired`/`xref-repaired-earlier` warning. They are the grids with `connected`, `hRules` >= 2 and `vRules` >= 3,
 *     each `hRules - 1` rows by `vRules - 1` columns with coverage null (Doppler's box is its grid search's group, which can
 *     be larger than the walker's box); every other grid is not a walker grid. A page that fails any condition, or has
 *     `xref-repaired`, has unknown (null) grids;
 *   - without them (an older build): `[]` from a complete `vectors.grids` list with no grid of two or more columns (one
 *     column is parallel rules: form lines, lined paper); any other grid Doppler found is unknown (null), since its search
 *     is not the walker's (shaded boxes count as rules, column lines need no outer sides).
 *   Null too when the list is truncated or absent (older builds), or at the drawing cap; never a guessed grid.
 * - `tables` ← null: tables come from the extractor's Markdown. `tableCoverage` ← 0 with `[]` known from the list, else
 *   null (with walker grids too: their boxes are not the walker's), so table-heavy from facts follows rows only.
 * - A failed page (`error: failed`) is omitted: unknown. A page marked `xref-repaired-earlier` (any of its facts may come
 *   from an object the file holds twice) keeps only its size: images, words, grids and table coverage are unknown.
 */
import { PAGE_RASTER_ROUTING, type PageLayoutImage } from "@docslurp/shared";

import { dopplerPageExtent, dopplerPageFactsLowConfidence, type Box, type DopplerColorSpace, type DopplerImageFilter, type DopplerImageItem, type DopplerPageFacts, type DopplerPageFactsDocument, type DopplerVectorGrid, type DopplerScan, type DopplerTextLayer } from "./doppler-page-facts.js";
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
    wordsInside: wordsInside(item),
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
 * An image's words inside as the walker would count them, or null. Only a low count authorizes anything:
 * `mixedScanImage` reads an image with at most `mixedScanMaxWordsInside` words inside. Facts can count fewer words than the
 * walker: Doppler's box is the part of the image inside its clip and the page, axis-aligned, where the walker counts word
 * centres inside the whole placement's box; a rotated or skewed image clipped to its own size looks unclipped in the facts,
 * and an older build counts only words wholly inside. So a count above the threshold stands (the walker's is at least as
 * high: it only blocks a read), and a count at or below it is unknown: facts never select a mixed-scan read. Doppler #44's
 * centred counts (`visibleWordsCentredInside` + `invisibleWordsCentredInside`, the walker's own test) are read first,
 * then an older build's whole-box pair.
 */
function wordsInside(item: DopplerImageItem): number | null {
  const centred = item.visibleWordsCentredInside !== undefined && item.invisibleWordsCentredInside !== undefined
    ? item.visibleWordsCentredInside + item.invisibleWordsCentredInside : undefined;
  const whole = item.visibleWordsInside !== undefined && item.invisibleWordsInside !== undefined
    ? item.visibleWordsInside + item.invisibleWordsInside : undefined;
  const count = centred ?? whole;
  return count !== undefined && count > PAGE_RASTER_ROUTING.mixedScanMaxWordsInside ? count : null;
}

/**
 * The page's walker grids under Doppler #44's contract, or null when the facts do not establish them: the list must be
 * complete (`gridsTruncated` false, `unlistedRuledGrids` 0), every grid must carry its thin-rule counts, and no
 * cross-reference rebuild may have happened before or after the page's vector facts were taken.
 */
function walkerGrids(page: DopplerPageFacts): DopplerVectorGrid[] | null {
  const v = page.vectors;
  if (!v?.grids || v.gridsTruncated !== false || v.unlistedRuledGrids !== 0) return null;
  if (page.parseWarnings.includes("xref-repaired") || page.parseWarnings.includes("xref-repaired-earlier")) return null;
  if (!v.grids.every((g) => g.hRules !== undefined && g.vRules !== undefined && g.connected !== undefined)) return null;
  return v.grids.filter((g) => g.connected === true && g.hRules! >= GRID_MIN_H && g.vRules! >= GRID_MIN_V);
}

function gridFacts(page: DopplerPageFacts): Pick<PageLayoutFacts, "grids" | "tableCoverage"> {
  const v = page.vectors;
  // Low confidence (`xref-repaired-earlier`): the rules may have been read from another object: unknown.
  if (!v || v.limitHit || v.gridsTruncated || dopplerPageFactsLowConfidence(page)) return { grids: null, tableCoverage: null };
  // A build with thin-rule counts (Doppler #44): the contract decides, and nothing else does (an older build's rule below
  // would call a page `[]` where an unlisted walker grid exists).
  const thinRuleBuild = v.unlistedRuledGrids !== undefined || (v.grids?.some((g) => g.hRules !== undefined) ?? false);
  // The contract makes every grid of a page with a rebuilt cross-reference table unknown, the rule proof's included.
  if (thinRuleBuild && page.parseWarnings.includes("xref-repaired")) return { grids: null, tableCoverage: null };
  // No walker grid: fewer than the walker's minimum rules (2 horizontal, 3 vertical) on the page.
  if (v.hRules < GRID_MIN_H || v.vRules < GRID_MIN_V) return { grids: [], tableCoverage: v.grids === undefined ? null : 0 };
  // An older build: rule counts can prove there is no grid, never where one is.
  if (v.grids === undefined) return { grids: null, tableCoverage: null };
  if (thinRuleBuild) {
    const grids = walkerGrids(page);
    if (!grids) return { grids: null, tableCoverage: null };
    if (grids.length === 0) return { grids: [], tableCoverage: 0 };
    // Rows and columns are the walker's; the box is not. Doppler's `bbox` spans its grid search's group (shaded boxes and
    // unconnected rules included), which can be far larger than the walker's box (its connected rules' extent), so neither
    // a grid's coverage nor the page's table coverage is known: table-heavy then follows rows only, never a larger area.
    return { grids: grids.map((grid) => ({ rows: grid.hRules! - 1, columns: grid.vRules! - 1, coverage: null })), tableCoverage: null };
  }
  // A complete list with no grid of two or more columns: Doppler's search found no table the walker could (one column is
  // parallel rules: form lines, lined paper). Finding none can only mean fewer table routes than the walker, never more.
  if (v.grids.every((g) => g.columns < GRID_MIN_COLUMNS)) return { grids: [], tableCoverage: 0 };
  // Doppler found a grid. Its search is not the walker's (shaded boxes count as rules, column lines need no outer sides),
  // and an older build carries no thin-rule counts to tell which grids the walker would find, so its rows and box cannot
  // stand for the walker's grid: unknown, never a guessed table.
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

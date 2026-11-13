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
 *   Facts cannot supply `bytesPerPixel` (the stream is never read) or `wordsInside` (no word boxes): both null, so
 *   `mixedScanImage` never selects a facts-only image. Null (unknown) when the list was not computed, is truncated, or
 *   holds fewer items than `imageCount`.
 * - `grids` ← `[]` only when the `vectors` family proves there is no ruled grid: fewer than 2 horizontal or 3 vertical rules
 *   (the walker's minimum grid) and no cap hit. Facts have rule counts, not rule positions, so a page that may hold a grid
 *   is unknown (null), never a guessed grid.
 * - `tables` ← null: tables come from the extractor's Markdown. `tableCoverage` ← null: it needs table and grid boxes.
 * - A failed page (`error: failed`) is omitted: unknown.
 */
import type { PageLayoutImage } from "@docslurp/shared";

import type { DopplerColorSpace, DopplerImageFilter, DopplerPageFacts, DopplerPageFactsDocument } from "./doppler-page-facts.js";
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

function repeatedObjects(pages: Iterable<DopplerPageFacts>, considered: number): Set<number> {
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
  return images.items.map((item) => ({
    bbox: [...item.bbox] as [number, number, number, number],
    coverage: item.coverage,
    widthPx: item.px[0],
    heightPx: item.px[1],
    bitsPerComponent: item.bpc ?? null,
    colorSpace: COLOR[item.colorSpace],
    encoding: ENCODING[item.filter],
    ppi: [item.dpi[0] > 0 ? item.dpi[0] : null, item.dpi[1] > 0 ? item.dpi[1] : null],
    bytesPerPixel: null,
    repeated: item.obj !== undefined && repeated.has(item.obj),
    wordsInside: null,
  }));
}

function grids(page: DopplerPageFacts): PageLayoutFacts["grids"] {
  const v = page.vectors;
  if (!v || v.limitHit) return null;
  return v.hRules < GRID_MIN_H || v.vRules < GRID_MIN_V ? [] : null;
}

/** One page's layout facts, or null when the page is unknown (failed). `repeated`: furniture image objects of the document. */
export function pageLayoutFactsFromDopplerPage(page: DopplerPageFacts, repeated: Set<number> = new Set()): PageLayoutFacts | null {
  if (page.failed) return null;
  const out: PageLayoutFacts = {
    images: layoutImages(page, repeated),
    tables: null,
    words: page.text?.wordCount ?? null,
    grids: grids(page),
    tableCoverage: null,
  };
  const g = page.geometry;
  const side = (n: number) => n >= MIN_SIDE_PT && n <= MAX_SIDE_PT;
  if (g && side(g.widthPt) && side(g.heightPt)) { out.widthPt = g.widthPt; out.heightPt = g.heightPt; }
  if (page.text) { out.invisibleWords = page.text.invisibleWordCount; out.textLayer = page.text.textLayer; }
  return out;
}

/** Every known page's layout facts, keyed by page number. Pages that are unknown in the facts are absent here too. */
export function pageLayoutFactsFromDopplerFacts(facts: Pick<DopplerPageFactsDocument, "pages">): Map<number, PageLayoutFacts> {
  const repeated = repeatedObjects(facts.pages.values(), facts.pages.size);
  const out = new Map<number, PageLayoutFacts>();
  for (const [number, page] of [...facts.pages].sort(([a], [b]) => a - b)) {
    const layout = pageLayoutFactsFromDopplerPage(page, repeated);
    if (layout) out.set(number, layout);
  }
  return out;
}

/**
 * Doppler page facts (`doppler-page-facts/1`, already validated by lib/doppler-page-facts.ts) as page evidence
 * (lib/page-evidence.ts), and the document-level operations on them: the stored layout form, settling the walker's unknown
 * grids, the encodings layer and the stored routing facts. Pure: no I/O, no clock.
 *
 * Field by field (evidence ← facts; a family that was not computed is unknown):
 * - `state`: `failed` for a page Doppler could not display; `low-confidence` for `xref-repaired-earlier` (any fact of the
 *   page may come from the other body of an object the file holds twice): only its size and its features are kept (no
 *   images, words, grids or encodings), and the `facts-low-confidence` mark keeps it off text-layer-only targets; `locked` for a locked document's single page.
 * - `size` ← `geometry.widthPt`/`heightPt` (the CropBox, rotation applied), within 1..14,400 pt; `rotation` ← `geometry`.
 * - `text` ← `text`: words (visible and invisible, as the walker's word boxes count them), characters, invisible words, the
 *   layer kind, coverage, math glyphs, invisible and over-image shares. `garbled` and `status` follow the probe's rules
 *   (page-evidence.ts textLayerGarbled, textLayerStatus): unmapped is the larger of `fonts.unmappedGlyphRatio` and
 *   `text.replacementCharRatio + privateUseRatio`; `ocr-layer` for text over a page image or an all-invisible layer over a
 *   full-page image; `suspect` for an `ok` layer drawn with `no-tounicode` fonts.
 * - `images` ← `images` (count, coverage, the full-page flag and the listed boxes); `placements` ← `images.items` in the
 *   walker's `pdfimages -list` vocabulary: `bbox`, `coverage` capped by the image's own box over the page, `px` →
 *   `widthPx`/`heightPx`, `bpc`, `dpi` → `ppi` (non-positive → null), `filter`/`colorSpace` renamed, `bytesPerPixel` one to
 *   one (null when absent, never 0), `repeated` from `obj` across the document (the walker's furniture rule), and
 *   `wordsInside` ← the centred counts (Doppler #44, the walker's own test), else an older build's whole-box counts, only
 *   above `mixedScanMaxWordsInside` (a lower count is unknown: facts never select a mixed-scan read). Null when the list was
 *   not computed, is truncated, or holds fewer items than `imageCount`. Routing hints only, never a billing input.
 * - `vectors` ← `vectors.paths`, `uncoveredRatio`, and the rule score min(`hRules`, `vRules`).
 * - `grids` (`gridEvidence`): `known []` with fewer than 2 horizontal or 3 vertical rules on the page. Otherwise, with
 *   thin-rule counts (Doppler #44: `unlistedRuledGrids` or counts on a grid), known only when `gridsTruncated` is false,
 *   `unlistedRuledGrids` is 0, every grid has its counts and the page has no `xref-repaired` warning: the grids with
 *   `connected`, `hRules` >= 2 and `vRules` >= 3, each `hRules - 1` rows by `vRules - 1` columns, coverage null (Doppler's box
 *   is its search's group, not the walker's box). Without them (an older build): `known []` from a complete list with no grid
 *   of two or more columns; any other grid Doppler found is unknown (its search is not the walker's). Unknown too when the
 *   list is truncated or absent, or at the drawing cap. `tableCoverage` ← 0 with `[]` known from the list, else null.
 * - `tables` ← null: tables come from the extractor's Markdown.
 * - `encodings` ← pageEncodingRoute (unknown on a failed, low-confidence, truncated or repaired page).
 * - `features` ← page and document features in the probe's vocabulary (`javascript-present` → `javascript`,
 *   `embedded-files` → `attachment`), `probe-error` on a failed page.
 */
import { PAGE_RASTER_ROUTING, type PageLayoutImage, type PageTable } from "@docslurp/shared";

import { pageEncodingRoute } from "./doppler-encoding-facts.js";
import {
  dopplerPageExtent, dopplerPageFactsLowConfidence, type Box, type DopplerColorSpace, type DopplerDocFacts, type DopplerImageFilter,
  type DopplerImageItem, type DopplerPageFacts, type DopplerPageFactsDocument, type DopplerScan, type DopplerTextLayer, type DopplerVectorGrid,
} from "./doppler-page-facts.js";
import type { PageLayoutFacts } from "./page-layout-facts.js";
import {
  FAILED_PAGE_FEATURE, LOW_CONFIDENCE_FEATURE, PAGE_EVIDENCE, furnitureFloor, isOcrLayer, pageLayoutFactsFromEvidence, pageSize, settleGrids,
  textLayerGarbled, textLayerStatus, unknownPageEvidence, type GridEvidence, type PageEvidence, type TextEvidence,
} from "./page-evidence.js";

/** The walker's `pdfimages -list` encodings (worker/scripts/pdf_layout_facts.py LISTING_ENCODINGS). */
const ENCODING: Record<DopplerImageFilter, string> = {
  dct: "jpeg", jpx: "jpx", jbig2: "jbig2", ccitt: "ccitt", rl: "rle", flate: "image", lzw: "image", none: "image", other: "other",
};
/** The walker's `pdfimages -list` colour spaces (LISTING_COLORS). */
const COLOR: Record<DopplerColorSpace, string> = {
  gray: "gray", rgb: "rgb", cmyk: "cmyk", lab: "lab", indexed: "index", icc1: "icc", icc3: "icc", icc4: "icc", sep: "sep",
  devn: "devn", none: "-", other: "other",
};
const FEATURE_NAMES: Record<string, string> = { "javascript-present": "javascript", "embedded-files": "attachment" };

/** Image objects drawn on enough of the `considered` pages to be page furniture (the walker's rule: page-evidence.ts furnitureFloor). */
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
  const floor = furnitureFloor(considered);
  return new Set([...seen].filter(([, set]) => set.size >= floor).map(([obj]) => obj));
}

function placements(page: DopplerPageFacts, repeated: Set<number>): PageLayoutImage[] | null {
  const images = page.images;
  if (!images?.items || images.truncated || images.itemsTruncated || images.items.length < images.imageCount) return null;
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
 * page, so a forged coverage on a small box cannot pass for a large scan. Null (unknown) without a page extent.
 */
function boxCappedCoverage(coverage: number, bbox: Box, extent: [number, number] | null): number | null {
  if (!extent || !(extent[0] > 0 && extent[1] > 0)) return null;
  const [w, h] = extent;
  const x = Math.max(0, Math.min(w, bbox[2]) - Math.max(0, bbox[0])), y = Math.max(0, Math.min(h, bbox[3]) - Math.max(0, bbox[1]));
  return Math.min(coverage, Math.round((x * y) / (w * h) * 10_000) / 10_000);
}

/**
 * An image's words inside as the walker would count them, or null. Only a low count authorizes anything (`mixedScanImage`
 * reads an image with at most `mixedScanMaxWordsInside` words inside), and facts can count fewer words than the walker:
 * Doppler's box is the part of the image inside its clip and the page, axis-aligned, where the walker counts word centres
 * inside the whole placement's box, and an older build counts only words wholly inside. So a count above the threshold
 * stands (it only blocks a read), and a count at or below it is unknown.
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
  if (page.parseWarnings.includes("xref-repaired") || dopplerPageFactsLowConfidence(page)) return null;
  if (!v.grids.every((g) => g.hRules !== undefined && g.vRules !== undefined && g.connected !== undefined)) return null;
  return v.grids.filter((g) => g.connected === true && g.hRules! >= PAGE_EVIDENCE.gridMinHRules && g.vRules! >= PAGE_EVIDENCE.gridMinVRules);
}

const UNKNOWN_GRIDS = { grids: { state: "unknown" } as GridEvidence, tableCoverage: null };

/** The page's grids and table coverage (see the module comment). */
function gridEvidence(page: DopplerPageFacts): { grids: GridEvidence; tableCoverage: number | null } {
  const v = page.vectors;
  if (!v || v.limitHit || v.gridsTruncated || dopplerPageFactsLowConfidence(page)) return UNKNOWN_GRIDS;
  const known = (grids: PageTable[], tableCoverage: number | null) => ({ grids: { state: "known", grids } as GridEvidence, tableCoverage });
  // A build with thin-rule counts (Doppler #44): the contract decides, and nothing else does.
  const thinRuleBuild = v.unlistedRuledGrids !== undefined || (v.grids?.some((g) => g.hRules !== undefined) ?? false);
  // The contract makes every grid of a page with a rebuilt cross-reference table unknown, the rule proof's included.
  if (thinRuleBuild && page.parseWarnings.includes("xref-repaired")) return UNKNOWN_GRIDS;
  // No walker grid: fewer than the walker's minimum rules on the page.
  if (v.hRules < PAGE_EVIDENCE.gridMinHRules || v.vRules < PAGE_EVIDENCE.gridMinVRules) return known([], v.grids === undefined ? null : 0);
  // An older build without a list: rule counts can prove there is no grid, never where one is.
  if (v.grids === undefined) return UNKNOWN_GRIDS;
  if (thinRuleBuild) {
    const grids = walkerGrids(page);
    if (!grids) return UNKNOWN_GRIDS;
    if (grids.length === 0) return known([], 0);
    // Rows and columns are the walker's; the box is not (Doppler's spans its search's group), so no coverage is known.
    return known(grids.map((grid) => ({ rows: grid.hRules! - 1, columns: grid.vRules! - 1, coverage: null })), null);
  }
  // A complete list with no grid of two or more columns: no table the walker could find (one column is parallel rules).
  if (v.grids.every((g) => g.columns < PAGE_EVIDENCE.gridMinColumns)) return known([], 0);
  // An older build's grid: its search is not the walker's, and it carries no counts to tell: unknown, never a guessed table.
  return UNKNOWN_GRIDS;
}

function features(page: DopplerPageFacts | null, doc: DopplerDocFacts | null, pageFeatures = true): string[] {
  const out = new Set<string>();
  for (const name of [...(doc?.unusualFeatures ?? []), ...(pageFeatures ? page?.unusualFeatures ?? [] : [])]) out.add(FEATURE_NAMES[name] ?? name);
  if (page?.failed) out.add(FAILED_PAGE_FEATURE);
  return [...out].sort();
}

const round = (value: number, digits: number) => { const f = 10 ** digits; return Math.round(value * f) / f; };

function textEvidence(page: DopplerPageFacts, unmapped: number, imageCoverage: number, unusual: string[]): TextEvidence {
  const t = page.text;
  if (!t) return { words: null, chars: null, invisibleWords: null, layer: null, coverage: null, mathGlyphRatio: null, invisibleTextRatio: null, textOverImageRatio: null, garbled: null, status: "unknown" };
  const chars = t.charCount;
  const words = t.wordCount;
  const garbled = textLayerGarbled(chars, unmapped, t.controlCharRatio ?? 0);
  let status: TextEvidence["status"] = textLayerStatus(chars, words, unmapped, garbled, imageCoverage);
  if ((status === "ok" || status === "suspect") &&
      ((t.textOverImageRatio !== undefined && isOcrLayer(t.textOverImageRatio, words)) || (t.textLayer === "invisible" && t.invisibleOverFullPageImage === true))) {
    status = "ocr-layer";
  }
  if (status === "ok" && unusual.includes("no-tounicode")) status = "suspect";
  return {
    words, chars, invisibleWords: t.invisibleWordCount, layer: t.textLayer, coverage: t.textCoverage, mathGlyphRatio: t.mathGlyphRatio ?? null,
    invisibleTextRatio: chars ? round(t.invisibleCharCount / chars, 4) : 0, textOverImageRatio: t.textOverImageRatio ?? null, garbled, status,
  };
}

/** Options shared by a document's pages: its doc line, furniture objects, and whether the run read math (`--math`). */
export interface DopplerEvidenceContext {
  doc?: DopplerDocFacts | null;
  repeated?: Set<number>;
  mathRead?: boolean;
}

/** One page's evidence (see the module comment). */
export function pageEvidenceFromDopplerPage(page: DopplerPageFacts, context: DopplerEvidenceContext = {}): PageEvidence {
  const doc = context.doc ?? null;
  const g = page.failed ? undefined : page.geometry;
  const size = g ? pageSize(g.widthPt, g.heightPt) : null;
  const rotation = g ? g.rotation : null;
  if (page.failed) return unknownPageEvidence(page.page, "doppler-facts", "failed", { features: features(page, doc), probeMs: page.factsMs ?? 0 });
  if (dopplerPageFactsLowConfidence(page)) {
    // No count, image or grid read from the page steers routing. Its features stay: they only ever add caution (an
    // appearance-only form still needs a render), and the low-confidence mark keeps it off text-layer-only targets.
    return unknownPageEvidence(page.page, "doppler-facts", "low-confidence", {
      size, rotation, features: [...new Set([...features(page, doc), LOW_CONFIDENCE_FEATURE])].sort(), probeMs: page.factsMs ?? 0,
    });
  }
  const t = page.text;
  const img = page.images;
  const vec = page.vectors;
  const fonts = page.fonts;
  const textUnmapped = Math.min(1, (t?.replacementCharRatio ?? 0) + (t?.privateUseRatio ?? 0));
  const unmapped = Math.max(fonts?.unmappedGlyphRatio ?? 0, textUnmapped);
  const imageCoverage = img?.imageCoverage ?? 0;
  const unusual = features(page, doc);
  const encodings = pageEncodingRoute(page, { mathRead: context.mathRead === true });
  return {
    page: page.page, source: "doppler-facts", state: "known", size, rotation,
    text: textEvidence(page, unmapped, imageCoverage, unusual),
    unmappedGlyphRatio: round(unmapped, 5),
    fonts: fonts ? { count: fonts.count, smallestPt: fonts.smallestPt ?? null } : null,
    images: img ? {
      count: img.imageCount, coverage: imageCoverage, largestCoverage: img.largestImageCoverage, fullPageImage: img.fullPageImage,
      boxes: (img.items ?? []).map((item) => ({ bbox: [...item.bbox] as [number, number, number, number], coverage: item.coverage })),
    } : null,
    placements: placements(page, context.repeated ?? new Set()),
    vectors: vec ? { paths: vec.paths, uncoveredRatio: vec.uncoveredRatio ?? null, ruleScore: Math.min(vec.hRules, vec.vRules) } : null,
    ...gridEvidence(page),
    tables: null,
    encodings: encodings.status === "known" ? encodings.route : null,
    features: unusual,
    probeMs: page.factsMs ?? 0,
  };
}

/** The single page of a locked document (the router reports it; nothing is extracted). */
export function lockedDopplerEvidence(doc: DopplerDocFacts): PageEvidence {
  return unknownPageEvidence(1, "doppler-facts", "locked", { features: [...new Set(["encrypted-user-password", ...features(null, doc)])].sort() });
}

/**
 * Every page's evidence, ascending, with the document's furniture computed once. A locked document gives its single locked
 * page; an unreadable one (`error`) gives none. `pageCount`: the host's own count (pages past it are left out).
 */
export function documentEvidenceFromDoppler(facts: Pick<DopplerPageFactsDocument, "doc" | "pages">, options: { mathRead?: boolean; pageCount?: number } = {}): PageEvidence[] {
  if (facts.doc.locked) return [lockedDopplerEvidence(facts.doc)];
  if (facts.doc.error) return [];
  const repeated = repeatedDopplerImageObjects(facts.pages.values(), facts.pages.size);
  return [...facts.pages.values()].filter((page) => options.pageCount === undefined || page.page <= options.pageCount)
    .sort((a, b) => a.page - b.page)
    .map((page) => pageEvidenceFromDopplerPage(page, { doc: facts.doc, repeated, mathRead: options.mathRead }));
}

// ── The stored layout form, and document-level operations on it ──

/** One page's layout facts, or null when the page is unknown (failed). `repeated`: furniture image objects of the document. */
export function pageLayoutFactsFromDopplerPage(page: DopplerPageFacts, repeated: Set<number> = new Set(), options: { mathRead?: boolean } = {}): PageLayoutFacts | null {
  return pageLayoutFactsFromEvidence(pageEvidenceFromDopplerPage(page, { repeated, mathRead: options.mathRead }));
}

/** Every known page's layout facts, keyed by page number. Pages that are unknown in the facts are absent here too. */
export function pageLayoutFactsFromDopplerFacts(facts: Pick<DopplerPageFactsDocument, "pages">, options: { mathRead?: boolean } = {}): Map<number, PageLayoutFacts> {
  const repeated = repeatedDopplerImageObjects(facts.pages.values(), facts.pages.size);
  const out = new Map<number, PageLayoutFacts>();
  for (const [number, page] of [...facts.pages].sort(([a], [b]) => a - b)) {
    const layout = pageLayoutFactsFromDopplerPage(page, repeated, options);
    if (layout) out.set(number, layout);
  }
  return out;
}

/**
 * The walker's layout with every page whose grids it left unknown (`grids: null`) settled from the same job's page facts
 * (page-evidence.ts settleGrids): the facts' grids where they know them (the walker's table coverage is kept), otherwise
 * marked `gridsUnknown`, which classify-route sends down the table path. Without page facts the walker's answer is used as
 * it is (a null there is the walker's own "no ruling line in this range"). Returns the counts for telemetry.
 */
export function settleUnknownGrids(layout: ReadonlyMap<number, PageLayoutFacts>, facts: Pick<DopplerPageFactsDocument, "pages">):
  { layout: Map<number, PageLayoutFacts>; fromFacts: number; unknown: number } {
  const out = new Map<number, PageLayoutFacts>();
  let fromFacts = 0;
  let unknown = 0;
  for (const [number, page] of layout) {
    if (page.grids !== null) { out.set(number, page); continue; }
    const entry = facts.pages.get(number);
    const settled = settleGrids({ state: "unknown" }, entry ? pageEvidenceFromDopplerPage(entry).grids : null);
    const { gridsUnknown: _ignored, ...rest } = page;
    if (settled.state === "known") {
      out.set(number, { ...rest, grids: settled.grids });
      fromFacts += 1;
    } else {
      out.set(number, { ...rest, gridsUnknown: true });
      unknown += 1;
    }
  }
  return { layout: out, fromFacts, unknown };
}

/**
 * Each layout page's encodings from the same job's page facts (pageEncodingRoute), replacing any it had: a page whose
 * encodings are unknown in the facts (or that has no facts line) has none. Only `encodings` comes from the facts.
 */
export function withEncodingRoutes(layout: ReadonlyMap<number, PageLayoutFacts>, facts: Pick<DopplerPageFactsDocument, "pages">, options: { mathRead?: boolean } = {}):
  { layout: Map<number, PageLayoutFacts>; known: number } {
  const out = new Map<number, PageLayoutFacts>();
  let known = 0;
  for (const [number, page] of layout) {
    const { encodings: _previous, ...rest } = page;
    const entry = facts.pages.get(number);
    const verdict = entry ? pageEncodingRoute(entry, options) : null;
    if (verdict?.status === "known") { out.set(number, { ...rest, encodings: verdict.route }); known += 1; }
    else out.set(number, rest);
  }
  return { layout: out, known };
}

/**
 * A page's routing facts as document_page_facts stores them (buildRoutingPageFacts): closed enums and Doppler's packed
 * encoding words (integers it validated; never text).
 */
export interface PageRoutingFacts {
  textLayer?: DopplerTextLayer | null;
  scanClass?: DopplerScan | null;
  mathBits?: number | null;
  tableBits?: number | null;
  encodingCounts?: number | null;
}

/**
 * The routing facts (`text_layer`, `scan_class`) for document_page_facts: the layout facts' text layer where they have one,
 * else the page facts' `text.textLayer`; the scan class from the page facts' `images.scan` (layout facts have none). A
 * failed or unknown page contributes nothing. Undefined when neither source knows anything. Stored as diagnostics: they
 * never steer routing, so a low-confidence page's are kept as Doppler wrote them.
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
    // The three words come together (the reader keeps all or none).
    const words = entry.mathBits !== undefined && entry.tableBits !== undefined && entry.encodingCounts !== undefined
      ? { mathBits: entry.mathBits, tableBits: entry.tableBits, encodingCounts: entry.encodingCounts } : {};
    if (textLayer || scanClass || "mathBits" in words) out.set(page, { ...(textLayer ? { textLayer } : {}), ...(scanClass ? { scanClass } : {}), ...words });
  }
  return out.size > 0 ? out : undefined;
}

/*
 * The one rule that decides whether a PDF page holds its content as pixels (or as an unreadable text layer) and goes
 * to a vision/OCR read, which bills Rich. Design: docs/page-routing-evidence.md.
 *
 * - The worker (worker/src/lib/page-image-evidence.ts, worker/src/stages/classify-route.ts) collects facts about each
 *   page and calls `decidePageRaster`; render selection, vision selection and billing follow its decision.
 * - The offline estimator's PDF probe (packages/estimate/src/probe/pdf.rs) mirrors these thresholds from the estimate
 *   card and classifies sampled pages with the same rule.
 *
 * Nothing here reads words, file names or ASCII classes: the facts are counts, areas and the text layer's own quality.
 */
export const PAGE_RASTER_ROUTING = {
  /** Pages with fewer native words than this are "sparse" and get raster evidence. */
  sparsePageWords: 30,
  /** Images covering less than this share of the page (logos, bullets, rules, tracking pixels) are ignored. */
  minSignificantImageCoverage: 0.02,
  /** Images with a shorter side than this (in pixels) carry no readable content. */
  minSignificantImagePixels: 32,
  /** A page without native text whose largest image covers at least this share holds its content as pixels. */
  rasterPageMinLargestImageCoverage: 0.25,
  /** ...or whose significant images together cover at least this share (banded or tiled scans). */
  rasterPageMinTotalImageCoverage: 0.35,
  /**
   * A page whose native text is only a stamp, page number or generated footer ("Page 1 of 2", a Bates number) over an
   * image covering at least `stampedScanMinImageCoverage` is a scan placed with margins.
   */
  stampTextMaxWords: 10,
  stampedScanMinImageCoverage: 0.5,
  /** A page with a little more native text (title, caption) needs an image this large to be a scan. */
  sparseTextFullPageImageCoverage: 0.85,
  /**
   * Bytes per page above which a PDF with no extractable text holds drawn content. Blank pages need well under 1 KB;
   * a page of text drawn as paths needs tens to hundreds of KB.
   */
  drawnContentMinBytesPerPage: 16 * 1024,
  /**
   * An image object drawn on at least this many pages, and on at least this share of the pages listed, is page
   * furniture (a logo, a letterhead, a slide background): a scan is a different image on every page.
   */
  repeatedImageMinPages: 3,
  repeatedImageMinShare: 0.2,
  /** Characters per word for scripts written without spaces (Han, Kana, Thai, Lao, Khmer, Myanmar). */
  unspacedCharsPerWord: 2,
  /**
   * A page with native text that also places a scan: a non-repeated, scan-like image covering at least this share of
   * the visible page, with no more than `mixedScanMaxWordsInside` native words inside its box (text beside the image does
   * not count), and a readable size (`mixedScanMinShortSidePx`, `mixedScanMinPpi`).
   */
  mixedScanMinCoverage: 0.2,
  mixedScanMaxWordsInside: 2,
  mixedScanMinShortSidePx: 200,
  mixedScanMinPpi: 50,
  /** Compressed stream bytes per pixel at or under which an image is document-like (ink on paper), not a photograph. */
  scanLikeMaxBytesPerPixel: 0.15,
} as const;

// ---- Words ----------------------------------------------------------------------------------------------------------

const UNSPACED_RUN = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}][\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{M}]*`;
const WORD_OR_UNSPACED = new RegExp(`(${UNSPACED_RUN})|([\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M}]*)`, "gu");

/**
 * Words on a page, by Unicode script: a run of two or more letters or digits is a word in spaced scripts (Latin, Greek,
 * Cyrillic, Arabic, Hebrew, Indic, Hangul); a run of unspaced-script letters counts `unspacedCharsPerWord` characters
 * to the word. Markdown syntax and stray glyphs do not count. Pass at most the first 256 KiB of a page.
 */
export function pageWordCount(text: string): number {
  const bounded = text.length > 262_144 ? text.slice(0, 262_144) : text;
  let words = 0;
  WORD_OR_UNSPACED.lastIndex = 0;
  for (let match = WORD_OR_UNSPACED.exec(bounded); match !== null; match = WORD_OR_UNSPACED.exec(bounded)) {
    const unspaced = match[1];
    if (unspaced !== undefined) {
      let letters = 0;
      for (const char of unspaced) if (!/\p{M}/u.test(char)) letters += 1;
      words += Math.max(1, Math.ceil(letters / PAGE_RASTER_ROUTING.unspacedCharsPerWord));
    } else if (Array.from(match[2]!).filter((char) => !/\p{M}/u.test(char)).length >= 2) {
      words += 1;
    }
  }
  return words;
}

// ---- Decision -------------------------------------------------------------------------------------------------------

export const BLANK_PAGE_SIGNAL = "ocr-not-authorized:blank-page";
export const DRAWN_CONTENT_SIGNAL = "ocr-authorized:drawn-content";
export const RASTER_PAGE_SIGNAL = "ocr-authorized:raster-page-without-text";
export const STAMPED_RASTER_SIGNAL = "ocr-authorized:stamped-raster-page";
export const SPARSE_FULL_PAGE_IMAGE_SIGNAL = "ocr-authorized:full-page-image-with-sparse-text";
export const GARBLED_TEXT_LAYER_SIGNAL = "ocr-authorized:garbled-text-layer";
export const TEXT_LAYER_DISAGREES_SIGNAL = "ocr-authorized:text-layer-disagrees-with-ocr";
export const TEXT_LAYER_UNVERIFIED_SIGNAL = "ocr-not-authorized:text-layer-unverified";
export const EVIDENCE_UNKNOWN_SIGNAL = "ocr-not-authorized:evidence-unknown";
export const MIXED_SCAN_IMAGE_SIGNAL = "ocr-authorized:scan-image-beside-native-text";

/**
 * One image drawn on a page, from the layout walker (worker/scripts/pdf_layout_facts.py, pdf-layout-facts@1): structural
 * facts only (placement, stream encoding and size, repetition, and how many native words sit inside its box).
 */
export interface PageLayoutImage {
  /** Box in displayed page points (origin top-left); null when the draw could not be placed. */
  bbox: [number, number, number, number] | null;
  /** Share of the visible page the image covers; null when unplaced. */
  coverage: number | null;
  widthPx: number;
  heightPx: number;
  bitsPerComponent: number | null;
  colorSpace: string;
  encoding: string;
  ppi: [number | null, number | null];
  bytesPerPixel: number | null;
  /** Drawn on enough pages to be page furniture (a logo, a letterhead). */
  repeated: boolean;
  /** Native words whose centres sit inside the image's box; null when the word boxes are unknown. */
  wordsInside: number | null;
}

/**
 * Scan-like: bilevel or fax encodings, or a raster that compresses like ink on paper rather than a photograph. Colour
 * space alone does not decide it: a grayscale photograph is still a photograph.
 */
export function scanLikeImage(image: PageLayoutImage, routing: typeof PAGE_RASTER_ROUTING = PAGE_RASTER_ROUTING): boolean {
  return image.encoding === "ccitt" || image.encoding === "jbig2" || image.bitsPerComponent === 1 ||
    (image.bytesPerPixel !== null && image.bytesPerPixel <= routing.scanLikeMaxBytesPerPixel);
}

/**
 * The largest image on a page with native text that holds content as pixels: placed, not furniture, scan-like, readable
 * and with (almost) no native text over it. Null when there is none, or the layout is unknown.
 */
export function mixedScanImage(images: readonly PageLayoutImage[] | null | undefined, routing: typeof PAGE_RASTER_ROUTING = PAGE_RASTER_ROUTING): PageLayoutImage | null {
  let best: PageLayoutImage | null = null;
  for (const image of images ?? []) {
    if (image.bbox === null || image.coverage === null || image.wordsInside === null || image.repeated) continue;
    const known = image.ppi.filter((value): value is number => value !== null);
    const ppi = known.length > 0 ? Math.min(...known) : null;
    if (image.coverage < routing.mixedScanMinCoverage || image.wordsInside > routing.mixedScanMaxWordsInside) continue;
    if (Math.min(image.widthPx, image.heightPx) < routing.mixedScanMinShortSidePx || ppi === null || ppi < routing.mixedScanMinPpi) continue;
    if (!scanLikeImage(image, routing)) continue;
    if (!best || image.coverage > best.coverage!) best = image;
  }
  return best;
}

export interface PageRasterFacts {
  /** Words in the PDF's own text layer (`pageWordCount`); null when the layer could not be read. Never read as 0. */
  nativeWords: number | null;
  /**
   * Significant images drawn on the page, repeated page furniture left out; null when the image listing is missing
   * or ended before this page. Only needed (and only collected) for sparse pages.
   */
  images: { count: number; coverage: number; largestCoverage: number } | null;
  /** Quality of the text layer (`assessTextLayer`) and, for a suspect layer, whether an OCR of the page agrees. */
  textLayer?: { verdict: "empty" | "ok" | "suspect" | "garbled"; matchesOcr?: boolean | null } | null;
  /** The document's bytes say its pages are drawn (vector text, outlines) while it has no text layer. */
  drawnContent?: boolean;
  /** The page's placed images (layout walker); absent or null when unknown. Read for pages with native text. */
  layoutImages?: readonly PageLayoutImage[] | null;
}

export type PageRasterKind =
  | "blank"
  | "native-text"
  | "raster"
  | "drawn-content"
  | "garbled-text-layer"
  | "suspect-text-layer"
  | "unknown";

export interface PageRasterDecision {
  /** A vision/OCR model should read the page (billed Rich when it does). */
  read: boolean;
  /** The region holding the content, when it is one image on a page with native text (displayed page points). */
  region?: [number, number, number, number];
  kind: PageRasterKind;
  confidence: number;
  signals: string[];
}

/** Raster rule over significant image coverage and native words (no text-layer quality). */
export function rasterPageSignal(
  words: number,
  images: { count: number; coverage: number; largestCoverage: number },
  routing: typeof PAGE_RASTER_ROUTING = PAGE_RASTER_ROUTING,
): { confidence: number; signal: string } | null {
  if (words === 0 && (images.largestCoverage >= routing.rasterPageMinLargestImageCoverage ||
      images.coverage >= routing.rasterPageMinTotalImageCoverage)) {
    return { confidence: 0.94, signal: RASTER_PAGE_SIGNAL };
  }
  if (words <= routing.stampTextMaxWords && images.largestCoverage >= routing.stampedScanMinImageCoverage) {
    return { confidence: 0.9, signal: STAMPED_RASTER_SIGNAL };
  }
  if (words < routing.sparsePageWords && images.largestCoverage >= routing.sparseTextFullPageImageCoverage) {
    return { confidence: 0.9, signal: SPARSE_FULL_PAGE_IMAGE_SIGNAL };
  }
  return null;
}

/**
 * Whether a page needs a model's read, from facts about the PDF page alone.
 *
 * - The text layer is unreadable (`garbled`), or suspect and an OCR of the page disagrees: read. A suspect layer no
 *   OCR has checked is not read: it is not evidence on its own, and unknown is not zero.
 * - Otherwise a page with `sparsePageWords` or more native words is a text page: Fast.
 * - A sparse page is a scan when significant, non-repeated images hold its content (`rasterPageSignal`).
 * - No words and no significant image, with no drawn-content hint: blank, never rendered or read.
 * - A little real text and no scan-sized image: a text page, Fast.
 */
export function decidePageRaster(facts: PageRasterFacts, routing: typeof PAGE_RASTER_ROUTING = PAGE_RASTER_ROUTING): PageRasterDecision {
  const layer = facts.textLayer;
  if (layer?.verdict === "garbled") {
    return { read: true, kind: "garbled-text-layer", confidence: 0.88, signals: [GARBLED_TEXT_LAYER_SIGNAL] };
  }
  if (layer?.verdict === "suspect") {
    if (layer.matchesOcr === false) {
      return { read: true, kind: "garbled-text-layer", confidence: 0.84, signals: [TEXT_LAYER_DISAGREES_SIGNAL] };
    }
    if (layer.matchesOcr !== true) {
      // Fall through to the raster rules; the unverified suspicion is reported, never charged.
      const rest = decidePageRaster({ ...facts, textLayer: null }, routing);
      return { ...rest, signals: [...rest.signals, TEXT_LAYER_UNVERIFIED_SIGNAL] };
    }
  }
  const words = facts.nativeWords;
  if (words === null) {
    return { read: false, kind: "unknown", confidence: 0.5, signals: [EVIDENCE_UNKNOWN_SIGNAL] };
  }
  if (words >= routing.sparsePageWords) {
    // Native text beside a scan: the text layer has the caption, the image has the content.
    const scan = mixedScanImage(facts.layoutImages, routing);
    if (scan) return { read: true, kind: "raster", confidence: 0.85, signals: [MIXED_SCAN_IMAGE_SIGNAL], region: scan.bbox! };
    return { read: false, kind: "native-text", confidence: 0.9, signals: ["ocr-not-authorized"] };
  }
  const images = facts.images;
  if (images === null) {
    return { read: false, kind: "unknown", confidence: 0.5, signals: [EVIDENCE_UNKNOWN_SIGNAL] };
  }
  const raster = rasterPageSignal(words, images, routing);
  if (raster) return { read: true, kind: "raster", confidence: raster.confidence, signals: [raster.signal] };
  if (words <= routing.stampTextMaxWords && facts.drawnContent === true) {
    return { read: true, kind: "drawn-content", confidence: 0.7, signals: [DRAWN_CONTENT_SIGNAL] };
  }
  if (words === 0 && images.count === 0) {
    return { read: false, kind: "blank", confidence: 0.9, signals: [BLANK_PAGE_SIGNAL] };
  }
  return {
    read: false,
    kind: "native-text",
    confidence: 0.8,
    signals: [`ocr-not-authorized:minor-images=${images.count}`],
  };
}

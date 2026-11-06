/*
 * The one table and rule that classify an embedded PDF image and decide what to do with it. Design:
 * docs/extraction/embedded-images.md.
 *
 * - The producer measures (placement, stored encoding, raster statistics when it can take them). It does not
 *   classify: thresholds live here so they can be reviewed, tested and tuned without changing a producer.
 * - The worker calls `planImageRouting` on validated facts; the media map records each class, route and reason, and
 *   Markdown reassembly includes an image only when its route is not `skip`.
 * - Nothing here reads words, file names or document identity. Inputs are numbers measured from the image, its
 *   placement and how often the same image recurs in the document.
 *
 * Routes decide; they do not call anything. `ocr`, `vision` and `label` name the reader a later stage will use.
 */
import { PAGE_RASTER_ROUTING } from "./page-raster-routing.js";
import type { EmbeddedImageFacts, ImageClassification, ImageClass, ImageRoute } from "./media-map.js";

export const IMAGE_ROUTING_TABLE_VERSION = "image-routing@1";

export const IMAGE_ROUTING = {
  // -- blank: nothing to read or show
  /** Luma spread of an image that is one flat colour (or flat plus sensor noise), with no edges. */
  blankMaxLumaStdDev: 2,
  blankMaxEdgeShare: 0.002,
  /** A scanned blank page: no ink, no edges, a little paper grain. */
  blankScanMaxInkShare: 0.0005,
  blankScanMaxLumaStdDev: 6,

  // -- decorative: page furniture, not content
  /** Same image on at least this many pages and this share of the document's pages: logo, letterhead, background. */
  repeatedMinPages: PAGE_RASTER_ROUTING.repeatedImageMinPages,
  repeatedMinShare: PAGE_RASTER_ROUTING.repeatedImageMinShare,
  /** Perceptual hashes this close (Hamming bits of 64) and a similar shape are the same picture re-encoded or rescaled. */
  nearDuplicateMaxHamming: 4,
  nearDuplicateMaxAspectRatioDelta: 0.1,
  /** Tiny: bullets, tracking pixels, icons. Both limits must hold. */
  tinyMaxSidePx: 48,
  tinyMaxCoverage: 0.004,
  /** Tiny on the page whatever its pixel size: a short side under this many points. */
  tinyMaxSidePt: 12,
  /** A small image wholly inside the top or bottom band of the page: header and footer marks. */
  furnitureBandShare: 0.1,
  furnitureBandMaxCoverage: 0.06,
  /** Rules and dividers drawn as images. */
  ruleMinAspectRatio: 20,

  // -- text-bearing scan: pixels that hold lines of text
  textScanMinCoverage: 0.5,
  textScanMinBands: 20,
  textScanMaxBandPitchSpread: 0.6,
  textScanMinInkShare: 0.005,
  textScanMaxInkShare: 0.45,
  textScanMaxSaturation: 40,
  textScanMaxColors: 64,
  /** A scan drawn under a page that already has this many text-showing operators has a text layer: do not read it again. */
  textLayerPresentMinTextOps: 10,
  /** Without raster statistics: a full-page bilevel stencil or CCITT/JBIG2 image is a scan. */
  bilevelScanMinCoverage: 0.5,

  // -- chart / diagram: flat colours on a plain ground, with edges, and not lines of text. Luma entropy separates it
  // from a photograph: the chart ceiling sits below the photograph floor, leaving a gap rather than one boundary.
  chartMaxColors: 256,
  chartMaxEntropy: 4,
  chartMinTopColorShare: 0.35,
  chartMinEdgeShare: 0.005,
  chartMaxEdgeShare: 0.35,
  chartMinSidePx: 64,
  chartMinCoverage: 0.02,
  /** Many flat bands of ink mean text, not a chart. */
  chartMaxBands: 40,

  // -- photograph: many colours, high entropy, no dominant ground
  photoMinColors: 128,
  photoMinEntropy: 4.5,
  photoMaxTopColorShare: 0.35,
  /** Lines of text are not a photograph: an interface screenshot has dozens of text-line bands where a photograph has a few. */
  photoMaxBands: 20,

  // -- caps on routed (ocr / vision / label) images
  maxRoutedPerDocument: 64,
  maxRoutedPerPage: 8,
} as const;

export interface ImageRoutingContext {
  /** Pages in the whole document (not the shard). */
  pageCount: number;
}

export interface PlannedImage {
  classification: ImageClassification;
  route: ImageRoute;
  /** Whether a reference to this image belongs in the document Markdown. */
  markdownIncluded: boolean;
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const hamming = (a: string, b: string): number => {
  let bits = 0;
  for (let i = 0; i < 16; i++) {
    let x = Number.parseInt(a[i]!, 16) ^ Number.parseInt(b[i]!, 16);
    while (x) { bits += x & 1; x >>= 1; }
  }
  return bits;
};

/** Distinct pages on which each image, by identity, content hash and perceptual hash, is drawn. */
interface Repeats {
  objectPages: number;
  contentPages: number;
  similarPages: number;
  firstOf: string | null;
}

function repeatCounts(images: readonly EmbeddedImageFacts[]): Repeats[] {
  const bases = images.map((image, index) => ({ image, index })).filter(({ image }) => image.role === "image" || image.role === "stencil");
  const byObject = new Map<string, Set<number>>();
  const byContent = new Map<string, Set<number>>();
  const key = (image: EmbeddedImageFacts) => (image.source.objectId ? `${image.source.objectId.num}:${image.source.objectId.gen}` : null);
  for (const { image } of bases) {
    const object = key(image);
    if (object) (byObject.get(object) ?? byObject.set(object, new Set()).get(object)!).add(image.pageNumber);
    (byContent.get(image.sha256) ?? byContent.set(image.sha256, new Set()).get(image.sha256)!).add(image.pageNumber);
  }
  const first = new Map<string, string>();
  const result: Repeats[] = images.map(() => ({ objectPages: 0, contentPages: 0, similarPages: 0, firstOf: null }));
  for (const { image, index } of bases) {
    const object = key(image);
    const slot = result[index]!;
    slot.objectPages = object ? byObject.get(object)!.size : 1;
    slot.contentPages = byContent.get(image.sha256)!.size;
    const identity = object ? `o${object}` : `c${image.sha256}`;
    const seen = first.get(identity) ?? first.get(`c${image.sha256}`);
    if (seen === undefined) {
      first.set(identity, `${image.pageNumber}.${image.occurrence}`);
      first.set(`c${image.sha256}`, `${image.pageNumber}.${image.occurrence}`);
    } else slot.firstOf = seen;
    // Near duplicates: a logo re-encoded or scaled per page. Same shape, close perceptual hash, on other pages.
    const signals = image.signals;
    if (signals) {
      const pages = new Set<number>([image.pageNumber]);
      for (const other of bases) {
        if (other.index === index || !other.image.signals) continue;
        const ratioA = image.width / image.height;
        const ratioB = other.image.width / other.image.height;
        if (Math.abs(ratioA - ratioB) / Math.max(ratioA, ratioB) > IMAGE_ROUTING.nearDuplicateMaxAspectRatioDelta) continue;
        if (hamming(signals.dhash, other.image.signals.dhash) <= IMAGE_ROUTING.nearDuplicateMaxHamming) pages.add(other.image.pageNumber);
      }
      // A flat image has an all-zero hash and would match every other flat image: only textured pictures count.
      slot.similarPages = signals.dhash === "0000000000000000" || signals.edgeShare < 0.002 ? 1 : pages.size;
    } else slot.similarPages = 1;
  }
  return result;
}

const furniture = (pages: number, pageCount: number) =>
  pages >= IMAGE_ROUTING.repeatedMinPages && pages / Math.max(1, pageCount) >= IMAGE_ROUTING.repeatedMinShare;

function decorativeReason(image: EmbeddedImageFacts, repeats: Repeats, pageCount: number): string | null {
  if (furniture(repeats.objectPages, pageCount)) return `repeated-object-${repeats.objectPages}-pages`;
  if (furniture(repeats.contentPages, pageCount)) return `repeated-content-${repeats.contentPages}-pages`;
  if (furniture(repeats.similarPages, pageCount)) return `repeated-similar-${repeats.similarPages}-pages`;
  const placement = image.placement;
  const aspect = Math.max(image.width, image.height) / Math.max(1, Math.min(image.width, image.height));
  if (aspect >= IMAGE_ROUTING.ruleMinAspectRatio) return "rule";
  if (placement.status === "known") {
    const [x0, y0, x1, y1] = placement.bbox;
    if (Math.min(x1 - x0, y1 - y0) < IMAGE_ROUTING.tinyMaxSidePt) return "tiny-on-page";
    if (Math.min(image.width, image.height) <= IMAGE_ROUTING.tinyMaxSidePx && placement.coverage <= IMAGE_ROUTING.tinyMaxCoverage) return "tiny";
    const band = IMAGE_ROUTING.furnitureBandShare * placement.pageHeightPt;
    const inBand = y1 <= band || y0 >= placement.pageHeightPt - band;
    if (inBand && placement.coverage <= IMAGE_ROUTING.furnitureBandMaxCoverage) return "header-footer-band";
  } else if (Math.max(image.width, image.height) <= IMAGE_ROUTING.tinyMaxSidePx) return "tiny";
  return null;
}

function classify(image: EmbeddedImageFacts, repeats: Repeats, pageCount: number): ImageClassification {
  const make = (label: ImageClass, confidence: number, signals: string[]): ImageClassification => ({ label, confidence: round(confidence), signals: signals.slice(0, 16) });
  if (image.role === "mask" || image.role === "smask") return make("mask", 1, ["mask-role"]);
  const s = image.signals;
  const T = IMAGE_ROUTING;
  if (s) {
    if (s.quantizedColors <= 1 || (s.lumaStdDev <= T.blankMaxLumaStdDev && s.edgeShare <= T.blankMaxEdgeShare)) return make("blank", 0.98, ["flat-colour"]);
    if (s.inkShare <= T.blankScanMaxInkShare && s.edgeShare <= T.blankMaxEdgeShare && s.lumaStdDev <= T.blankScanMaxLumaStdDev) return make("blank", 0.9, ["no-ink", "no-edges"]);
  }
  const decorative = decorativeReason(image, repeats, pageCount);
  const placement = image.placement;
  const coverage = placement.status === "known" ? placement.coverage : null;
  const longSide = Math.max(image.width, image.height);
  const bilevelStored = image.role === "stencil" || image.source.encoding === "ccitt" || image.source.encoding === "jbig2";
  const textShaped = s !== null && s.textBands >= T.textScanMinBands && (s.bandPitchSpread === null || s.bandPitchSpread <= T.textScanMaxBandPitchSpread)
    && s.inkShare >= T.textScanMinInkShare && s.inkShare <= T.textScanMaxInkShare;
  const pageSized = coverage !== null ? coverage >= T.textScanMinCoverage : longSide >= 1000;
  if (decorative) return make("decorative", decorative.startsWith("repeated") ? 0.95 : 0.8, [decorative]);
  if (s === null) {
    // No raster statistics: only stored-format evidence is left. Never call the image a photo or chart without pixels.
    if (bilevelStored && coverage !== null && coverage >= T.bilevelScanMinCoverage) return make("text-scan", 0.6, ["bilevel-stored", "page-sized"]);
    return make("figure", 0.3, ["no-signals"]);
  }
  const lowColor = s.bilevel || s.quantizedColors <= T.textScanMaxColors || s.saturation < T.textScanMaxSaturation;
  if (textShaped && pageSized && lowColor) {
    const evidence = ["text-bands", "page-sized", ...(s.bilevel ? ["bilevel"] : []), ...(bilevelStored ? ["bilevel-stored"] : [])];
    return make("text-scan", 0.75 + 0.05 * (evidence.length - 2), evidence);
  }
  const roomy = Math.min(image.width, image.height) >= T.chartMinSidePx && (coverage === null || coverage >= T.chartMinCoverage);
  if (roomy && s.quantizedColors <= T.chartMaxColors && s.entropy <= T.chartMaxEntropy && s.topColorShare >= T.chartMinTopColorShare
    && s.edgeShare >= T.chartMinEdgeShare && s.edgeShare <= T.chartMaxEdgeShare && s.textBands <= T.chartMaxBands && !textShaped) {
    return make("chart-diagram", 0.7, ["few-colours", "plain-ground", "edges"]);
  }
  if (roomy && s.quantizedColors >= T.photoMinColors && s.entropy >= T.photoMinEntropy && s.topColorShare <= T.photoMaxTopColorShare && s.textBands <= T.photoMaxBands) {
    return make("photo", 0.7, ["many-colours", "high-entropy", ...(image.source.encoding === "jpeg" || image.source.encoding === "jpx" ? ["lossy-stored"] : [])]);
  }
  return make("figure", 0.4, ["unclassified"]);
}

function route(image: EmbeddedImageFacts, classification: ImageClassification, repeats: Repeats): ImageRoute {
  const T = IMAGE_ROUTING;
  switch (classification.label) {
    case "mask": return { action: "keep", reason: "mask-of-image" };
    case "blank": return { action: "skip", reason: "blank-or-solid" };
    case "decorative": return { action: "skip", reason: `decorative:${classification.signals[0] ?? "furniture"}` };
    default: break;
  }
  if (repeats.firstOf) return { action: "skip", reason: `duplicate-of:${repeats.firstOf}` };
  switch (classification.label) {
    case "text-scan": {
      const p = image.placement;
      if (p.status === "known" && p.pageTextOps >= T.textLayerPresentMinTextOps) return { action: "keep", reason: "text-layer-present" };
      return { action: "ocr", reason: "text-bearing-scan" };
    }
    case "chart-diagram": return { action: "vision", reason: "chart-or-diagram" };
    case "photo": return { action: "label", reason: "photo" };
    default: return { action: "keep", reason: image.signals === null ? "signals-unavailable" : "unclassified-figure" };
  }
}

/**
 * Classify and route every image of a document. `images` are all occurrences (masks included, immediately after their
 * base); the result is parallel to it. Caps keep the routed set bounded: the largest images win, and an image over a cap
 * is kept (never skipped) with the cap named.
 */
export function planImageRouting(images: readonly EmbeddedImageFacts[], context: ImageRoutingContext): PlannedImage[] {
  const repeats = repeatCounts(images);
  const planned: PlannedImage[] = images.map((image, index) => {
    const classification = classify(image, repeats[index]!, context.pageCount);
    const decided = route(image, classification, repeats[index]!);
    return { classification, route: decided, markdownIncluded: false };
  });
  const routed = planned
    .map((p, index) => ({ p, index, image: images[index]! }))
    .filter(({ p }) => p.route.action === "ocr" || p.route.action === "vision" || p.route.action === "label")
    .sort((a, b) => {
      const ca = a.image.placement.status === "known" ? a.image.placement.coverage : 0;
      const cb = b.image.placement.status === "known" ? b.image.placement.coverage : 0;
      return cb - ca || a.index - b.index;
    });
  const perPage = new Map<number, number>();
  let total = 0;
  for (const { p, image } of routed) {
    const used = perPage.get(image.pageNumber) ?? 0;
    if (total >= IMAGE_ROUTING.maxRoutedPerDocument) p.route = { action: "keep", reason: "routing-cap:document" };
    else if (used >= IMAGE_ROUTING.maxRoutedPerPage) p.route = { action: "keep", reason: "routing-cap:page" };
    else { total += 1; perPage.set(image.pageNumber, used + 1); }
  }
  for (const p of planned) {
    p.markdownIncluded = p.route.action !== "skip" && p.classification.label !== "mask" && p.route.reason !== "text-layer-present";
  }
  return planned;
}

/** Count of routes by action, for stage stats and the media map. */
export function routeCounts(planned: readonly PlannedImage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of planned) counts[p.route.action] = (counts[p.route.action] ?? 0) + 1;
  return counts;
}

/**
 * Chart and diagram candidates from Doppler page facts (`doppler-page-facts/1`, validated by lib/doppler-page-facts.ts):
 * page structure instead of keywords. Pure apart from `loadChartFacts` (one artifact read). Rules, all general (no
 * document, fixture or eval knowledge; see docs/extraction/doppler-page-facts.md "Chart and diagram candidates"):
 *
 * - **Vector figure.** A figure cluster (curved or diagonal drawing, as Doppler groups it) at least
 *   `minClusterSidePt` on its short side, `minClusterPaths` paths, and between `minClusterAreaShare` and
 *   `maxClusterAreaShare` of the page. It stands alone when the page's vector ink is mostly away from words
 *   (`uncoveredRatio` at or above `strongUncoveredRatio`) or the page has a large non-text vector area (`coverage` x
 *   `uncoveredRatio` at or above `strongNonTextVectorShare`). With a lower but real uncovered ratio
 *   (`weakUncoveredRatio`) it needs a second vote: the legacy keyword route on the same page.
 * - **Image region.** A placed image that is not the page's scan (the page's `scan` is `none`, the image is not the
 *   `scanImage`, and it covers less than `maxImageAreaShare`), at least `minImageAreaShare` of the page and
 *   `minImagePx` samples on each side, not a stencil mask. Photos are common, so an image region always needs the
 *   keyword vote on its page.
 * - **Furniture is never a candidate.** An image whose `obj` recurs on several pages, or a cluster whose box recurs
 *   (`furnitureMinPages` pages and `furnitureMinShare` of the pages with facts), is a logo, header or border.
 * - Every candidate carries the cluster or image box as its placement, so only crops are read, never the whole page.
 *   At most `maxPerPage` per page, largest first.
 *
 * Facts that are absent, refused or do not cover a page leave that page to today's signals unchanged.
 */
import type { BBox } from "@docslurp/shared";

import { DOPPLER_PAGE_FACTS_MAX_PAGES, dopplerPageFactsByteBudget, dopplerPageFactsMode, dopplerPageImageSizesUntrusted, parseDopplerPageFacts, type Box, type DopplerPageFacts, type DopplerPageFactsDocument } from "../lib/doppler-page-facts.js";
import { DOPPLER_PAGE_FACTS_SLOT } from "../extractors/doppler-figures.js";
import type { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";
import { keyFromStorageUri, type ArtifactStore } from "../tools/storage.js";
import type { VisualCandidate } from "./types.js";


export const FACTS_CANDIDATE_RULES = {
  /** Shorter side of a figure cluster, in points: smaller is an icon, bullet, glyph or rule. */
  minClusterSidePt: 48,
  /** Painted paths in a figure cluster: fewer is a swoosh, arrow or ornament. */
  minClusterPaths: 6,
  /** Share of the page a cluster must cover: smaller is an icon. */
  minClusterAreaShare: 0.02,
  /** Share of the page above which a cluster is a page frame or background, not a figure. */
  maxClusterAreaShare: 0.9,
  /** Page vector cells with no word on them, over vector cells: drawing, not text decoration (stands alone). */
  strongUncoveredRatio: 0.6,
  /** Page share of vector ink with no words on it (`coverage` x `uncoveredRatio`): a large drawing (stands alone). */
  strongNonTextVectorShare: 0.15,
  /** Below this uncovered ratio a cluster is text decoration (underlines, boxes around text): never a candidate. */
  weakUncoveredRatio: 0.3,
  /** Share of the page an image must cover to be a figure region. */
  minImageAreaShare: 0.04,
  /** Share at or above which an image is the page (Doppler's scan threshold). */
  maxImageAreaShare: 0.85,
  /** Samples on each side of an image region. */
  minImagePx: 96,
  /** An image object or cluster box on at least this many pages... */
  furnitureMinPages: 3,
  /** ...and this share of the pages with facts is furniture (the walker's repeated-image rule). */
  furnitureMinShare: 0.2,
  /** Candidates per page, largest first. */
  maxPerPage: 4,
  /** Candidates per document (bounds the work; reads are capped separately by the per-document read cap). */
  maxPerDocument: 500,
} as const;

/** Whether page facts may nominate chart candidates (`use`); `store` only dedupes repeated images; `off` neither. */
export function chartFactsUse(env: NodeJS.ProcessEnv = process.env): { candidates: boolean; dedupe: boolean } {
  const mode = dopplerPageFactsMode(env);
  return { candidates: mode === "use", dedupe: mode !== "off" };
}

/** Page sides the layout reader accepts (parsePageLayoutFacts): anything else is not a page a raster maps to. */
const MIN_SIDE_PT = 1;
const MAX_SIDE_PT = 14_400;

/**
 * Whether the page's facts boxes are in the space the page raster is cropped in. Facts boxes are MediaBox points, rotated,
 * top-left origin; the raster shows the CropBox. A CropBox that differs from the MediaBox shifts every box: unknown.
 */
function placeable(page: DopplerPageFacts): boolean {
  const g = page.geometry;
  if (!g || !(g.widthPt >= MIN_SIDE_PT && g.widthPt <= MAX_SIDE_PT && g.heightPt >= MIN_SIDE_PT && g.heightPt <= MAX_SIDE_PT)) return false;
  if (g.cropBox && g.mediaBox && g.cropBox.some((v, i) => Math.abs(v - g.mediaBox![i]!) > 0.5)) return false;
  return true;
}

function toBBox(box: Box, page: DopplerPageFacts): BBox | null {
  if (!placeable(page)) return null;
  const w = page.geometry!.widthPt;
  const h = page.geometry!.heightPt;
  const x0 = Math.max(0, Math.min(w, Math.min(box[0], box[2])));
  const x1 = Math.max(0, Math.min(w, Math.max(box[0], box[2])));
  const y0 = Math.max(0, Math.min(h, Math.min(box[1], box[3])));
  const y1 = Math.max(0, Math.min(h, Math.max(box[1], box[3])));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

const areaShare = (b: BBox, page: DopplerPageFacts) => (b.width * b.height) / (page.geometry!.widthPt * page.geometry!.heightPt);

function boxKey(b: BBox): string {
  // 6 pt buckets: the same furniture drawn by the same template lands in the same bucket.
  const q = (v: number) => Math.round(v / 6);
  return `${q(b.x)},${q(b.y)},${q(b.width)},${q(b.height)}`;
}

/** Image objects and cluster boxes that recur across pages (logos, headers, borders). */
export function furnitureOf(facts: Pick<DopplerPageFactsDocument, "pages">): { objects: Set<number>; boxes: Set<string> } {
  const objects = new Map<number, Set<number>>();
  const boxes = new Map<string, Set<number>>();
  let considered = 0;
  for (const page of facts.pages.values()) {
    if (page.failed) continue;
    considered += 1;
    for (const item of page.images?.items ?? []) {
      if (item.obj === undefined) continue;
      objects.set(item.obj, (objects.get(item.obj) ?? new Set()).add(page.page));
    }
    for (const cluster of page.vectors?.clusters ?? []) {
      const b = toBBox(cluster.bbox, page);
      if (b) boxes.set(boxKey(b), (boxes.get(boxKey(b)) ?? new Set()).add(page.page));
    }
  }
  const floor = Math.max(FACTS_CANDIDATE_RULES.furnitureMinPages, Math.ceil(FACTS_CANDIDATE_RULES.furnitureMinShare * Math.max(1, considered)));
  return {
    objects: new Set([...objects].filter(([, pages]) => pages.size >= floor).map(([obj]) => obj)),
    boxes: new Set([...boxes].filter(([, pages]) => pages.size >= floor).map(([key]) => key)),
  };
}

export interface FactsCandidateResult {
  candidates: VisualCandidate[];
  /** Per rule, for stage stats. */
  counts: { vectorStrong: number; vectorVoted: number; imageVoted: number; furniture: number; scanPages: number };
}

/**
 * Candidates from the facts. `keywordPages`: pages the legacy classifier routed `chart-or-figure` (the second vote for
 * weak vector clusters and image regions).
 */
export function candidatesFromPageFacts(facts: Pick<DopplerPageFactsDocument, "pages">, keywordPages: ReadonlySet<number>): FactsCandidateResult {
  const R = FACTS_CANDIDATE_RULES;
  const furniture = furnitureOf(facts);
  const counts = { vectorStrong: 0, vectorVoted: 0, imageVoted: 0, furniture: 0, scanPages: 0 };
  const out: VisualCandidate[] = [];
  const pages = [...facts.pages.values()].sort((a, b) => a.page - b.page);
  for (const page of pages) {
    if (page.failed || !page.geometry) continue;
    const voted = keywordPages.has(page.page);
    const found: Array<{ c: VisualCandidate; area: number }> = [];
    const vectors = page.vectors;
    const uncovered = vectors?.uncoveredRatio;
    if (vectors?.clusters && uncovered !== undefined && uncovered >= R.weakUncoveredRatio) {
      const strong = uncovered >= R.strongUncoveredRatio || vectors.coverage * uncovered >= R.strongNonTextVectorShare;
      vectors.clusters.forEach((cluster, i) => {
        const bbox = toBBox(cluster.bbox, page);
        if (!bbox) return;
        const share = areaShare(bbox, page);
        if (Math.min(bbox.width, bbox.height) < R.minClusterSidePt || cluster.paths < R.minClusterPaths) return;
        if (share < R.minClusterAreaShare || share > R.maxClusterAreaShare) return;
        if (furniture.boxes.has(boxKey(bbox))) { counts.furniture += 1; return; }
        if (!strong && !voted) return;
        if (strong) counts.vectorStrong += 1; else counts.vectorVoted += 1;
        found.push({ area: share, c: { id: `p${page.page}-v${i}`, pageNumber: page.page, imageIndex: null, bbox, kind: null, detectedBy: "page-facts-vector" } });
      });
    }
    const images = page.images;
    if (images && images.scan !== "none") counts.scanPages += 1;
    if (images?.items && images.scan === "none" && voted) {
      for (const item of images.items) {
        if (item.imageMask || item.index === images.scanImage) continue;
        const bbox = toBBox(item.bbox, page);
        if (!bbox) continue;
        const share = areaShare(bbox, page);
        if (share < R.minImageAreaShare || share >= R.maxImageAreaShare || item.coverage >= R.maxImageAreaShare) continue;
        // An image's size on a page an earlier xref rebuild may have changed (`xref-repaired-earlier`) is unknown: no read.
        if (dopplerPageImageSizesUntrusted(page) || item.px[0] < R.minImagePx || item.px[1] < R.minImagePx) continue;
        if (item.obj !== undefined && furniture.objects.has(item.obj)) { counts.furniture += 1; continue; }
        counts.imageVoted += 1;
        found.push({
          area: share,
          c: {
            id: `p${page.page}-f${item.index}`, pageNumber: page.page, imageIndex: null, bbox, kind: null, detectedBy: "page-facts-image",
            ...(item.obj !== undefined ? { asset: { obj: item.obj, ...(overlaid(page, bbox) ? {} : { clean: true }) } } : {}),
          },
        });
      }
    }
    found.sort((a, b) => b.area - a.area);
    out.push(...found.slice(0, R.maxPerPage).map((f) => f.c));
    if (out.length >= R.maxPerDocument) break;
  }
  out.length = Math.min(out.length, R.maxPerDocument);
  return { candidates: out, counts };
}

/**
 * Whether anything may be drawn over a placement: a figure cluster crossing its box, text over images on the page, or a
 * page whose `text`/`vectors` facts are unknown. Clusters cover curved and diagonal drawing only; axis-aligned overlays
 * (rectangles over a base image) are not seen.
 */
function overlaid(page: DopplerPageFacts, box: BBox): boolean {
  if (!page.text || !page.vectors || page.vectors.clustersTruncated || !page.vectors.clusters) return true;
  if ((page.text.textOverImageRatio ?? 1) > 0) return true;
  return page.vectors.clusters.some((cluster) => {
    const c = toBBox(cluster.bbox, page);
    return c !== null && c.x < box.x + box.width && box.x < c.x + c.width && c.y < box.y + box.height && box.y < c.y + c.height;
  });
}

/** Box overlap (IoU) an image-backed candidate must reach to take the facts image's object number. */
export const OBJ_MATCH_MIN_IOU = 0.9;

function iou(a: BBox, b: BBox): number {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = x * y;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Gives each image-backed candidate (an embedded image image routing or the router placed) the facts `obj` of the image
 * it is, so repeated placements of one image object share a read. The boxes must agree closely (`OBJ_MATCH_MIN_IOU`):
 * a chart drawn over a background image, a vector cluster or a router region is never that image. Stencil masks and a
 * page's scan image are never matched. Candidates that already carry an `obj` keep it.
 */
export function annotateImageObjects(candidates: VisualCandidate[], facts: Pick<DopplerPageFactsDocument, "pages">): void {
  for (const candidate of candidates) {
    if (!candidate.bbox) continue;
    const known = facts.pages.get(candidate.pageNumber);
    // Reuse needs the facts' word that nothing is drawn over the placement (`clean`); without facts, never.
    if (candidate.asset && known && !known.failed) {
      candidate.asset = { ...candidate.asset, clean: !overlaid(known, candidate.bbox) && candidate.asset.clean !== false };
    }
    if (candidate.asset?.obj !== undefined) continue;
    const imageBacked = candidate.detectedBy === "image-routing" || (candidate.detectedBy === "router-inset" && candidate.imageIndex !== null);
    if (!imageBacked) continue;
    const page = facts.pages.get(candidate.pageNumber);
    if (!page || page.failed || !page.images?.items) continue;
    let best: { obj: number; score: number } | null = null;
    let ambiguous = false;
    for (const item of page.images.items) {
      if (item.obj === undefined || item.imageMask || item.index === page.images.scanImage) continue;
      const bbox = toBBox(item.bbox, page);
      const score = bbox ? iou(bbox, candidate.bbox) : 0;
      if (score < OBJ_MATCH_MIN_IOU) continue;
      if (best && best.obj !== item.obj) ambiguous = true;
      if (!best || score > best.score) best = { obj: item.obj, score };
    }
    // Two different objects in the same place (a stack of images): no identity rather than the wrong one.
    if (best && !ambiguous) candidate.asset = { ...candidate.asset, obj: best.obj, clean: !overlaid(page, candidate.bbox) };
  }
}

/**
 * The document's facts from its `doppler-page-facts` slot (canonical lines extract-markdown re-serialized from what the
 * strict reader kept), read again by the same strict reader: bounded by the host's page count and its byte budget.
 * No slot, a storage without byte reads, or a refused stream: null (today's behaviour).
 */
export async function loadChartFacts(
  storage: Pick<ArtifactStore, "bucket"> & Partial<Pick<ArtifactStore, "getBytes">>,
  ledger: DocumentArtifactLedger,
  document: { id: string; pageCount: number },
): Promise<DopplerPageFactsDocument | null> {
  const uri = ledger.readDocument(document.id, DOPPLER_PAGE_FACTS_SLOT);
  const key = uri ? keyFromStorageUri(uri, storage.bucket) : null;
  if (!key || !storage.getBytes || !Number.isSafeInteger(document.pageCount) || document.pageCount < 1 || document.pageCount > DOPPLER_PAGE_FACTS_MAX_PAGES) return null;
  let bytes: Buffer;
  try {
    bytes = await storage.getBytes(key, { maxBytes: dopplerPageFactsByteBudget(document.pageCount) });
  } catch {
    return null;
  }
  const parsed = parseDopplerPageFacts(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), { pageCount: document.pageCount });
  return parsed.ok ? parsed.facts : null;
}

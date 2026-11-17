/**
 * Page evidence: what is known, and what is not, about one page of a PDF, and the routing decisions that follow from it.
 *
 * Three sources measure pages, each through its own adapter:
 * - Doppler's page facts (lib/page-evidence-doppler.ts `pageEvidenceFromDopplerPage`), the sandboxed route's measure;
 * - the layout walker's pdf-layout-facts@1 pages (`pageEvidenceFromLayout`), also the stored form classify-route reads;
 * - the native probe's rows (`pageEvidenceFromProbeRow`), the v2 router's host probe.
 * Each adapter applies this module's rules once (page-side bounds, furniture, the low-confidence and truncation downgrades,
 * which grids count as the walker's), so a consumer never re-decides a fact another consumer already decided differently.
 *
 * Every quantity is known or unknown (null). Unknown is never read as zero, "no table" or "no image". A whole page can be
 * unknown in four ways (`state`): the source failed on it, it is low confidence (Doppler `xref-repaired-earlier`: any of its
 * facts may come from another body of an object the file holds twice, so only its size is kept), or its document is locked.
 *
 * Decisions (the only rules consumers apply to evidence):
 * - `pageTableDecision`: a table (known), no table (known), or unknown, which takes the table path. Doppler's encodings only
 *   add a table, never remove one.
 * - `pageOnTablePath` / `routerTableRuleScore`: the same table path for the v2 router.
 * - `textLayerGarbled`, `textLayerUnreliable`, `textLayerStatus`, `isOcrLayer`: whether the text layer can be trusted.
 * - `mathGlyphsWithholdTrust`, `mathGlyphsNeedTriage`, `mathGlyphNeed`: the one math-glyph threshold, three purposes.
 * - `readImageBoxes` and the `placements` list: which images may authorize a read (none on a page that is not `known`).
 * - `pageCostRouteOf`: the page's cost path for document cost stats.
 *
 * Pure: no I/O, no clock.
 */
import {
  PAGE_RASTER_ROUTING, isTableHeavy, pageCostRoute, type PageCostRoute, type PageLayoutImage, type PageTable, type TextLayerStatus,
} from "@docslurp/shared";

import type { PageEncodingRoute } from "./doppler-encoding-facts.js";
import type { PageLayoutFacts } from "./page-layout-facts.js";

// ── Rules ──

export const PAGE_EVIDENCE = {
  /** A page side in points: 1 pt to the PDF limit of 14,400 pt. Anything else is not a size routing can divide by. */
  minSidePt: 1,
  maxSidePt: 14_400,
  /** The page size the v2 router assumes when the size is unknown (US Letter, as the probe's failed row). */
  defaultWidthPt: 612,
  defaultHeightPt: 792,
  /** The walker's minimum ruled grid: 2 distinct horizontal and 3 distinct vertical rules (so 2 columns). */
  gridMinHRules: 2,
  gridMinVRules: 3,
  gridMinColumns: 2,
  /** A text layer is garbled with at least this many characters and too many unmapped or control characters. */
  garbledMinChars: 20,
  garbledUnmappedRatio: 0.1,
  garbledControlRatio: 0.4,
  /** Unmapped glyphs above this share make an `ok` text layer `suspect` (the probe's status rule). */
  suspectUnmappedRatio: 0.03,
  /** Image coverage at which a page without text is unknown (not absent), and a sparse layer is suspect. */
  imageHostCoverage: 0.3,
  /** Text over a page-sized image at this share (with 3 or more words) is an OCR layer. */
  ocrLayerOverImage: 0.5,
  /** The v2 router's rule score that is a full table need (needs tables = score / this, at most 1). */
  fullTableRuleScore: 4,
} as const;

/**
 * Math glyphs (mathematical alphanumerics, operators and symbols; Greek letters are prose and unit symbols): one share,
 * used for three distinct purposes, each a named decision below. PROVISIONAL gate: chosen on the TL1 development and
 * calibration data (0.01 separated its math pages); it is the stricter of the cuts tried (a later math-encoding evaluation
 * used 0.02), so it withholds accept-text-only from more pages, never fewer. Doppler's encoding facts name the math that
 * needs a read directly; this share is the conservative backstop.
 */
export const PAGE_MATH_GLYPHS = {
  gate: 0.01,
  /** The share, as a multiple of the gate, at which the v2 router's math need is full. */
  fullNeedMultiple: 8,
} as const;

/** A page side within PAGE_EVIDENCE's bounds. */
export function pageSideOk(n: number): boolean {
  return Number.isFinite(n) && n >= PAGE_EVIDENCE.minSidePt && n <= PAGE_EVIDENCE.maxSidePt;
}

/** A page size, or null when either side is out of bounds (unknown). */
export function pageSize(widthPt: number | null | undefined, heightPt: number | null | undefined): PageSize | null {
  return typeof widthPt === "number" && typeof heightPt === "number" && pageSideOk(widthPt) && pageSideOk(heightPt) ? { widthPt, heightPt } : null;
}

/** The probe's garbled-layer rule: enough characters, and too many unmapped glyphs or control characters. */
export function textLayerGarbled(chars: number, unmappedRatio: number, controlRatio: number): boolean {
  return chars >= PAGE_EVIDENCE.garbledMinChars && (unmappedRatio > PAGE_EVIDENCE.garbledUnmappedRatio || controlRatio > PAGE_EVIDENCE.garbledControlRatio);
}

/** A text layer the v2 router never trusts: garbled, or more than garbledUnmappedRatio of its glyphs unmapped. */
export function textLayerUnreliable(native: { garbled: boolean; unmappedGlyphRatio: number }): boolean {
  return native.garbled || native.unmappedGlyphRatio > PAGE_EVIDENCE.garbledUnmappedRatio;
}

/** ok | suspect | absent | unknown, from free facts only (the probe's rule). */
export function textLayerStatus(chars: number, words: number, unmappedRatio: number, garbled: boolean, imageCoverage: number): Exclude<TextLayerStatus, "ocr-layer"> {
  if (chars === 0) return imageCoverage >= PAGE_EVIDENCE.imageHostCoverage ? "unknown" : "absent";
  if (garbled || unmappedRatio > PAGE_EVIDENCE.suspectUnmappedRatio) return "suspect";
  if (words < 20 && imageCoverage >= PAGE_EVIDENCE.imageHostCoverage) return "suspect";
  return "ok";
}

/** Text lying over a page-sized image: an OCR layer. */
export function isOcrLayer(textOverImageRatio: number, words: number): boolean {
  return words >= 3 && textOverImageRatio >= PAGE_EVIDENCE.ocrLayerOverImage;
}

/** Trust purpose: a page with this share of math glyphs is never accept-text-only. */
export function mathGlyphsWithholdTrust(ratio: number): boolean {
  return ratio >= PAGE_MATH_GLYPHS.gate;
}

/** Triage purpose: a page with this share of math glyphs is worth a decision model's look. */
export function mathGlyphsNeedTriage(ratio: number): boolean {
  return ratio >= PAGE_MATH_GLYPHS.gate;
}

/** Need purpose: the v2 router's 0..1 math need from the share (full at fullNeedMultiple times the gate). */
export function mathGlyphNeed(ratio: number): number {
  return Math.min(1, ratio / (PAGE_MATH_GLYPHS.gate * PAGE_MATH_GLYPHS.fullNeedMultiple));
}

/**
 * Furniture (a logo, a letterhead, a slide background): an image object drawn on at least repeatedImageMinPages pages and
 * on at least repeatedImageMinShare of the `scope` pages. One rule in two forms: the walker's floor
 * (worker/scripts/pdf_layout_facts.py `repeated_objects`, mirrored by Doppler's layout mapping and chart-export) and the
 * host probe's share (lib/page-image-evidence.ts, mirrored by evidence built from Doppler facts) agree for every page count
 * up to the facts' 100,000-page ceiling. What each counts differs on purpose: the walker counts every placement over the
 * pages it considered, the probe only significant placements over the pages it listed.
 */
export function furnitureFloor(scope: number, rule: { minPages: number; minShare: number } = FURNITURE): number {
  return Math.max(rule.minPages, Math.ceil(rule.minShare * Math.max(1, scope)));
}

/** The same furniture rule as a test of one object's page count (see furnitureFloor). */
export function isFurnitureShare(pages: number, scope: number, rule: { minPages: number; minShare: number } = FURNITURE): boolean {
  return pages >= rule.minPages && pages / Math.max(1, scope) >= rule.minShare;
}

/** PAGE_RASTER_ROUTING.repeatedImageMinPages / repeatedImageMinShare (the walker's and the probe's rule). */
const FURNITURE = { minPages: PAGE_RASTER_ROUTING.repeatedImageMinPages, minShare: PAGE_RASTER_ROUTING.repeatedImageMinShare } as const;

// ── Evidence ──

export type PageEvidenceSource = "doppler-facts" | "layout-walker" | "native-probe";

/**
 * - `known`: the source measured the page (each quantity may still be unknown);
 * - `failed`: the source could not read the page: nothing is known;
 * - `low-confidence`: Doppler read the page after an earlier page rebuilt the cross-reference table: only its size is kept;
 * - `locked`: the document needs a password: nothing is known (the router reports it).
 */
export type PageEvidenceState = "known" | "failed" | "low-confidence" | "locked";

export interface PageSize { widthPt: number; heightPt: number }

/** What the text layer is: none, invisible (an OCR layer), visible or mixed. */
export type TextLayerKind = "none" | "invisible" | "visible" | "mixed";

export interface TextEvidence {
  /** Every word of the text layer, visible or not. */
  words: number | null;
  chars: number | null;
  invisibleWords: number | null;
  layer: TextLayerKind | null;
  /** Share of the page the text covers. */
  coverage: number | null;
  mathGlyphRatio: number | null;
  /** Share of the characters drawn invisibly; over a page-sized image. */
  invisibleTextRatio: number | null;
  textOverImageRatio: number | null;
  garbled: boolean | null;
  /** The v2 router's verdict on the layer (`unknown` when the text is). */
  status: TextLayerStatus;
  /** Agreement of an OCR layer with a fresh OCR of a band of the page (native probe only); null when it could not run. */
  ocrLayerAgreement?: number | null;
  ocrLayerMs?: number;
}

export interface ImageEvidence {
  count: number;
  coverage: number;
  largestCoverage: number;
  fullPageImage: boolean;
  /** Boxes as the source reported them (page points, top-left origin). */
  boxes: Array<{ bbox: [number, number, number, number]; coverage: number }>;
}

export interface FontEvidence {
  count: number | null;
  smallestPt: number | null;
}

export interface VectorEvidence {
  paths: number;
  uncoveredRatio: number;
  /** The source's rule score (min of the horizontal and vertical rule counts); null when unknown. */
  ruleScore: number | null;
}

/**
 * The page's ruled grids:
 * - `known`: these grids (possibly none) are the walker's;
 * - `unknown`: a source tried and could not say: the table path, never "no table";
 * - `unmeasured`: the walker alone, without page facts to settle it, gave no grid for the page (its own "no ruling line in
 *   this range"): no table from grids, and an unknown cost route.
 */
export type GridEvidence =
  | { state: "known"; grids: PageTable[] }
  | { state: "unknown" }
  | { state: "unmeasured" };

export interface PageEvidence {
  page: number;
  source: PageEvidenceSource;
  state: PageEvidenceState;
  size: PageSize | null;
  rotation: number | null;
  text: TextEvidence;
  /** Glyphs without a Unicode value, from the fonts and the text (the larger). */
  unmappedGlyphRatio: number | null;
  fonts: FontEvidence | null;
  images: ImageEvidence | null;
  /** Placed images with stream facts and furniture marked, as the walker lists them; null when the listing is unknown. */
  placements: PageLayoutImage[] | null;
  vectors: VectorEvidence | null;
  grids: GridEvidence;
  /** The extractor's own tables with their geometry (walker); null when unknown. */
  tables: PageTable[] | null;
  /** Share of the page covered by the union of the table boxes and grids; null when unknown. */
  tableCoverage: number | null;
  /** Doppler's math and table encodings, when known. */
  encodings: PageEncodingRoute | null;
  /** Unusual features in the probe's vocabulary (page and document). */
  features: string[];
  /** Time the source spent on the page, ms. */
  probeMs: number;
}

/** A text layer nothing is known about. */
export const UNKNOWN_TEXT: TextEvidence = Object.freeze({
  words: null, chars: null, invisibleWords: null, layer: null, coverage: null, mathGlyphRatio: null, invisibleTextRatio: null,
  textOverImageRatio: null, garbled: null, status: "unknown",
}) as TextEvidence;

/** A page nothing is known about (besides, optionally, its size). */
export function unknownPageEvidence(page: number, source: PageEvidenceSource, state: Exclude<PageEvidenceState, "known">, extra: Partial<Pick<PageEvidence, "size" | "rotation" | "features" | "probeMs">> = {}): PageEvidence {
  return {
    page, source, state, size: extra.size ?? null, rotation: extra.rotation ?? null, text: { ...UNKNOWN_TEXT }, unmappedGlyphRatio: null,
    fonts: null, images: null, placements: null, vectors: null, grids: { state: "unknown" }, tables: null, tableCoverage: null,
    encodings: null, features: extra.features ?? [], probeMs: extra.probeMs ?? 0,
  };
}

/** Marks a low-confidence page in the v2 router's unusual features (never an attention feature; keeps the page from reading blank). */
export const LOW_CONFIDENCE_FEATURE = "facts-low-confidence";
/** Marks a page the source failed on (the probe's own vocabulary). */
export const FAILED_PAGE_FEATURE = "probe-error";

// ── Adapters: the layout walker and the native probe (Doppler's is lib/page-evidence-doppler.ts) ──

/**
 * A page of pdf-layout-facts@1 (parsed by parsePageLayoutFacts): the walker's own, or the stored layout classify-route reads.
 * Grids are unknown with `gridsUnknown` (a source tried), else known from the list, else unmeasured (the walker's own "no
 * ruling line"). Fields a caller left out are unknown.
 */
export function pageEvidenceFromLayout(page: number, layout: PageLayoutFacts): PageEvidence {
  // The mark wins (it is only ever set beside unknown grids); a missing list is not a known one.
  const grids: GridEvidence = layout.gridsUnknown === true ? { state: "unknown" }
    : Array.isArray(layout.grids) ? { state: "known", grids: [...layout.grids] } : { state: "unmeasured" };
  return {
    page, source: "layout-walker", state: "known",
    size: pageSize(layout.widthPt, layout.heightPt), rotation: null,
    text: {
      ...UNKNOWN_TEXT, words: layout.words ?? null, invisibleWords: layout.invisibleWords ?? null, layer: layout.textLayer ?? null,
    },
    unmappedGlyphRatio: null, fonts: null, images: null,
    placements: layout.images ?? null, vectors: null, grids, tables: layout.tables ?? null, tableCoverage: layout.tableCoverage ?? null,
    encodings: layout.encodings ?? null, features: [], probeMs: 0,
  };
}

/** The native probe's row as page evidence reads it (routing/page-input.ts ProbeRow is the full wire shape). */
export interface NativeProbePage {
  pageNumber: number;
  charCount: number;
  wordCount: number;
  textCoverage: number;
  fontCount: number;
  unmappedGlyphRatio: number;
  mathGlyphRatio: number;
  tableRuleScore: number;
  imageCoverage: number;
  largestImageCoverage: number;
  fullPageImage: boolean;
  vectorDrawingCount: number;
  uncoveredVectorRatio: number;
  garbled: boolean;
  textLayerStatus: TextLayerStatus;
  imageCount: number;
  textFacts: { wordCount: number | null; imageCount: number | null; imageCoverage: number | null; textLayerStatus: TextLayerStatus };
  invisibleTextRatio?: number;
  textOverImageRatio?: number;
  ocrLayerCheck?: { agreement: number | null; wallMs: number };
  images: Array<{ bbox: [number, number, number, number]; coverage: number }>;
  smallestFontPt: number | null;
  widthPt: number;
  heightPt: number;
  rotation: number;
  probeMs: number;
  unusualFeatures?: string[];
  locked?: boolean;
  probeEngine?: string;
}

/**
 * A native probe row. The probe measures every quantity it reports, so a row is `known` (its failed row says so with
 * `probe-error` and unknown text facts); a locked row is `locked`. The probe finds no grids: `unmeasured`, with its rule score.
 */
export function pageEvidenceFromProbeRow(row: NativeProbePage): PageEvidence {
  if (row.locked) {
    return unknownPageEvidence(1, "native-probe", "locked", { features: row.unusualFeatures ?? [], probeMs: row.probeMs ?? 0 });
  }
  return {
    page: row.pageNumber, source: "native-probe", state: "known",
    size: { widthPt: row.widthPt, heightPt: row.heightPt }, rotation: row.rotation,
    text: {
      words: row.textFacts.wordCount === null ? null : row.wordCount, chars: row.charCount, invisibleWords: null, layer: null,
      coverage: row.textCoverage, mathGlyphRatio: row.mathGlyphRatio, invisibleTextRatio: row.invisibleTextRatio ?? null,
      textOverImageRatio: row.textOverImageRatio ?? null, garbled: row.garbled, status: row.textFacts.textLayerStatus,
      ...(row.ocrLayerCheck ? { ocrLayerAgreement: row.ocrLayerCheck.agreement, ocrLayerMs: row.ocrLayerCheck.wallMs } : {}),
    },
    unmappedGlyphRatio: row.unmappedGlyphRatio,
    fonts: { count: row.fontCount, smallestPt: row.smallestFontPt },
    // The probe's failed row says its images are unknown through its text facts.
    images: row.textFacts.imageCount === null
      ? null
      : { count: row.imageCount, coverage: row.imageCoverage, largestCoverage: row.largestImageCoverage, fullPageImage: row.fullPageImage, boxes: row.images },
    placements: null,
    vectors: { paths: row.vectorDrawingCount, uncoveredRatio: row.uncoveredVectorRatio, ruleScore: row.tableRuleScore },
    grids: { state: "unmeasured" }, tables: null, tableCoverage: null, encodings: null,
    features: row.unusualFeatures ?? [], probeMs: row.probeMs,
  };
}

// ── Grid precedence ──

/**
 * Which source's grids stand for a page: the walker's when it knows them, else the page facts' when they do, else unknown
 * (the table path; never "no table"). Only the grids are settled; nothing else of the walker's page changes.
 */
export function settleGrids(walker: GridEvidence, facts: GridEvidence | null): GridEvidence {
  if (walker.state === "known") return walker;
  if (facts?.state === "known") return facts;
  return { state: "unknown" };
}

// ── Decisions ──

export type PageTableReason = "encoding-vision" | "grids-unknown" | "table-heavy" | "encoding-text-layer" | "none";
export interface PageTableDecision {
  decision: "table" | "no-table" | "unknown";
  reason: PageTableReason;
}

/**
 * Whether the page is a table page, from its evidence and the tables its text shows. In order:
 * 1. a table Doppler's encodings say only a read recovers (`outlined-text-grid`): a table;
 * 2. grids unknown: unknown, which takes the table path (a document can never steer its pages into "no table");
 * 3. table-heavy (shared isTableHeavy) over the extractor's tables (the walker's with geometry, else the text's Markdown
 *    tables), the known grids, and the rows the text kept aligned: a table;
 * 4. a table encoding the text layer holds, on a page with no known grid: a table (encodings only add);
 * 5. otherwise no table.
 * `encodings` only when encoding routing is on and the page's encodings are known.
 */
export function pageTableDecision(
  evidence: PageEvidence | null,
  args: { markdownTables?: readonly PageTable[]; textRows?: readonly PageTable[]; encodings?: PageEncodingRoute | null } = {},
): PageTableDecision {
  const encodings = args.encodings ?? null;
  if (encodings?.table === "vision") return { decision: "table", reason: "encoding-vision" };
  if (evidence?.grids.state === "unknown") return { decision: "unknown", reason: "grids-unknown" };
  const knownGrids = evidence?.grids.state === "known" ? evidence.grids.grids : [];
  const tables: PageTable[] = [...(evidence?.tables ?? args.markdownTables ?? []), ...knownGrids, ...(args.textRows ?? [])];
  if (isTableHeavy(tables, evidence?.tableCoverage ?? null)) return { decision: "table", reason: "table-heavy" };
  if (encodings?.table === "text-layer" && knownGrids.length === 0) return { decision: "table", reason: "encoding-text-layer" };
  return { decision: "no-table", reason: "none" };
}

/** The page's grids put it on the table path: unknown, or known and table-heavy. Structure alone (no text). */
export function pageOnTablePath(evidence: PageEvidence): boolean {
  const decision = pageTableDecision(evidence).decision;
  return decision !== "no-table";
}

/**
 * The v2 router's table rule score: the source's own score, raised to a full table need where the page's grids put it on
 * the table path (unknown included, so a low-confidence or truncated page is never a "no table"). Never lowered: grids that
 * prove no table leave the rule score as it was.
 */
export function routerTableRuleScore(evidence: PageEvidence): number {
  const own = evidence.vectors?.ruleScore ?? 0;
  if (evidence.state === "locked" || evidence.state === "failed") return own;
  return pageOnTablePath(evidence) ? Math.max(own, PAGE_EVIDENCE.fullTableRuleScore) : own;
}

/** Image boxes that may put a paid question about an inset (the router's inset gate): none unless the page is `known`. */
export function readImageBoxes(evidence: PageEvidence): ImageEvidence["boxes"] {
  return evidence.state === "known" ? evidence.images?.boxes ?? [] : [];
}

/**
 * The page's cost path (shared pageCostRoute, the estimator's rule) from its evidence and what the run observed about it:
 * a page whose grids are unknown takes the table path when the source text has letters (a page without them goes to OCR).
 * `lexicalText`: the source text layer had letters (null: unknown, then the evidence's word count decides).
 */
export function pageCostRouteOf(evidence: PageEvidence | undefined, observed: { lexicalText: boolean | null; vectorPaths: number | null }): PageCostRoute {
  if (evidence?.grids.state === "unknown" && observed.lexicalText === true) return "table";
  const words = evidence?.text.words ?? null;
  return pageCostRoute({
    words: observed.lexicalText === null ? words : observed.lexicalText ? Math.max(1, words ?? 1) : 0,
    images: evidence?.placements?.length ?? null,
    vectorPaths: observed.vectorPaths,
    grids: evidence?.grids.state === "known" ? evidence.grids.grids : null,
    gridCoverage: evidence?.tableCoverage ?? null,
  });
}

// ── Projections ──

/**
 * The layout form of the evidence (pdf-layout-facts@1 as parsePageLayoutFacts reads it), or null for a page that failed
 * (the layout leaves it out: unknown). A low-confidence page keeps only its size. Unknown grids are `grids: null`: the job
 * marks them `gridsUnknown` (the table path) when it settles the layout against the walker's (settleUnknownGrids), which
 * every job with page facts does before routing reads it.
 */
export function pageLayoutFactsFromEvidence(evidence: PageEvidence): PageLayoutFacts | null {
  if (evidence.state === "failed" || evidence.state === "locked") return null;
  const size = evidence.size ? { widthPt: evidence.size.widthPt, heightPt: evidence.size.heightPt } : {};
  if (evidence.state === "low-confidence") return { images: null, tables: null, words: null, grids: null, tableCoverage: null, ...size };
  const grids = evidence.grids.state === "known" ? evidence.grids.grids : null;
  return {
    images: evidence.placements,
    tables: evidence.tables,
    words: evidence.text.words,
    grids,
    tableCoverage: evidence.tableCoverage,
    ...size,
    ...(evidence.text.layer !== null ? { invisibleWords: evidence.text.invisibleWords, textLayer: evidence.text.layer } : {}),
    ...(evidence.encodings ? { encodings: evidence.encodings } : {}),
  };
}

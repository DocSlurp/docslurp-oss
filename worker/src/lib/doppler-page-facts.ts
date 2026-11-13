/**
 * Strict, bounded reader for Doppler's per-page facts (`doppler-page-facts/1`, JSON lines: one `doc` line, one `page` line
 * per page, one `run` line). The contract lives in Doppler's `docslurp/page-facts/` (README.md and the JSON Schema).
 *
 * The bytes come from the PDF VM, which read a customer file: they are untrusted. This reader
 * - bounds everything before it parses: total bytes (a per-page budget under an absolute ceiling), line length, line count,
 *   list lengths and string lengths;
 * - accepts ASCII lines only (the contract escapes everything else), finite numbers only, ratios in 0..1, non-negative
 *   integer counts, closed enums (unknown values are dropped, as the contract asks), and page numbers within the page
 *   count the host measured itself;
 * - never keeps a string from the document: `producer` and `creator` are not read at all;
 * - turns a malformed line, page or family into "unknown" (absent), never a guess. A broken doc line refuses the whole
 *   input, as does an oversized one.
 *
 * Facts are routing evidence only. Billing and limits use the host's own page count (pdfpagecount), never the facts'
 * `pageCount`, which is kept as `reportedPageCount` for diagnostics.
 */

export const DOPPLER_PAGE_FACTS_SCHEMA = "doppler-page-facts/1";

/** Byte budget: a base for the doc and run lines plus a per-page allowance (a full-level page with 32 image items is ~10 KB), under an absolute ceiling. */
export const DOPPLER_PAGE_FACTS_BASE_BYTES = 8 * 1024 * 1024;
export const DOPPLER_PAGE_FACTS_BYTES_PER_PAGE = 12 * 1024;
export const DOPPLER_PAGE_FACTS_MAX_BYTES = 64 * 1024 * 1024;
/** One line (a full-level page with 32 image items and 32 clusters is a few KiB). */
export const DOPPLER_PAGE_FACTS_MAX_LINE_BYTES = 64 * 1024;
/** The largest page count the reader accepts from the host. */
export const DOPPLER_PAGE_FACTS_MAX_PAGES = 100_000;
/** Lines beyond the doc line, one page line per page and the run line that a valid stream never needs. */
const LINE_SLACK = 16;

/** The byte budget for a document of `pageCount` pages (host-measured). */
export function dopplerPageFactsByteBudget(pageCount: number): number {
  const pages = Number.isSafeInteger(pageCount) && pageCount > 0 ? Math.min(pageCount, DOPPLER_PAGE_FACTS_MAX_PAGES) : 1;
  return Math.min(DOPPLER_PAGE_FACTS_MAX_BYTES, DOPPLER_PAGE_FACTS_BASE_BYTES + DOPPLER_PAGE_FACTS_BYTES_PER_PAGE * pages);
}

// ── Vocabularies (closed sets; unknown values are dropped) ──

const FAMILIES = ["fonts", "oddtext", "images-detail", "vectors", "forms", "annots", "ocg", "structure"] as const;
const FEATURES = [
  "acroform-empty", "acroform-filled", "annotation-freetext", "annotation-highlight", "annotation-other", "annotation-text",
  "drawing-limit", "embedded-files", "encrypted-empty-password", "encrypted-user-password", "huge-page", "javascript-present",
  "layered-scan", "link-internal", "link-uri", "no-tounicode", "ocg-hidden", "ocg-visible", "rotated-content", "rotated-page",
  "scan-page", "type3-font", "xfa-present",
] as const;
const WARNINGS = [
  "bad-content-stream", "broken-image", "internal-error", "io-error", "limit-hit", "missing-font", "non-finite", "out-of-range",
  "page-failed", "syntax-error", "syntax-warning", "unimplemented", "xref-repaired",
] as const;
const TEXT_LAYERS = ["none", "invisible", "visible", "mixed"] as const;
const SCANS = ["none", "single", "tiled", "layered"] as const;
const FILTERS = ["none", "dct", "jpx", "jbig2", "ccitt", "flate", "lzw", "rl", "other"] as const;
const COLOR_SPACES = ["none", "gray", "rgb", "cmyk", "indexed", "lab", "icc1", "icc3", "icc4", "sep", "devn", "other"] as const;
const COPY_CLASSES = ["jpeg", "bilevel", "decode", "render"] as const;
const ANNOT_SUBTYPES = [
  "text", "link", "freeText", "line", "square", "circle", "polygon", "polyLine", "highlight", "underline", "squiggly", "strikeOut",
  "stamp", "caret", "ink", "popup", "fileAttachment", "sound", "movie", "widget", "screen", "printerMark", "trapNet", "watermark",
  "threeD", "richMedia", "other",
] as const;
const PERMISSIONS = ["print", "printHighRes", "modify", "copy", "annotate", "fillForms", "accessibility", "assemble"] as const;
const DOC_TRUNCATED = ["embeddedFiles", "outlineCount", "strings"] as const;

export type DopplerPageFactsFamily = (typeof FAMILIES)[number];
export type DopplerUnusualFeature = (typeof FEATURES)[number];
export type DopplerParseWarning = (typeof WARNINGS)[number];
export type DopplerTextLayer = (typeof TEXT_LAYERS)[number];
export type DopplerScan = (typeof SCANS)[number];
export type DopplerImageFilter = (typeof FILTERS)[number];
export type DopplerColorSpace = (typeof COLOR_SPACES)[number];
export type DopplerImageCopy = (typeof COPY_CLASSES)[number];
export type DopplerAnnotSubtype = (typeof ANNOT_SUBTYPES)[number];

export type Box = [number, number, number, number];

// ── Typed facts (field names as on the wire; a family that was not computed or did not validate is absent) ──

export interface DopplerGeometry {
  widthPt: number;
  heightPt: number;
  rotation: 0 | 90 | 180 | 270;
  userUnit: number;
  mediaBox?: Box;
  cropBox?: Box;
}

export interface DopplerTextFacts {
  charCount: number;
  visibleCharCount: number;
  invisibleCharCount: number;
  wordCount: number;
  visibleWordCount: number;
  invisibleWordCount: number;
  /** Unknown value on the wire: the whole `text` family is unknown (it decides routing). */
  textLayer: DopplerTextLayer;
  textCoverage: number;
  clippedCharCount?: number;
  controlCharRatio?: number;
  privateUseRatio?: number;
  replacementCharRatio?: number;
  mathGlyphRatio?: number;
  verticalCharRatio?: number;
  rotatedTextRatio?: number;
  textOverImageRatio?: number;
  invisibleOverFullPageImage?: boolean;
}

export interface DopplerFontFacts {
  count: number;
  smallestPt?: number;
  type3: number;
  nonEmbedded: number;
  cid: number;
  noToUnicode: number;
  glyphCount: number;
  unmappedGlyphRatio?: number;
  ocrFontHint: boolean;
  truncated: boolean;
}

export interface DopplerImageItem {
  index: number;
  bbox: Box;
  coverage: number;
  px: [number, number];
  dpi: [number, number];
  filter: DopplerImageFilter;
  bpc?: number;
  colorSpace: DopplerColorSpace;
  imageMask: boolean;
  softMask: boolean;
  mask: boolean;
  decode: boolean;
  inline: boolean;
  obj?: number;
  copy: DopplerImageCopy;
}

export interface DopplerImageFacts {
  imageCount: number;
  imageCoverage: number;
  largestImageCoverage: number;
  fullPageImage: boolean;
  /** Unknown value on the wire: the whole `images` family is unknown. */
  scan: DopplerScan;
  scanImage?: number;
  maskCount?: number;
  inlineCount?: number;
  /** Absent when not computed or when the list did not validate (unknown, not empty). */
  items?: DopplerImageItem[];
  itemsTruncated?: boolean;
  truncated: boolean;
}

export interface DopplerVectorCluster {
  bbox: Box;
  paths: number;
  curves: number;
  segments: number;
}

export interface DopplerVectorFacts {
  paths: number;
  filled: number;
  stroked: number;
  coverage: number;
  uncoveredRatio?: number;
  hRules: number;
  vRules: number;
  ruleGridScore: number;
  shadings: number;
  patterns: number;
  clips: number;
  figureClusters: number;
  /** Absent when the list did not validate. */
  clusters?: DopplerVectorCluster[];
  clustersTruncated: boolean;
  limitHit: boolean;
}

export interface DopplerFormFacts {
  fields: number;
  text: number;
  checkbox: number;
  radio: number;
  choice: number;
  signature: number;
  pushButton: number;
  filled: number;
  empty: number;
  valueAppearanceMismatch: number;
  signed: number;
  unsigned: number;
  truncated: boolean;
}

export interface DopplerAnnotFacts {
  count: number;
  /** Known subtypes only; an unknown key is dropped. */
  bySubtype: Partial<Record<DopplerAnnotSubtype, number>>;
  linkUri: number;
  linkInternal: number;
  linkOther: number;
  visibleAppearance: number;
  truncated: boolean;
}

export interface DopplerLayerFacts {
  hiddenContent: boolean;
  visibleContent: boolean;
  hiddenOps: number;
  visibleOps: number;
}

/** One page's facts. `failed`: Doppler could not display the page (no other facts). */
export interface DopplerPageFacts {
  page: number;
  failed?: true;
  geometry?: DopplerGeometry;
  text?: DopplerTextFacts;
  fonts?: DopplerFontFacts;
  images?: DopplerImageFacts;
  vectors?: DopplerVectorFacts;
  forms?: DopplerFormFacts;
  annots?: DopplerAnnotFacts;
  layers?: DopplerLayerFacts;
  parseWarnings: DopplerParseWarning[];
  unusualFeatures: DopplerUnusualFeature[];
  factsMs?: number;
}

/** The doc line, without the document's own strings (`producer`, `creator` are never read). */
export interface DopplerDocFacts {
  level?: "basic" | "full";
  include?: DopplerPageFactsFamily[];
  scanThresholds?: { minCoverage: number; maxVisibleWords: number; layerOverlap: number };
  error?: "open-failed" | "damaged";
  locked?: boolean;
  /** Doppler's own `/Count`: diagnostics only. Never bills, limits or authorizes anything. */
  reportedPageCount?: number;
  pdfVersion?: string;
  linearized?: boolean;
  xref?: "ok" | "repaired";
  encryption?: "none" | "empty-user-password" | "user-password-required";
  permissions?: Partial<Record<(typeof PERMISSIONS)[number], boolean>>;
  incrementalUpdates?: number;
  tagged?: boolean;
  markedContent?: boolean;
  lang?: string;
  outlineCount?: number;
  pageLabels?: boolean;
  embeddedFiles?: number;
  javascript?: boolean;
  openAction?: boolean;
  launchAction?: boolean;
  truncated?: Array<(typeof DOC_TRUNCATED)[number]>;
  acroForm?: "none" | "present";
  needAppearances?: boolean;
  xfa?: "none" | "static" | "dynamic";
  ocgCount?: number;
  ocgOffByDefault?: number;
  unusualFeatures: DopplerUnusualFeature[];
}

export interface DopplerRunFacts {
  pagesEmitted: number;
  pagesFailed: number;
  stop?: "max-pages";
  version: string;
  commit: string;
  totalMs?: number;
  peakRssKiB?: number;
}

/** What the reader kept, and how much it had to set aside. */
export interface DopplerPageFactsSummary {
  /** The host's page count the facts were bounded by. */
  pageCount: number;
  pagesKnown: number;
  pagesFailed: number;
  /** Lines set aside: malformed JSON, non-ASCII, over-long, wrong schema or type, out of order, out of range, duplicate. */
  linesDropped: number;
  /** A run line arrived last: the stream was not cut short. */
  complete: boolean;
}

export interface DopplerPageFactsDocument {
  doc: DopplerDocFacts;
  pages: Map<number, DopplerPageFacts>;
  run: DopplerRunFacts | null;
  summary: DopplerPageFactsSummary;
}

export type DopplerPageFactsRefusal = "unsupported-input" | "page-count" | "oversized" | "too-many-lines" | "header";

export type DopplerPageFactsParse =
  | { ok: true; facts: DopplerPageFactsDocument }
  | { ok: false; reason: DopplerPageFactsRefusal };

// ── Value checks ──

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const has = (o: Obj, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** A non-negative safe integer, at most `max`. */
function count(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
}
function ratio(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}
/** Page points: finite and within ±10^9, as the contract clamps them. */
function points(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e9 ? value : undefined;
}
function nonNegative(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
}
function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
function oneOf<T extends string | number>(set: readonly T[], value: unknown): T | undefined {
  return (set as readonly unknown[]).includes(value) ? value as T : undefined;
}
function box(value: unknown): Box | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const out = value.map(points);
  return out.every((v) => v !== undefined) ? out as Box : undefined;
}
/** A closed-vocabulary list: unknown values dropped, duplicates removed, sorted. Over `max` entries: unknown. */
function vocabulary<T extends string>(set: readonly T[], value: unknown, max: number): T[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const kept = new Set<T>();
  for (const item of value) if ((set as readonly unknown[]).includes(item)) kept.add(item as T);
  return [...kept].sort();
}

/**
 * Collect fields: `required` ones must validate or the whole family is unknown (undefined); optional ones are kept only
 * when they validate. Keys are fixed by the caller, so nothing from the input names a property of the result.
 */
function family<T>(source: unknown, required: Record<string, (v: unknown) => unknown>, optional: Record<string, (v: unknown) => unknown> = {}): T | undefined {
  if (!isObj(source)) return undefined;
  const out: Obj = {};
  for (const [key, check] of Object.entries(required)) {
    const value = has(source, key) ? check(source[key]) : undefined;
    if (value === undefined) return undefined;
    out[key] = value;
  }
  for (const [key, check] of Object.entries(optional)) {
    if (!has(source, key)) continue;
    const value = check(source[key]);
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

// ── Families ──

function geometry(value: unknown): DopplerGeometry | undefined {
  return family<DopplerGeometry>(value, {
    // A page side is a size: negative is not a fact.
    widthPt: (v) => nonNegative(v, 1e9), heightPt: (v) => nonNegative(v, 1e9), rotation: (v) => oneOf([0, 90, 180, 270] as const, v),
    userUnit: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0.0001 && v <= 1_000_000 ? v : undefined,
  }, { mediaBox: box, cropBox: box });
}

function text(value: unknown): DopplerTextFacts | undefined {
  const facts = family<DopplerTextFacts>(value, {
    charCount: count, visibleCharCount: count, invisibleCharCount: count, wordCount: count, visibleWordCount: count,
    invisibleWordCount: count, textLayer: (v) => oneOf(TEXT_LAYERS, v), textCoverage: ratio,
  }, {
    clippedCharCount: count, controlCharRatio: ratio, privateUseRatio: ratio, replacementCharRatio: ratio, mathGlyphRatio: ratio,
    verticalCharRatio: ratio, rotatedTextRatio: ratio, textOverImageRatio: ratio, invisibleOverFullPageImage: bool,
  });
  // Counts that contradict each other are not facts.
  if (!facts) return undefined;
  if (facts.visibleCharCount + facts.invisibleCharCount !== facts.charCount) return undefined;
  if (facts.visibleWordCount + facts.invisibleWordCount !== facts.wordCount) return undefined;
  if (facts.clippedCharCount !== undefined && facts.clippedCharCount > facts.invisibleCharCount) return undefined;
  const layer = facts.wordCount === 0 ? "none" : facts.invisibleWordCount === 0 ? "visible" : facts.visibleWordCount === 0 ? "invisible" : "mixed";
  if (facts.textLayer !== layer) return undefined;
  return facts;
}

function fonts(value: unknown): DopplerFontFacts | undefined {
  return family<DopplerFontFacts>(value, {
    count: (v) => count(v, 256), type3: count, nonEmbedded: count, cid: count, noToUnicode: count, glyphCount: count,
    ocrFontHint: bool, truncated: bool,
  }, { smallestPt: (v) => nonNegative(v, 1e9), unmappedGlyphRatio: ratio });
}

const MAX_ITEMS = 32;

function imageItem(value: unknown): DopplerImageItem | undefined {
  return family<DopplerImageItem>(value, {
    index: (v) => count(v) !== undefined && (v as number) >= 1 ? v : undefined,
    bbox: box, coverage: ratio,
    px: (v) => Array.isArray(v) && v.length === 2 && v.every((n) => count(n) !== undefined) ? [v[0], v[1]] : undefined,
    dpi: (v) => Array.isArray(v) && v.length === 2 && v.every((n) => points(n) !== undefined) ? [v[0], v[1]] : undefined,
    filter: (v) => oneOf(FILTERS, v), colorSpace: (v) => oneOf(COLOR_SPACES, v), imageMask: bool, softMask: bool, mask: bool,
    decode: bool, inline: bool, copy: (v) => oneOf(COPY_CLASSES, v),
  }, {
    bpc: (v) => count(v, 32) !== undefined && (v as number) >= 1 ? v : undefined,
    obj: (v) => count(v) !== undefined && (v as number) >= 1 ? v : undefined,
  });
}

/** A list of family objects: over the cap, or any entry that does not validate, makes the whole list unknown. */
function list<T>(value: unknown, max: number, item: (v: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const out: T[] = [];
  for (const entry of value) {
    const parsed = item(entry);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

function images(value: unknown): DopplerImageFacts | undefined {
  const facts = family<DopplerImageFacts>(value, {
    imageCount: count, imageCoverage: ratio, largestImageCoverage: ratio, fullPageImage: bool, scan: (v) => oneOf(SCANS, v),
    truncated: bool,
  }, {
    scanImage: (v) => count(v) !== undefined && (v as number) >= 1 ? v : undefined, maskCount: count, inlineCount: count,
    items: (v) => list(v, MAX_ITEMS, imageItem), itemsTruncated: bool,
  });
  if (!facts) return undefined;
  if (facts.items && facts.items.length > facts.imageCount) delete facts.items;
  return facts;
}

function cluster(value: unknown): DopplerVectorCluster | undefined {
  return family<DopplerVectorCluster>(value, { bbox: box, paths: count, curves: count, segments: count });
}

function vectors(value: unknown): DopplerVectorFacts | undefined {
  return family<DopplerVectorFacts>(value, {
    paths: (v) => count(v, 100_000), filled: count, stroked: count, coverage: ratio, hRules: count, vRules: count,
    ruleGridScore: ratio, shadings: count, patterns: count, clips: count, figureClusters: count,
    clusters: (v) => list(v, MAX_ITEMS, cluster), clustersTruncated: bool, limitHit: bool,
  }, { uncoveredRatio: ratio });
}

function forms(value: unknown): DopplerFormFacts | undefined {
  return family<DopplerFormFacts>(value, {
    fields: count, text: count, checkbox: count, radio: count, choice: count, signature: count, pushButton: count, filled: count,
    empty: count, valueAppearanceMismatch: count, signed: count, unsigned: count, truncated: bool,
  });
}

function bySubtype(value: unknown): DopplerAnnotFacts["bySubtype"] | undefined {
  if (!isObj(value)) return undefined;
  const out: DopplerAnnotFacts["bySubtype"] = {};
  // Iterate the closed vocabulary, never the input's keys: an unknown (or hostile) key cannot name a property here.
  for (const subtype of ANNOT_SUBTYPES) {
    if (!has(value, subtype)) continue;
    const n = count(value[subtype]);
    if (n === undefined) return undefined;
    out[subtype] = n;
  }
  return out;
}

function annots(value: unknown): DopplerAnnotFacts | undefined {
  return family<DopplerAnnotFacts>(value, {
    count: (v) => count(v, 10_000), bySubtype, linkUri: count, linkInternal: count, linkOther: count, visibleAppearance: count,
    truncated: bool,
  });
}

function layers(value: unknown): DopplerLayerFacts | undefined {
  return family<DopplerLayerFacts>(value, { hiddenContent: bool, visibleContent: bool, hiddenOps: count, visibleOps: count });
}

const PAGE_FAMILIES = { geometry, text, fonts, images, vectors, forms, annots, layers } as const;

/**
 * Validate one page object (a wire `page` line, or a page of a stored artifact). Null when the page number is missing,
 * out of 1..pageCount, or the required lists are malformed: the page is then unknown.
 */
export function validateDopplerPage(value: unknown, pageCount: number): DopplerPageFacts | null {
  if (!isObj(value)) return null;
  const page = count(value.page);
  if (page === undefined || page < 1 || page > pageCount) return null;
  const parseWarnings = vocabulary(WARNINGS, value.parseWarnings, 64);
  const unusualFeatures = vocabulary(FEATURES, value.unusualFeatures, 64);
  if (!parseWarnings || !unusualFeatures) return null;
  const out: DopplerPageFacts = { page, parseWarnings, unusualFeatures };
  if (has(value, "error") || (has(value, "failed") && value.failed === true)) {
    // A page Doppler could not display carries no other facts; any other error value is not a fact we know.
    if (has(value, "error") && value.error !== "failed") return null;
    out.failed = true;
    return out;
  }
  for (const [name, check] of Object.entries(PAGE_FAMILIES)) {
    if (!has(value, name)) continue;
    const parsed = check(value[name]);
    if (parsed !== undefined) (out as unknown as Obj)[name] = parsed;
  }
  const ms = nonNegative(value.factsMs, 86_400_000);
  if (ms !== undefined) out.factsMs = ms;
  return out;
}

const LANG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,4}$/;
const BUILD = /^[A-Za-z0-9._+-]{0,64}$/;

/** Validate the doc line (or a stored doc summary). `producer` and `creator` are never read. */
export function validateDopplerDoc(value: unknown): DopplerDocFacts | null {
  if (!isObj(value)) return null;
  const unusualFeatures = has(value, "unusualFeatures") ? vocabulary(FEATURES, value.unusualFeatures, 64) : [];
  if (!unusualFeatures) return null;
  const pick = <K extends keyof DopplerDocFacts>(key: K, wire: string, check: (v: unknown) => DopplerDocFacts[K] | undefined) => {
    if (!has(value, wire)) return;
    const parsed = check(value[wire]);
    if (parsed !== undefined) out[key] = parsed;
  };
  const out: DopplerDocFacts = { unusualFeatures };
  pick("level", "level", (v) => oneOf(["basic", "full"] as const, v));
  pick("include", "include", (v) => vocabulary(FAMILIES, v, FAMILIES.length));
  pick("scanThresholds", "scanThresholds", (v) => family(v, {
    minCoverage: (n) => ratio(n) !== undefined && (n as number) > 0 ? n : undefined, maxVisibleWords: count,
    layerOverlap: (n) => ratio(n) !== undefined && (n as number) > 0 ? n : undefined,
  }));
  pick("error", "error", (v) => oneOf(["open-failed", "damaged"] as const, v));
  pick("locked", "locked", bool);
  // Stored summaries carry the renamed field; the wire carries `pageCount`.
  pick("reportedPageCount", has(value, "reportedPageCount") ? "reportedPageCount" : "pageCount", (v) => count(v));
  pick("pdfVersion", "pdfVersion", (v) => typeof v === "string" && /^[12]\.[0-9]$/.test(v) ? v : undefined);
  pick("linearized", "linearized", bool);
  pick("xref", "xref", (v) => oneOf(["ok", "repaired"] as const, v));
  pick("encryption", "encryption", (v) => oneOf(["none", "empty-user-password", "user-password-required"] as const, v));
  pick("permissions", "permissions", (v) => {
    if (!isObj(v)) return undefined;
    const out: NonNullable<DopplerDocFacts["permissions"]> = {};
    for (const key of PERMISSIONS) if (has(v, key) && typeof v[key] === "boolean") out[key] = v[key] as boolean;
    return out;
  });
  pick("incrementalUpdates", "incrementalUpdates", (v) => count(v));
  pick("tagged", "tagged", bool);
  pick("markedContent", "markedContent", bool);
  pick("lang", "lang", (v) => typeof v === "string" && v.length <= 64 && LANG.test(v) ? v : undefined);
  pick("outlineCount", "outlineCount", (v) => count(v));
  pick("pageLabels", "pageLabels", bool);
  pick("embeddedFiles", "embeddedFiles", (v) => count(v));
  pick("javascript", "javascript", bool);
  pick("openAction", "openAction", bool);
  pick("launchAction", "launchAction", bool);
  pick("truncated", "truncated", (v) => vocabulary(DOC_TRUNCATED, v, DOC_TRUNCATED.length));
  pick("acroForm", "acroForm", (v) => oneOf(["none", "present"] as const, v));
  pick("needAppearances", "needAppearances", bool);
  pick("xfa", "xfa", (v) => oneOf(["none", "static", "dynamic"] as const, v));
  pick("ocgCount", "ocgCount", (v) => count(v));
  pick("ocgOffByDefault", "ocgOffByDefault", (v) => count(v));
  return out;
}

/** Validate the run line (or a stored run summary). Null when its required fields do not validate. */
export function validateDopplerRun(value: unknown): DopplerRunFacts | null {
  return family<DopplerRunFacts>(value, {
    pagesEmitted: count, pagesFailed: count,
    version: (v) => typeof v === "string" && BUILD.test(v) ? v : undefined,
    commit: (v) => typeof v === "string" && BUILD.test(v) ? v : undefined,
  }, {
    stop: (v) => oneOf(["max-pages"] as const, v),
    totalMs: (v) => nonNegative(v, 86_400_000),
    peakRssKiB: (v) => count(v),
  }) ?? null;
}

// ── Lines ──

/** A line's bytes are printable ASCII only (the contract escapes everything else; `\r` before `\n` is tolerated). */
function asciiLine(bytes: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const b = bytes[i]!;
    if (b < 0x20 || b > 0x7e) return false;
  }
  return true;
}

function parseLine(line: string): Obj | null {
  try {
    const value: unknown = JSON.parse(line);
    return isObj(value) && value.schema === DOPPLER_PAGE_FACTS_SCHEMA && typeof value.type === "string" ? value : null;
  } catch {
    // Malformed JSON, or nesting deep enough to exhaust the parser's stack: the line is unknown.
    return null;
  }
}

/**
 * Parse a facts stream. `pageCount` is the host's own count (pdfpagecount): pages beyond it are dropped, and it sizes the
 * byte budget. Accepts the bytes (`Uint8Array`) or a string of the same ASCII text; anything else is refused.
 */
export function parseDopplerPageFacts(input: unknown, options: { pageCount: number }): DopplerPageFactsParse {
  const { pageCount } = options;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > DOPPLER_PAGE_FACTS_MAX_PAGES) return { ok: false, reason: "page-count" };
  const budget = dopplerPageFactsByteBudget(pageCount);
  let bytes: Uint8Array;
  if (typeof input === "string") {
    // A string longer than the budget in UTF-16 units is over it in bytes too; non-ASCII lines are refused below.
    if (input.length > budget) return { ok: false, reason: "oversized" };
    // UTF-8, so a character above U+007E stays non-ASCII bytes the line check refuses (latin1 would keep its low byte only).
    bytes = Buffer.from(input, "utf8");
    if (bytes.byteLength > budget) return { ok: false, reason: "oversized" };
  } else if (input instanceof Uint8Array) {
    if (input.byteLength > budget) return { ok: false, reason: "oversized" };
    bytes = input;
  } else {
    return { ok: false, reason: "unsupported-input" };
  }

  const maxLines = pageCount + 2 + LINE_SLACK;
  const pages = new Map<number, DopplerPageFacts>();
  const duplicates = new Set<number>();
  let doc: DopplerDocFacts | null = null;
  let run: DopplerRunFacts | null = null;
  let afterRun = false;
  let lastPage = 0;
  let linesDropped = 0;
  let lines = 0;
  const decoder = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(0x0a, start);
    // An unterminated last line may have been cut short (the contract says to drop it).
    if (newline === -1) { if (doc) linesDropped++; else return { ok: false, reason: "header" }; break; }
    const end = newline > start && bytes[newline - 1] === 0x0d ? newline - 1 : newline;
    const lineStart = start;
    start = newline + 1;
    if (end === lineStart) continue;
    if (++lines > maxLines) return { ok: false, reason: "too-many-lines" };
    const usable = end - lineStart <= DOPPLER_PAGE_FACTS_MAX_LINE_BYTES && asciiLine(bytes, lineStart, end);
    const value = usable ? parseLine(decoder.toString("latin1", lineStart, end)) : null;

    if (!doc) {
      // The header decides whether anything here is facts: a broken doc line refuses the whole stream.
      if (!value || value.type !== "doc") return { ok: false, reason: "header" };
      doc = validateDopplerDoc(value);
      if (!doc) return { ok: false, reason: "header" };
      continue;
    }
    if (!value || afterRun) { linesDropped++; continue; }
    if (value.type === "run") {
      run = validateDopplerRun(value);
      afterRun = true;
      if (!run) linesDropped++;
      continue;
    }
    if (value.type !== "page") { linesDropped++; continue; }
    const page = validateDopplerPage(value, pageCount);
    // Pages come in ascending order; a repeated or out-of-order page makes that page unknown rather than picking one.
    const number = count(value.page);
    if (number !== undefined && number <= lastPage) {
      linesDropped++;
      if (pages.delete(number) || number === lastPage) duplicates.add(number);
      continue;
    }
    if (!page) { linesDropped++; if (number !== undefined && number <= pageCount) lastPage = number; continue; }
    lastPage = page.page;
    pages.set(page.page, page);
  }
  if (!doc) return { ok: false, reason: "header" };
  for (const number of duplicates) pages.delete(number);
  // A locked or unreadable document has no page facts, whatever followed its doc line.
  if (doc.locked || doc.error) pages.clear();
  let failed = 0;
  for (const page of pages.values()) if (page.failed) failed++;
  return {
    ok: true,
    facts: { doc, pages, run, summary: { pageCount, pagesKnown: pages.size, pagesFailed: failed, linesDropped, complete: run !== null } },
  };
}

// ── Stored artifact ──

export const DOPPLER_PAGE_FACTS_ARTIFACT_VERSION = "doppler-page-facts-artifact@1";
/** The document artifact slot (DocumentArtifactLedger) holding the stored facts. */
export const DOPPLER_PAGE_FACTS_ARTIFACT = "doppler-page-facts";

export interface DopplerPageFactsArtifact {
  version: typeof DOPPLER_PAGE_FACTS_ARTIFACT_VERSION;
  schema: typeof DOPPLER_PAGE_FACTS_SCHEMA;
  documentId: string;
  source: "vm-pdf";
  summary: DopplerPageFactsSummary;
  doc: DopplerDocFacts;
  run: DopplerRunFacts | null;
  pages: DopplerPageFacts[];
}

/** The artifact extract-markdown stores: the validated facts only (no document strings), pages ascending. */
export function dopplerPageFactsArtifact(documentId: string, facts: DopplerPageFactsDocument): DopplerPageFactsArtifact {
  return {
    version: DOPPLER_PAGE_FACTS_ARTIFACT_VERSION, schema: DOPPLER_PAGE_FACTS_SCHEMA, documentId, source: "vm-pdf",
    summary: facts.summary, doc: facts.doc, run: facts.run,
    pages: [...facts.pages.values()].sort((a, b) => a.page - b.page),
  };
}

/**
 * Read a stored artifact back, validating it again with the same checks as the wire (storage is not a trust boundary we
 * rely on). Null when it is not one, or names another document.
 */
export function readDopplerPageFactsArtifact(payload: unknown, expected: { documentId: string; pageCount: number }): DopplerPageFactsDocument | null {
  if (!isObj(payload) || payload.version !== DOPPLER_PAGE_FACTS_ARTIFACT_VERSION || payload.documentId !== expected.documentId) return null;
  const { pageCount } = expected;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > DOPPLER_PAGE_FACTS_MAX_PAGES) return null;
  const doc = validateDopplerDoc(payload.doc);
  if (!doc || !Array.isArray(payload.pages) || payload.pages.length > pageCount) return null;
  const pages = new Map<number, DopplerPageFacts>();
  for (const entry of payload.pages) {
    const page = validateDopplerPage(entry, pageCount);
    if (page && !pages.has(page.page)) pages.set(page.page, page);
  }
  const run = payload.run === null ? null : validateDopplerRun(payload.run);
  const summary = isObj(payload.summary) ? payload.summary : {};
  let failed = 0;
  for (const page of pages.values()) if (page.failed) failed++;
  return {
    doc, pages, run,
    summary: { pageCount, pagesKnown: pages.size, pagesFailed: failed, linesDropped: count(summary.linesDropped) ?? 0, complete: run !== null },
  };
}

// ── Mode ──

export const DOPPLER_PAGE_FACTS_ENV = "DOCSLURP_DOPPLER_PAGE_FACTS";
export type DopplerPageFactsMode = "off" | "store" | "use";

/**
 * `off`: facts a provider returns are dropped unread. `store` (default): parsed and stored as a document artifact only.
 * `use`: also stand in for layout facts when the provider returned none. An unknown value is `off`, said loudly: a typo
 * must not widen what untrusted facts can decide.
 */
export function dopplerPageFactsMode(env: NodeJS.ProcessEnv = process.env): DopplerPageFactsMode {
  const raw = env[DOPPLER_PAGE_FACTS_ENV]?.trim().toLowerCase();
  if (!raw) return "store";
  if (raw === "off" || raw === "store" || raw === "use") return raw;
  console.error(`[doppler-page-facts] ${DOPPLER_PAGE_FACTS_ENV}=${JSON.stringify(raw.slice(0, 32))} is not off|store|use; page facts are off`);
  return "off";
}

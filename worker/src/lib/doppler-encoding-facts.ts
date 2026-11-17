/**
 * Doppler's math and table encoding facts (`doppler-page-facts/1`, family `mathtables`): the packed router words a page
 * line carries (`mathBits`, `tableBits`, `encodingCounts`), their bit layout, and what each encoding means for routing.
 * The contract is Doppler's `docslurp/page-facts/README.md` ("Math and table encodings") and its JSON Schema; the names
 * below are Doppler's own, in bit order. Doppler only appends names (the order is an API), so a bit this build does not
 * name is an encoding it cannot route: the page's encodings are unknown, never "no math" or "no table".
 *
 * Pure: no I/O. The words were validated by lib/doppler-page-facts.ts (bounded integers, consistent with their own
 * names and counts); here they are only decoded and interpreted.
 */
import type { DopplerPageFacts } from "./doppler-page-facts.js";

/** `mathBits` names (`mathFlags`), bit i = 1 << i. Order is Doppler's API: names are appended, never moved. */
export const DOPPLER_MATH_FLAGS = [
  "text-math", "stacked-math", "actualtext-tex", "alt-tex", "mathml", "raster-strips", "glyph-outlines", "type3-bitmap-font",
  "math-font-no-unicode", "plain-unicode-math", "formula-struct", "math-matrix", "analysis-truncated",
] as const;
/** `tableBits` names (`tableFlags`), bit i = 1 << i. */
export const DOPPLER_TABLE_FLAGS = [
  "rule-grid", "hrule-open", "booktabs", "whitespace", "shaded-rows", "tagged-table", "raster-table-like", "outlined-text-grid",
  "math-grid", "analysis-truncated",
] as const;
/**
 * `encodingCounts` nibbles: 13 four-bit log2 buckets (0 for 0, else floor(log2 n) + 1, at most 15), nibble i at bits
 * 4i..4i+3. Names are ours (Doppler documents the nibbles by position); the positions are Doppler's.
 */
export const DOPPLER_ENCODING_COUNTS = [
  "mathFontChars", // math-font characters with a Unicode value
  "plainUnicodeMath", // text.unicodeMath characters drawn by text fonts
  "unreadableMathGlyphs", // math-class unmapped or private use, plus Type 3 bitmap glyphs
  "mathStrips", // images.mathStrips
  "glyphOutlineClusters", // vectors.glyphOutlineClusters
  "formulas", // structure.formulas
  "texSources", // altTextTexLike + actualTextTexLike
  "mathml", // structure.mathml + mathmlFiles
  "ruledGrids", // tableLayout.ruledGrids
  "ruleTables", // vectors.ruleTables (before the 64 cap)
  "whitespaceTables",
  "structureTables", // structure.tables
  "mathRegions", // before the 64 cap
] as const;

export type DopplerMathFlag = (typeof DOPPLER_MATH_FLAGS)[number];
export type DopplerTableFlag = (typeof DOPPLER_TABLE_FLAGS)[number];
export type DopplerEncodingCount = (typeof DOPPLER_ENCODING_COUNTS)[number];

/** Largest values on the wire: 32-bit words and a 52-bit count word (exact in a double). */
export const DOPPLER_FLAG_WORD_MAX = 0xffff_ffff;
export const DOPPLER_ENCODING_COUNTS_MAX = 2 ** 52 - 1;

/** The bit of `name` in its word. */
export function dopplerFlagBit<T extends string>(names: readonly T[], name: T): number {
  const index = names.indexOf(name);
  if (index < 0) throw new Error(`unknown Doppler flag ${name}`);
  return 2 ** index;
}

/** A word's names in bit order, and the bits this build does not name (from a newer Doppler: unknown encodings). */
export function decodeDopplerFlags<T extends string>(word: number, names: readonly T[]): { flags: T[]; unknownBits: number } {
  // Not a word (non-finite, fractional, negative or past 32 bits): nothing this build can name. The reader never passes
  // one; a caller that does gets "unknown" (unknownBits non-zero), never an empty word.
  if (!Number.isSafeInteger(word) || word < 0 || word > DOPPLER_FLAG_WORD_MAX) return { flags: [], unknownBits: Number.POSITIVE_INFINITY };
  const flags: T[] = [];
  let unknownBits = 0;
  // Arithmetic, not `>>`: a 32-bit word's top bit would read negative through JavaScript's signed shifts.
  for (let bit = 0, rest = word; rest > 0; bit += 1, rest = Math.floor(rest / 2)) {
    if (rest % 2 === 0) continue;
    if (bit < names.length) flags.push(names[bit]!);
    else unknownBits += 2 ** bit;
  }
  return { flags, unknownBits };
}

/** One log2 bucket: 0 is a count of 0; bucket b (1..15) is a count in [2^(b-1), 2^b - 1] (15: 2^14 or more). */
export interface DopplerCountBucket { bucket: number; min: number; max: number | null }

export function dopplerCountBucket(bucket: number): DopplerCountBucket {
  if (bucket === 0) return { bucket, min: 0, max: 0 };
  return { bucket, min: 2 ** (bucket - 1), max: bucket >= 15 ? null : 2 ** bucket - 1 };
}

/** The 13 nibbles of `encodingCounts`, by name. Throws on a value outside 0..2^52-1 (the parser never passes one). */
export function decodeDopplerEncodingCounts(packed: number): Record<DopplerEncodingCount, DopplerCountBucket> {
  if (!Number.isSafeInteger(packed) || packed < 0 || packed > DOPPLER_ENCODING_COUNTS_MAX) throw new Error("encodingCounts out of range");
  const out = {} as Record<DopplerEncodingCount, DopplerCountBucket>;
  let rest = packed;
  for (const name of DOPPLER_ENCODING_COUNTS) {
    out[name] = dopplerCountBucket(rest % 16);
    rest = Math.floor(rest / 16);
  }
  return out;
}

/** The nibble of one count (0 for 0, else floor(log2 n) + 1, at most 15). */
export function dopplerEncodingNibble(packed: number, name: DopplerEncodingCount): number {
  return Math.floor(packed / 16 ** DOPPLER_ENCODING_COUNTS.indexOf(name)) % 16;
}

// ── Routing meaning (Doppler's README "route" column; tables matter more than math to our users) ──

/** Table encodings the text layer holds (Doppler reads them as text): the page takes the text-layer table route. */
export const TEXT_LAYER_TABLE_FLAGS: readonly DopplerTableFlag[] = ["rule-grid", "hrule-open", "booktabs", "whitespace", "shaded-rows", "tagged-table"];
/** A table drawn as glyph outlines: no text layer holds it, so only a read of the page recovers it. */
export const VISION_TABLE_FLAGS: readonly DopplerTableFlag[] = ["outlined-text-grid"];
/**
 * A lossless line-art image shaped like a table: a vision candidate only. The shape is a heuristic over drawing geometry
 * (image data is never decoded), so charts, logos and diagrams match too; it never authorizes a read on its own.
 */
export const RASTER_TABLE_FLAGS: readonly DopplerTableFlag[] = ["raster-table-like"];
/** Math only a read of the page recovers (images, outlines, bitmap fonts). */
export const VISION_MATH_FLAGS: readonly DopplerMathFlag[] = ["raster-strips", "glyph-outlines", "type3-bitmap-font"];
/**
 * The fewest unreadable math glyphs (encodingCounts nibble `unreadableMathGlyphs`) for `math-font-no-unicode` to need a
 * read: bucket 5 is 16 or more glyphs. A few unmapped delimiter or radical pieces (pdflatex's big operators commonly lack a
 * Unicode value) are not a formula the text layer lost.
 */
export const UNMAPPED_MATH_READ_MIN_BUCKET = 5;

/**
 * Math glyphs without a Unicode value: the text layer cannot read them, but Doppler's math reader (`pdftomarkdown --math`)
 * reads them from glyph names and lists what it cannot read in its report. Vision only when the run did not read math, the
 * page carries no TeX or MathML source, and at least UNMAPPED_MATH_READ_MIN_BUCKET's worth of glyphs are unreadable.
 */
export const UNMAPPED_MATH_FLAGS: readonly DopplerMathFlag[] = ["math-font-no-unicode"];
/**
 * The page carries the formula's source (TeX in ActualText or Alt, MathML): copy it, keep the text layer. Current Doppler
 * sets only `actualtext-tex`; `alt-tex` and `mathml` (like `formula-struct` and `tagged-table`) are reserved and never set,
 * and are read here as positive-only signals.
 */
export const SOURCE_MATH_FLAGS: readonly DopplerMathFlag[] = ["actualtext-tex", "alt-tex", "mathml"];
/** Math the text layer holds as text. */
export const TEXT_MATH_FLAGS: readonly DopplerMathFlag[] = ["text-math", "stacked-math", "plain-unicode-math", "formula-struct", "math-matrix"];

export type EncodingTableRoute = "none" | "text-layer" | "vision";
export type EncodingMathRoute = "none" | "text" | "source" | "vision";

/**
 * What a page's encodings say, when they are known (complete and named by this build). Stored with the page's layout facts
 * (lib/page-layout-facts.ts), so it holds closed vocabularies only.
 */
export interface PageEncodingRoute {
  /** `text-layer`: a table the text layer holds; `vision`: a table drawn as outlines; `none`: no table encoding at all. */
  table: EncodingTableRoute;
  /** A raster image shaped like a table (a candidate for a read, never one on its own). */
  rasterTableCandidate: boolean;
  /** A grid of math glyphs (a matrix): never a table, whatever its rules say. */
  mathGrid: boolean;
  /** `vision`: math only a read recovers; `source`: the page carries TeX or MathML; `text`: the text layer holds it. */
  math: EncodingMathRoute;
  /** The run read math (`--math`): unmapped math glyphs were the math reader's to read. */
  mathRead: boolean;
  /** encodingCounts' `unreadableMathGlyphs` log2 bucket (0..15): orders capped reads, gates `math-font-no-unicode`. */
  unreadableMathGlyphs: number;
  /** The page's flags in bit order (for signals and the ingest report). */
  mathFlags: DopplerMathFlag[];
  tableFlags: DopplerTableFlag[];
}

export type PageEncodingUnknown = "absent" | "failed" | "low-confidence" | "xref-repaired" | "drawing-limit" | "truncated" | "unknown-bits";

export type PageEncodingVerdict = { status: "known"; route: PageEncodingRoute } | { status: "unknown"; reason: PageEncodingUnknown };

/**
 * The page's encoding route. Unknown (the caller keeps today's routing) when the words are absent (an older build, or
 * `mathtables` not asked for), the page failed or is low confidence (`xref-repaired-earlier`), either word sets
 * `analysis-truncated` (a cap was hit: the bits may be incomplete, so no bit's absence is evidence), or a word holds a bit
 * this build does not name.
 *
 * `mathRead`: the run read math (`pdftomarkdown --math`), whose reader handles glyphs without Unicode and reports what it
 * could not read; unmapped math glyphs alone then do not need a read.
 */
export function pageEncodingRoute(page: DopplerPageFacts, options: { mathRead?: boolean } = {}): PageEncodingVerdict {
  if (page.failed) return { status: "unknown", reason: "failed" };
  if (page.mathBits === undefined || page.tableBits === undefined || page.encodingCounts === undefined) return { status: "unknown", reason: "absent" };
  if (page.parseWarnings.includes("xref-repaired-earlier")) return { status: "unknown", reason: "low-confidence" };
  // As gridFacts (lib/doppler-page-facts-layout.ts): a rebuilt cross-reference table or a drawing cap leaves the page's
  // drawing (so its rules, outlines and table shapes) incomplete.
  if (page.parseWarnings.includes("xref-repaired")) return { status: "unknown", reason: "xref-repaired" };
  if (page.vectors?.limitHit || page.parseWarnings.includes("limit-hit") || page.unusualFeatures.includes("drawing-limit")) {
    return { status: "unknown", reason: "drawing-limit" };
  }
  const math = decodeDopplerFlags(page.mathBits, DOPPLER_MATH_FLAGS);
  const table = decodeDopplerFlags(page.tableBits, DOPPLER_TABLE_FLAGS);
  if (math.unknownBits !== 0 || table.unknownBits !== 0) return { status: "unknown", reason: "unknown-bits" };
  if (math.flags.includes("analysis-truncated") || table.flags.includes("analysis-truncated")) return { status: "unknown", reason: "truncated" };
  return { status: "known", route: encodingRouteFromFlags(math.flags, table.flags, options.mathRead === true, dopplerEncodingNibble(page.encodingCounts, "unreadableMathGlyphs")) };
}

/** The route the flags name (pageEncodingRoute's rules; the flags are complete and not truncated). */
export function encodingRouteFromFlags(mathFlags: readonly DopplerMathFlag[], tableFlags: readonly DopplerTableFlag[], mathRead: boolean, unreadableMathGlyphs = 0): PageEncodingRoute {
  const hasTable = (set: readonly DopplerTableFlag[]) => tableFlags.some((flag) => set.includes(flag));
  const hasMath = (set: readonly DopplerMathFlag[]) => mathFlags.some((flag) => set.includes(flag));
  const table: EncodingTableRoute = hasTable(TEXT_LAYER_TABLE_FLAGS) ? "text-layer" : hasTable(VISION_TABLE_FLAGS) ? "vision" : "none";
  const source = hasMath(SOURCE_MATH_FLAGS);
  const unmappedNeedsRead = hasMath(UNMAPPED_MATH_FLAGS) && !source && !mathRead && unreadableMathGlyphs >= UNMAPPED_MATH_READ_MIN_BUCKET;
  const math: EncodingMathRoute = hasMath(VISION_MATH_FLAGS) || unmappedNeedsRead ? "vision"
    : source ? "source"
      : hasMath(TEXT_MATH_FLAGS) || hasMath(UNMAPPED_MATH_FLAGS) ? "text"
        : "none";
  return {
    table,
    rasterTableCandidate: hasTable(RASTER_TABLE_FLAGS),
    mathGrid: tableFlags.includes("math-grid"),
    math,
    mathRead,
    unreadableMathGlyphs,
    mathFlags: DOPPLER_MATH_FLAGS.filter((flag) => mathFlags.includes(flag)),
    tableFlags: DOPPLER_TABLE_FLAGS.filter((flag) => tableFlags.includes(flag)),
  };
}

/** The flags behind a route, for a signal: `vision` math names the flags that need a read. */
export function encodingMathVisionFlags(route: PageEncodingRoute): DopplerMathFlag[] {
  return route.mathFlags.filter((flag) => VISION_MATH_FLAGS.includes(flag) ||
    (UNMAPPED_MATH_FLAGS.includes(flag) && !route.mathRead && route.unreadableMathGlyphs >= UNMAPPED_MATH_READ_MIN_BUCKET));
}

/**
 * Parse a stored PageEncodingRoute (page-layout-facts JSON). Only the flags, `mathRead` and the unreadable-glyph bucket are read, as closed
 * vocabularies; the route is derived from them again (encodingRouteFromFlags), so a stored route can never say more than
 * its flags. A truncated flag, or anything malformed, is unknown.
 */
export function parsePageEncodingRoute(value: unknown): PageEncodingRoute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.mathRead !== "boolean") return undefined;
  const unreadable = v.unreadableMathGlyphs;
  if (typeof unreadable !== "number" || !Number.isSafeInteger(unreadable) || unreadable < 0 || unreadable > 15) return undefined;
  const names = <T extends string>(list: unknown, vocabulary: readonly T[]): T[] | undefined =>
    Array.isArray(list) && list.length <= vocabulary.length && list.every((item) => (vocabulary as readonly unknown[]).includes(item))
      ? list as T[] : undefined;
  const mathFlags = names(v.mathFlags, DOPPLER_MATH_FLAGS);
  const tableFlags = names(v.tableFlags, DOPPLER_TABLE_FLAGS);
  if (!mathFlags || !tableFlags || mathFlags.includes("analysis-truncated") || tableFlags.includes("analysis-truncated")) return undefined;
  return encodingRouteFromFlags(mathFlags, tableFlags, v.mathRead, unreadable);
}

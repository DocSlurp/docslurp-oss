/**
 * Engine-neutral contract for the `native-pdf` document extractor.
 *
 * DocSlurp code depends only on `NativePdfEngine`. Implementations:
 * - `binding-engine.ts` wraps the private in-process Node binding (frozen v1 interface).
 * - `poppler-engine.ts` serves the text/markdown subset with poppler-utils so a
 *   page is never left without Markdown when the binding is absent or fails.
 *
 * Every method is async so subprocess-backed engines fit the same shape. Methods
 * an engine cannot serve reject with `NativePdfError` code
 * `NATIVE_PDF_UNSUPPORTED`; callers treat that as "fall back", never as a hard
 * failure. Coordinates are PDF points with a top-left origin.
 */

export type Bbox = [number, number, number, number];
export type TableStrategy = "lines" | "text" | "none";

export interface NativePdfEngineVersion {
  /** Neutral engine family, safe for public telemetry (e.g. "native-pdf", "poppler"). */
  engine: string;
  version: string;
  gitSha: string;
  features: string[];
}

export interface NativePdfMetadata {
  producer?: string;
  creator?: string;
  title?: string;
  encrypted: boolean;
  permissions?: string[];
}

export interface NativePdfSpan {
  text: string;
  bbox: Bbox;
  font: string;
  size: number;
  renderMode: number;
  invisible: boolean;
  /** Glyphs without a Unicode mapping. */
  unmapped: number;
}

export interface NativePdfImagePlacement {
  index: number;
  bbox: Bbox;
  widthPx: number;
  heightPx: number;
  effectiveDpi: number;
}

export interface NativePdfDrawingStats {
  lineCount: number;
  rectCount: number;
  longRuleCount: number;
  vectorArea: number;
}

export interface NativePdfLink {
  uri?: string;
  /** 0-based target page of an internal link. */
  destPage?: number;
  bbox: Bbox;
}

export interface NativePdfTable {
  bbox: Bbox;
  rows: string[][];
}

export interface NativePdfGlyphStats {
  glyphs: number;
  invisible: number;
  stroke: number;
  /** Glyphs without a Unicode mapping (span-level `unmapped` is not populated by every engine). */
  unmapped: number;
  fonts: number;
}

export interface NativePdfWord {
  text: string;
  bbox: Bbox;
}

/** A raw text run from the one-pass page scan; unlike `spans()` runs are never merged, so joining them is not text. */
export interface NativePdfScanRun extends NativePdfSpan {
  glyphs: number;
  /** Glyphs drawn over a page-sized image (an OCR text layer or text on a scan). */
  overImage: number;
  controlChars: number;
  type3: boolean;
}

export interface NativePdfScanStats {
  /** Every glyph drawn, mapped or not. */
  glyphs: number;
  /** Glyphs with a Unicode mapping (equals `glyphStats().glyphs`). */
  mapped: number;
  unmapped: number;
  invisible: number;
  stroke: number;
  type3: number;
  controlChars: number;
  overImage: number;
}

/** One content-stream pass: text runs, image placements (pixels not decoded) and glyph totals. */
export interface NativePdfPageScan {
  runs: NativePdfScanRun[];
  images: NativePdfImagePlacement[];
  stats: NativePdfScanStats;
}

export interface NativePdfRenderOptions {
  dpi?: number;
  maxEdgePx?: number;
  clip?: Bbox;
  format?: "png" | "jpeg" | "webp";
  gray?: boolean;
}

export interface NativePdfOcrFillOptions {
  /**
   * `fill`: OCR the page and add only words the text layer lacks. `adaptive`: OCR the whole page only when the
   * native text is nearly absent or unmapped, otherwise just the large raster regions.
   */
  policy?: "fill" | "adaptive";
  /** Recognition raster resolution (engine default 200). */
  dpi?: number;
}

export interface NativePdfOcrFill {
  /** Page text and Markdown including the recognised words. */
  text: string;
  markdown: string;
  /** OCR words added to the page's text layer. */
  filledRegions: number;
  /** OCR model id for internal ledgers (e.g. `pp-ocrv6-small-rten`). */
  engine: string;
  /** 1 when the whole page was OCR'd (the native layer was missing or unusable). */
  replacedPages: number;
}

export interface NativePdfPage {
  size(): Promise<{ widthPt: number; heightPt: number; rotation: 0 | 90 | 180 | 270 }>;
  text(): Promise<string>;
  markdown(opts?: { tableStrategy?: TableStrategy }): Promise<string>;
  spans(): Promise<NativePdfSpan[]>;
  /** Word boxes; unlike spans these are never merged across side-by-side columns. */
  words(): Promise<NativePdfWord[]>;
  images(): Promise<NativePdfImagePlacement[]>;
  drawings(): Promise<NativePdfDrawingStats>;
  glyphStats(): Promise<NativePdfGlyphStats>;
  /**
   * Runs, images and glyph totals in one content pass (about the cost of `spans()` alone, where spans + images +
   * glyphStats are three passes). Optional: engines without it are read through the separate methods.
   */
  scan?(): Promise<NativePdfPageScan>;
  links(): Promise<NativePdfLink[]>;
  tables(opts?: { strategy?: "lines" | "text" }): Promise<NativePdfTable[]>;
  render(opts: NativePdfRenderOptions): Promise<Buffer>;
  /**
   * OCR the page where its text layer is missing or unusable. The words join the open document's text layer, so
   * later text()/markdown() calls include them. Rejects NATIVE_PDF_UNSUPPORTED when the engine has no OCR models.
   */
  ocrFill(opts?: NativePdfOcrFillOptions): Promise<NativePdfOcrFill>;
}

export interface NativePdfDocument {
  pageCount(): Promise<number>;
  metadata(): Promise<NativePdfMetadata>;
  /** 0-based. */
  page(index: number): NativePdfPage;
  close(): Promise<void>;
}

export interface NativePdfEngine {
  /** Implementation id for internal logs ("binding", "poppler", "fake"). */
  readonly id: string;
  version(): NativePdfEngineVersion;
  openPath(path: string, opts?: { password?: string; signal?: AbortSignal }): Promise<NativePdfDocument>;
}

/**
 * Adapter failure codes. Every failure leaves the document to the next extractor (kreuzberg by default);
 * `NATIVE_PDF_FAILURE_KIND` says how loudly. `PDF_LOCKED` / `PDF_UNSUPPORTED_ENCRYPTION` / `PDF_LIMIT` are
 * engine-neutral PDF terms, the rest are adapter outcomes.
 */
export type NativePdfErrorCode =
  /** The engine cannot serve this method or input (e.g. OCR without models); fall back. */
  | "NATIVE_PDF_UNSUPPORTED"
  /** No engine installed in this process. */
  | "NATIVE_PDF_UNAVAILABLE"
  /** Output rejected by an adapter guard: too few pages with text, unrepaired columns, lost text layer. */
  | "NATIVE_PDF_EMPTY"
  | "NATIVE_PDF_LAYOUT"
  | "NATIVE_PDF_DROPOUT"
  /** Engine error on a damaged document, adapter misuse, abort, or an unknown engine code. */
  | "NATIVE_PDF_FAILED"
  /** A user password is required and was not supplied (or is wrong). Withholding it is normal. */
  | "PDF_LOCKED"
  /** Unknown security handler or unsupported /V or /R. Not a password problem: never prompt for one. */
  | "PDF_UNSUPPORTED_ENCRYPTION"
  /** The document exceeds the engine's resource limits (`limit` names which). */
  | "PDF_LIMIT";

/**
 * - `locked`: a document state, not an error. The locked-PDF path (kreuzberg / the probe's locked row) reports it.
 * - `expected`: a routine reason to fall back; logged at info.
 * - `unexpected`: falls back too, but warns: an engine defect, a damaged file or an adapter bug worth looking at.
 */
export type NativePdfFailureKind = "locked" | "expected" | "unexpected";

export const NATIVE_PDF_FAILURE_KIND: Record<NativePdfErrorCode, NativePdfFailureKind> = {
  PDF_LOCKED: "locked",
  PDF_UNSUPPORTED_ENCRYPTION: "expected",
  PDF_LIMIT: "expected",
  NATIVE_PDF_UNSUPPORTED: "expected",
  NATIVE_PDF_UNAVAILABLE: "expected",
  NATIVE_PDF_EMPTY: "expected",
  NATIVE_PDF_LAYOUT: "expected",
  // The dropout guard is a safety net for an engine regression: worth a warning when it fires.
  NATIVE_PDF_DROPOUT: "unexpected",
  NATIVE_PDF_FAILED: "unexpected",
};

/**
 * Every error code the binding documents (binding 0.13.0 error `code`), mapped to an adapter code.
 * Anything else (no code, or a code added upstream later) becomes NATIVE_PDF_FAILED and keeps `engineCode`.
 */
export const ENGINE_ERROR_CODES: Readonly<Record<string, NativePdfErrorCode>> = {
  NATIVE_PDF_UNSUPPORTED: "NATIVE_PDF_UNSUPPORTED",
  PDF_LOCKED: "PDF_LOCKED",
  PDF_UNSUPPORTED_ENCRYPTION: "PDF_UNSUPPORTED_ENCRYPTION",
  PDF_LIMIT: "PDF_LIMIT",
  /** Damaged or unparseable document. */
  PDF_ERROR: "NATIVE_PDF_FAILED",
  /** Adapter bugs: a call after close(), or an option the engine rejects. */
  PDF_CLOSED: "NATIVE_PDF_FAILED",
  INVALID_ARGUMENT: "NATIVE_PDF_FAILED",
};

export class NativePdfError extends Error {
  /** The engine's own code when this wraps an engine error (internal logs only). */
  readonly engineCode?: string;
  /** For PDF_LIMIT: which limit tripped (e.g. `total_decompressed_size`). */
  readonly limit?: string;

  constructor(
    readonly code: NativePdfErrorCode,
    message: string,
    options?: { cause?: unknown; engineCode?: string; limit?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "NativePdfError";
    if (options?.engineCode) this.engineCode = options.engineCode;
    if (options?.limit) this.limit = options.limit;
  }

  get kind(): NativePdfFailureKind {
    return NATIVE_PDF_FAILURE_KIND[this.code];
  }
}

export function unsupported(method: string, engine: string): NativePdfError {
  return new NativePdfError("NATIVE_PDF_UNSUPPORTED", `${engine} does not support ${method}`);
}

/** Normalise anything an engine throws (binding `EngineError`s, NotImplementedError, plain errors) to NativePdfError. */
export function toNativePdfError(error: unknown): NativePdfError {
  if (error instanceof NativePdfError) return error;
  const raw = error as { code?: unknown; limit?: unknown; name?: unknown } | null;
  const message = error instanceof Error ? error.message : String(error);
  const engineCode = typeof raw?.code === "string" ? raw.code : raw?.name === "NotImplementedError" ? "NATIVE_PDF_UNSUPPORTED" : "unknown";
  const code = ENGINE_ERROR_CODES[engineCode] ?? "NATIVE_PDF_FAILED";
  const limit = typeof raw?.limit === "string" ? raw.limit : undefined;
  return new NativePdfError(code, message, { cause: error, engineCode, limit });
}

export function isUnsupported(error: unknown): boolean {
  return toNativePdfError(error).code === "NATIVE_PDF_UNSUPPORTED";
}

/** One log line per fallback: info for routine reasons, a warning for unexpected ones. Returns the normalised error. */
export function logNativePdfFallback(context: string, error: unknown, next = "kreuzberg"): NativePdfError {
  const failure = toNativePdfError(error);
  const detail = [
    `code=${failure.code}`,
    failure.engineCode && failure.engineCode !== failure.code ? `engineCode=${failure.engineCode}` : "",
    failure.limit ? `limit=${failure.limit}` : "",
    `kind=${failure.kind}`,
    `next=${next}`,
  ].filter(Boolean).join(" ");
  const line = `[native-pdf] ${context} fell back ${detail} reason=${failure.message.split("\n")[0]!.slice(0, 200)}`;
  if (failure.kind === "unexpected") console.warn(line);
  else console.error(line);
  return failure;
}

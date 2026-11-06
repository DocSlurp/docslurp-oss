/** What the profiler measured about one file: neutral, aggregate facts only (`fileProfileSchema` in `@docslurp/shared`). */
export type FileProfile = {
  schema: 1;
  profiler: string;
  kind: "pdf" | "image" | "office" | "ebook" | "text" | "audio" | "video" | "unknown";
  format: string;
  /** Sniffed MIME type, only when the file's name and declared type say nothing. */
  mimeType?: string;
  bytes: number;
  /** Pages, slides, sheets or image frames, when counted. */
  pages?: number;
  encrypted?: boolean;
  durationSeconds?: number;
  /** Characters of a text file read whole (text volume). */
  textChars?: number;
  /** Facts over up to 24 sampled pages of a PDF. */
  pdf?: {
    sampledPages: number;
    textLayerPages: number;
    /** Sampled pages with 0, 1-10, 11-29, 30-199, 200-499 and 500+ native words. */
    wordsPerPage: [number, number, number, number, number, number];
    lowTextPages: number;
    blankPages: number;
    /** Pages the page raster rule finds held by a full-page image. */
    rasterPages: number;
    imagePages: number;
    images: number;
    /** Sampled pages with image coverage 0, under 15%, 15-50%, 50-90% and 90%+. */
    imageCoverage: [number, number, number, number, number];
    furnitureImages: number;
    layoutHeavyPages: number;
    vectorHeavyPages: number;
    unmappedFontPages: number;
    drawnContent: boolean;
    budgetExhausted: boolean;
    /** Native words on the sampled pages in total. */
    sampledWords: number;
    /** Median and largest visible page area, in square inches. */
    medianPageAreaSqIn: number;
    maxPageAreaSqIn: number;
    /** Glyphs shown on the sampled pages, and text lines started. */
    sampledChars: number;
    sampledTextLines: number;
    /** Glyphs per effective font size: under 1 pt, 1-4, 4-6, 6-20, 20 pt and up. */
    charsByFontSize: [number, number, number, number, number];
    /** Glyphs drawn invisibly (rendering modes 3 and 7), and glyphs placed outside the visible box. */
    invisibleChars: number;
    offCropChars: number;
    /** Page equivalents of the sampled pages (the billing measurement's rule): text, area, each page's larger, the largest. */
    sampledTextEquivalents: number;
    sampledAreaEquivalents: number;
    sampledPageEquivalents: number;
    maxPageEquivalents: number;
    /** Sampled pages per text equivalents (1, 2, 3, 4-8, 9-16, 17-64, 65+) and per area equivalents (1 to 8). */
    textEquivalentsPerPage: [number, number, number, number, number, number, number];
    areaEquivalentsPerPage: [number, number, number, number, number, number, number, number];
    /** Sampled pages over 3 text equivalents. */
    densePages: number;
    /** Median and largest visible (CropBox) page width and height, in points. */
    medianPageWidthPt: number;
    medianPageHeightPt: number;
    maxPageWidthPt: number;
    maxPageHeightPt: number;
    /** Glyphs extraction drops, so not counted: outside the MediaBox, and tiny glyphs over the per-page limit. */
    offPageChars: number;
    tinyCharsDropped: number;
    /** Sampled pages whose text was estimated from content size (read only in part). */
    textEstimatedPages: number;
    /** Sampled pages per page equivalents (larger of text and area): 1, 2, 3, 4-8, 9-16, 17-64, 65+. */
    pageEquivalentsPerPage: [number, number, number, number, number, number, number];
    /** Page equivalents summed over the pages holding more than 3. */
    densePageEquivalents: number;
    /** Significant images per placed resolution: under 100, 100-200, 200-300, 300+ ppi. */
    imagePpi: [number, number, number, number];
    /** Significant images per stream bytes per pixel: under 0.05, 0.05-0.2, 0.2-0.5, 0.5-1, 1+. */
    imageBytesPerPixel: [number, number, number, number, number];
    /** Glyphs drawn inside a significant image's box, and pages with 20 or more. */
    glyphsOverImages: number;
    textOverImagePages: number;
    /** Pages with native text that also place a scan-like image the page router reads (over a fifth of the page, readable, almost no words inside). */
    scanBesideTextPages: number;
    /** Pages where that rule could not be decided: words on the page or inside a candidate image unknown. Never read. */
    scanBesideTextUnknownPages: number;
    /** Pages table-heavy from their ruled grids alone (a grid of 5+ rows, or grids covering 40% of the page). */
    ruledTablePages: number;
  };
  /** Package structure: slide and worksheet parts, body bytes; `declaredPages` is authored metadata, informational only. */
  office?: { embeddedImages: number; slides?: number; sheets?: number; bodyBytes: number; declaredPages?: number };
  notes?: string[];
};

/** A file as `POST /v1/uploads/estimate` takes it. */
export type EstimateRequestFile = { name: string; size: number; type?: string; profile?: FileProfile };

export type FileMeta = { name: string; type?: string; size: number };
export type ReadPlan = { head: number; tail: number };
export type EstimatorInfo = { profileSchema: number; profiler: string };

export type EstimatorErrorCode = "invalid_request" | "crashed" | "worker_failed" | "quote_failed";
export class EstimatorError extends Error {
  readonly code: EstimatorErrorCode;
  constructor(code: EstimatorErrorCode, message: string);
}

export type Estimator = {
  info(): EstimatorInfo;
  readPlan(file: FileMeta): ReadPlan;
  profile(file: FileMeta, head: Uint8Array, tail?: Uint8Array): FileProfile;
  profileBlob(blob: Blob, name?: string): Promise<FileProfile>;
  estimateFiles(files: ArrayLike<Blob & { name: string }> | Iterable<Blob & { name: string }>, options?: EstimateOptions): Promise<EstimateResult>;
  /** Calls into the module, traps (`crashed`) and fresh instances made after them. */
  health(): EstimatorHealth;
};

export type EstimatorHealth = { calls: number; crashes: number; resets: number };

export type EstimateOptions = {
  /** Stops work between files and between 1 MiB reads; the result is then partial. */
  signal?: AbortSignal;
  /** Called synchronously for every event, in order; an async consumer can use `estimateEvents` instead. */
  onProgress?: (event: EstimateEvent) => void;
  /** Files read at once (reads overlap the probe of the previous file). Default 2. */
  concurrency?: number;
  /** Files per batch. Default 16. */
  batchSize?: number;
  /** Cap on bytes read but not yet profiled; one larger file still runs alone. Default 128 MiB. */
  maxBufferedBytes?: number;
};

export type FileRef = { index: number; name: string };

export type FileEstimate = {
  index: number;
  name: string;
  size: number;
  type?: string;
  /** probed: profiled; failed: unreadable or the profiler stopped; skipped: cancelled before it finished. */
  status: "probed" | "failed" | "skipped";
  /** Why the file has no profile (sent with name, type and size only). */
  reason?: { code: string; message: string };
  profile: FileProfile | null;
  /** What to send for this file: with its profile, or name, type and size only. */
  requestFile: EstimateRequestFile;
  measured: boolean;
  bytesRead: number;
  plannedBytes: number;
  readMs: number;
  /** Wall time of the probe call; null when the probe never ran. */
  probeMs: number | null;
  elapsedMs: number;
};

export type EstimateStats = {
  elapsedMs: number;
  files: { total: number; probed: number; failed: number; skipped: number; unprofiled: number };
  /** `read` against `files` (the files' sizes): media and large files are read as head/tail slices only. */
  bytes: { read: number; planned: number; files: number; readShare: number };
  probeMs: { total: number; p50: number; p95: number; max: number };
  readMs: number;
  throughput: { filesPerSecond: number; megabytesPerSecond: number };
  pages: { found: number; files: number };
  durationSeconds: number;
  pdf: { files: number; sampledPages: number; rasterPages: number; textLayerPages: number };
  estimator: { crashes: number; resets: number };
  bounds: { concurrency: number; batchSize: number; maxBufferedBytes: number; peakInFlight: number; peakBufferedBytes: number };
};

export type EstimateResult = {
  files: FileEstimate[];
  /** The body for `POST /v1/uploads/estimate` (`requestQuote`). */
  request: { files: EstimateRequestFile[] };
  /** Null from a worker stopped mid-run. */
  stats: EstimateStats | null;
  /** Some files have no profile (failed, or skipped by cancellation). */
  partial: boolean;
  cancelled: boolean;
  unprofiledFiles: number;
};

type EventBase = {
  elapsedMs: number;
  files: { total: number; completed: number; probed: number; failed: number; skipped: number };
  /** `read` and `planned` cover the read plans (what the probe needs), `files` the files' full sizes. */
  bytes: { read: number; planned: number; files: number };
};

/**
 * Per file: file-start, read-progress*, probe-start, probe-done, file-done (a file that fails to read skips the probe
 * events). batch-done after each batch; done is always last. Files skipped by cancellation emit nothing.
 * Profiling is one opaque call: its events carry the stage and elapsed time, never a percentage.
 */
export type EstimateEvent = EventBase & (
  | { type: "file-start"; file: FileRef & { size: number; type?: string }; plan: ReadPlan | null; filePlannedBytes: number }
  | { type: "read-progress"; file: FileRef; fileBytesRead: number; filePlannedBytes: number }
  | { type: "probe-start"; file: FileRef; stage: "probe"; readMs: number }
  | { type: "probe-done"; file: FileRef; stage: "probe"; probeMs: number; ok: boolean }
  | { type: "file-done"; file: FileRef; result: FileEstimate }
  | { type: "batch-done"; batch: { index: number; start: number; end: number } }
  | { type: "done"; partial: boolean; cancelled: boolean; result?: EstimateResult }
);

export function estimateFiles(estimator: Estimator, files: ArrayLike<Blob & { name: string }> | Iterable<Blob & { name: string }>, options?: EstimateOptions): Promise<EstimateResult>;
export function estimateEvents(estimator: Estimator, files: ArrayLike<Blob & { name: string }> | Iterable<Blob & { name: string }>, options?: Omit<EstimateOptions, "onProgress"> & { highWaterMark?: number }): AsyncIterable<EstimateEvent>;
export function yieldToEventLoop(): Promise<void>;

export function createEstimator(options?: { module?: WebAssembly.Module | BufferSource | URL | string }): Promise<Estimator>;

/** `POST /v1/uploads/estimate`: the server's quote for profiled files (an estimate; never what an upload is charged). */
export function requestQuote(args: {
  files: EstimateRequestFile[];
  workspace?: string;
  speedBoost?: boolean;
  apiKey?: string;
  origin?: string | URL;
  fetch?: typeof fetch;
  init?: RequestInit;
}): Promise<unknown>;

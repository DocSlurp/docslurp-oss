export type PageMix = { text: number; complex: number; scanned: number };

export type EstimateProfile = {
  cardVersion: string;
  quality: "fast" | "auto" | "good";
  documentFeatures: { documentSummary: boolean; structuredFields: boolean; knowledgeGraph: boolean; propositions: boolean };
  videoFrames: boolean;
  workerSlots?: number;
  stageCount: number;
  billing: "enforced" | "disabled";
};

export type QuoteFile = {
  name: string;
  size: number;
  type?: string;
  pages?: number;
  durationSeconds?: number;
  mix?: PageMix;
  mixConfidence?: number;
};

export type QuoteRequest = { files: QuoteFile[]; profile?: EstimateProfile; speedBoost?: boolean };

export type Range = { low: number; high: number };

export type Quote = {
  card: { version: string; revision: string; source: "bundled" | "supplied" };
  estimate: { pages: number; pagesRange?: { low: number; high: number }; unmeasuredFiles?: number; documents: number; billing: "enforced" | "disabled"; credits: Range | null; seconds: Range | null; basis: string };
  media: null | {
    audioFiles: number; videoFiles: number; audioMinutes: number; videoMinutes: number;
    durationsAssumed: boolean; videoFrames: boolean; credits: Range;
    lighter: null | { kind: "video-audio-track-only"; credits: number; savedCredits: number; pipeline: { mediaVideo: { enabled: false } } };
  };
  /** e.g. `profile-card-mismatch`: the profile was built for another price card. */
  warnings: string[];
};

export type ProbeResult = {
  kind: "pdf" | "image" | "office" | "ebook" | "text" | "audio" | "video" | "unknown";
  format: string;
  mimeType?: string;
  pages?: number;
  mix?: PageMix;
  mixConfidence?: number;
  durationSeconds?: number;
  sampledPages?: number;
  notes?: string[];
};

export type FileMeta = { name: string; type?: string; size: number };
export type ReadPlan = { head: number; tail: number };
export type EstimateCard = { schema: number; rules: number; version: string; revision: string; [key: string]: unknown };

export type EstimatorErrorCode = "invalid_request" | "invalid_card" | "unsupported_rules" | "crashed" | "worker_failed";
export class EstimatorError extends Error {
  readonly code: EstimatorErrorCode;
  constructor(code: EstimatorErrorCode, message: string);
}

export type Estimator = {
  /** The neutral evidence and routing rules the probe classifies pages with (`profiler-rules.json`); never priced. */
  rules(): { schema: number; pageRasterRouting: Record<string, number>; pageTableRouting: Record<string, number>; revision: string };
  card(): EstimateCard;
  readPlan(file: FileMeta): ReadPlan;
  probe(file: FileMeta, head: Uint8Array, tail?: Uint8Array): ProbeResult;
  quote(request: QuoteRequest): Quote;
  probeBlob(blob: Blob, name?: string): Promise<ProbeResult>;
  quoteFiles(files: Array<Blob & { name: string }>, request?: Omit<QuoteRequest, "files">): Promise<Quote & { probes: Array<ProbeResult | null> }>;
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
  /** Files per batch; a provisional quote follows each batch (at most every `quoteIntervalMs`). Default 16. */
  batchSize?: number;
  /** Cap on bytes read but not yet probed; one larger file still runs alone. Default 128 MiB. */
  maxBufferedBytes?: number;
  /** Minimum time between provisional quotes on `batch-done`. Default 250 ms. */
  quoteIntervalMs?: number;
  profile?: EstimateProfile;
  speedBoost?: boolean;
};

export type FileRef = { index: number; name: string };

export type FileEstimate = {
  index: number;
  name: string;
  size: number;
  type?: string;
  /** probed: measured; failed: unreadable or the probe stopped; skipped: cancelled before it finished. */
  status: "probed" | "failed" | "skipped";
  /** Why the file is priced from name, type and size only. */
  reason?: { code: string; message: string };
  probe: ProbeResult | null;
  /** What the quote used for this file: measurements, or size only. */
  quoteFile: QuoteFile;
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
  files: { total: number; probed: number; failed: number; skipped: number; sizeOnly: number };
  /** `read` against `files` (the files' sizes): media and large files are read as head/tail slices only. */
  bytes: { read: number; planned: number; files: number; readShare: number };
  probeMs: { total: number; p50: number; p95: number; max: number };
  readMs: number;
  throughput: { filesPerSecond: number; megabytesPerSecond: number };
  pages: { found: number; files: number };
  durationSeconds: number;
  mixConfidence: { files: number; min: number | null; mean: number | null; max: number | null };
  estimator: { crashes: number; resets: number };
  bounds: { concurrency: number; batchSize: number; maxBufferedBytes: number; peakInFlight: number; peakBufferedBytes: number };
};

export type EstimateResult = {
  /** Measured files plus size-only assumptions for the rest; null for no files (or from a worker stopped mid-run). */
  quote: Quote | null;
  files: FileEstimate[];
  stats: EstimateStats | null;
  /** Some files are priced from name, type and size only (failed, or skipped by cancellation). */
  partial: boolean;
  cancelled: boolean;
  sizeOnlyFiles: number;
};

type EventBase = {
  elapsedMs: number;
  files: { total: number; completed: number; probed: number; failed: number; skipped: number };
  /** `read` and `planned` cover the read plans (what the probe needs), `files` the files' full sizes. */
  bytes: { read: number; planned: number; files: number };
};

/**
 * Per file: file-start, read-progress*, probe-start, probe-done, file-done (a file that fails to read skips the probe
 * events). batch-done after each batch; quote-done is always last. Files skipped by cancellation emit nothing.
 * The probe is one opaque call: its events carry the stage and elapsed time, never a percentage.
 */
export type EstimateEvent = EventBase & (
  | { type: "file-start"; file: FileRef & { size: number; type?: string }; plan: ReadPlan | null; filePlannedBytes: number }
  | { type: "read-progress"; file: FileRef; fileBytesRead: number; filePlannedBytes: number }
  | { type: "probe-start"; file: FileRef; stage: "probe"; readMs: number }
  | { type: "probe-done"; file: FileRef; stage: "probe"; probeMs: number; ok: boolean }
  | { type: "file-done"; file: FileRef; result: FileEstimate }
  | { type: "batch-done"; batch: { index: number; start: number; end: number }; quote?: Quote; provisional?: true }
  | { type: "quote-done"; quote: Quote | null; partial: boolean; cancelled: boolean; result?: EstimateResult }
);

export function estimateFiles(estimator: Estimator, files: ArrayLike<Blob & { name: string }> | Iterable<Blob & { name: string }>, options?: EstimateOptions): Promise<EstimateResult>;
export function estimateEvents(estimator: Estimator, files: ArrayLike<Blob & { name: string }> | Iterable<Blob & { name: string }>, options?: Omit<EstimateOptions, "onProgress"> & { highWaterMark?: number }): AsyncIterable<EstimateEvent>;
export function yieldToEventLoop(): Promise<void>;

export function createEstimator(options?: {
  module?: WebAssembly.Module | BufferSource | URL | string;
  card?: EstimateCard | string;
}): Promise<Estimator>;

export function applyProbe(file: QuoteFile, probe: ProbeResult | null): QuoteFile;
export function fetchEstimateCard(origin?: string, init?: RequestInit): Promise<EstimateCard>;

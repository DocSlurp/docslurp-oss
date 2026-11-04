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
  estimate: { pages: number; documents: number; billing: "enforced" | "disabled"; credits: Range | null; seconds: Range | null; basis: string };
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

export type EstimatorErrorCode = "invalid_request" | "invalid_card" | "unsupported_rules" | "crashed";
export class EstimatorError extends Error {
  readonly code: EstimatorErrorCode;
  constructor(code: EstimatorErrorCode, message: string);
}

export type Estimator = {
  card(): EstimateCard;
  readPlan(file: FileMeta): ReadPlan;
  probe(file: FileMeta, head: Uint8Array, tail?: Uint8Array): ProbeResult;
  quote(request: QuoteRequest): Quote;
  probeBlob(blob: Blob, name?: string): Promise<ProbeResult>;
  quoteFiles(files: Array<Blob & { name: string }>, request?: Omit<QuoteRequest, "files">): Promise<Quote & { probes: Array<ProbeResult | null> }>;
};

export function createEstimator(options?: {
  module?: WebAssembly.Module | BufferSource | URL | string;
  card?: EstimateCard | string;
}): Promise<Estimator>;

export function applyProbe(file: QuoteFile, probe: ProbeResult | null): QuoteFile;
export function fetchEstimateCard(origin?: string, init?: RequestInit): Promise<EstimateCard>;

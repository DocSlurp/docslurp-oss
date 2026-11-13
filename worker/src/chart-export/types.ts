/**
 * Chart & diagram export (generator stage): the seams other slices plug into.
 *
 * - `DeterministicVisualExtractor`: the no-model sources (Office chart XML, embedded specs, SVG geometry). They read
 *   customer bytes, so the implementation runs in the credential-free parser VM; the host only sees the bounded
 *   partials it returns, which are validated again here (`visualSpecSchema`) before use.
 * - `ChartModelClient`: one image + prompt model call. The production client goes through the vision runtime (attempt
 *   guard, privacy gate, model-swap and fallback handling); tests use a fake.
 */
import type { BBox, ChartExportFormat, ExportedVisual, VisualSource, VisualSpec } from "@docslurp/shared";

import type { UsageEvent } from "../models.js";

export type VisualKind = "chart" | "diagram";

/** A chart or diagram the pipeline found, before export. */
export interface VisualCandidate {
  /** Stable within the document: `p<page>-i<imageIndex>` / `p<page>-page` / `p<page>-d<n>`. */
  id: string;
  pageNumber: number;
  imageIndex: number | null;
  bbox: BBox | null;
  /** Image routing's page-local image occurrence (media map), matched against router image indexes. */
  occurrence?: number | null;
  /** Null when the detector could not tell (legacy `chart-or-figure` pages). */
  kind: VisualKind | null;
  /** Which free signal found it (for stats and telemetry). */
  detectedBy: "router-inset" | "router-region" | "legacy-page-route" | "image-routing" | "deterministic";
  /**
   * On no known page (a partial without a page: DOCX/XLSX chart parts). `pageNumber` is then nominal (never paired, never
   * read by a model) and the exported visual's page is null.
   */
  unpaged?: boolean;
}

/** A local image the model may see (page raster, crop or stored figure). The caller owns the file. */
export interface VisualImage {
  path: string;
  mimeType: string;
}

// ---- Deterministic extractors (S2) ---------------------------------------------------------------------------

/** Where a deterministic partial came from in the source document. */
export interface DeterministicVisualPartial {
  source: Extract<VisualSource, "office-chart-xml" | "embedded-spec" | "svg-geometry">;
  /** 0..1: how well axes/marks resolved. */
  confidence: number;
  /** Parsed spec; untrusted until it passes `visualSpecSchema` again on the host. */
  spec: VisualSpec | null;
  /** Compact geometry digest (labels, scale, mark values) for `svg-assisted`; never raw SVG. */
  digest: string | null;
  /** Page the visual sits on (1-based); null when the source has no pages (a spreadsheet chart sheet). */
  pageNumber?: number | null;
  /** Image index within the page when the partial describes an image the router/legacy path also sees. */
  imageIndex?: number | null;
  /**
   * Placement on the page in page points, top-left origin (the router's space), when the host knows it from its own
   * records (a Doppler figure's index entry); never taken from guest output. Pairs the partial with a candidate.
   */
  bbox?: BBox | null;
  kind?: VisualKind;
}

export interface DeterministicVisualInput {
  /**
   * The document; `sourceKey`/`sourceSha256` let the VM adapter stage the verified source for the parser guest (the
   * host never parses it).
   */
  document: {
    id: string; mimeType: string; pageCount: number; sourceKey?: string | null; sourceSha256?: string | null;
    /** lib/parse-source.ts: the upload's hash behind a scanned copy, and quarantine's decision; staging checks both. */
    originalSourceSha256?: string | null; parseSourceDecision?: import("../lib/parse-source.js").ParseSourceDecision;
  };
  /** Candidates the router or classifier found, so the extractor can align partials with images. */
  candidates: readonly VisualCandidate[];
  /**
   * Stored artifacts that may carry figures (Doppler figure index, media map). `artifactUri` resolves a document
   * artifact slot (a Doppler figure's `doppler-figure:<id>`) to its storage URI.
   */
  artifacts: { dopplerFiguresIndexUri: string | null; mediaMapUri: string | null; artifactUri?: (slot: string) => string | null };
  /** The project's diagram opt-out (the guest skips Mermaid/Graphviz SVGs when false). */
  diagrams?: boolean;
  /**
   * Free signals from stored outputs that say whether the source can hold a deterministic chart. The parser VM runs on
   * the source only when one is present (an Office file with chart parts, an HTML/EPUB file with embed hints or a
   * candidate, a standalone SVG/JSON document); see `vm-extractor.ts`.
   */
  signals?: { officeChartParts?: number; htmlEmbedHints?: boolean; candidates?: number };
  /** The parsed Doppler figure index when the caller already read it (saves a second read). */
  dopplerFiguresIndex?: unknown;
  /**
   * Records a cost-only usage event (parser-VM time spent on this document's chart extraction) in the stage's usage
   * ledger. Never a customer charge.
   */
  recordUsage?: (event: UsageEvent) => void;
  signal?: AbortSignal;
}

export interface DeterministicVisualResult {
  partials: DeterministicVisualPartial[];
  /** Free presence counts the extractor saw without exporting (Office chart parts, SVG figures). */
  /** `svgFigures` is telemetry only: SVG figures are also candidates (Doppler figures), so stats do not add it. */
  presence?: { officeChartParts?: number; svgFigures?: number; embeddedSpecs?: number };
}

/** S2's entry (`extractDeterministicVisuals`) satisfies this; the default does nothing. */
export type DeterministicVisualExtractor = (input: DeterministicVisualInput) => Promise<DeterministicVisualResult>;

export const noopDeterministicVisualExtractor: DeterministicVisualExtractor = async () => ({ partials: [] });

let activeExtractor: DeterministicVisualExtractor = noopDeterministicVisualExtractor;

/** Installed at worker start (S2 merge point). Returns the previous extractor (tests restore it). */
export function setDeterministicVisualExtractor(extractor: DeterministicVisualExtractor): DeterministicVisualExtractor {
  const previous = activeExtractor;
  activeExtractor = extractor;
  return previous;
}

export function deterministicVisualExtractor(): DeterministicVisualExtractor {
  return activeExtractor;
}

// ---- Model client -------------------------------------------------------------------------------------------

export type ChartModelPurpose = "spec" | "repair" | "direct";

export interface ChartModelRequest {
  modelUri: string;
  prompt: string;
  image: VisualImage;
  pageNumber: number;
  purpose: ChartModelPurpose;
  format?: ChartExportFormat;
  signal?: AbortSignal;
}

export interface ChartModelResponse {
  text: string;
  /** Model the provider served (usage rows are priced on it). */
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  latencyMs: number;
  finishReason?: string | null;
  /** Prompt tokens served from / written to the provider's prompt cache (included in inputTokens), when reported. */
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface ChartModelClient {
  complete(request: ChartModelRequest): Promise<ChartModelResponse>;
}

/** One generator call, for the stage's totals, the routed path's actuals and the per-visual charge (billing.ts). */
export interface ChartExportCallRecord {
  /** The visual (candidate id) the call was made for. */
  visualId: string;
  /**
   * The provider answered (any outcome: valid, invalid, `none`). Such a call was paid for, so the visual it was made
   * for is charged if it is exported, whatever source it ends up with. False when the call threw before an answer.
   */
  responded: boolean;
  purpose: ChartModelPurpose;
  format: ChartExportFormat | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  latencyMs: number;
  ok: boolean;
}

export interface ExportVisualResult {
  /** Null when nothing was exported (no image and no usable deterministic spec, or the model saw no visual). */
  visual: ExportedVisual | null;
  calls: ChartExportCallRecord[];
}

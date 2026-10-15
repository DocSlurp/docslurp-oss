import type { Assignment, AssignmentRole, BBox, RoutingTarget } from "@docslurp/shared";

import type { VisionPageOutput } from "../../stages/vision-extract.js";
import type { NativeOcrPolicy } from "../flags.js";

/** A rendered page (or crop of one) on local disk; the owner of the temp file cleans it up. */
export interface RasterRef {
  path: string;
  mimeType: string;
  /** 1-based page this raster shows, when known; lets crops be rendered straight from the source (PDF_RASTER_ENGINE). */
  pageNumber?: number;
}

/**
 * Everything an executor may touch, injected so executors are testable with fakes and the
 * stage owns temp files, storage, usage-ledger writes and privacy gates.
 */
export interface ExecutorDeps {
  /** The canonical (already extracted) text of the page, or null when unavailable. */
  pageText(pageNumber: number): Promise<string | null>;
  /** One page from a native extractor, or null when that extractor cannot run per page. */
  nativePageText(extractorId: string, pageNumber: number): Promise<string | null>;
  /** NATIVE_PDF_OCR policy for page OCR (default `scripts`: tesseract first, see ocr-policy.ts). */
  nativeOcrPolicy?: NativeOcrPolicy;
  /**
   * Native-pdf OCR for one page (`fill`: recognise only regions the text layer lacks; `full`: adaptive whole-page OCR).
   * Optional: absent, null or a NATIVE_PDF_UNSUPPORTED rejection (no OCR models) mean "the engine cannot do this" and
   * the executor falls back to the page raster + `ocr`; other engine errors fall back too, with a warning.
   */
  nativePdfOcr?(args: { pageNumber: number; mode: "fill" | "full"; dpi?: number; signal?: AbortSignal }): Promise<NativePdfOcrResult | null>;
  /** Hands `fn` the page's rendered raster; null when the page has none. Cleanup is the dep's job. */
  withRaster<T>(pageNumber: number, fn: (raster: RasterRef) => Promise<T>): Promise<T | null>;
  /** Hands `fn` a crop of `raster` to `bbox` (page-top-left points). */
  withCrop<T>(raster: RasterRef, bbox: BBox, fn: (crop: RasterRef) => Promise<T>): Promise<T>;
  /**
   * Renders only `bbox` of the page (page-top-left points) with the native raster engine and hands `fn` the clip,
   * skipping the full-page raster. Optional; resolves null when the engine is not active (PDF_RASTER_ENGINE) or cannot
   * serve the clip, and the caller takes the full-page `withRaster` + `withCrop` path.
   */
  withPageClip?<T>(pageNumber: number, bbox: BBox, fn: (crop: RasterRef) => Promise<T>): Promise<T | null>;
  ocr(raster: RasterRef, options: { pageNumber: number; signal?: AbortSignal }): Promise<{ text: string; latencyMs: number; model: string }>;
  label(raster: RasterRef, options: { pageNumber: number; signal?: AbortSignal }): Promise<{ text: string; latencyMs: number; model: string }>;
  /** Runs the target's own model over the image; records usage and cost like any vision call. */
  vlm(args: {
    target: RoutingTarget;
    role: AssignmentRole;
    raster: RasterRef;
    pageNumber: number;
    signal?: AbortSignal;
  }): Promise<VisionPageOutput>;
}

export interface NativePdfOcrResult {
  text: string;
  markdown: string;
  /** Regions the OCR added to a page that already had a text layer (0 for whole-page OCR). */
  filledRegions: number;
  /** Engine/OCR model that produced the text, for ledgers (internal). */
  engine: string;
  latencyMs: number;
  /** Page area in square inches, for the dropout guard's density check. */
  pageAreaIn2?: number | null;
}

export interface ExecutionRequest {
  assignment: Assignment;
  /** Index into plan.assignments. */
  index: number;
  target: RoutingTarget;
  /** Page raster, cropped to the assignment's region/image bbox when scoped. Set by the runner. */
  raster?: RasterRef;
}

/** What one assignment produced. `scope` and `role` say where the text belongs in the page. */
export interface ExecutorOutput {
  assignmentIndex: number;
  pageNumber: number;
  role: AssignmentRole;
  scope: Assignment["scope"];
  targetId: string;
  text: string;
  model: string;
  runtime: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  finishReason?: string | null;
  /** Set when a native executor could not run per page and used the document text slice instead. */
  fallback?: string;
  /**
   * Set when the target's vendor refused a crop (content filter) and one retry ran on another vendor's target.
   * Usage fields then cover both calls; `served` says whether the retry's text replaced the refusal.
   */
  refusalFallback?: { fromTargetId: string; toTargetId: string; served: boolean };
}

export interface TargetExecutor {
  /** Registry key (target id, or `kind:<kind>`). */
  id: string;
  /** False for executors that read text only, so no raster is rendered or downloaded. */
  needsRaster: boolean;
  run(request: ExecutionRequest, deps: ExecutorDeps, signal?: AbortSignal): Promise<ExecutorOutput | null>;
}

/** Fields every executor output shares, taken from the request (cost-free by default). */
export function baseOutput(request: ExecutionRequest) {
  return {
    assignmentIndex: request.index,
    pageNumber: request.assignment.pageNumber,
    role: request.assignment.role,
    scope: request.assignment.scope,
    targetId: request.assignment.targetId,
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
  };
}

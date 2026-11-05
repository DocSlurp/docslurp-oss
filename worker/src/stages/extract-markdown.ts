import { reserveOrientationAttempt } from "../lib/image-orientation.js";
import { EMBEDDED_IMAGE_TARGETS, embeddedImageGraph, resolveEmbeddedImageRequest } from "../extractors/embedded-images.js";
import { anchorImageMarkdownFile } from "../extractors/image-markdown.js";
import {
  SANDBOXED_PDF_MAX_MARKDOWN_BYTES, VM_PDF_EXTRACTOR_ID, requireSandboxedPdfProvider, sandboxedPdfOcrPages,
} from "../extractors/plugins.js";
import { buildSummaryEvidence } from "./summary-evidence.js";
import type { CapacityLeaseStore } from "../media/capacity/types.js";
import { extractMedia } from "../media/extract.js";
import type { MediaJournal } from "../media/types.js";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import {
  DOCUMENT_FAILURE_MARKERS,
  defaultDocumentExtractionConfig,
  isProviderCallAllowed,
  resolveVisionRoute,
  splitTextIntoPagesStrict,
  parserPlaybookCatalog,
  parserPlaybookForQuality,
  qualityAllowsPageReading,
  documentExtractionForQuality,
  deriveDocumentTitle,
  htmlDocumentTitle,
  imageAnchorsToAltText,
  resolvePdfExtractorSetting,
  hostPdfExtractorsUnderSandbox,
  sandboxedPdfConfigured,
  type ExtractionContract,
  type ExtractionArtifactRef,
} from "@docslurp/shared";
import { readJsonFile } from "../tools/storage.js";
import { documentArtifactRoot, runArtifactRoot } from "../lib/artifact-root.js";
import { pushPerfMetric } from "../lib/perf-context.js";
import { buildExtractionContract } from "../lib/extraction-contract.js";

import type { Config } from "../config.js";
import type { Stage } from "../pipeline/pipeline.js";
import { adaptiveUnstructuredSettingsForStage } from "../pipeline/adaptive-tuning.js";
import {
  checkDedup,
  isCostCapExceeded,
  DocumentStageError,
  type DocumentStageResult,
  emitDocumentPageProgress,
  completeDocumentPages,
  registerHash,
  runDocumentStage,
  runDocuments,
  skipCompletedPages,
} from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import type { CanonicalDocument } from "@docslurp/shared";
import { enrichCanonicalDocumentWithPptx, enrichCanonicalDocumentWithXlsx } from "../lib/office-structure.js";
import {
  enrichCanonicalDocumentWithBestParser,
  scoreParserEnrichments,
} from "../lib/parser-canonical.js";
import {
  normalizeExtractedMarkdown,
  sanitizeExtractedMarkdown,
  scoreExtractionPlausibility,
} from "../lib/extracted-markdown.js";
import { evaluateParserPolicy } from "../lib/parser-policy.js";
import {
  SPARSE_PAGE_WORDS,
  collectPageImageEvidence,
  drawnBytesPerPage,
  imageFilePageEvidence,
  totalEmbeddedImageBytes,
  pageAlignedTexts,
  type PageImageEvidence,
  type PageImageEvidenceArtifact,
} from "../lib/page-image-evidence.js";
export { scoreExtractionPlausibility } from "../lib/extracted-markdown.js";
import type { CommandPlan } from "../tools/runner.js";
import { resolveNativePdfEngine } from "../native-pdf/engine.js";
import { buildNativeParserPayload } from "../native-pdf/parser-payload.js";
import { buildNativePdfRegions } from "../native-pdf/regions.js";
import { nativePdfEmphasisEnabled, resolveNativePdfMode } from "../native-pdf/mode.js";
import { runNativePdfShadow } from "../native-pdf/shadow.js";
import { nativePdfEngineState } from "../native-pdf/loader.js";
import { logNativePdfFallback } from "../native-pdf/types.js";
import { isDocumentLevelFailure, RunPolicyError } from "../lib/document-failure.js";
import { rethrowIfTeardown } from "../sandbox/teardown-breaker.js";
import { SpendCheckUnavailableError } from "../db/spend-check.js";
import { reportExtractionDecision, summarizeNativePdfShadow, type NativePdfStageStats } from "../native-pdf/telemetry.js";
import { documentExtractorRegistry, serializeExtractorOptions, unsupportedSourceReason, type CandidateExecutors, type ExtractedCandidate, type PreparedExtractor } from "../extractors/registry.js";
import { ExtractorAttemptLedger } from "../extractors/attempt-ledger.js";
import { runLocalPdfArtifactGraph } from "../extractors/local-graph-runner.js";
import type { CommandRunner } from "../tools/runner.js";
import { type ArtifactStore } from "../tools/storage.js";
import { PdfRasterCache, PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import { pageFactsEnabled, probePdfPageFacts, recordPageFacts, splitFormFeedPages } from "../pipeline/page-facts.js";
import { configuredVisionServedRoute, executeVisionRuntime, visionCall } from "../tools/vision-runtime.js";
import { guardedVisionCall, priceVisionResult } from "../lib/guarded-vision-call.js";
import type { VisionServedRoute } from "../lib/vision-pricing.js";
import { visionGuardFor } from "../lib/vision-attempt-guard.js";
import { allowHostedCall } from "../lib/privacy-guard.js";
import { resolveRunRoutingV2 } from "../lib/vision-routing-v2.js";
import { createHostedOcrReader } from "../ocr/hosted-reader.js";
import { affordableImageFrames, authorizeImageFrames, authorizeImageRead } from "../ocr/image-frames.js";
import { OCR_FAILED_PAGES_KEY, OcrInfrastructureError, OcrRefusedError, ocrFailedPages, recordOcrFailedPages, resolveOcrMode } from "../ocr/mode.js";
import { ocrDocument } from "../ocr/read-document.js";
import { recordMeasuredPageCount, type PageCountResult } from "../lib/office-page-count.js";

interface PageHeatmapEntry {
  pageNumber: number;
  plausibilityScore: number;
  strategy: string;
  charCount: number;
  tokenEstimate: number;
}

type SelfCritiqueCorrection = {
  pageNumber: number;
  accepted: boolean;
  originalPlausibilityScore: number;
  correctedPlausibilityScore: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costCents: number;
  text: string;
  reason: string;
};

type SelfCritiqueResult = {
  correctedText: string;
  correctedTextUri: string | null;
  critiqueArtifactUri: string;
  reviewedPages: number[];
  acceptedPages: number[];
  corrections: SelfCritiqueCorrection[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costCents: number;
};

export function buildPerPageHeatmap(
  text: string,
  pageCount: number,
  strategy: string,
): PageHeatmapEntry[] {
  // Only page breaks the text itself carries: equal-length slices would score invented pages, and the critique
  // that reads this heatmap would re-read and rewrite them.
  const pageTexts = splitTextIntoPagesStrict(text, pageCount);
  if (pageTexts === null || pageTexts.length === 0) {
    return [];
  }

  return pageTexts.map((pageText, i) => {
    const charCount = pageText.length;
    const words = pageText.trim() ? pageText.trim().split(/\s+/).length : 0;
    const tokenEstimate = words === 0 ? 0 : Math.floor(words * 1.3);
    return {
      pageNumber: i + 1,
      plausibilityScore: scoreExtractionPlausibility(pageText, 1).plausibilityScore,
      strategy,
      charCount,
      tokenEstimate,
    };
  });
}

/** Refuse provider Markdown that is not a regular file or exceeds SANDBOXED_PDF_MAX_MARKDOWN_BYTES, before it is read. */
export async function assertSandboxedPdfMarkdownBounded(outputPath: string): Promise<void> {
  const info = await lstat(outputPath);
  if (!info.isFile()) throw new Error("Sandboxed PDF provider output is not a regular file");
  if (info.size > SANDBOXED_PDF_MAX_MARKDOWN_BYTES) {
    throw new Error(`Sandboxed PDF provider output exceeds ${SANDBOXED_PDF_MAX_MARKDOWN_BYTES} bytes`);
  }
}

/** Scanned PDF pages one OCR job reads; a long scan runs as several jobs. */
export const OCR_PDF_BATCH_PAGES = 32;
/**
 * OCR read stats for a document: every page OCR read (the winner's, reported or inferred, plus the scan-fill engine's),
 * where the reads came from, how many pages scan-fill read, and how many pages' OCR failed.
 */
export function ocrReadStats(
  winnerPages: readonly number[],
  winnerSource: "extractor-reported" | "inferred",
  scanFilledPages: readonly number[],
  failedPages: number,
): { ocrReadPages: number; ocrReadSource: string; scanFilledPages: number; ocrFailedPages: number } {
  const scanFilled = new Set(scanFilledPages);
  const winnerOnly = winnerPages.filter((page) => !scanFilled.has(page));
  const sources = [
    ...(winnerSource === "extractor-reported" || winnerOnly.length ? [winnerSource] : []),
    ...(scanFilled.size ? ["scan-fill"] : []),
  ];
  return {
    ocrReadPages: new Set([...winnerPages, ...scanFilledPages]).size,
    ocrReadSource: sources.length ? sources.join("+") : "none",
    scanFilledPages: scanFilled.size,
    ocrFailedPages: failedPages,
  };
}

/** The OcrInfrastructureError in an error's cause chain, if any. */
function findOcrInfrastructureError(error: unknown): OcrInfrastructureError | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    if (current instanceof OcrInfrastructureError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Scan-fill stops after this many OCR batches in a row failed deterministically; the remaining pages fail unread. */
export const OCR_MAX_CONSECUTIVE_FAILED_BATCHES = 3;
/** Bound on the OCR ledger's own `pdftotext` probe (the text layer is light work; a slow one is a hostile file). */
export const OCR_LEDGER_PROBE_TIMEOUT_MS = 20_000;

/** Text a page holds for a "has words" test: image references and `<!-- page N -->` markers are not words read. */
export function ocrLedgerPageText(text: string | null | undefined): string {
  if (typeof text !== "string") return "";
  return imageAnchorsToAltText(text).replace(/<!--\s*page\s+\d+\s*-->/gi, "");
}

/**
 * Whether the winning candidate ran OCR, so empty-native pages holding words could only be OCR reads. Only these
 * candidates OCR without reporting pages: Dolphin (a page-reading model). Text-layer extractors (native-pdf,
 * poppler-text, pandoc, pptx, xlsx, json) never OCR, and none of them links an OCR engine. The OCR engine reports and
 * charges its own pages.
 */
export function candidateRanUnreportedOcr(candidate: Pick<ExtractedCandidate, "label">): boolean {
  return candidate.label === "dolphin";
}

export function assertSupportedDocumentTarget(target: string): void {
  if (target !== "document/markdown") {
    throw new Error(`unsupported document extraction target ${target}; supported target: document/markdown`);
  }
}

/** What candidate executors know about the document: graph-local and the OCR extractor read it. */
interface CandidateContext {
  sourceHash: string;
  pageCount: number;
  documentId: string;
  ocrLanguage?: string;
  /** The run, for the OCR extractor's ledger and escalation reads. */
  state?: import("../pipeline/pipeline.js").WorkflowState;
  mimeType?: string | null;
}

/** Run ledger slot holding a content hash's measured page count, so a deduplicated copy bills the same pages. */
const MEASURED_PAGES_KEY = "measured-pages";

function measuredPagesOf(value: string | undefined): PageCountResult | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PageCountResult>;
    return Number.isSafeInteger(parsed.pages) && parsed.pages! >= 1 && (parsed.method === "slides" || parsed.method === "sheet-rows" || parsed.method === "text-rule")
      ? { pages: parsed.pages!, method: parsed.method }
      : null;
  } catch {
    return null;
  }
}

export class ExtractMarkdownStage implements Stage {
  readonly name = "extract-markdown";
  private readonly rasters: PdfRasterCache;

  constructor(
    private readonly runner: CommandRunner,
    private readonly storage: ArtifactStore,
    private readonly cfg: Config,
    private readonly sources = new PdfSourceCache(storage),
    private readonly mediaJournal?: MediaJournal,
    private readonly capacityStore?: CapacityLeaseStore,
  ) {
    this.rasters = new PdfRasterCache(runner, storage, sources);
  }

  async run(
    state: import("../pipeline/pipeline.js").WorkflowState,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!state.run.pipeline.markdownExtraction) {
      return;
    }

    await runDocuments(
      healthyDocuments(state),
      state.docConcurrency,
      async (document) => {
        const manifestKey = `${runArtifactRoot(state.run, document.userId)}/markdown/${document.id}.json`;
        const artifactSlot = `${document.id}:markdown`;
        const playbook =
          (state.artifactLedger.readDocument(document.id, "parser-playbook") as
            | keyof typeof parserPlaybookCatalog
            | undefined) ??
          parserPlaybookForQuality(state.run.pipeline.quality);
        // Fast runs only text-layer extractors with OCR off, whatever the request or workspace asked for.
        const { config: extractionConfig, removed: fastRemoved } = documentExtractionForQuality(
          { ...defaultDocumentExtractionConfig, ...(state.run.pipeline.documentExtraction ?? {}) },
          state.run.pipeline.quality,
        );
        if (fastRemoved.length > 0) {
          console.warn(
            `[extract-markdown] quality fast removed page-reading extraction settings run=${state.run.id} ` +
              `document=${document.id} removed=${fastRemoved.join(",")}`,
          );
        }
        assertSupportedDocumentTarget(extractionConfig.target);
        // Only the OCR engine reads the OCR language (ocr/read-document.ts); document extractors never OCR.
        const extractorOptions = extractionConfig.options;
        const hasTablePages =
          state.artifactLedger.readDocument(document.id, "hasTablePages") === "true";
        // The sniffed format (format-detect) alone says whether the bytes are a PDF; a file name or declared type never does.
        const format = state.artifactLedger.readDocument(document.id, "normalizedFormat") ?? "unknown";
        if (format === "audio" || format === "video") {
          await extractMedia({ state, document, runner: this.runner, storage: this.storage, journal: this.mediaJournal, capacityStore: this.capacityStore, signal });
          return;
        }
        const isPdf = format === "pdf";
        const requestedImages = resolveEmbeddedImageRequest(extractionConfig, format, this.tryResolveExtractorOrder(format, extractionConfig.order));

        console.log(
          `[extract-debug] stage=${this.name} document=${document.id} ` +
            `playbook=${playbook} isPdf=${isPdf} hasTablePages=${hasTablePages} ` +
            `extractorOrder=${this.describeExtractorOrder(format, extractionConfig.order)}`,
        );

        const attemptLedger = new ExtractorAttemptLedger();
        // native-pdf as an extraction candidate, kept across the stage's retry attempts.
        let nativeExtraction: NativePdfStageStats["extraction"] = { status: "not-planned", code: null, reason: null };
        let lastUsableResult: DocumentStageResult | null = null;

        // A PDF routed to the sandboxed provider is never parsed on this host for evidence: page facts, page-image
        // evidence and the OCR ledger's text-layer probe are skipped (stage stats say so).
        const sandboxReason = isPdf ? this.pdfSandboxReason(format, extractionConfig.order) : null;
        const sandboxedPdfRoute = sandboxReason !== null;
        // Under a sandboxed deployment no workspace setting may name a host PDF parser (pages, enrich, voting too).
        const hostPdf = isPdf ? hostPdfExtractorsUnderSandbox(extractionConfig) : [];
        // Page facts for the ingest report run beside extraction (poppler, no pixels) and never fail it.
        const pageFacts = this.recordSourcePageFacts(state, document, format, signal, sandboxedPdfRoute, sandboxReason);
        try {
          await runDocumentStage(
            state,
            document,
            this.name,
            artifactSlot,
            "markdown extraction ready",
            async (retryStrategy) => {
              // Fails this document, never the run, and before anything reads the source.
              if (hostPdf.length > 0) {
                throw new Error(`extractor ${hostPdf.map((entry) => `${entry.id} (${entry.path.join(".")})`).join(", ")} refused for pdf: this deployment runs PDFs only in ${VM_PDF_EXTRACTOR_ID}`);
              }
              const extractionStartedAt = Date.now();
              const pageCount = Math.max(1, document.pageCount);

              await emitDocumentPageProgress(
                state,
                document,
                this.name,
                1,
                pageCount,
                "processing",
              );

              const allPages = Array.from({ length: pageCount }, (_, i) => i + 1);

              const completedPages = state.store
                ? await state.store.getCompletedPages(
                    state.run.id,
                    document.id,
                    this.name,
                  )
                : new Set<number>();

              const remaining = skipCompletedPages(completedPages, allPages);
              console.log(
                `[extract-debug] document=${document.id} retryStrategy=${retryStrategy ?? "default"} ` +
                  `pages=${pageCount} completed=${completedPages.size} remaining=${remaining.length}`,
              );

              const cachedSource = await this.sources.get(document);
              const tempFile = cachedSource.path;

              // Track partial artifacts so we can fall through with usable assets on failure
              let partialArtifactUri = "";
              let partialStats: Record<string, unknown> = {};
              // Private source copies of concurrent candidates (isolateConcurrentCandidates).
              const candidateDirs: string[] = [];

              try {
                const contentHash = cachedSource.sha256;
                const existingUri = checkDedup(state, contentHash, artifactSlot);
                if (existingUri) {
                  const inheritedFailures = state.artifactLedger.read(`${OCR_FAILED_PAGES_KEY}:${contentHash}`);
                  if (inheritedFailures) state.artifactLedger.recordDocument(document.id, OCR_FAILED_PAGES_KEY, inheritedFailures);
                  // A copy of a measured Office, EPUB or spreadsheet file bills its original's count, never intake's one page.
                  const inheritedPages = measuredPagesOf(state.artifactLedger.read(`${MEASURED_PAGES_KEY}:${contentHash}`));
                  if (inheritedPages) await recordMeasuredPageCount(state, document, format, inheritedPages);
                  console.log(
                    `[extract-debug] document=${document.id} deduplicated=true existingUri=${existingUri}`,
                  );
                  reportExtractionDecision({
                    documentId: document.id,
                    format,
                    extractor: "dedup",
                    strategy: "deduplicated",
                    extractorOrder: this.tryResolveExtractorOrder(format, extractionConfig.order),
                    attempted: [],
                    unavailable: [],
                    nativePdf: null,
                  });
                  return {
                    artifactUri: existingUri,
                    stats: { deduplicated: true, extractor: "dedup" },
                  };
                }

                // Fast never OCRs: an image file keeps its page image (render-images) and has no extracted text.
                // The same image test billing and render-images use (MIME image/*), so an image MIME the format map
                // does not know is kept unread too instead of reaching an OCR-capable extractor.
                const keepImageUnread = (format === "image" || (document.mimeType ?? "").startsWith("image/")) &&
                  !qualityAllowsPageReading(state.run.pipeline.quality);
                // An Office file no reader here can open fails now, loudly and for good, never through a weaker reader.
                const unsupported = keepImageUnread ? null : await unsupportedSourceReason(tempFile, {
                  format, mimeType: document.fileFacts?.sniffedMimeType ?? document.mimeType, filename: document.filename,
                });
                if (unsupported) {
                  console.error(`[extract-markdown] unsupported-format document=${document.id} format=${format} reason=${JSON.stringify(unsupported)}`);
                  throw new Error(unsupported);
                }
                let plannedExtractors = keepImageUnread ? null : await this.planExtractors({
                  mimeType: document.fileFacts?.sniffedMimeType ?? null,
                  tempFile,
                  multiStrategyVoting: extractionConfig.voting.enabled,
                  secondaryId: extractionConfig.voting.secondary,
                  order: extractionConfig.order,
                  format,
                  options: extractorOptions,
                  attemptLedger,
                });
                // Why an image continues without extracted text (reported in the manifest and stats).
                let textlessFallback: string | null = null;
                if (keepImageUnread) {
                  textlessFallback = "quality fast keeps images unread";
                  plannedExtractors = {
                    primary: this.textlessImageExtractor(state, document, textlessFallback),
                    secondary: null,
                    tableAware: false,
                  };
                } else if (!plannedExtractors) {
                  if (lastUsableResult) return lastUsableResult;
                  const cause = `no untried extractor remains for ${format}: ${JSON.stringify(attemptLedger.snapshot())}`;
                  // An image with OCR off (or every OCR attempt spent) fails: hosted vision is never a stand-in for OCR
                  // (only DOCSLURP_OCR_MODE=hosted makes it the reader).
                  if (format === "image") console.error(`[ocr] image-unread document=${document.id} mode=${resolveOcrMode()} cause=${cause}`);
                  throw new Error(cause);
                }
                const tableAware = plannedExtractors.tableAware;
                console.log(
                  `[extract-debug] document=${document.id} primary=${plannedExtractors.primary.label} ` +
                    `secondary=${plannedExtractors.secondary?.label ?? "none"} tableAware=${tableAware}`,
                );

                const candidateAKey = `${runArtifactRoot(state.run, document.userId)}/markdown/${document.id}.${plannedExtractors.primary.label}.md`;
                const candidateBKey = plannedExtractors.secondary
                  ? `${runArtifactRoot(state.run, document.userId)}/markdown/${document.id}.${plannedExtractors.secondary.label}.md`
                  : null;

                attemptLedger.reserve(plannedExtractors.primary.label);
                if (plannedExtractors.secondary) attemptLedger.reserve(plannedExtractors.secondary.label);
                const isolated = await this.isolateConcurrentCandidates({
                  mimeType: document.fileFacts?.sniffedMimeType ?? null,
                  primary: plannedExtractors.primary,
                  secondary: plannedExtractors.secondary,
                  sourcePath: tempFile,
                  format,
                  options: extractorOptions,
                  dirs: candidateDirs,
                });
                if (requestedImages) {
                  for (const prepared of [isolated.primary.extractor, isolated.secondary?.extractor]) {
                    if (prepared && !prepared.plan.sandboxedPdf) throw new Error("Embedded image extraction refuses a non-VM candidate");
                    if (prepared?.plan.sandboxedPdf) prepared.plan.sandboxedPdf.embeddedImages = { minWidth: requestedImages.minWidth, minHeight: requestedImages.minHeight };
                  }
                }
                const [resultA, resultB] = await this.collectCandidateResults({
                  primary: isolated.primary.extractor,
                  primaryKey: candidateAKey,
                  secondary: isolated.secondary?.extractor ?? null,
                  secondaryKey: candidateBKey,
                  primarySource: isolated.primary.source,
                  secondarySource: isolated.secondary?.source ?? tempFile,
                  graphContext: { sourceHash: contentHash, pageCount, documentId: document.id, ocrLanguage: state.run.pipeline.documentExtraction?.ocr?.language, state, mimeType: document.mimeType },
                  signal,
                });
                // A candidate whose command could not be torn down ends the stage: never let the
                // other candidate (possibly the in-process engine) take over as a fallback.
                for (const result of [resultA, resultB]) {
                  if (result?.status === "rejected") rethrowIfTeardown(result.reason);
                  // A charge check that could not decide is retried, and a run-policy stop (cost cap, unfunded run) ends the stage:
                  // neither is a reason to try another extractor or fail the document.
                  if (result?.status === "rejected" && (result.reason instanceof SpendCheckUnavailableError || result.reason instanceof RunPolicyError)) throw result.reason;
                }
                // Neither may a candidate whose OCR boundary could not run: the activity retries instead of another
                // extractor (or a failed document) standing in for an OCR read that was never tried.
                for (const result of [resultA, resultB]) {
                  if (result?.status === "rejected" && findOcrInfrastructureError(result.reason)) throw findOcrInfrastructureError(result.reason);
                }

                for (const [planned, result] of [
                  [plannedExtractors.primary, resultA],
                  [plannedExtractors.secondary, resultB],
                ] as const) {
                  if (planned?.label !== "native-pdf" || !result) continue;
                  if (result.status === "fulfilled") {
                    nativeExtraction = { status: "lost-vote", code: null, reason: null };
                  } else {
                    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
                    const code = (result.reason as { code?: unknown } | null)?.code;
                    nativeExtraction = { status: "failed", code: typeof code === "string" ? code : null, reason: reason.slice(0, 4000) };
                  }
                }
                let candidateA =
                  resultA.status === "fulfilled" ? resultA.value : null;
                const candidateB =
                  resultB.status === "fulfilled" ? resultB.value : null;

                console.log(
                  `[extract-debug] document=${document.id} ` +
                    `primary=${plannedExtractors.primary.label} status=${resultA.status} ` +
                    `secondary=${plannedExtractors.secondary?.label ?? "none"} status=${resultB?.status ?? "n/a"}`,
                );

                if (
                  candidateA === null &&
                  (plannedExtractors.secondary ? candidateB === null : true)
                ) {
                  // Activity cancellation or worker shutdown aborted the extractors: that is an
                  // interruption, not "no extractor produced output". An extractor's own timeout
                  // aborts only its derived signal, so it still falls through to the next extractor.
                  if (signal?.aborted) throw interruptionCause(signal, resultA, resultB);
                  const errA =
                    resultA.status === "rejected"
                      ? resultA.reason
                      : "unavailable";
                  const secondaryLabel =
                    plannedExtractors.secondary?.label ?? "secondary";
                  const errB = plannedExtractors.secondary
                    ? resultB.status === "rejected"
                      ? resultB.reason
                      : "unavailable"
                    : "skipped";
                  const failure = `${plannedExtractors.primary.label}=${errA}, ${secondaryLabel}=${errB}`;
                  // A failed OCR read fails the image: no other reader stands in for it.
                  throw new Error(`no extractor produced output: ${failure}`);
                }

                try {
                  const availableCandidates = [candidateA, candidateB].filter(
                    (candidate): candidate is ExtractedCandidate => candidate !== null,
                  );
                  const candidateMarkdown = await Promise.all(
                    availableCandidates.map(async (candidate) => ({
                      candidate,
                      markdown: await this.sanitizeCandidateArtifact(candidate),
                    })),
                  );
                  const policyDecision = evaluateParserPolicy({
                    primaryExtractor: plannedExtractors.primary.label,
                    candidates: candidateMarkdown.map(({ candidate, markdown }) => ({
                      extractor: candidate.label,
                      markdown,
                      latencyMs: 0,
                      eligibleForSelection: true,
                    })),
                  });
                  const winningCandidate = availableCandidates.find(
                    (candidate) =>
                      candidate.label === policyDecision.selectedExtractor,
                  )!;
                  let strategy = `${winningCandidate.label}-${
                    availableCandidates.length === 1 && plannedExtractors.secondary
                      ? "only"
                      : policyDecision.strategy
                  }`;
                  const similarity = policyDecision.similarity;
                  const needsVision = policyDecision.needsEscalation || textlessFallback !== null;

                  // Winning text is our first usable partial artifact
                  partialArtifactUri = winningCandidate.textUri;
                  partialStats = {
                    strategy,
                    similarity,
                    needsVision,
                    primary: plannedExtractors.primary.label,
                    secondary: plannedExtractors.secondary?.label ?? null,
                    winningExtractor: winningCandidate.label,
                  };
                  console.log(
                    `[extract-debug] document=${document.id} strategy=${strategy} ` +
                      `similarity=${similarity.toFixed(3)} needsVision=${needsVision} ` +
                      `winner=${winningCandidate.label} partialArtifact=${partialArtifactUri}`,
                  );

                  let winningText = policyDecision.selectedMarkdown;
                  // Office, EPUB and spreadsheet files arrive counted as one page. Count what the extractor read, from its own
                  // output (no other parser runs and the source is not read again), and record it as documents.billing_pages
                  // before features and the completion charge read it (page-base-fee.ts). The page basis (page_count) stays what
                  // the text splits into: these formats' text has no page breaks.
                  const measuredPages = await recordMeasuredPageCount(state, document, format, {
                    extractor: winningCandidate.label,
                    markdown: policyDecision.selectedMarkdown,
                  });
                  if (measuredPages.pages !== null && measuredPages.method !== null) {
                    state.artifactLedger.record(`${MEASURED_PAGES_KEY}:${contentHash}`, JSON.stringify({ pages: measuredPages.pages, method: measuredPages.method }));
                  }
                  // Scanned pages (no words in the winner's text) are read by the OCR engine in its boundary; the
                  // text-layer extractors never OCR. The engine charges each page it reads.
                  const scanFill = isPdf && qualityAllowsPageReading(state.run.pipeline.quality)
                    ? await this.ocrScannedPdfPages(state, document, { sourcePath: tempFile, text: winningText, textKey: winningCandidate.textKey, ocrLanguage: extractionConfig.ocr.language, contentHash }, signal)
                    : null;
                  if (scanFill) {
                    winningText = scanFill.text;
                    strategy = `${strategy}+ocr`;
                    partialArtifactUri = scanFill.textUri;
                  }
                  let plausibilityScore = scoreExtractionPlausibility(
                    winningText,
                    document.pageCount,
                  ).plausibilityScore;
                  let heatmapPages = buildPerPageHeatmap(
                    winningText,
                    document.pageCount,
                    strategy,
                  );
                  const heatmapKey = `${runArtifactRoot(state.run, document.userId)}/heatmap/${document.id}.json`;
                  const critique = await this.runSelfCritique({
                    state,
                    document,
                    sourceTempFile: tempFile,
                    strategy,
                    winningText,
                    winningTextUri: scanFill?.textUri ?? winningCandidate.textUri,
                    heatmapPages,
                    signal,
                  });
                  if (critique && critique.acceptedPages.length > 0) {
                    winningText = critique.correctedText;
                    strategy = `${strategy}+critique`;
                    plausibilityScore = scoreExtractionPlausibility(
                      winningText,
                      document.pageCount,
                    ).plausibilityScore;
                    heatmapPages = buildPerPageHeatmap(
                      winningText,
                      document.pageCount,
                      strategy,
                    );
                    partialArtifactUri = critique.correctedTextUri ?? partialArtifactUri;
                    console.log(
                      `[extract-debug] document=${document.id} critiqueAccepted=${critique.acceptedPages.length} ` +
                        `reviewed=${critique.reviewedPages.length} correctedUri=${critique.correctedTextUri ?? "none"}`,
                    );
                  }
                  const normalizedWinningText = normalizeExtractedMarkdown({
                    markdown: winningText,
                    preserveTables: state.run.pipeline.preserveTables,
                  });
                  if (normalizedWinningText !== winningText) {
                    winningText = normalizedWinningText;
                    strategy = `${strategy}+normalized`;
                    plausibilityScore = scoreExtractionPlausibility(
                      winningText,
                      document.pageCount,
                    ).plausibilityScore;
                    heatmapPages = buildPerPageHeatmap(
                      winningText,
                      document.pageCount,
                      strategy,
                    );
                    console.log(
                      `[extract-debug] document=${document.id} normalizedMarkdown=true preserveTables=${state.run.pipeline.preserveTables}`,
                    );
                  }
                  const nativePdfMode = resolveNativePdfMode();
                  const nativeEngineState = isPdf && winningCandidate.label !== VM_PDF_EXTRACTOR_ID ? await nativePdfEngineState() : null;
                  const nativePdfStats: NativePdfStageStats | null = nativeEngineState
                    ? {
                        mode: nativePdfMode,
                        engine: nativeEngineState.status,
                        engineSource: nativeEngineState.status === "unavailable" ? null : nativeEngineState.source,
                        engineVersion: nativeEngineState.status === "unavailable" ? null : nativeEngineState.version,
                        engineUnavailableReason: nativeEngineState.status === "loaded" ? null : nativeEngineState.reason.slice(0, 4000),
                        extraction: winningCandidate.label === "native-pdf"
                          ? { status: "served", code: null, reason: null }
                          : nativeExtraction.status === "not-planned" && attemptLedger.snapshot().unavailable.includes("native-pdf")
                            ? { status: "unavailable", code: null, reason: "native-pdf planned but unavailable" }
                            : nativeExtraction,
                        shadow: {
                          status: "not-applicable",
                          reason: winningCandidate.label === "native-pdf"
                            ? "native-pdf served the document"
                            : nativePdfMode === "off"
                              ? "DOCSLURP_PDF_ENGINE=off (extraction role only; the parser payload can still use the engine)"
                              : null,
                          agreement: null,
                          nativeMs: null,
                        },
                        parserPayload: { status: "none", reason: null },
                      }
                    : null;
                  if (isPdf && winningCandidate.label !== "native-pdf" && winningCandidate.label !== VM_PDF_EXTRACTOR_ID && nativePdfMode === "shadow") {
                    // Shadow mode records agreement and timing only; the primary output is untouched.
                    const nativeEngine = await resolveNativePdfEngine(this.runner).catch(() => null);
                    if (!nativeEngine) {
                      nativePdfStats!.shadow = { status: "skipped", reason: nativePdfStats!.engineUnavailableReason ?? "engine unavailable", agreement: null, nativeMs: null };
                    } else {
                      const referencePages = winningText.split("\f");
                      const shadowRows = await runNativePdfShadow({
                          engine: nativeEngine,
                          sourcePath: tempFile,
                          documentId: document.id,
                          stageName: this.name,
                          referencePages: referencePages.length === pageCount ? referencePages : null,
                          referenceText: winningText,
                          referenceExtractor: winningCandidate.label,
                          signal: withTimeoutSignal(signal, Math.max(30_000, this.cfg.parserArtifactTimeoutMs)),
                          emphasis: nativePdfEmphasisEnabled(),
                        });
                      state.pendingPerformance.push(...shadowRows);
                      nativePdfStats!.shadow = summarizeNativePdfShadow(shadowRows);
                    }
                  }
                  const sourceArtifactUri =
                    critique?.correctedTextUri ?? winningCandidate.textUri;
                  const canonicalDocument = buildCanonicalDocumentFromMarkdown({
                    documentId: document.id,
                    text: winningText,
                    pageCount: document.pageCount,
                    sourceArtifactUri,
                    extractor: winningCandidate.label,
                  });
                  // The VM extractor already reconstructs Markdown; do not silently parse it again on the host.
                  const parserArtifacts = winningCandidate.label === VM_PDF_EXTRACTOR_ID
                    ? []
                    : await this.buildParserArtifacts(
                        document,
                        format,
                        tempFile,
                        state,
                        { hasTablePages, nativePayloadOutcome: nativePdfStats?.parserPayload },
                        signal,
                      );
                  const parserEnrichedCanonicalDocument =
                    parserArtifacts.length > 0
                      ? enrichCanonicalDocumentWithBestParser(
                          canonicalDocument,
                          parserArtifacts.map((artifact) => ({
                            parser: artifact.parser,
                            payload: artifact.payload,
                            artifactUri: artifact.uri,
                          })),
                        )
                      : canonicalDocument;
                  const parserAwareCanonicalDocument = await this.enrichOfficeStructure({
                    format,
                    document: parserEnrichedCanonicalDocument,
                    documentId: document.id,
                    sourceTempFile: tempFile,
                    signal,
                  });
                  const parserScores =
                    parserArtifacts.length > 0
                      ? scoreParserEnrichments(
                          canonicalDocument,
                          parserArtifacts.map((artifact) => ({
                            parser: artifact.parser,
                            payload: artifact.payload,
                            artifactUri: artifact.uri,
                          })),
                        )
                      : [];
                  const imageCandidate = availableCandidates.find(candidate => candidate.plan.sandboxedPdf?.embeddedImages);
                  if (requestedImages && !imageCandidate) {
                    throw new Error("VM images unavailable; refusing local image enrichment fallback");
                  }
                  const graph = extractionConfig.enrich.length > 0
                    ? await this.enrichDocumentArtifacts({
                        document,
                        sourcePath: tempFile,
                        sourceHash: contentHash,
                        format,
                        targets: extractionConfig.enrich,
                        canContinue: () => !isCostCapExceeded(state),
                        reserveOrientation: () => reserveOrientationAttempt(state),
                        recordUsage: event => state.usageLedger.enqueue({ ...event,
                          metadata: { ...event.metadata, documentId: document.id, stage: "embedded-image-orientation" } }),
                        vmImages: imageCandidate ? { output: imageCandidate.tempTextPath, markdownPath: imageCandidate.tempTextPath } : undefined,
                        pageNumbers: allPages,
                        runId: state.run.id,
                        signal,
                      })
                    : null;
                  const canonicalKey = `${runArtifactRoot(state.run, document.userId)}/canonical/${document.id}.json`;
                  const parserEvalKey = `${runArtifactRoot(state.run, document.userId)}/parser-eval/${document.id}.json`;

                  await this.storage.putJson(manifestKey, {
                    documentId: document.id,
                    mode: "multi-strategy-voting",
                    tableAware,
                    strategy,
                    similarity,
                    needsVision,
                    textlessFallback,
                    textArtifactUri: winningCandidate.textUri,
                    candidates: [
                      candidateA
                        ? { label: candidateA.label, artifactUri: candidateA.textUri }
                        : null,
                      candidateB
                        ? { label: candidateB.label, artifactUri: candidateB.textUri }
                        : null,
                    ].filter(Boolean),
                    policyObservations: policyDecision.observations,
                    extractorAttempts: attemptLedger.snapshot(),
                    artifactGraphUri: graph?.manifestUri ?? null,
                    artifactGraphTargets: graph?.requestedTargets ?? [],
                    artifactGraphSteps: graph?.steps ?? [],
                    artifactGraphOutputCount: graph?.outputCount ?? 0,
                    artifactGraphLatencyMs: graph?.latencyMs ?? 0,
                    artifactGraphStats: graph?.stats ?? null,
                    preserve: {
                      tables: state.run.pipeline.preserveTables,
                      code: state.run.pipeline.preserveCode,
                    },
                    critique: critique
                      ? {
                          artifactUri: critique.critiqueArtifactUri,
                          reviewedPages: critique.reviewedPages,
                          acceptedPages: critique.acceptedPages,
                        }
                      : null,
                    plan: winningCandidate.plan,
                  });

                  await this.storage.putJson(heatmapKey, {
                    documentId: document.id,
                    pages: heatmapPages,
                  });
                  await this.storage.putJson(
                    canonicalKey,
                    parserAwareCanonicalDocument,
                  );
                  if (parserScores.length > 0) {
                    await this.storage.putJson(parserEvalKey, {
                      documentId: document.id,
                      selectedParser: parserAwareCanonicalDocument.source.parser,
                      totalBlocks: canonicalDocument.blocks.length,
                      candidates: parserScores.map((candidate) => ({
                        parser: candidate.parser,
                        matchedBlocks: candidate.matchedBlocks,
                        bboxBlocks: candidate.bboxBlocks,
                        pageBackedBlocks: candidate.pageBackedBlocks,
                        matchRatio: candidate.matchRatio,
                        bboxRatio: candidate.bboxRatio,
                        pageRatio: candidate.pageRatio,
                      })),
                    });
                  }

                  const contract = buildExtractionContract({
                    documentId: document.id,
                    markdown: winningText,
                    extractor: winningCandidate.label,
                    strategy,
                    extractionTimeMs: Date.now() - extractionStartedAt,
                    pageCount: document.pageCount,
                    canonicalDocument: parserAwareCanonicalDocument,
                  });
                  const contractKey = `${runArtifactRoot(state.run, document.userId)}/extraction/${document.id}.contract.json`;
                  await this.storage.putJson(contractKey, contract);

                  const artifactUri =
                    critique?.correctedTextUri ?? scanFill?.textUri ?? winningCandidate.textUri;
                  if (state.run.pipeline.summarize) {
                    const evidenceKey = `${runArtifactRoot(state.run, document.userId)}/summary-evidence/${document.id}.json`;
                    await this.storage.putJson(evidenceKey, buildSummaryEvidence({
                      text: winningText, pageCount: document.pageCount,
                      documentId: document.id, sourceUri: artifactUri,
                    }));
                    state.artifactLedger.recordDocument(document.id, "summary-evidence", this.storage.uri(evidenceKey));
                  }
                  const manifestUri = this.storage.uri(manifestKey);
                  const canonicalUri = this.storage.uri(canonicalKey);
                  const contractUri = this.storage.uri(contractKey);
                  const parserEvalUri =
                    parserScores.length > 0
                      ? this.storage.uri(parserEvalKey)
                      : null;
                  const hostPdfProbes = isPdf && (sandboxedPdfRoute || winningCandidate.label === VM_PDF_EXTRACTOR_ID)
                    ? "skipped-sandboxed-route" as const : isPdf ? "ran" as const : "not-pdf" as const;
                  const pageImageEvidenceUri = hostPdfProbes === "skipped-sandboxed-route"
                    ? this.skipHostPdfEvidence(document, "page-image-evidence", sandboxReason ?? "sandboxed-pdf-winner")
                    : await this.recordDocumentImageEvidence(document, tempFile, winningText, state, { isPdf, format }, signal);
                  // Every page OCR produced text for was read by a model: record the read per page, which is the only
                  // thing that bills a page Rich (db/page-base-fee.ts). Vision reading it too is the same page, charged
                  // once (the ledger keys a charge by run, document and page) and topped up for its output tokens.
                  const ocrReadPages = await this.recordOcrPageReads(state, document, {
                    format, isPdf, winningText, candidate: winningCandidate, sourcePath: tempFile,
                    sandboxedRoute: hostPdfProbes === "skipped-sandboxed-route",
                  }, signal);
                  registerHash(state, contentHash, artifactUri);

                  for (const parserArtifact of parserArtifacts) {
                    state.artifactLedger.recordDocument(
                      document.id,
                      `${parserArtifact.parser}-json`,
                      parserArtifact.uri,
                    );
                  }
                  state.artifactLedger.recordDocument(document.id, "markdown-manifest", manifestUri);
                  if (pageImageEvidenceUri) {
                    state.artifactLedger.recordDocument(document.id, "page-image-evidence", pageImageEvidenceUri);
                  }
                  if (graph) {
                    state.artifactLedger.recordDocument(document.id, "artifact-graph", graph.manifestUri);
                    // Exact child URIs are authorized and withheld by the existing artifact/PII guards.
                    for (const [index, uri] of (graph.artifactUris ?? []).entries()) {
                      state.artifactLedger.recordDocument(document.id, `embedded-image-artifact:${index}`, uri);
                    }
                  }
                  state.artifactLedger.recordDocument(document.id, "heatmap", this.storage.uri(heatmapKey));
                  state.artifactLedger.recordDocument(document.id, "canonical-document", canonicalUri);
                  state.artifactLedger.recordDocument(document.id, "extraction-contract", contractUri);
                  if (critique) {
                    state.artifactLedger.recordDocument(document.id, "markdown-critique", critique.critiqueArtifactUri);
                  }
                  if (parserEvalUri) {
                    state.artifactLedger.recordDocument(document.id, "parser-eval", parserEvalUri);
                  }
                  await this.recordDocumentTitle(state, document, format, tempFile, winningText);

                  state.pendingPerformance.push({
                    documentId: document.id,
                    scope: "document",
                    stageName: this.name,
                    metric: "extraction-strategy-similarity",
                    value: similarity,
                    unit: "ratio",
                    tags: ["document", "extraction", "voting"],
                    metadata: { strategy, needsVision },
                  });
                  state.pendingPerformance.push({
                    documentId: document.id,
                    scope: "document",
                    stageName: this.name,
                    metric: "extraction-plausibility",
                    value: plausibilityScore,
                    unit: "ratio",
                    tags: ["document", "extraction", "plausibility"],
                    metadata: {
                      strategy,
                      similarity,
                      charCount: winningText.length,
                      pageCount: document.pageCount,
                      critiqueAcceptedPages: critique?.acceptedPages.length ?? 0,
                    },
                  });
                  state.pendingPerformance.push({
                    documentId: document.id,
                    scope: "document",
                    stageName: this.name,
                    metric: "heatmap-generated",
                    value: heatmapPages.length,
                    unit: "pages",
                    tags: ["document", "extraction", "heatmap"],
                    metadata: { strategy },
                  });
                  state.pendingPerformance.push({
                    documentId: document.id,
                    scope: "document",
                    stageName: this.name,
                    metric: "canonical-block-count",
                    value: canonicalDocument.stats.blockCount,
                    unit: "block",
                    tags: ["document", "canonical", "structure"],
                    metadata: {
                      headings: canonicalDocument.stats.headingCount,
                      tables: canonicalDocument.stats.tableCount,
                      codeBlocks: canonicalDocument.stats.codeBlockCount,
                      artifactUri: canonicalUri,
                      parser: parserAwareCanonicalDocument.source.parser,
                      parserBackedBboxes:
                        parserAwareCanonicalDocument.blocks.filter(
                          (block) => block.bbox,
                        ).length,
                    },
                  });
                  for (const candidate of parserScores) {
                    state.pendingPerformance.push({
                      documentId: document.id,
                      scope: "document",
                      stageName: this.name,
                      metric: "parser-match-ratio",
                      value: candidate.matchRatio,
                      unit: "ratio",
                      tags: ["document", "parser", candidate.parser],
                      metadata: {
                        parser: candidate.parser,
                        matchedBlocks: candidate.matchedBlocks,
                        totalBlocks: canonicalDocument.blocks.length,
                        parserEvalUri,
                      },
                    });
                    state.pendingPerformance.push({
                      documentId: document.id,
                      scope: "document",
                      stageName: this.name,
                      metric: "parser-bbox-ratio",
                      value: candidate.bboxRatio,
                      unit: "ratio",
                      tags: ["document", "parser", candidate.parser, "bbox"],
                      metadata: {
                        parser: candidate.parser,
                        bboxBlocks: candidate.bboxBlocks,
                        totalBlocks: canonicalDocument.blocks.length,
                        parserEvalUri,
                      },
                    });
                  }
                  for (const candidate of parserScores) {
                    const parserArtifact = parserArtifacts.find(
                      (artifact) => artifact.parser === candidate.parser,
                    );
                    state.pendingParserEvaluations.push({
                      userId: document.userId,
                      runId: state.run.id,
                      documentId: document.id,
                      stageName: this.name,
                      parser: candidate.parser,
                      matchedBlocks: candidate.matchedBlocks,
                      bboxBlocks: candidate.bboxBlocks,
                      pageBackedBlocks: candidate.pageBackedBlocks,
                      matchRatio: candidate.matchRatio,
                      bboxRatio: candidate.bboxRatio,
                      pageRatio: candidate.pageRatio,
                      selected:
                        parserAwareCanonicalDocument.source.parser ===
                        candidate.parser,
                      artifactUri: parserEvalUri,
                      metadata: {
                        parserArtifactUri: parserArtifact?.uri ?? null,
                      },
                    });
                  }

                  // A multi-frame image's page basis grows once OCR counts its frames: progress and stats cover every frame.
                  const countedPages = Math.max(pageCount, document.pageCount);
                  const processedPages = countedPages > pageCount
                    ? [...remaining, ...Array.from({ length: countedPages - pageCount }, (_, index) => pageCount + index + 1)]
                    : remaining;
                  await completeDocumentPages(state, document, this.name, processedPages, countedPages);

                  console.log(
                    `[extract-debug] document=${document.id} completed ` +
                      `strategy=${strategy} plausibilityScore=${plausibilityScore.toFixed(3)} ` +
                      `artifactUri=${artifactUri}`,
                  );

                  const completedResult: DocumentStageResult = {
                    artifactUri,
                    stats: {
                      strategy,
                      similarity,
                      needsVision,
                      textlessFallback,
                      plausibilityScore,
                      manifestUri,
                      artifactGraphUri: graph?.manifestUri ?? null,
                      artifactGraphTargets: graph?.requestedTargets ?? [],
                      artifactGraphTargetIds: graph?.targetIds ?? [],
                      artifactGraphSteps: graph?.steps ?? [],
                      artifactGraphOutputCount: graph?.outputCount ?? 0,
                      artifactGraphLatencyMs: graph?.latencyMs ?? 0,
                      artifactGraphStats: graph?.stats ?? null,
                      canonicalUri,
                      parserArtifactUri:
                        parserAwareCanonicalDocument.source.parserArtifactUri,
                      parserEvalUri,
                      critiqueArtifactUri: critique?.critiqueArtifactUri ?? null,
                      critiqueReviewedPages: critique?.reviewedPages ?? [],
                      critiqueAcceptedPages: critique?.acceptedPages ?? [],
                      preserveTables: state.run.pipeline.preserveTables,
                      preserveCode: state.run.pipeline.preserveCode,
                      skippedPages: completedPages.size,
                      processedPages: processedPages.length,
                      pageCount: countedPages,
                      // Office, EPUB and spreadsheet files: the pages they bill (counted from the extractor's output) and how.
                      billingPages: measuredPages.pages,
                      billingPagesMethod: measuredPages.method,
                      // Which extractor served the document, what else was planned or tried, and how the
                      // native PDF engine took part: queryable from stage stats without fetching the manifest.
                      extractor: winningCandidate.label,
                      secondaryExtractor: plannedExtractors.secondary?.label ?? null,
                      extractorOrder: this.tryResolveExtractorOrder(format, extractionConfig.order),
                      extractorAttempts: attemptLedger.snapshot(),
                      retryStrategy: retryStrategy ?? "default",
                      extractionMs: Date.now() - extractionStartedAt,
                      nativePdf: nativePdfStats,
                      // Host poppler probes (page facts, page-image evidence, OCR-ledger text layer) for this PDF.
                      hostPdfProbes,
                      ...ocrReadStats(ocrReadPages, winningCandidate.ocrPages ? "extractor-reported" : "inferred", scanFill?.pages ?? [], ocrFailedPages(state.artifactLedger, document.id).size),
                    },
                  };
                  const attemptsSnapshot = attemptLedger.snapshot();
                  reportExtractionDecision({
                    documentId: document.id,
                    format,
                    extractor: winningCandidate.label,
                    strategy,
                    extractorOrder: this.tryResolveExtractorOrder(format, extractionConfig.order),
                    attempted: attemptsSnapshot.attempted,
                    unavailable: attemptsSnapshot.unavailable,
                    nativePdf: nativePdfStats,
                  });
                  lastUsableResult = completedResult;
                  return completedResult;
                } finally {
                  await Promise.all([
                    this.cleanupCandidate(candidateA),
                    this.cleanupCandidate(candidateB),
                  ]);
                }
              } catch (error) {
                rethrowIfTeardown(error);
                const message = error instanceof Error ? error.message : String(error);
                console.error(
                  `[extract-error] stage=${this.name} document=${document.id} ` +
                    `message=${message} partialArtifact=${partialArtifactUri || "none"} ` +
                    `partialStats=${JSON.stringify(partialStats)}`,
                );
                // Rethrow interruptions untouched so they keep their AbortError/cancellation identity.
                // OCR could not run (VM creation, capacity, a deadline): the activity retries; the document is not at fault.
                const ocrInfrastructure = findOcrInfrastructureError(error);
                if (ocrInfrastructure) throw ocrInfrastructure;
                if (!partialArtifactUri && !signal?.aborted && isDocumentLevelFailure(error, signal)) {
                  // Every extractor failed: keep what was planned and tried, and say so in telemetry.
                  const attempts = attemptLedger.snapshot();
                  reportExtractionDecision({
                    documentId: document.id,
                    format,
                    extractor: "none",
                    strategy: "failed",
                    extractorOrder: this.tryResolveExtractorOrder(format, extractionConfig.order),
                    attempted: attempts.attempted,
                    unavailable: attempts.unavailable,
                    nativePdf: null,
                  });
                  const stageError = new DocumentStageError(message, {
                    stats: {
                      failedAt: "extract-markdown",
                      error: message,
                      extractor: "none",
                      extractorOrder: this.tryResolveExtractorOrder(format, extractionConfig.order),
                      extractorAttempts: attempts,
                      nativePdfExtraction: format === "pdf" ? nativeExtraction : null,
                    },
                  });
                  (stageError as Error & { cause?: unknown }).cause = error;
                  throw stageError;
                }
                if (partialArtifactUri && !signal?.aborted) {
                  throw new DocumentStageError(message, {
                    artifactUri: partialArtifactUri,
                    stats: {
                      ...partialStats,
                      failedAt: "extract-markdown",
                      error: message,
                      extractorOrder: this.tryResolveExtractorOrder(format, extractionConfig.order),
                      extractorAttempts: attemptLedger.snapshot(),
                    },
                  });
                }
                throw error;
              } finally {
                await Promise.all(candidateDirs.map((dir) => rm(dir, { recursive: true, force: true })));
              }
            },
            signal,
            {
              retryStrategies: this.tryResolveExtractorOrder(format, extractionConfig.order).slice(1),
            },
          );
        } finally {
          await pageFacts;
          this.imageListings.delete(this.imageListingKey(state, document));
          this.textLayerListings.delete(this.imageListingKey(state, document));
        }
      },
    );
  }

  /**
   * Derives the display title from the extracted Markdown (plus the HTML <title>/og:title,
   * read from the local source without a subprocess) and stores it once per document.
   * The title is untrusted document content for display only; it is never fed to a model.
   * Best effort: a failure is logged and never fails extraction.
   */
  private async recordDocumentTitle(
    state: import("../pipeline/pipeline.js").WorkflowState,
    document: import("../models.js").Document,
    format: string,
    sourcePath: string,
    markdown: string,
  ): Promise<void> {
    if (!state.store?.setDocumentTitleIfAbsent) return;
    try {
      const metadataTitles = format === "html" ? [htmlDocumentTitle(await readFileHead(sourcePath, 256 * 1024))] : [];
      const derived = deriveDocumentTitle({
        metadataTitles,
        pages: (splitTextIntoPagesStrict(markdown, document.pageCount) ?? [markdown]).slice(0, 2),
        filename: document.filename,
      });
      if (!derived) return;
      const written = await state.store.setDocumentTitleIfAbsent(document.id, derived);
      console.log(`[extract-debug] document=${document.id} title-source=${derived.source} title-written=${written}`);
    } catch (error) {
      console.warn(`[extract-markdown] title derivation failed document=${document.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Pending `pdfimages -list` runs from page facts, per run and document, shared with page triage. */
  private readonly imageListings = new Map<string, { lastPage: number; stdout: Promise<string | null> }>();
  /** Pending `pdftotext` runs from page facts (the native text layer), shared with page triage. */
  private readonly textLayerListings = new Map<string, { lastPage: number; stdout: Promise<string | null> }>();

  private imageListingKey(
    state: import("../pipeline/pipeline.js").WorkflowState,
    document: import("../models.js").Document,
  ): string {
    return `${state.run.id}:${document.id}`;
  }

  /**
   * The PDF's own text layer per page from page facts' pdftotext run, or null when page facts
   * did not run or failed. OCR text from the extractor is word-shaped, so page triage needs the
   * text layer to see that an OCR'd scan is still a raster page.
   */
  private async textLayerPages(
    state: import("../pipeline/pipeline.js").WorkflowState,
    document: import("../models.js").Document,
  ): Promise<string[] | null> {
    const listing = this.textLayerListings.get(this.imageListingKey(state, document));
    if (!listing) return null;
    const stdout = await listing.stdout.catch(() => null);
    return stdout === null ? null : splitFormFeedPages(stdout, listing.lastPage);
  }

  /**
   * OCR the PDF pages whose extracted text has no words, in the configured OCR boundary (in `vm` mode the VM renders the
   * pages from the stored PDF; the host renders nothing for OCR), and splice the text into those page slots. Returns null
   * when no page needs it or OCR does not read PDFs here (`off`, or `hosted`, which never renders on the host); those
   * pages stay unread and are logged. A failed read throws: the document fails rather than going to another reader.
   */
  private async ocrScannedPdfPages(
    state: import("../pipeline/pipeline.js").WorkflowState,
    document: import("../models.js").Document,
    args: { sourcePath: string; text: string; textKey: string; ocrLanguage?: string; contentHash: string },
    signal?: AbortSignal,
  ): Promise<{ text: string; textUri: string; pages: number[] } | null> {
    const pageCount = Math.max(1, Math.trunc(document.pageCount) || 1);
    // A fully scanned PDF often comes back as no text at all (some extractors add page breaks only around text): every page
    // is empty then.
    const split = splitFormFeedPages(args.text, pageCount)
      ?? (pageCount === 1 ? [args.text] : !/[\p{L}\p{N}]/u.test(ocrLedgerPageText(args.text)) ? Array<string>(pageCount).fill("") : null);
    if (!split) {
      console.error(`[ocr] scanned-pages-unread document=${document.id} reason=no-page-breaks: the extracted text has no reliable page breaks`);
      pushPerfMetric({ metric: "ocr-pages-refused", value: 1, unit: "count", tags: ["ocr", "no-page-breaks"], metadata: { documentId: document.id } });
      return null;
    }
    const hasWords = (text: string | undefined) => /[\p{L}\p{N}]/u.test(ocrLedgerPageText(text ?? ""));
    const empty = split.map((text, index) => (hasWords(text) ? 0 : index + 1)).filter((page) => page > 0);
    if (empty.length === 0) return null;
    const mode = resolveOcrMode();
    if (mode === "off" || mode === "hosted") {
      console.error(`[ocr] scanned-pages-unread document=${document.id} pages=${empty.length} mode=${mode}: ${mode === "hosted" ? "hosted OCR never renders PDF pages on the host" : "OCR is off"}`);
      pushPerfMetric({ metric: "ocr-pages-refused", value: empty.length, unit: "count", tags: ["ocr", mode], metadata: { documentId: document.id } });
      return null;
    }
    const pages = [...split];
    const read: number[] = [];
    const hostedReader = createHostedOcrReader({ state, cfg: this.cfg, runner: this.runner });
    const failed: number[] = [];
    let consecutiveFailedBatches = 0;
    for (let start = 0; start < empty.length; start += OCR_PDF_BATCH_PAGES) {
      const batch = empty.slice(start, start + OCR_PDF_BATCH_PAGES);
      let result: Awaited<ReturnType<typeof ocrDocument>>;
      try {
        result = await ocrDocument({
          runner: this.runner, state, documentId: document.id, source: args.sourcePath, kind: "pdf", pages: batch,
          ...(args.ocrLanguage ? { languageSetting: args.ocrLanguage } : {}),
          hostedReader, stage: this.name, ...(signal ? { signal } : {}),
        });
      } catch (error) {
        rethrowIfTeardown(error);
        if (signal?.aborted) throw error;
        // The boundary could not run (VM creation, capacity, a deadline): the activity fails retryably and Temporal backs
        // off, rather than failing pages that were never tried. Pages already read are charged once per page per run.
        if (error instanceof OcrInfrastructureError) {
          console.error(`[ocr] scanned-pages-infrastructure document=${document.id} pages=${batch.join(",")} reason=${error.message.slice(0, 300)}`);
          throw error;
        }
        // A deterministic refusal (validation, model pin, hostile input, OCR refused by configuration): those pages fail,
        // loudly, without another read of the same bytes; the document's text pages stand. Nothing else reads them.
        failed.push(...batch);
        consecutiveFailedBatches += 1;
        console.error(`[ocr] scanned-pages-failed document=${document.id} pages=${batch.join(",")} reason=${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
        pushPerfMetric({ metric: "ocr-pages-failed", value: batch.length, unit: "count", tags: ["ocr"], metadata: { documentId: document.id } });
        if (consecutiveFailedBatches >= OCR_MAX_CONSECUTIVE_FAILED_BATCHES) {
          // The same refusal is coming back batch after batch (a refused document, a broken pin): stop spending VMs on it.
          const rest = empty.slice(start + OCR_PDF_BATCH_PAGES);
          failed.push(...rest);
          console.error(`[ocr] scanned-pages-stopped document=${document.id} after=${consecutiveFailedBatches} failed batches; ${rest.length} remaining pages failed unread`);
          if (rest.length) pushPerfMetric({ metric: "ocr-pages-failed", value: rest.length, unit: "count", tags: ["ocr", "stopped"], metadata: { documentId: document.id } });
          break;
        }
        continue;
      }
      consecutiveFailedBatches = 0;
      // Pages the boundary did not reach (past its frame cap) fail; none is left neither read nor failed.
      if (result.unreadPages.length) {
        failed.push(...result.unreadPages);
        console.error(`[ocr] scanned-pages-unreached document=${document.id} pages=${result.unreadPages.join(",")}`);
      }
      for (const page of result.pages) {
        if (page.pageNumber >= 1 && page.pageNumber <= pageCount && hasWords(page.text)) {
          pages[page.pageNumber - 1] = page.text;
          read.push(page.pageNumber);
        }
      }
    }
    if (failed.length > 0) {
      // Vision must not read these pages in OCR's place (vision-extract excludes them).
      const list = recordOcrFailedPages(state, document.id, failed);
      // A later document with the same bytes reuses this Markdown (checkDedup): it inherits the failed pages too.
      state.artifactLedger.record(`${OCR_FAILED_PAGES_KEY}:${args.contentHash}`, list);
    }
    // Every page is a scan and none could be read: the document has no text, so it fails rather than publishing nothing.
    if (failed.length > 0 && failed.length === pageCount) throw new Error(`OCR failed for every page (${pageCount}) of a scanned document`);
    if (read.length === 0) return null;
    const text = pages.join("\f");
    const key = `${args.textKey}.ocr.md`;
    await this.storage.putBytes(key, Buffer.from(text, "utf8"), "text/markdown; charset=utf-8");
    console.log(`[ocr] document=${document.id} scanned pages read=${read.length}/${empty.length}`);
    return { text, textUri: this.storage.uri(key), pages: read };
  }

  /**
   * Records the Rich read of every page OCR produced text for, exactly once per page per run (the ledger keys a charge by run,
   * document and page; a retry re-records the same pages under the same ids). An unknown fact never raises a charge.
   *
   * - A winner the OCR engine produced (the `ocr` extractor: an image, every frame of a multi-frame TIFF): the engine already
   *   charged each page it read with words (ocr/ledger.ts); nothing more is recorded here.
   * - A PDF whose winning candidate reports the pages it OCR'd (graph-local's OCR adapter, the sandboxed PDF provider):
   *   exactly those pages, within the page count. Nothing is inferred on top.
   * - The sandboxed route with no report: nothing. The host never probes the PDF for that route.
   * - Otherwise, only when the winner ran OCR (candidateRanUnreportedOcr) and its text has reliable form-feed page breaks: a page
   *   whose native text layer (poppler's `pdftotext`, from page facts or run here) has no words while the extracted page does.
   * Words exclude image references and page markers. Fast never reads a page with a model, so it records nothing. Never throws:
   * a failed probe is logged loudly (`[ocr-ledger] probe-failed`) and bills nothing.
   */
  private async recordOcrPageReads(
    state: import("../pipeline/pipeline.js").WorkflowState,
    document: import("../models.js").Document,
    args: { format: string; isPdf: boolean; winningText: string; candidate: ExtractedCandidate; sourcePath: string; sandboxedRoute?: boolean },
    signal?: AbortSignal,
  ): Promise<number[]> {
    if (!qualityAllowsPageReading(state.run.pipeline.quality)) return [];
    if (args.candidate.ocrCharged) return [...(args.candidate.ocrPages ?? [])].sort((a, b) => a - b);
    const hasWords = (text: string | null | undefined) => /[\p{L}\p{N}]/u.test(ocrLedgerPageText(text));
    const pages = new Set<number>();
    let reported = false;
    if (args.format === "image") {
      // Images are read only by the OCR engine, which charges its own pages; any other winner read nothing.
    } else if (args.isPdf) {
      const pageCount = Math.max(1, Math.trunc(document.pageCount) || 1);
      const sandboxed = args.sandboxedRoute === true || args.candidate.label === VM_PDF_EXTRACTOR_ID;
      if (args.candidate.ocrPages) {
        reported = true;
        for (const page of args.candidate.ocrPages) if (Number.isSafeInteger(page) && page >= 1 && page <= pageCount) pages.add(page);
      } else if (sandboxed) {
        console.log(`[ocr-ledger] document=${document.id} extractor=${args.candidate.label} reported no OCR pages; none recorded`);
      } else if (candidateRanUnreportedOcr(args.candidate)) {
        const extracted = splitFormFeedPages(args.winningText, pageCount);
        if (!extracted) {
          console.log(`[ocr-ledger] document=${document.id} extractor=${args.candidate.label} text has no reliable page breaks; no OCR reads recorded`);
        } else if (extracted.some((page) => hasWords(page))) {
          try {
            const native = await this.nativeTextLayerPages(state, document, args.sourcePath, pageCount, signal);
            if (native) {
              for (let page = 1; page <= pageCount; page += 1) {
                if (!hasWords(native[page - 1]) && hasWords(extracted[page - 1])) pages.add(page);
              }
            } else {
              this.ocrLedgerProbeFailed(document, args.candidate.label, "native text layer unavailable");
            }
          } catch (error) {
            rethrowIfTeardown(error);
            if (signal?.aborted) throw error;
            this.ocrLedgerProbeFailed(document, args.candidate.label, error instanceof Error ? error.message : String(error));
          }
        }
      }
    }
    for (const pageNumber of [...pages].sort((a, b) => a - b)) {
      state.usageLedger.chargeRichPage({ documentId: document.id, pageNumber, readBy: reported ? "page-ocr" : "pdf-ocr", model: args.candidate.label });
    }
    return [...pages].sort((a, b) => a - b);
  }

  /** A text-layer probe failed for an OCR-capable winner: its scanned-page reads go unbilled, so say so loudly. */
  private ocrLedgerProbeFailed(document: import("../models.js").Document, extractor: string, reason: string): void {
    console.warn(`[ocr-ledger] probe-failed document=${document.id} extractor=${extractor} reason=${reason.slice(0, 300)}; scanned-page OCR reads are not recorded`);
    pushPerfMetric({ metric: "ocr-ledger-probe-failed", value: 1, unit: "count", tags: ["ocr-ledger", extractor], metadata: { documentId: document.id } });
  }

  /** The PDF's own text layer per page (page facts' pdftotext run, else one run here), or null when neither is available. */
  private async nativeTextLayerPages(
    state: import("../pipeline/pipeline.js").WorkflowState,
    document: import("../models.js").Document,
    sourcePath: string,
    pageCount: number,
    signal?: AbortSignal,
  ): Promise<string[] | null> {
    const fromFacts = await this.textLayerPages(state, document);
    if (fromFacts && fromFacts.length >= pageCount) return fromFacts;
    const plan = await this.runner.pageText(sourcePath, pageCount);
    if (!plan.available) return null;
    const result = await this.runner.run({ ...plan, pages: pageCount, timeoutMs: OCR_LEDGER_PROBE_TIMEOUT_MS }, signal);
    return splitFormFeedPages(result.stdout, pageCount);
  }

  /**
   * Raster evidence for classify-route: PDFs get page triage (`pdfimages`), and with routing v2
   * an uploaded image gets one full-page raster page (`image-file`). Null when vision fallback is
   * off or the format has none.
   */
  async recordDocumentImageEvidence(
    document: import("../models.js").Document,
    sourcePath: string,
    winningText: string,
    state: import("../pipeline/pipeline.js").WorkflowState,
    source: { isPdf: boolean; format: string },
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!state.run.pipeline.visionFallback) return null;
    if (source.isPdf) return await this.recordPageImageEvidence(document, sourcePath, winningText, state, signal);
    if (source.format === "image" && resolveRunRoutingV2(state)) {
      return await this.storePageImageEvidence(document, state, imageFilePageEvidence(), "image-file");
    }
    return null;
  }

  /**
   * (File bytes - every embedded image's bytes) / pages, from page facts' whole-document
   * `pdfimages -list` run; null when that listing is missing, failed or stops short of the last
   * page (the drawn-content hint then stays off rather than counting unlisted images as drawing).
   */
  private async drawnBytesPerPage(
    state: import("../pipeline/pipeline.js").WorkflowState,
    document: import("../models.js").Document,
    sourcePath: string,
  ): Promise<number | null> {
    const pageCount = Math.max(1, document.pageCount);
    const listing = this.imageListings.get(this.imageListingKey(state, document));
    if (!listing || listing.lastPage < pageCount) return null;
    const stdout = await listing.stdout.catch(() => null);
    if (stdout === null) return null;
    const fileBytes = await stat(sourcePath).then((info) => info.size).catch(() => null);
    return drawnBytesPerPage(fileBytes, totalEmbeddedImageBytes(stdout), pageCount);
  }

  private async storePageImageEvidence(
    document: import("../models.js").Document,
    state: import("../pipeline/pipeline.js").WorkflowState,
    pages: PageImageEvidence[],
    source: PageImageEvidenceArtifact["source"],
    drawnBytesPerPage: number | null = null,
  ): Promise<string> {
    const artifact: PageImageEvidenceArtifact = {
      documentId: document.id,
      source,
      sparsePageWords: SPARSE_PAGE_WORDS,
      drawnBytesPerPage,
      pages,
    };
    const key = `${runArtifactRoot(state.run, document.userId)}/page-image-evidence/${document.id}.json`;
    await this.storage.putJson(key, artifact);
    console.log(
      `[extract-debug] document=${document.id} pageImageEvidence source=${source} sparsePages=${pages.length} ` +
        `withImages=${pages.filter((page) => page.imageCount > 0).length}`,
    );
    return this.storage.uri(key);
  }

  /**
   * Raster evidence for PDF pages with no or almost no native text (see
   * lib/page-image-evidence.ts), persisted for classify-route. Optional: any failure
   * leaves triage on text evidence alone.
   */
  private async recordPageImageEvidence(
    document: import("../models.js").Document,
    sourcePath: string,
    winningText: string,
    state: import("../pipeline/pipeline.js").WorkflowState,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const pageTexts = pageAlignedTexts(winningText, Math.max(1, document.pageCount));
    if (!pageTexts) return null;
    try {
      const pages = await collectPageImageEvidence({
        runner: this.runner,
        sourcePath,
        pageTexts,
        signal,
        sharedImagesList: this.imageListings.get(this.imageListingKey(state, document)),
        // Evidence routing counts native words from the PDF's own text layer, so an OCR'd scan stays sparse, and
        // judges the layer's quality (a suspect layer is cross-checked against an OCR of its page).
        ...(resolveRunRoutingV2(state)
          ? {
              textLayerPages: await this.textLayerPages(state, document),
              // No OCR cross-check of suspect text layers: it was tuned against the previous recogniser and stays off until re-tuned
              // for the PP-OCR recogniser (docs/page-text-layer-quality.md). Suspect layers stay unverified.
            }
          : {}),
      });
      if (!pages) return null;
      return await this.storePageImageEvidence(document, state, pages, "pdfimages",
        await this.drawnBytesPerPage(state, document, sourcePath));
    } catch (error) {
      rethrowIfTeardown(error);
      if (signal?.aborted) throw error;
      console.warn(
        `[extract-markdown] page image evidence unavailable document=${document.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Why this PDF is kept off the host, or null when it is not: `sandboxed-pdf-deployment` when the deployment is sandboxed
   * (registry.resolve then refuses any other extractor, so the PDF goes to vm-pdf or fails), `sandboxed-pdf-route` when the
   * workspace's order names vm-pdf on a deployment that would otherwise parse on the host. Host-side evidence probes are
   * skipped in both cases, even if a later fallback wins.
   */
  private pdfSandboxReason(format: string, configured: Partial<Record<string, string[]>>): "sandboxed-pdf-deployment" | "sandboxed-pdf-route" | null {
    if (format !== "pdf") return null;
    if (resolvePdfExtractorSetting() === VM_PDF_EXTRACTOR_ID || sandboxedPdfConfigured()) return "sandboxed-pdf-deployment";
    return this.tryResolveExtractorOrder(format, configured).includes(VM_PDF_EXTRACTOR_ID) ? "sandboxed-pdf-route" : null;
  }

  /** Host PDF evidence the sandboxed route does without; logged with the reason so the gap is visible. */
  private skipHostPdfEvidence(document: import("../models.js").Document, what: "page-facts" | "page-image-evidence", reason: string | null): null {
    console.log(`[extract-debug] document=${document.id} ${what}=skipped reason=${reason ?? "sandboxed-pdf-route"}`);
    return null;
  }

  /** Text-layer bytes and image counts per page (PDF), or one image page (image files). */
  private async recordSourcePageFacts(
    state: import("../pipeline/pipeline.js").WorkflowState,
    document: import("../models.js").Document,
    format: string,
    signal?: AbortSignal,
    sandboxedPdfRoute = false,
    sandboxReason: string | null = null,
  ): Promise<void> {
    if (!pageFactsEnabled() || !state.store?.upsertPageFacts) return;
    if (format === "pdf" && sandboxedPdfRoute) {
      this.skipHostPdfEvidence(document, "page-facts", sandboxReason);
      return;
    }
    // A resumed run skips a completed extraction; its facts were recorded then.
    if (state.documentStage(document.id, this.name)?.status === "completed") return;
    try {
      if (format === "image") {
        await recordPageFacts(state.store, [{
          documentId: document.id, runId: state.run.id, pageNumber: 1,
          textBytes: 0, wordCount: 0, imageCount: 1, factsSource: "image-file",
        }]);
        return;
      }
      if (format !== "pdf") return;
      const source = await this.sources.get(document);
      const rows = await probePdfPageFacts({
        runner: this.runner,
        sourcePath: source.path,
        documentId: document.id,
        runId: state.run.id,
        pageCount: Math.max(1, document.pageCount),
        signal,
        // Page triage (recordPageImageEvidence) reuses this pdfimages run instead of a second one.
        onImagesList: (listing) => this.imageListings.set(this.imageListingKey(state, document), listing),
        onPageText: (listing) => this.textLayerListings.set(this.imageListingKey(state, document), listing),
      });
      await recordPageFacts(state.store, rows);
    } catch (error) {
      rethrowIfTeardown(error);
      console.warn(`[page-facts] skipped document=${document.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async extractCandidate(
    extractor: PreparedExtractor,
    textKey: string,
    sourceTempFile: string,
    signal?: AbortSignal,
    graphContext?: CandidateContext,
  ): Promise<ExtractedCandidate> {
    return extractor.execute(this.candidateExecutors(graphContext), textKey, sourceTempFile, signal);
  }

  private candidateExecutors(
    graphContext?: CandidateContext,
  ): CandidateExecutors {
    return {
      stream: (plan, label, key, abort) => this.extractStreamCandidate(plan, label, key, abort),
      file: (plan, label, key, outputPath, abort) => this.extractFileCandidate(plan, label, key, outputPath, abort, graphContext?.documentId),
      graph: (candidate, key, source, abort) => this.extractGraphCandidate(candidate, key, source, graphContext, abort),
      markdownFile: (candidate, key, outputPath) => this.uploadMarkdownFileCandidate(candidate, key, outputPath),
      ocr: (candidate, key, source, abort) => this.extractOcrCandidate(candidate, key, source, graphContext, abort),
    };
  }

  /**
   * An image's text from the OCR engine (every frame of a multi-frame TIFF, pages joined by form feeds), read in the
   * configured boundary and charged per page there. Escalation reads go through the guarded vision path. Any refusal or
   * failure throws: the stage fails the image rather than handing it to another reader.
   */
  private async extractOcrCandidate(
    extractor: PreparedExtractor,
    textKey: string,
    sourcePath: string,
    context: CandidateContext | undefined,
    signal?: AbortSignal,
  ): Promise<ExtractedCandidate> {
    if (!context?.state) throw new Error("ocr extraction requires the run state");
    const state = context.state;
    // The read starts a VM: authorized before it (cost cap, balance for its Rich page), not only after the frames are counted.
    await authorizeImageRead(state, context.documentId);
    const result = await ocrDocument({
      runner: this.runner,
      state,
      documentId: context.documentId,
      source: sourcePath,
      kind: "image",
      mimeType: context.mimeType ?? null,
      ...(context.ocrLanguage ? { languageSetting: context.ocrLanguage } : {}),
      hostedReader: createHostedOcrReader({ state, cfg: this.cfg, runner: this.runner }),
      stage: this.name,
      // Each frame read is a page of the document (intake counted the image as one): recorded, and its extra Rich frames checked
      // against the balance, before anything is charged.
      beforeCharging: (frames) => authorizeImageFrames(state, context.documentId, this.name, frames),
      // The VM reads no more frames than the run can pay for.
      frameBudget: (max) => affordableImageFrames(state, context.documentId, max),
      ...(signal ? { signal } : {}),
    });
    const markdown = result.pages.map((page) => page.text).join("\f");
    const scratchDir = await mkdtemp(path.join(tmpdir(), "docslurp-extract-ocr-"));
    const outputPath = path.join(scratchDir, "ocr.md");
    try {
      await writeFile(outputPath, markdown, "utf8");
      const candidate = await this.uploadMarkdownFileCandidate(extractor, textKey, outputPath);
      return { ...candidate, ocrPages: result.chargedPages, ocrCharged: true };
    } catch (error) {
      await rm(scratchDir, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Fast keeps an image unread (no OCR on Fast): a stand-in extractor whose empty Markdown keeps the image as its page
   * image. It is never a stand-in for OCR that failed or is off; those fail the document. When the workspace cannot use
   * vision either, the image is unreadable: fail naming that cause. The raw diagnostic stays in the stored error and
   * logs; `publicDocumentError` never shows it to users.
   */
  private textlessImageExtractor(
    state: import("../pipeline/pipeline.js").WorkflowState,
    document: import("../models.js").Document,
    cause: string,
  ): PreparedExtractor {
    const pipeline = state.run.pipeline;
    // Fast keeps the image as its page image on purpose; nothing has to read it.
    const keptAsImage = !qualityAllowsPageReading(pipeline.quality);
    const visionAllowed =
      pipeline.visionFallback &&
      isProviderCallAllowed(pipeline.privacyMode, visionCall(resolveVisionRoute(pipeline.vision)));
    if (!visionAllowed && !keptAsImage) {
      console.error(
        `[extract-error] stage=${this.name} document=${document.id} image-unreadable ` +
          `visionFallback=${pipeline.visionFallback} privacyMode=${pipeline.privacyMode} cause=${cause}`,
      );
      throw new Error(`${DOCUMENT_FAILURE_MARKERS.imageNeedsVision} (${cause})`);
    }
    console.warn(
      `[extract-debug] stage=${this.name} document=${document.id} textless-image-to-vision cause=${cause}`,
    );
    const plan: CommandPlan = { binary: "in-process:image-textless", args: [], available: true };
    return {
      label: "image-textless",
      plan,
      tableAware: false,
      execute: async (_executors, textKey) => {
        const scratchDir = await mkdtemp(path.join(tmpdir(), "docslurp-extract-"));
        const tempTextPath = path.join(scratchDir, "image-textless.md");
        try {
          await writeFile(tempTextPath, "", "utf8");
          await this.storage.putBytes(textKey, new Uint8Array(0), "text/markdown; charset=utf-8");
        } catch (error) {
          await rm(scratchDir, { recursive: true, force: true });
          throw error;
        }
        return { label: "image-textless", plan, textKey, textUri: this.storage.uri(textKey), tempTextPath };
      },
    };
  }

  /** Upload Markdown an in-process extractor (e.g. JSON/JSONL) already wrote locally. */
  private async uploadMarkdownFileCandidate(
    extractor: PreparedExtractor,
    textKey: string,
    outputPath: string,
  ): Promise<ExtractedCandidate> {
    const upload = this.storage.createMultipartUploadStream(textKey, "text/markdown; charset=utf-8");
    await pipeline(createReadStream(outputPath), upload.writable);
    await upload.done;
    return {
      label: extractor.label,
      plan: extractor.plan,
      textKey,
      textUri: this.storage.uri(textKey),
      tempTextPath: outputPath,
    };
  }

  private async extractGraphCandidate(
    extractor: PreparedExtractor,
    textKey: string,
    sourcePath: string,
    context?: CandidateContext,
    signal?: AbortSignal,
  ): Promise<ExtractedCandidate> {
    if (!context) throw new Error("graph-local requires source hash and page count");
    const scratchDir = await mkdtemp(path.join(tmpdir(), "docslurp-extract-graph-"));
    try {
      const graph = await runLocalPdfArtifactGraph({
        sourcePath,
        sourceDocumentId: context.documentId,
        sha256: context.sourceHash,
        pageCount: context.pageCount,
        targetKinds: ["document/markdown"],
        scratchDir,
        ocrLanguage: context.ocrLanguage,
        signal,
      });
      const markdown = graph.targets.find((artifact) => artifact.kind === "document/markdown");
      if (!markdown) throw new Error("graph-local produced no document/markdown artifact");
      const upload = this.storage.createMultipartUploadStream(textKey, "text/markdown; charset=utf-8");
      await pipeline(createReadStream(markdown.uri), upload.writable);
      await upload.done;
      return {
        label: extractor.label,
        plan: extractor.plan,
        textKey,
        textUri: this.storage.uri(textKey),
        tempTextPath: markdown.uri,
        ...(graph.ocrPages?.length ? { ocrPages: [...graph.ocrPages] } : {}),
      };
    } catch (error) {
      await rm(scratchDir, { recursive: true, force: true });
      throw error;
    }
  }

  private async extractStreamCandidate(
    plan: CommandPlan,
    label: string,
    textKey: string,
    signal?: AbortSignal,
  ): Promise<ExtractedCandidate> {
    const scratchDir = await mkdtemp(path.join(tmpdir(), "docslurp-extract-"));
    const tempTextPath = path.join(scratchDir, `${label}.txt`);
    const fileWriter = createWriteStream(tempTextPath);
    const upload = this.storage.createMultipartUploadStream(
      textKey,
      "text/markdown; charset=utf-8",
    );
    const fanout = new FanoutWritable([fileWriter, upload.writable]);

    try {
      await this.runner.runToWritable(plan, fanout, signal);
      if (!fanout.writableFinished) {
        await once(fanout, "finish");
      }
      await upload.done;
      return {
        label: label,
        plan: plan,
        textKey,
        textUri: this.storage.uri(textKey),
        tempTextPath,
      };
    } catch (error) {
      await upload.done.catch(() => undefined);
      await rm(scratchDir, { recursive: true, force: true });
      throw error;
    }
  }

  private async extractFileCandidate(
    plan: CommandPlan,
    label: string,
    textKey: string,
    outputPath: string,
    signal?: AbortSignal,
    documentId?: string,
  ): Promise<ExtractedCandidate> {
    await this.runner.run(plan, signal);
    // Provider output is untrusted: a regular file of bounded size, checked before anything reads it.
    if (plan.sandboxedPdf) await assertSandboxedPdfMarkdownBounded(outputPath);
    // VM image output: put each routed-in image's reference at its reading-order position before the Markdown is stored.
    if (plan.sandboxedPdf?.embeddedImages) {
      if (!documentId) throw new Error("VM image references need the document id");
      const images = await requireSandboxedPdfProvider().embeddedImages!.read(outputPath, signal);
      await anchorImageMarkdownFile({ markdownPath: outputPath, images, sourceDocumentId: documentId });
    }

    const upload = this.storage.createMultipartUploadStream(
      textKey,
      "text/markdown; charset=utf-8",
    );
    await pipeline(createReadStream(outputPath), upload.writable);
    await upload.done;
    const ocrPages = plan.sandboxedPdf ? sandboxedPdfOcrPages(plan.sandboxedPdf) : undefined;

    return {
      label,
      plan,
      textKey,
      textUri: this.storage.uri(textKey),
      tempTextPath: outputPath,
      ...(ocrPages ? { ocrPages: [...ocrPages] } : {}),
    };
  }

  private async sanitizeCandidateArtifact(
    candidate: ExtractedCandidate,
  ): Promise<string> {
    const original = await readFile(candidate.tempTextPath, "utf8");
    const sanitized = sanitizeExtractedMarkdown(original);
    if (sanitized.strippedDataUriCount === 0 && sanitized.strippedFrontmatterLines === 0) {
      return original;
    }

    await writeFile(candidate.tempTextPath, sanitized.markdown, "utf8");
    await this.storage.streamText(
      candidate.textKey,
      sanitized.markdown,
      "text/markdown; charset=utf-8",
    );
    console.log(
      `[extract-sanitize] extractor=${candidate.label} ` +
        `dataUris=${sanitized.strippedDataUriCount} bytes=${sanitized.strippedDataUriBytes} ` +
        `frontmatterLines=${sanitized.strippedFrontmatterLines}`,
    );
    return sanitized.markdown;
  }

  private async cleanupCandidate(
    candidate: ExtractedCandidate | null,
  ): Promise<void> {
    if (!candidate) {
      return;
    }

    const directory = path.dirname(candidate.tempTextPath);
    if (path.basename(directory).startsWith("docslurp-extract-")) {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Two candidates that run at once each get a private copy of the source, prepared against it, in
   * a directory of its own: a candidate's command can write only its own directory, never the cached
   * source's directory that the other candidate (and every other command of the document) uses. Two
   * commands sharing a writable directory could meet on a UNIX socket there and pass descriptors,
   * one holding the other's stdout to defeat its teardown. A single or serialized candidate keeps
   * the cached source. The copy is a reflink where the filesystem supports it. `dirs` collects the
   * directories for the caller to remove.
   */
  private async isolateConcurrentCandidates(args: {
    mimeType?: string | null;
    primary: PreparedExtractor;
    secondary: PreparedExtractor | null;
    sourcePath: string;
    format: string;
    options: Record<string, unknown>;
    dirs: string[];
  }): Promise<{
    primary: { extractor: PreparedExtractor; source: string };
    secondary: { extractor: PreparedExtractor; source: string } | null;
  }> {
    // Every candidate, single, serialized or concurrent, gets its own copy: the cached source is
    // shared by every activity on this worker that processes the same key (a reprocess, a new
    // version) and stays read-only (sandbox/paths.ts), while extractors write beside their input.
    const registered = new Set(documentExtractorRegistry.list().map((descriptor) => descriptor.id));
    const isolate = async (extractor: PreparedExtractor) => {
      // In-process stand-ins (image-textless) run no command and are not in the registry.
      if (!registered.has(extractor.label)) return { extractor, source: args.sourcePath };
      const dir = await mkdtemp(path.join(tmpdir(), "docslurp-candidate-"));
      args.dirs.push(dir);
      const source = path.join(dir, path.basename(args.sourcePath));
      await copyFile(args.sourcePath, source, fsConstants.COPYFILE_FICLONE);
      const prepared = await documentExtractorRegistry.prepare(
        extractor.label,
        this.runner,
        source,
        serializeExtractorOptions(args.options, extractor.label),
        { format: args.format, mimeType: args.mimeType ?? null },
      );
      return { extractor: prepared, source };
    };
    // Settle both before failing: the caller removes `dirs` as soon as this throws, and a sibling
    // still copying would otherwise recreate its directory (or copy into a removed one) afterwards.
    const [primary, secondary] = await Promise.allSettled([
      isolate(args.primary),
      args.secondary ? isolate(args.secondary) : Promise.resolve(null),
    ]);
    if (primary.status === "rejected") throw primary.reason;
    if (secondary.status === "rejected") throw secondary.reason;
    return { primary: primary.value, secondary: secondary.value };
  }

  private async collectCandidateResults(args: {
    primary: PreparedExtractor;
    primaryKey: string;
    secondary: PreparedExtractor | null;
    secondaryKey: string | null;
    primarySource: string;
    secondarySource: string;
    graphContext: CandidateContext;
    signal?: AbortSignal;
  }): Promise<
    [
      PromiseSettledResult<ExtractedCandidate | null>,
      PromiseSettledResult<ExtractedCandidate | null>,
    ]
  > {
    const runPrimary = async () =>
      await this.extractCandidate(
        args.primary,
        args.primaryKey,
        args.primarySource,
        args.signal,
        args.graphContext,
      );
    const runSecondary = async () => {
      if (!args.secondary || !args.secondaryKey) {
        return null;
      }
      return await this.extractCandidate(
        args.secondary,
        args.secondaryKey,
        args.secondarySource,
        args.signal,
        args.graphContext,
      );
    };

    if (!args.secondary || !args.secondaryKey) {
      return [await settle(runPrimary()), { status: "fulfilled", value: null }];
    }

    if (!this.cfg.serializePdfCandidateExtraction) {
      return (await Promise.allSettled([runPrimary(), runSecondary()])) as [
        PromiseSettledResult<ExtractedCandidate | null>,
        PromiseSettledResult<ExtractedCandidate | null>,
      ];
    }

    const primary = await settle(runPrimary());
    const secondary = await settle(runSecondary());
    return [primary, secondary];
  }

  private async runSelfCritique(args: {
    state: import("../pipeline/pipeline.js").WorkflowState;
    document: import("../models.js").Document;
    sourceTempFile: string;
    strategy: string;
    winningText: string;
    winningTextUri: string;
    heatmapPages: PageHeatmapEntry[];
    signal?: AbortSignal;
  }): Promise<SelfCritiqueResult | null> {
    const maxCostCents = Number.parseFloat(
      process.env.DOCSLURP_CRITIQUE_MAX_COST_CENTS ?? "0",
    );
    if (!critiqueEnabled() || !Number.isFinite(maxCostCents) || maxCostCents <= 0) {
      return null;
    }
    // Self-critique re-reads page rasters with a vision model; fast never reads a page.
    if (!qualityAllowsPageReading(args.state.run.pipeline.quality)) {
      return null;
    }
    const maxCostPerPageCents = Number.parseFloat(
      process.env.DOCSLURP_CRITIQUE_MAX_COST_PER_PAGE_CENTS ??
        String(maxCostCents),
    );
    // Critique rewrites single pages and joins them with form feeds, which later stages trust as page breaks. Text
    // without reliable page breaks (the form feeds do not describe exactly `pageCount` pages) has no pages to
    // rewrite: skip the critique rather than invent boundaries.
    const pageTexts = splitTextIntoPagesStrict(args.winningText, Math.max(1, args.document.pageCount));
    if (pageTexts === null || pageTexts.length === 0) {
      console.warn(`[extract-markdown] self-critique skipped document=${args.document.id}: text has no reliable page breaks pageCount=${args.document.pageCount}`);
      return null;
    }
    // Pages whose OCR failed in its boundary stay failed: critique never re-reads them with a hosted model.
    const ocrFailed = ocrFailedPages(args.state.artifactLedger, args.document.id);
    const critiquePages = budgetCritiquePages(
      selectCritiquePages(args.heatmapPages).filter((page) => !ocrFailed.has(page)),
      maxCostCents,
      maxCostPerPageCents,
    );
    if (critiquePages.length === 0) {
      return null;
    }
    // Vision already stopped for the run (rejection breaker, org attempt limit): no renders, no calls.
    if (visionGuardFor(args.state).stop) {
      return null;
    }
    // Self-critique is optional; skip it when the vision route is hosted and
    // the workspace privacy mode forbids hosted calls.
    if (!(await allowHostedCall(args.state, visionCall(resolveVisionRoute(args.state.run.pipeline.vision)), [args.document.id]))) {
      return null;
    }

    const scratchDir = await mkdtemp(path.join(tmpdir(), "docslurp-critique-"));
    const critiqueArtifactKey = `${runArtifactRoot(args.state.run, args.document.userId)}/critique/${args.document.id}.json`;
    const correctedTextKey = `${runArtifactRoot(args.state.run, args.document.userId)}/markdown/${args.document.id}.critique.md`;
    const renderManifestUri =
      args.state.artifactLedger.readDocument(args.document.id, "images") ?? null;

    try {
      const rasterPages = await this.rasters.renderSelectedPages({
        document: args.document,
        runId: args.state.run.id,
        pageNumbers: critiquePages,
        dpi: 150,
        signal: args.signal,
      });
      await Promise.all(
        rasterPages.map(async (raster) => {
          const bytes = await this.storage.getBytes(raster.artifactKey);
          await writeFile(
            path.join(scratchDir, `critique-page-${raster.pageNumber}.png`),
            bytes,
          );
        }),
      );

      // The route each page's critique was served on (a fallback's when it served), for the usage records below.
      const critiqueRoutes = new Map<number, VisionServedRoute>();
      const corrections = await Promise.all(
        critiquePages.map(async (pageNumber): Promise<SelfCritiqueCorrection> => {
        const imagePath = path.join(
          scratchDir,
          `critique-page-${pageNumber}.png`,
        );
        try {
          const originalText = pageTexts[pageNumber - 1] ?? "";
          const critiqueVision = {
            ...args.state.run.pipeline.vision,
            prompt: buildCritiquePrompt(
              originalText,
              args.state.run.pipeline.preserveTables,
              args.state.run.pipeline.preserveCode,
            ),
          };
          // The run's vision attempt guard admits every critique request like every other vision
          // request; critique never creates a customer charge, so its requests stay uncharged. A
          // rejected or failed call records its spend there.
          const guarded = await guardedVisionCall({
            host: args.state,
            vision: critiqueVision,
            cfg: this.cfg,
            target: { documentId: args.document.id, pageNumber, purpose: "critique" },
            record: (input) => args.state.usageLedger.record(input),
            metadata: { critique: true },
            call: (gate) => executeVisionRuntime({
              imagePath,
              outputPath: `${imagePath}.json`,
              privacyMode: args.state.run.pipeline.privacyMode,
              vision: critiqueVision,
              cfg: this.cfg,
              runner: this.runner,
              signal: args.signal,
              gate,
            }),
          });
          if (!guarded.admitted) throw new Error(`vision-stopped: ${guarded.stop.reason}`);
          const result = guarded.result;
          critiqueRoutes.set(pageNumber, result.route);
          const normalizedText = normalizeCritiqueText(result.text);
          const originalPlausibilityScore = scoreExtractionPlausibility(
            originalText,
            1,
          ).plausibilityScore;
          const correctedPlausibilityScore = scoreExtractionPlausibility(
            normalizedText,
            1,
          ).plausibilityScore;
          const accepted = shouldAcceptCritique({
            originalText,
            correctedText: normalizedText,
            originalPlausibilityScore,
            correctedPlausibilityScore,
          });
          return {
            pageNumber,
            accepted,
            originalPlausibilityScore,
            correctedPlausibilityScore,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            latencyMs: result.latencyMs,
            // Priced on the route that served it (a fallback's, the configured OpenAI base URL).
            costCents: priceVisionResult(result, this.cfg),
            text: normalizedText,
            reason: accepted ? "plausibility-gain" : "requires-review",
          };
        } catch (error) {
          const originalText = pageTexts[pageNumber - 1] ?? "";
          return {
            pageNumber,
            accepted: false,
            originalPlausibilityScore: scoreExtractionPlausibility(
              originalText,
              1,
            ).plausibilityScore,
            correctedPlausibilityScore: 0,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            costCents: 0,
            text: "",
            reason: error instanceof Error ? error.message : "critique-failed",
          };
        }
        }),
      );

      const inputTokens = corrections.reduce(
        (sum, correction) => sum + correction.inputTokens,
        0,
      );
      const outputTokens = corrections.reduce(
        (sum, correction) => sum + correction.outputTokens,
        0,
      );
      const latencyMs = Math.max(
        0,
        ...corrections.map((correction) => correction.latencyMs),
      );
      const costCents = corrections.reduce(
        (sum, correction) => sum + correction.costCents,
        0,
      );

      const acceptedCorrections = corrections.filter(
        (correction) => correction.accepted,
      );
      recordCritiqueUsage({
        ledger: args.state.usageLedger,
        corrections,
        routes: critiqueRoutes,
        configuredRoute: configuredVisionServedRoute(args.state.run.pipeline.vision, this.cfg),
        metadata: { documentId: args.document.id, artifact: this.storage.uri(critiqueArtifactKey), maxCostCents, budgetExceeded: costCents > maxCostCents },
      });

      for (const correction of corrections) {
        args.state.pendingPerformance.push({
          documentId: args.document.id,
          scope: "page",
          stageName: this.name,
          metric: "critique-latency",
          pageNumber: correction.pageNumber,
          value: correction.latencyMs,
          unit: "ms",
          tags: [
            "page",
            "critique",
            correction.accepted ? "accepted" : "rejected",
          ],
          metadata: {
            accepted: correction.accepted,
            originalPlausibilityScore: correction.originalPlausibilityScore,
            correctedPlausibilityScore: correction.correctedPlausibilityScore,
          },
        });
      }
      if (acceptedCorrections.length === 0) {
        await this.storage.putJson(critiqueArtifactKey, {
          documentId: args.document.id,
          strategy: args.strategy,
          renderManifestUri,
          reviewedPages: critiquePages,
          acceptedPages: [],
          corrections,
        });
        return {
          correctedText: args.winningText,
          correctedTextUri: null,
          critiqueArtifactUri: this.storage.uri(critiqueArtifactKey),
          reviewedPages: critiquePages,
          acceptedPages: [],
          corrections,
          inputTokens,
          outputTokens,
          latencyMs,
          costCents,
        };
      }

      const correctedText = mergeCritiquedPages(
        args.winningText,
        Math.max(1, args.document.pageCount),
        acceptedCorrections.map((correction) => ({
          pageNumber: correction.pageNumber,
          text: correction.text,
        })),
      );
      await this.storage.streamText(
        correctedTextKey,
        correctedText,
        "text/markdown; charset=utf-8",
      );
      await this.storage.putJson(critiqueArtifactKey, {
        documentId: args.document.id,
        strategy: args.strategy,
        renderManifestUri,
        reviewedPages: critiquePages,
        acceptedPages: acceptedCorrections.map(
          (correction) => correction.pageNumber,
        ),
        correctedTextArtifactUri: this.storage.uri(correctedTextKey),
        corrections,
      });

      return {
        correctedText,
        correctedTextUri: this.storage.uri(correctedTextKey),
        critiqueArtifactUri: this.storage.uri(critiqueArtifactKey),
        reviewedPages: critiquePages,
        acceptedPages: acceptedCorrections.map(
          (correction) => correction.pageNumber,
        ),
        corrections,
        inputTokens,
        outputTokens,
        latencyMs,
        costCents,
      };
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }

  /**
   * Slides and spreadsheets: add where each block came from (slide number + shape box, sheet + A1 range)
   * from the python-pptx / openpyxl sidecars. Optional and non-fatal; the Markdown text is unchanged.
   */
  private async enrichOfficeStructure(args: {
    format: string;
    document: CanonicalDocument;
    documentId: string;
    sourceTempFile: string;
    signal?: AbortSignal;
  }): Promise<CanonicalDocument> {
    const kind = args.format === "office-pptx" ? "pptx" : args.format === "office-excel" ? "xlsx" : null;
    if (!kind) return args.document;
    const outputPath = `${args.sourceTempFile}.${kind}-structure.json`;
    try {
      const plan = kind === "pptx"
        ? await this.runner.pptxExtract(args.sourceTempFile, outputPath)
        : await this.runner.xlsxExtractPy(args.sourceTempFile, outputPath, { structureOnly: true });
      if (!plan.available) return args.document;
      await this.runner.run(plan, withTimeoutSignal(args.signal, Math.min(this.cfg.parserArtifactTimeoutMs, 30_000)));
      const payload = await readJsonFile(outputPath);
      return kind === "pptx"
        ? enrichCanonicalDocumentWithPptx(args.document, payload)
        : enrichCanonicalDocumentWithXlsx(args.document, payload);
    } catch (error) {
      rethrowIfTeardown(error);
      console.warn(`[extract-markdown] skipped office structure sidecar kind=${kind} document=${args.documentId} reason=${toError(error).message}`);
      return args.document;
    }
  }

  private async buildParserArtifacts(
    document: import("../models.js").Document,
    /** The sniffed format (format-detect's normalizedFormat). */
    format: string,
    sourceTempFile: string,
    state: import("../pipeline/pipeline.js").WorkflowState,
    options: {
      hasTablePages?: boolean;
      /** Filled with whether the native engine supplied the block payload, and why not. */
      nativePayloadOutcome?: { status: "native" | "none"; reason: string | null };
    } = {},
    signal?: AbortSignal,
  ): Promise<
    Array<{ parser: "native-pdf" | "unstructured"; uri: string; payload: unknown }>
  > {
    // PDF parsers (the in-process native engine, region extraction, the Unstructured sidecar) read only bytes sniffed as a
    // PDF: a polyglot named x.pdf, or declared application/pdf, that sniffed as HTML must never reach a PDF parser.
    if (format !== "pdf") {
      if (options.nativePayloadOutcome) options.nativePayloadOutcome.reason = `sniffed format is ${format}, not pdf`;
      return [];
    }

    const artifacts: Array<{
      parser: "native-pdf" | "unstructured";
      uri: string;
      payload: unknown;
    }> = [];
    const jobs: Array<{
      parser: "native-pdf" | "unstructured";
      outputPath: string;
      planFactory: () => Promise<CommandPlan>;
      timeoutMs: number;
    }> = [];

    // Block payload (bbox, font size) from the in-process engine, whichever extractor won; absent when the private
    // engine is not installed, in which case the canonical document keeps its Markdown-derived blocks.
    const nativeOutcome = await this.buildNativeParserPayloadOrNull(
      sourceTempFile,
      withTimeoutSignal(signal, Math.min(this.cfg.parserArtifactTimeoutMs, 15_000)),
    );
    const nativePayload = nativeOutcome.payload;
    if (options.nativePayloadOutcome) {
      options.nativePayloadOutcome.status = nativePayload ? "native" : "none";
      options.nativePayloadOutcome.reason = nativeOutcome.reason;
    }
    if (nativePayload) {
      const key = `${documentArtifactRoot(document)}/parser/${document.id}.native-pdf.json`;
      await this.storage.putJson(key, nativePayload);
      artifacts.push({ parser: "native-pdf", uri: this.storage.uri(key), payload: nativePayload });
    }

    if (this.shouldBuildUnstructuredParserArtifact(state, options)) {
      jobs.push({
        parser: "unstructured" as const,
        outputPath: `${sourceTempFile}.unstructured.json`,
        planFactory: () =>
          this.runner.unstructuredPartition(
            sourceTempFile,
            `${sourceTempFile}.unstructured.json`,
            // Text layer only: unstructured's OCR strategies would OCR inside this process.
            "fast",
        ),
        timeoutMs: this.cfg.parserArtifactTimeoutMs,
      });
    }

    for (const job of jobs) {
      try {
        const payload =
          job.parser === "unstructured"
            ? await this.buildChunkedUnstructuredParserPayload({
                sourceTempFile,
                outputPath: job.outputPath,
                pageCount:
                  Number.isFinite(document.pageCount) && document.pageCount > 0
                    ? Math.floor(document.pageCount)
                    : 1,
                timeoutMs: job.timeoutMs,
                adaptiveSettings: this.unstructuredAdaptiveSettings(state),
                signal,
              })
            : await this.buildSingleParserPayload(job, signal);
        if (!payload) {
          continue;
        }
        const key = `${documentArtifactRoot(document)}/parser/${document.id}.${job.parser}.json`;
        await this.storage.putJson(key, payload);
        artifacts.push({
          parser: job.parser,
          uri: this.storage.uri(key),
          payload,
        });
      } catch (error) {
        rethrowIfTeardown(error);
        console.warn(
          `[extract-markdown] skipped optional parser artifact parser=${job.parser} document=${document.id} reason=${toError(error).message}`,
        );
      }
    }

    // Optional region extraction: bounding-box classified text regions per page.
    if (
      (state.run.pipeline as { pdfRegionExtraction?: boolean })
        .pdfRegionExtraction
    ) {
      try {
        const regionsPayload = await this.buildNativeRegionsOrNull(
          sourceTempFile,
          withTimeoutSignal(signal, Math.min(this.cfg.parserArtifactTimeoutMs, 20_000)),
        );
        if (regionsPayload) {
          const regionsKey = `${documentArtifactRoot(document)}/parser/${document.id}.regions.json`;
          await this.storage.putJson(regionsKey, regionsPayload);
          state.artifactLedger.recordDocument(document.id, "pdf-regions", this.storage.uri(regionsKey));
          const totalRegions = regionsPayload.pages.reduce((sum, p) => sum + p.regionCount, 0);
          pushPerfMetric({
            metric: "pdf-region-count",
            value: totalRegions,
            unit: "regions",
            metadata: {
              documentId: document.id,
              pageCount: regionsPayload.pageCount,
              artifactUri: this.storage.uri(regionsKey),
            },
          });
        }
      } catch (error) {
        rethrowIfTeardown(error);
        console.warn(
          `[extract-markdown] skipped pdf region extraction document=${document.id} reason=${toError(error).message}`,
        );
      }
    }

    return artifacts;
  }

  private shouldBuildUnstructuredParserArtifact(
    state: import("../pipeline/pipeline.js").WorkflowState,
    options: {
      hasTablePages?: boolean;
    },
  ): boolean {
    return (
      options.hasTablePages === true ||
      (state.run.pipeline as { pdfRegionExtraction?: boolean }).pdfRegionExtraction === true
    );
  }

  /** Page regions (header/sidebar/body/footer blocks) from the in-process native engine; null when it cannot serve them. */
  private async buildNativeRegionsOrNull(sourceTempFile: string, signal?: AbortSignal) {
    const engine = await resolveNativePdfEngine(this.runner);
    if (!engine) return null;
    const doc = await engine.openPath(sourceTempFile, { signal });
    try {
      const regions = await buildNativePdfRegions(doc, {}, signal);
      return regions.pages.length > 0 ? regions : null;
    } finally {
      await doc.close().catch(() => undefined);
    }
  }

  /** Block payload from the in-process native engine; null (not an error) when it cannot serve it. */
  private async buildNativeParserPayloadOrNull(
    sourceTempFile: string,
    signal?: AbortSignal,
  ): Promise<{ payload: unknown | null; reason: string | null }> {
    try {
      const engine = await resolveNativePdfEngine(this.runner);
      if (!engine) return { payload: null, reason: "engine unavailable" };
      const doc = await engine.openPath(sourceTempFile, { signal });
      try {
        const payload = await buildNativeParserPayload(doc, signal);
        return payload.pages.length > 0 ? { payload, reason: null } : { payload: null, reason: "engine returned no pages" };
      } finally {
        await doc.close().catch(() => undefined);
      }
    } catch (error) {
      const failure = logNativePdfFallback("parser-payload", error, "markdown-derived blocks");
      return { payload: null, reason: `${failure.code}: ${failure.message}`.slice(0, 4000) };
    }
  }

  private async buildSingleParserPayload(
    job: {
      planFactory: () => Promise<CommandPlan>;
      outputPath: string;
      timeoutMs: number;
    },
    signal?: AbortSignal,
  ): Promise<unknown | null> {
    const plan = await job.planFactory();
    if (!plan.available) {
      return null;
    }

    await this.runner.run(plan, withTimeoutSignal(signal, job.timeoutMs));
    return await readJsonFile(job.outputPath);
  }

  private async buildChunkedUnstructuredParserPayload(args: {
    sourceTempFile: string;
    outputPath: string;
    pageCount: number;
    timeoutMs: number;
    adaptiveSettings: {
      initialChunkPages: number;
      maxChunkPages: number;
      maxConcurrency: number;
    };
    signal?: AbortSignal;
  }): Promise<unknown | null> {
    const sliceTimeoutMs = this.unstructuredSliceTimeoutMs(args.timeoutMs);
    const adaptive = args.adaptiveSettings;

    if (args.pageCount <= adaptive.initialChunkPages) {
      const plan = await this.runner.unstructuredPartition(
        args.sourceTempFile,
        args.outputPath,
        "fast",
      );
      if (!plan.available) {
        return null;
      }
      await this.runner.run(plan, withTimeoutSignal(args.signal, sliceTimeoutMs));
      return await readJsonFile(args.outputPath);
    }

    const scratchDir = await mkdtemp(path.join(tmpdir(), "docslurp-unstructured-pages-"));
    const completed: Array<{ startPage: number; elements: unknown[] }> = [];
    const pendingRanges: Array<{ startPage: number; endPage: number }> = [];
    let nextPage = 1;
    let active = 0;
    let currentChunkPages = adaptive.initialChunkPages;
    let currentConcurrency = 1;

    try {
      await new Promise<void>((resolve, reject) => {
        const launchMore = () => {
          if (args.signal?.aborted) {
            reject(args.signal.reason instanceof Error ? args.signal.reason : new Error("aborted"));
            return;
          }

          while (
            active < currentConcurrency &&
            (pendingRanges.length > 0 || nextPage <= args.pageCount)
          ) {
            const pendingRange = pendingRanges.shift();
            const startPage = pendingRange?.startPage ?? nextPage;
            const endPage = pendingRange?.endPage ?? Math.min(
              args.pageCount,
              startPage + currentChunkPages - 1,
            );
            if (!pendingRange) {
              nextPage = endPage + 1;
            }
            active += 1;

            void this.extractUnstructuredPageRange({
              sourceTempFile: args.sourceTempFile,
              scratchDir,
              startPage,
              endPage,
              signal: args.signal,
              timeoutMs: sliceTimeoutMs,
            })
              .then((elements) => {
                completed.push({ startPage, elements });
                active -= 1;
                currentChunkPages = Math.min(
                  adaptive.maxChunkPages,
                  currentChunkPages + 1,
                );
                currentConcurrency = Math.min(
                  adaptive.maxConcurrency,
                  currentConcurrency + 1,
                );
                launchMore();
              })
              .catch((error) => {
                active -= 1;
                currentChunkPages = Math.max(1, currentChunkPages - 1);
                currentConcurrency = Math.max(1, currentConcurrency - 1);
                if (endPage > startPage) {
                  pendingRanges.unshift(
                    ...Array.from(
                      { length: endPage - startPage + 1 },
                      (_, index) => {
                        const pageNumber = startPage + index;
                        return { startPage: pageNumber, endPage: pageNumber };
                      },
                    ),
                  );
                  launchMore();
                  return;
                }
                reject(error);
              });
          }

          if (
            active === 0 &&
            pendingRanges.length === 0 &&
            nextPage > args.pageCount
          ) {
            resolve();
          }
        };

        launchMore();
      });

      return completed
        .sort((left, right) => left.startPage - right.startPage)
        .flatMap((entry) => entry.elements);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }

  private async extractUnstructuredPageRange(args: {
    sourceTempFile: string;
    scratchDir: string;
    startPage: number;
    endPage: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<unknown[]> {
    const range = `${args.startPage}-${args.endPage}`;
    const slicePath = path.join(args.scratchDir, `pages-${range}.pdf`);
    const outputPath = path.join(args.scratchDir, `pages-${range}.unstructured.json`);
    const split = await this.extractPdfPageRangeToFile({
      sourceTempFile: args.sourceTempFile,
      scratchDir: args.scratchDir,
      outputPath: slicePath,
      startPage: args.startPage,
      endPage: args.endPage,
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    });
    if (!split) {
      throw new Error("no PDF page range splitter is available for unstructured parsing");
    }
    const unstructuredPlan = await this.runner.unstructuredPartition(
      slicePath,
      outputPath,
      "fast",
    );
    if (!unstructuredPlan.available) {
      throw new Error("unstructured parser is unavailable");
    }

    await this.runner.run(
      unstructuredPlan,
      withTimeoutSignal(args.signal, args.timeoutMs),
    );
    const payload = await readJsonFile(outputPath);
    if (!Array.isArray(payload)) {
      throw new Error(
        `unstructured chunk ${range} did not produce a JSON array`,
      );
    }
    return payload
      .map((element) =>
        offsetUnstructuredElementPageNumber(
          element,
          args.startPage - 1,
          args.endPage,
        ),
      )
      .filter((element) => element !== null);
  }

  private unstructuredAdaptiveSettings(
    state?: import("../pipeline/pipeline.js").WorkflowState,
  ): {
    initialChunkPages: number;
    maxChunkPages: number;
    maxConcurrency: number;
  } {
    const initialChunkPages = Math.max(
      1,
      Math.min(
        100,
        this.cfg.unstructuredParserInitialChunkPages ?? 1,
      ),
    );
    const maxChunkPages = Math.max(
      initialChunkPages,
      Math.min(100, this.cfg.unstructuredParserMaxChunkPages ?? 2),
    );
    const maxConcurrency = Math.max(
      1,
      this.cfg.unstructuredParserMaxConcurrency ?? 3,
    );
    const fallback = {
      initialChunkPages,
      maxChunkPages,
      maxConcurrency,
    };
    return state
      ? adaptiveUnstructuredSettingsForStage(state, this.name, fallback)
      : fallback;
  }

  private unstructuredSliceTimeoutMs(fallbackMs: number): number {
    const configured = this.cfg.unstructuredParserChunkTimeoutMs;
    return Number.isFinite(configured) && configured > 0
      ? configured
      : fallbackMs;
  }

  private async extractPdfPageRangeToFile(args: {
    sourceTempFile: string;
    scratchDir: string;
    outputPath: string;
    startPage: number;
    endPage: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const range = `${args.startPage}-${args.endPage}`;
    const qpdfPlan = await this.runner.extractPdfPageRange(
      args.sourceTempFile,
      args.outputPath,
      range,
    );
    if (qpdfPlan.available) {
      await this.runner.run(
        qpdfPlan,
        withTimeoutSignal(args.signal, args.timeoutMs),
      );
      return true;
    }

    const pagePattern = path.join(
      args.scratchDir,
      `pages-${args.startPage}-${args.endPage}-%d.pdf`,
    );
    const splitPlan = await this.runner.splitPdfPageRange(
      args.sourceTempFile,
      pagePattern,
      args.startPage,
      args.endPage,
    );
    if (!splitPlan.available) {
      return false;
    }
    await this.runner.run(
      splitPlan,
      withTimeoutSignal(args.signal, args.timeoutMs),
    );

    const pagePaths = Array.from(
      { length: args.endPage - args.startPage + 1 },
      (_, index) => pagePattern.replace("%d", String(args.startPage + index)),
    );
    if (pagePaths.length === 1) {
      await pipeline(createReadStream(pagePaths[0]!), createWriteStream(args.outputPath));
      return true;
    }

    const unitePlan = await this.runner.unitePdfs(pagePaths, args.outputPath);
    if (!unitePlan.available) {
      return false;
    }
    await this.runner.run(
      unitePlan,
      withTimeoutSignal(args.signal, args.timeoutMs),
    );
    return true;
  }

  private async buildSingleUnstructuredParserPayload(args: {
    sourceTempFile: string;
    outputPath: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<unknown | null> {
    const plan = await this.runner.unstructuredPartition(
      args.sourceTempFile,
      args.outputPath,
      "fast",
    );
    if (!plan.available) {
      return null;
    }
    await this.runner.run(plan, withTimeoutSignal(args.signal, args.timeoutMs));
    return await readJsonFile(args.outputPath);
  }

  private async enrichDocumentArtifacts(args: {
    document: import("../models.js").Document;
    sourcePath: string;
    sourceHash: string;
    format: string;
    targets: string[];
    pageNumbers: number[];
    runId: string;
    signal?: AbortSignal;
    graphRunner?: typeof runLocalPdfArtifactGraph;
    /** Images the VM extractor returned beside its Markdown output; read through the provider, never re-parsed here. */
    vmImages?: { output: string; markdownPath?: string };
    canContinue?: () => boolean;
    reserveOrientation?: () => boolean;
    recordUsage?: (event: import("../models.js").UsageEvent) => void;
  }): Promise<{ manifestUri: string; targetIds: string[]; requestedTargets: string[]; steps: string[]; outputCount: number; latencyMs: number; artifactUris: string[]; stats?: Readonly<Record<string, unknown>> }> {
    const startedAt = Date.now();
    const scratchDir = await mkdtemp(path.join(tmpdir(), "docslurp-artifact-graph-"));
    try {
      if (args.format !== "pdf") {
        throw new Error(`artifact enrichment is unavailable for ${args.format}`);
      }
      const vmImages = args.vmImages ? requireSandboxedPdfProvider().embeddedImages : undefined;
      if (args.vmImages && !vmImages) throw new Error("The sandboxed PDF provider does not return embedded images");
      const result = args.vmImages && vmImages
        ? await embeddedImageGraph({ images: await vmImages.read(args.vmImages.output, args.signal),
            producer: { id: vmImages.producerId, optionsDigest: vmImages.optionsDigest }, sourcePath: args.sourcePath,
            sourceDocumentId: args.document.id, sourceHash: args.sourceHash, pageCount: args.pageNumbers.length,
            targets: args.targets, scratchDir, signal: args.signal, markdownPath: args.vmImages.markdownPath,
            recordUsage: args.recordUsage, canContinue: args.canContinue, reserveOrientation: args.reserveOrientation })
        : await (args.graphRunner ?? runLocalPdfArtifactGraph)({
        sourcePath: args.sourcePath,
        sourceDocumentId: args.document.id,
        sha256: args.sourceHash,
        pageCount: args.pageNumbers.length,
        targetKinds: args.targets,
        scratchDir,
        signal: args.signal,
      });
      const source = result.artifacts[0];
      if (!source || source.kind !== "source/pdf") {
        throw new Error("local PDF graph returned no source artifact");
      }
      const baseKey = `${documentArtifactRoot(args.document, args.runId)}/artifact-graph/${args.document.id}`;
      const persisted: ExtractionArtifactRef[] = [
        { ...source, uri: this.storage.uri(args.document.sourceKey) },
      ];
      for (const [index, artifact] of result.artifacts.slice(1).entries()) {
        const key = `${baseKey}/${index}`;
        await this.storage.streamToStorage(key, createReadStream(artifact.uri), artifact.mediaType);
        persisted.push({ ...artifact, uri: this.storage.uri(key) });
      }
      const manifestKey = `${baseKey}/manifest.json`;
      const targetIds = result.targets.map((artifact) => artifact.id);
      await this.storage.putJson(manifestKey, {
        documentId: args.document.id,
        requestedTargets: args.targets,
        targetIds,
        steps: result.steps,
        outputCount: persisted.length - 1,
        latencyMs: Date.now() - startedAt,
        artifacts: persisted,
      });
      return {
        manifestUri: this.storage.uri(manifestKey),
        targetIds,
        requestedTargets: args.targets,
        steps: [...result.steps],
        outputCount: persisted.length - 1,
        latencyMs: Date.now() - startedAt,
        // Image children and the media map are recorded as document artifact slots, so the artifact and PII guards
        // (and exports) see them, whichever producer made them.
        artifactUris: persisted.slice(1).filter(ref => EMBEDDED_IMAGE_TARGETS.has(ref.kind) || ref.kind === "page/embedded-image-mask").map(ref => ref.uri),
        ...(result.stats ? { stats: result.stats } : {}),
      };
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }

  /**
   * Resolution throws for formats without extractors (e.g. a dedup copy whose
   * normalizedFormat artifact lives on its source document). These lookups run
   * before runDocumentStage, which skips already-completed documents and turns
   * a real extraction failure into a failed document, so they must not throw
   * and fail the whole run first.
   */
  private tryResolveExtractorOrder(format: string, configured: Partial<Record<string, string[]>>): string[] {
    try {
      return this.resolveDocumentExtractorOrder(format, configured);
    } catch {
      return [];
    }
  }

  private describeExtractorOrder(format: string, configured: Partial<Record<string, string[]>>): string {
    const order = this.tryResolveExtractorOrder(format, configured);
    return order.length ? order.join(",") : `none-for-${format}`;
  }

  private resolveDocumentExtractorOrder(
    format: string,
    order: Partial<Record<string, string[]>>,
  ): string[] {
    return documentExtractorRegistry.resolve(format, order[format]);
  }

  private async planExtractors(args: {
    tempFile: string;
    /** The bytes' sniffed MIME type (quarantine's file facts), handed to extractors that take one. */
    mimeType?: string | null;
    multiStrategyVoting: boolean;
    secondaryId: string;
    order: Partial<Record<string, string[]>>;
    format: string;
    options: Record<string, unknown>;
    attemptLedger: ExtractorAttemptLedger;
  }): Promise<{
    primary: PreparedExtractor;
    secondary: PreparedExtractor | null;
    tableAware: boolean;
  } | null> {
    const labels = this.resolveDocumentExtractorOrder(args.format, args.order)
      .filter((id) => args.attemptLedger.canAttempt(id));
    if (labels.length === 0) return null;
    const probes = await Promise.all(
      labels.map((id) =>
        documentExtractorRegistry.prepare(
          id,
          this.runner,
          args.tempFile,
          serializeExtractorOptions(args.options, id),
          { format: args.format, mimeType: args.mimeType ?? null },
        ),
      ),
    );
    for (const probe of probes) {
      if (!probe.plan.available) args.attemptLedger.markUnavailable(probe.label);
    }
    const planned = probes.filter((probe) => probe.plan.available);
    const primary = this.pickAvailableExtractor(planned, true);
    if (!primary) return null;
    let secondary: PreparedExtractor | null = null;
    if (args.multiStrategyVoting) {
      if (args.secondaryId === "next-in-order") {
        secondary = this.pickAvailableExtractor(
          planned.filter((candidate) => candidate.label !== primary.label),
          true,
        );
      } else if (args.secondaryId !== primary.label && args.attemptLedger.canAttempt(args.secondaryId)) {
        documentExtractorRegistry.resolve(args.format, [args.secondaryId]);
        const explicit = await documentExtractorRegistry.prepare(
          args.secondaryId,
          this.runner,
          args.tempFile,
          serializeExtractorOptions(args.options, args.secondaryId),
          { format: args.format, mimeType: args.mimeType ?? null },
        );
        if (!explicit.plan.available) args.attemptLedger.markUnavailable(explicit.label);
        secondary = explicit.plan.available ? explicit : null;
      }
    }
    return { primary, secondary, tableAware: primary.tableAware };
  }

  private pickAvailableExtractor(
    extractors: PreparedExtractor[],
    allowMissing = false,
  ): PreparedExtractor | null {
    const available =
      extractors.find((extractor) => extractor.plan.available) ?? null;
    if (available) {
      return available;
    }

    if (allowMissing) {
      return null;
    }

    return extractors[0] ?? null;
  }


}

export function selectCritiquePages(
  pages: PageHeatmapEntry[],
  threshold = 0.42,
  maxPages = 3,
): number[] {
  return [...pages]
    .filter((page) => page.plausibilityScore < threshold)
    .sort(
      (left, right) =>
        left.plausibilityScore - right.plausibilityScore ||
        left.charCount - right.charCount,
    )
    .slice(0, Math.max(1, maxPages))
    .map((page) => page.pageNumber);
}

export function budgetCritiquePages(
  pages: number[],
  maxCostCents: number,
  maxCostPerPageCents: number,
): number[] {
  if (
    !Number.isFinite(maxCostCents) ||
    !Number.isFinite(maxCostPerPageCents) ||
    maxCostCents <= 0 ||
    maxCostPerPageCents <= 0
  ) {
    return [];
  }
  return pages.slice(
    0,
    Math.floor(maxCostCents / maxCostPerPageCents),
  );
}

export function mergeCritiquedPages(
  originalText: string,
  pageCount: number,
  corrections: Array<{ pageNumber: number; text: string }>,
): string {
  // Strict: a text whose page breaks do not match the page count has no pages to replace, and joining slices with
  // form feeds would write boundaries the text never had.
  const pages = splitTextIntoPagesStrict(originalText, pageCount);
  if (pages === null || pages.length === 0) {
    return originalText;
  }

  for (const correction of corrections) {
    if (correction.pageNumber < 1 || correction.pageNumber > pages.length) {
      continue;
    }
    pages[correction.pageNumber - 1] = correction.text.trim();
  }

  return pages.join("\f");
}

function offsetUnstructuredElementPageNumber(
  element: unknown,
  pageOffset: number,
  maxPageNumber: number,
): unknown | null {
  if (!element || typeof element !== "object") {
    return element;
  }

  const candidate = element as {
    metadata?: { page_number?: unknown; [key: string]: unknown };
    [key: string]: unknown;
  };
  const pageNumber = candidate.metadata?.page_number;
  if (typeof pageNumber !== "number" || !Number.isFinite(pageNumber)) {
    return element;
  }
  const adjustedPageNumber = pageNumber + pageOffset;
  if (adjustedPageNumber > maxPageNumber) {
    return null;
  }

  return {
    ...candidate,
    metadata: {
      ...candidate.metadata,
      page_number: adjustedPageNumber,
    },
  };
}

function shouldAcceptCritique(args: {
  originalText: string;
  correctedText: string;
  originalPlausibilityScore: number;
  correctedPlausibilityScore: number;
}): boolean {
  // Plausibility and length are not grounded correctness signals. Keep the
  // proposed correction as review evidence, but never mutate canonical text
  // until a page-image-grounded scorer is calibrated by the eval harness.
  void args;
  return false;
}

/**
 * Records a document's self-critique usage: one `page-critique` event per route that served critiques (a fallback's
 * when it served), each with its own pages, tokens and cost, so no route's spend is labelled as another's. Pages
 * whose critique failed (zero usage; their billed spend was recorded by the guarded call) are counted under the
 * configured route.
 */
export function recordCritiqueUsage(args: {
  ledger: Pick<import("../pipeline/usage-ledger.js").PipelineUsageEventLedger, "record">;
  corrections: Array<Pick<SelfCritiqueCorrection, "pageNumber" | "accepted" | "inputTokens" | "outputTokens" | "costCents">>;
  routes: ReadonlyMap<number, VisionServedRoute>;
  configuredRoute: VisionServedRoute;
  metadata: Record<string, unknown>;
}): void {
  const byRoute = new Map<string, { route: VisionServedRoute; corrections: typeof args.corrections }>();
  for (const correction of args.corrections) {
    const route = args.routes.get(correction.pageNumber) ?? args.configuredRoute;
    const key = `${route.provider}\u0000${route.model}\u0000${route.runtime}\u0000${route.baseUrl ?? ""}`;
    const group = byRoute.get(key) ?? { route, corrections: [] };
    group.corrections.push(correction);
    byRoute.set(key, group);
  }
  for (const { route, corrections } of byRoute.values()) {
    args.ledger.record({
      provider: route.provider,
      model: route.model,
      metric: "page-critique",
      amount: corrections.length,
      unit: "page",
      costCents: corrections.reduce((sum, correction) => sum + correction.costCents, 0),
      inputTokens: corrections.reduce((sum, correction) => sum + correction.inputTokens, 0),
      outputTokens: corrections.reduce((sum, correction) => sum + correction.outputTokens, 0),
      metadata: {
        ...args.metadata,
        reviewedPages: corrections.map((correction) => correction.pageNumber),
        acceptedPages: corrections.filter((correction) => correction.accepted).map((correction) => correction.pageNumber),
        runtime: route.runtime,
        billing: route.billing,
      },
    });
  }
}

function critiqueEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(
    (process.env.DOCSLURP_CRITIQUE_ENABLED ?? "").trim().toLowerCase(),
  );
}

function normalizeCritiqueText(text: string): string {
  return text
    .replace(/^```(?:markdown)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function buildCritiquePrompt(
  pageMarkdown: string,
  preserveTables: boolean,
  preserveCode: boolean,
): string {
  const constraints = [
    "You are correcting OCR markdown for a single document page.",
    "Use the page image as the source of truth.",
    "Return only corrected markdown for this page.",
    preserveTables
      ? "Preserve table structure in markdown when possible."
      : null,
    preserveCode
      ? "Preserve code blocks and syntax exactly when they appear."
      : null,
    "Fix missing text, broken reading order, and damaged table rows.",
    "Do not add commentary or explanations.",
    "",
    "First-pass markdown:",
    pageMarkdown.slice(0, 12_000),
  ].filter(Boolean);
  return constraints.join("\n");
}

class FanoutWritable extends Writable {
  constructor(private readonly destinations: Writable[]) {
    super();
  }

  override _write(
    chunk: string | Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    void Promise.all(
      this.destinations.map((destination) =>
        writeChunk(destination, chunk, encoding),
      ),
    ).then(
      () => callback(),
      (error) => callback(toError(error)),
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    void Promise.all(
      this.destinations.map((destination) => endWritable(destination)),
    ).then(
      () => callback(),
      (error) => callback(toError(error)),
    );
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    for (const destination of this.destinations) {
      destination.destroy(error ?? undefined);
    }
    callback(error);
  }
}

/** The first `maxBytes` of a file as UTF-8 (a split trailing character is dropped). */
async function readFileHead(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function writeChunk(
  destination: Writable,
  chunk: string | Buffer,
  encoding: BufferEncoding,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      destination.off("error", onError);
      destination.off("drain", onDrain);
    };

    destination.once("error", onError);
    if (destination.write(chunk, encoding)) {
      cleanup();
      resolve();
      return;
    }
    destination.once("drain", onDrain);
  });
}

async function endWritable(destination: Writable): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      destination.off("error", onError);
      destination.off("finish", onFinish);
    };

    destination.once("error", onError);
    destination.once("finish", onFinish);
    destination.end();
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function withTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  if (timeoutMs <= 0) {
    return signal;
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

/** What to rethrow when the stage's own signal aborted every extractor: its reason, else an extractor's abort. */
function interruptionCause(signal: AbortSignal, ...results: PromiseSettledResult<unknown>[]): unknown {
  if (signal.reason instanceof Error) return signal.reason;
  const rejected = results.find((result) => result.status === "rejected");
  return rejected ? rejected.reason : Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

async function settle<T>(
  promise: Promise<T>,
): Promise<PromiseSettledResult<T>> {
  try {
    return {
      status: "fulfilled",
      value: await promise,
    };
  } catch (reason) {
    return {
      status: "rejected",
      reason,
    };
  }
}

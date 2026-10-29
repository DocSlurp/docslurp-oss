import { buildSummaryEvidence } from "./summary-evidence.js";
import type { CapacityLeaseStore } from "../media/capacity/types.js";
import { extractMedia } from "../media/extract.js";
import type { MediaJournal } from "../media/types.js";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
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
  splitTextIntoPages,
  parserPlaybookCatalog,
  parserPlaybookForQuality,
  qualityAllowsPageReading,
  documentExtractionForQuality,
  deriveDocumentTitle,
  htmlDocumentTitle,
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
  pageAlignedTexts,
  type PageImageEvidenceArtifact,
} from "../lib/page-image-evidence.js";
import {
  LiteParseDocumentExtractionAdapter,
  type DocumentExtractionResult,
} from "../lib/document-extraction-adapter.js";
import { buildCanonicalDocumentFromStructuredExtraction } from "../lib/structured-canonical.js";
export { scoreExtractionPlausibility } from "../lib/extracted-markdown.js";
import type { CommandPlan } from "../tools/runner.js";
import { resolveNativePdfEngine } from "../native-pdf/engine.js";
import { buildNativeParserPayload } from "../native-pdf/parser-payload.js";
import { buildNativePdfRegions } from "../native-pdf/regions.js";
import { nativePdfEmphasisEnabled, resolveNativePdfMode } from "../native-pdf/mode.js";
import { runNativePdfShadow } from "../native-pdf/shadow.js";
import { nativePdfEngineState } from "../native-pdf/loader.js";
import { logNativePdfFallback } from "../native-pdf/types.js";
import { isDocumentLevelFailure } from "../lib/document-failure.js";
import { reportExtractionDecision, summarizeNativePdfShadow, type NativePdfStageStats } from "../native-pdf/telemetry.js";
import { documentExtractorRegistry, serializeExtractorOptions, type CandidateExecutors, type ExtractedCandidate, type PreparedExtractor } from "../extractors/registry.js";
import { ExtractorAttemptLedger } from "../extractors/attempt-ledger.js";
import { runLocalPdfArtifactGraph } from "../extractors/local-graph-runner.js";
import type { CommandRunner } from "../tools/runner.js";
import { type ArtifactStore } from "../tools/storage.js";
import { PdfRasterCache, PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import { pageFactsEnabled, probePdfPageFacts, recordPageFacts } from "../pipeline/page-facts.js";
import { executeVisionRuntime, visionCall } from "../tools/vision-runtime.js";
import { allowHostedCall } from "../lib/privacy-guard.js";

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

function buildPerPageHeatmap(
  text: string,
  pageCount: number,
  strategy: string,
): PageHeatmapEntry[] {
  const pageTexts = splitTextIntoPages(text, pageCount);
  if (pageTexts.length === 0) {
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

export function assertSupportedDocumentTarget(target: string): void {
  if (target !== "document/markdown") {
    throw new Error(`unsupported document extraction target ${target}; supported target: document/markdown`);
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
        const hasTablePages =
          state.artifactLedger.readDocument(document.id, "hasTablePages") === "true";
        const format = state.artifactLedger.readDocument(document.id, "normalizedFormat") ?? (this.isPdfDocument(document) ? "pdf" : "unknown");
        if (format === "audio" || format === "video") {
          await extractMedia({ state, document, runner: this.runner, storage: this.storage, journal: this.mediaJournal, capacityStore: this.capacityStore, signal });
          return;
        }
        const isPdf = format === "pdf";

        console.log(
          `[extract-debug] stage=${this.name} document=${document.id} ` +
            `playbook=${playbook} isPdf=${isPdf} hasTablePages=${hasTablePages} ` +
            `extractorOrder=${this.describeExtractorOrder(format, extractionConfig.order)}`,
        );

        const attemptLedger = new ExtractorAttemptLedger();
        // native-pdf as an extraction candidate, kept across the stage's retry attempts.
        let nativeExtraction: NativePdfStageStats["extraction"] = { status: "not-planned", code: null, reason: null };
        let lastUsableResult: DocumentStageResult | null = null;

        // Page facts for the ingest report run beside extraction (poppler, no pixels) and never fail it.
        const pageFacts = this.recordSourcePageFacts(state, document, format, signal);
        try {
          await runDocumentStage(
            state,
            document,
            this.name,
            artifactSlot,
            "markdown extraction ready",
            async (retryStrategy) => {
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

              try {
                const contentHash = cachedSource.sha256;
                const existingUri = checkDedup(state, contentHash, artifactSlot);
                if (existingUri) {
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
                let plannedExtractors = keepImageUnread ? null : await this.planExtractors({
                  tempFile,
                  multiStrategyVoting: extractionConfig.voting.enabled,
                  secondaryId: extractionConfig.voting.secondary,
                  order: extractionConfig.order,
                  format,
                  options: extractionConfig.options,
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
                  if (format !== "image") throw new Error(cause);
                  // OCR is unavailable here (e.g. an image built without Tesseract data): vision reads the pixels.
                  textlessFallback = `OCR unavailable; ${cause}`;
                  plannedExtractors = {
                    primary: this.textlessImageExtractor(state, document, textlessFallback),
                    secondary: null,
                    tableAware: false,
                  };
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
                const [resultA, resultB] = await this.collectCandidateResults({
                  primary: plannedExtractors.primary,
                  primaryKey: candidateAKey,
                  secondary: plannedExtractors.secondary,
                  secondaryKey: candidateBKey,
                  sourceTempFile: tempFile,
                  graphContext: { sourceHash: contentHash, pageCount, documentId: document.id },
                  signal,
                });

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
                  // A crashing OCR is the same as an absent one for an image, but only once every configured
                  // extractor has had its turn (the stage's retry strategies run them one per attempt).
                  const untried = this.tryResolveExtractorOrder(format, extractionConfig.order)
                    .some((id) => attemptLedger.canAttempt(id));
                  if (format !== "image" || untried) {
                    throw new Error(`no extractor produced output: ${failure}`);
                  }
                  textlessFallback = `OCR failed; ${failure}`;
                  const textless = this.textlessImageExtractor(state, document, textlessFallback);
                  plannedExtractors = { primary: textless, secondary: null, tableAware: false };
                  candidateA = await textless.execute(
                    this.candidateExecutors(),
                    candidateAKey,
                    tempFile,
                    signal,
                  );
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
                    winningTextUri: winningCandidate.textUri,
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
                  const normalizedStructuredPages =
                    winningCandidate.structuredResult &&
                    (critique?.acceptedPages.length ?? 0) === 0
                      ? winningCandidate.structuredResult.pages.map((page) => ({
                          ...page,
                          markdown: normalizeExtractedMarkdown({
                            markdown: page.markdown,
                            preserveTables: state.run.pipeline.preserveTables,
                          }),
                        }))
                      : null;
                  const normalizedWinningText = normalizedStructuredPages
                    ? normalizedStructuredPages
                        .map((page) => page.markdown)
                        .join("\f")
                    : normalizeExtractedMarkdown({
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
                  const nativeEngineState = isPdf && winningCandidate.label !== "doppler" ? await nativePdfEngineState() : null;
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
                  if (isPdf && winningCandidate.label !== "native-pdf" && winningCandidate.label !== "doppler" && nativePdfMode === "shadow") {
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
                  const canUseStructuredCanonical =
                    normalizedStructuredPages !== null;
                  const canonicalDocument = canUseStructuredCanonical
                    ? buildCanonicalDocumentFromStructuredExtraction({
                        documentId: document.id,
                        extractor: winningCandidate.label,
                        pages: normalizedStructuredPages!,
                        sourceArtifactUri,
                        parserArtifactUri:
                          winningCandidate.structuredArtifactUri ?? null,
                      })
                    : buildCanonicalDocumentFromMarkdown({
                        documentId: document.id,
                        text: winningText,
                        pageCount: document.pageCount,
                        sourceArtifactUri,
                        extractor: winningCandidate.label,
                      });
                  // Doppler already reconstructs Markdown; do not silently parse it again on the host.
                  const parserArtifacts = winningCandidate.structuredResult || winningCandidate.label === "doppler"
                    ? []
                    : await this.buildParserArtifacts(
                        document,
                        tempFile,
                        state,
                        { hasTablePages, nativePayloadOutcome: nativePdfStats?.parserPayload },
                        signal,
                      );
                  if (nativePdfStats && winningCandidate.structuredResult) {
                    nativePdfStats.parserPayload = { status: "none", reason: `structured result from ${winningCandidate.label}` };
                  }
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
                  const graph = extractionConfig.enrich.length > 0
                    ? await this.enrichDocumentArtifacts({
                        document,
                        sourcePath: tempFile,
                        sourceHash: contentHash,
                        format,
                        targets: extractionConfig.enrich,
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
                        ? {
                            label: candidateA.label,
                            artifactUri: candidateA.textUri,
                            structuredArtifactUri:
                              candidateA.structuredArtifactUri ?? null,
                          }
                        : null,
                      candidateB
                        ? {
                            label: candidateB.label,
                            artifactUri: candidateB.textUri,
                            structuredArtifactUri:
                              candidateB.structuredArtifactUri ?? null,
                          }
                        : null,
                    ].filter(Boolean),
                    policyObservations: policyDecision.observations,
                    extractorAttempts: attemptLedger.snapshot(),
                    artifactGraphUri: graph?.manifestUri ?? null,
                    artifactGraphTargets: graph?.requestedTargets ?? [],
                    artifactGraphSteps: graph?.steps ?? [],
                    artifactGraphOutputCount: graph?.outputCount ?? 0,
                    artifactGraphLatencyMs: graph?.latencyMs ?? 0,
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
                    critique?.correctedTextUri ?? winningCandidate.textUri;
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
                  const pageImageEvidenceUri =
                    isPdf && state.run.pipeline.visionFallback
                      ? await this.recordPageImageEvidence(document, tempFile, winningText, state, signal)
                      : null;
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
                  if (graph) state.artifactLedger.recordDocument(document.id, "artifact-graph", graph.manifestUri);
                  state.artifactLedger.recordDocument(document.id, "heatmap", this.storage.uri(heatmapKey));
                  state.artifactLedger.recordDocument(document.id, "canonical-document", canonicalUri);
                  state.artifactLedger.recordDocument(document.id, "extraction-contract", contractUri);
                  if (winningCandidate.structuredArtifactUri) {
                    state.artifactLedger.recordDocument(
                      document.id,
                      "liteparse-structured",
                      winningCandidate.structuredArtifactUri,
                    );
                  }
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

                  await completeDocumentPages(state, document, this.name, remaining, pageCount);

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
                      processedPages: remaining.length,
                      // Which extractor served the document, what else was planned or tried, and how the
                      // native PDF engine took part: queryable from stage stats without fetching the manifest.
                      extractor: winningCandidate.label,
                      secondaryExtractor: plannedExtractors.secondary?.label ?? null,
                      extractorOrder: this.tryResolveExtractorOrder(format, extractionConfig.order),
                      extractorAttempts: attemptLedger.snapshot(),
                      retryStrategy: retryStrategy ?? "default",
                      extractionMs: Date.now() - extractionStartedAt,
                      nativePdf: nativePdfStats,
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
                const message = error instanceof Error ? error.message : String(error);
                console.error(
                  `[extract-error] stage=${this.name} document=${document.id} ` +
                    `message=${message} partialArtifact=${partialArtifactUri || "none"} ` +
                    `partialStats=${JSON.stringify(partialStats)}`,
                );
                // Rethrow interruptions untouched so they keep their AbortError/cancellation identity.
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
        pages: splitTextIntoPages(markdown, document.pageCount).slice(0, 2),
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

  private imageListingKey(
    state: import("../pipeline/pipeline.js").WorkflowState,
    document: import("../models.js").Document,
  ): string {
    return `${state.run.id}:${document.id}`;
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
      });
      if (!pages) return null;
      const artifact: PageImageEvidenceArtifact = {
        documentId: document.id,
        source: "pdfimages",
        sparsePageWords: SPARSE_PAGE_WORDS,
        pages,
      };
      const key = `${runArtifactRoot(state.run, document.userId)}/page-image-evidence/${document.id}.json`;
      await this.storage.putJson(key, artifact);
      console.log(
        `[extract-debug] document=${document.id} pageImageEvidence sparsePages=${pages.length} ` +
          `withImages=${pages.filter((page) => page.imageCount > 0).length}`,
      );
      return this.storage.uri(key);
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn(
        `[extract-markdown] page image evidence unavailable document=${document.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** Text-layer bytes and image counts per page (PDF), or one image page (image files). */
  private async recordSourcePageFacts(
    state: import("../pipeline/pipeline.js").WorkflowState,
    document: import("../models.js").Document,
    format: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!pageFactsEnabled() || !state.store?.upsertPageFacts) return;
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
      });
      await recordPageFacts(state.store, rows);
    } catch (error) {
      console.warn(`[page-facts] skipped document=${document.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async extractCandidate(
    extractor: PreparedExtractor,
    textKey: string,
    sourceTempFile: string,
    signal?: AbortSignal,
    graphContext?: { sourceHash: string; pageCount: number; documentId: string },
  ): Promise<ExtractedCandidate> {
    return extractor.execute(this.candidateExecutors(graphContext), textKey, sourceTempFile, signal);
  }

  private candidateExecutors(
    graphContext?: { sourceHash: string; pageCount: number; documentId: string },
  ): CandidateExecutors {
    return {
      stream: (plan, label, key, abort) => this.extractStreamCandidate(plan, label, key, abort),
      file: (plan, label, key, outputPath, abort) => this.extractFileCandidate(plan, label, key, outputPath, abort),
      liteparse: (candidate, key, source, abort) => this.extractLiteParseCandidate(candidate, key, source, abort),
      graph: (candidate, key, source, abort) => this.extractGraphCandidate(candidate, key, source, graphContext, abort),
      markdownFile: (candidate, key, outputPath) => this.uploadMarkdownFileCandidate(candidate, key, outputPath),
    };
  }

  /**
   * An image has no text layer, so when OCR cannot read it (no Tesseract data on this worker, or
   * Kreuzberg's bundled OCR crashing) vision is the only reader left. Returns a stand-in extractor whose empty
   * Markdown lets page triage and the vision stage read the pixels. When the workspace cannot use vision
   * (turned off, or privacy mode forbids the route) the image is unreadable: fail naming that cause. The raw
   * diagnostic stays in the stored error and logs; `publicDocumentError` never shows it to users.
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
    context?: { sourceHash: string; pageCount: number; documentId: string },
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

  private async extractLiteParseCandidate(
    extractor: PreparedExtractor,
    textKey: string,
    sourceTempFile: string,
    signal?: AbortSignal,
  ): Promise<ExtractedCandidate> {
    const adapter = new LiteParseDocumentExtractionAdapter(this.runner, {
      ocrEnabled: false,
    });
    const structuredResult = await adapter.extract({
      inputPath: sourceTempFile,
      outputPath: extractor.outputPath!,
      signal,
    });
    const sanitized = sanitizeExtractedMarkdown(structuredResult.markdown);
    const tempTextPath = `${extractor.outputPath!}.md`;
    await writeFile(tempTextPath, sanitized.markdown, "utf8");
    await this.storage.streamText(
      textKey,
      sanitized.markdown,
      "text/markdown; charset=utf-8",
    );
    const structuredKey = `${textKey}.structured.json`;
    const sanitizedResult = {
      ...structuredResult,
      markdown: sanitized.markdown,
    };
    await this.storage.putJson(structuredKey, sanitizedResult);

    return {
      label: extractor.label,
      plan: extractor.plan,
      textKey,
      textUri: this.storage.uri(textKey),
      tempTextPath,
      structuredResult: sanitizedResult,
      structuredArtifactUri: this.storage.uri(structuredKey),
    };
  }

  private async extractFileCandidate(
    plan: CommandPlan,
    label: string,
    textKey: string,
    outputPath: string,
    signal?: AbortSignal,
  ): Promise<ExtractedCandidate> {
    await this.runner.run(plan, signal);

    const upload = this.storage.createMultipartUploadStream(
      textKey,
      "text/markdown; charset=utf-8",
    );
    await pipeline(createReadStream(outputPath), upload.writable);
    await upload.done;

    return {
      label,
      plan,
      textKey,
      textUri: this.storage.uri(textKey),
      tempTextPath: outputPath,
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

  private async collectCandidateResults(args: {
    primary: PreparedExtractor;
    primaryKey: string;
    secondary: PreparedExtractor | null;
    secondaryKey: string | null;
    sourceTempFile: string;
    graphContext: { sourceHash: string; pageCount: number; documentId: string };
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
        args.sourceTempFile,
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
        args.sourceTempFile,
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
    const critiquePages = budgetCritiquePages(
      selectCritiquePages(args.heatmapPages),
      maxCostCents,
      maxCostPerPageCents,
    );
    if (critiquePages.length === 0) {
      return null;
    }
    // Self-critique is optional; skip it when the vision route is hosted and
    // the workspace privacy mode forbids hosted calls.
    if (!(await allowHostedCall(args.state, visionCall(resolveVisionRoute(args.state.run.pipeline.vision)), [args.document.id]))) {
      return null;
    }

    const pageTexts = splitTextIntoPages(
      args.winningText,
      Math.max(1, args.document.pageCount),
    );
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

      const corrections = await Promise.all(
        critiquePages.map(async (pageNumber): Promise<SelfCritiqueCorrection> => {
        const imagePath = path.join(
          scratchDir,
          `critique-page-${pageNumber}.png`,
        );
        try {
          const originalText = pageTexts[pageNumber - 1] ?? "";
          const result = await executeVisionRuntime({
            imagePath,
            outputPath: `${imagePath}.json`,
            privacyMode: args.state.run.pipeline.privacyMode,
            vision: {
              ...args.state.run.pipeline.vision,
              prompt: buildCritiquePrompt(
                originalText,
                args.state.run.pipeline.preserveTables,
                args.state.run.pipeline.preserveCode,
              ),
            },
            cfg: this.cfg,
            runner: this.runner,
            signal: args.signal,
          });
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
            costCents: result.provider === "private" && result.costCents !== undefined ? result.costCents : calculateCritiqueCost(
              this.cfg,
              result.runtime,
              result.baseUrl,
              result.inputTokens,
              result.outputTokens,
            ),
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
      args.state.usageLedger.record({
          provider:
            resolveVisionRoute(args.state.run.pipeline.vision).runtime === "remote-openai"
              ? "openai"
              : "vision-runtime",
          model: resolveVisionRoute(args.state.run.pipeline.vision).model,
          metric: "page-critique",
          amount: corrections.length,
          unit: "page",
          costCents,
          inputTokens,
          outputTokens,
          metadata: {
            documentId: args.document.id,
            artifact: this.storage.uri(critiqueArtifactKey),
            reviewedPages: corrections.map((correction) => correction.pageNumber),
            acceptedPages: acceptedCorrections.map(
              (correction) => correction.pageNumber,
            ),
            maxCostCents,
            budgetExceeded: costCents > maxCostCents,
          },
        },
      );

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
      console.warn(`[extract-markdown] skipped office structure sidecar kind=${kind} document=${args.documentId} reason=${toError(error).message}`);
      return args.document;
    }
  }

  private async buildParserArtifacts(
    document: import("../models.js").Document,
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
    const isPdf = this.isPdfDocument(document);
    if (!isPdf) {
      if (options.nativePayloadOutcome) options.nativePayloadOutcome.reason = "filename and MIME type are not PDF";
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
            "hi_res",
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
        "hi_res",
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
      "hi_res",
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
      "hi_res",
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
  }): Promise<{ manifestUri: string; targetIds: string[]; requestedTargets: string[]; steps: string[]; outputCount: number; latencyMs: number }> {
    const startedAt = Date.now();
    const scratchDir = await mkdtemp(path.join(tmpdir(), "docslurp-artifact-graph-"));
    try {
      if (args.format !== "pdf") {
        throw new Error(`artifact enrichment is unavailable for ${args.format}`);
      }
      const result = await (args.graphRunner ?? runLocalPdfArtifactGraph)({
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

  private isPdfDocument(document: import("../models.js").Document): boolean {
    return (
      path.extname(document.filename).toLowerCase() === ".pdf" ||
      document.mimeType.toLowerCase().includes("pdf")
    );
  }

  private resolveDocumentExtractorOrder(
    format: string,
    order: Partial<Record<string, string[]>>,
  ): string[] {
    return documentExtractorRegistry.resolve(format, order[format]);
  }

  private async planExtractors(args: {
    tempFile: string;
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
          { format: args.format },
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
          { format: args.format },
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
  const pages = splitTextIntoPages(originalText, pageCount);
  if (pages.length === 0) {
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

function calculateCritiqueCost(
  cfg: Config,
  runtime: string,
  baseUrl: string | null,
  inputTokens: number,
  outputTokens: number,
): number {
  const normalizedBaseUrl = baseUrl?.replace(/\/+$/, "") ?? null;
  const normalizedOpenAiBaseUrl = cfg.openAiBaseUrl.replace(/\/+$/, "");
  const billableRuntime =
    runtime === "remote-openai" ||
    (runtime === "openai-compatible" &&
      normalizedBaseUrl === normalizedOpenAiBaseUrl);

  if (!billableRuntime) {
    return 0;
  }

  return Math.ceil(
    (inputTokens / 1000) * cfg.costPer1kInputTokens +
      (outputTokens / 1000) * cfg.costPer1kOutputTokens,
  );
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

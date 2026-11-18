import { createHostedOcrReader } from "../ocr/hosted-reader.js";
import { mayHaveHtmlTables, storeEmbedTableCells, type StoreEmbedTableCellsStats } from "./embed-table-cells.js";
import { visionRunMayReadPages, visionSkipsTextNativeSource } from "../lib/vision-reads-pages.js";
import { recordPageExtracts, visionPageRecords } from "../pipeline/page-extracts.js";
import { runUsesOcrPageClass } from "../pipeline/ocr-page-class.js";
import { recordPageEscalation } from "../pipeline/run-milestones.js";
import { recordOcrReads } from "../ocr/ledger.js";
import { OcrInfrastructureError, ocrFailedPages, recordOcrFailedPages, resolveOcrMode } from "../ocr/mode.js";
import { authorizeOcrRead } from "../ocr/image-frames.js";
import { ocrDocument } from "../ocr/read-document.js";
import { OCR_PDF_BATCH_PAGES } from "./extract-markdown.js";
import { OCR_BOUNDARY_FAILED } from "../routing/executors/run.js";
import { imageOrientationEnabled, normalizeImageOrientation, withOrientationAdmission, reserveOrientationAttempt } from "../lib/image-orientation.js";
import { rm } from "node:fs/promises";
import {
  adaptiveRoutingDecisionSurfaceSchema,
  canonicalDocumentSchema,
  documentLadderPolicy,
  effectiveLadder,
  ladderPlanSummary,
  parserPlaybookCatalog,
  parserPlaybookForQuality,
  ladderForbidsVision,
  ladderSkipsOcr,
  qualityAllowsPageReading,
  resolveVisionRoute,
  visionListPriceCents,
  visionModelTokenPricing,
  type LadderPlan,
  type ParserPlaybookKey,
  type VisionConfig,
  type VisionRuntime,
  extractionContractSchema,
} from "@docslurp/shared";

import { findProviderRetryableError } from "../lib/provider-retry.js";
import type { Config } from "../config.js";
import type { UsageEvent } from "../models.js";
import type { PdfRasterCache, RasterPageArtifact } from "../pipeline/pdf-asset-cache.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import {
  DocumentStageError,
  emitDocumentPageProgress,
  isCostCapExceeded,
  runSpentCents,
  runDocumentStage,
  runDocuments,
} from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import type { CommandRunner } from "../tools/runner.js";
import { type ArtifactStore, cleanupTempFile, keyFromStorageUri } from "../tools/storage.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import { ladderKeepsImageUnread, planDocumentLadder, pinLadderPlan, readLadderPin } from "../routing/auto-ladder.js";
import { configuredVisionServedRoute, executeVisionRuntime, isPageTranscription, visionCall, visionRenderLongEdge, VisionImageOverBudgetError } from "../tools/vision-runtime.js";
import { findVisionBilledUsage, findVisionOutputRejected } from "../tools/vision-stream.js";
import { primaryFailureUsages, priceVisionResult, visionFailureUsages, type VisionFailureUsage } from "../lib/guarded-vision-call.js";
import { allowHostedCall } from "../lib/privacy-guard.js";
import { trustedTempDownloadPattern } from "../lib/temp-file-names.js";
import { maxInt } from "./utils.js";
import { refreshSummaryEvidence } from "./summary-evidence-refresh.js";
import {
  reconcileCanonicalArtifacts,
  type CanonicalReconciliationDecision,
} from "../lib/canonical-reconciliation.js";
import { loadActiveRoutePlan } from "../routing/active-plan.js";
import { DRAWN_CONTENT_SIGNAL, selectLegacyVisionPages, TABLE_LEAK_ONLY_SIGNAL } from "./classify-route.js";
import { inkCheckVerdict, readPngFileFacts } from "../lib/page-image-evidence.js";
import {
  findVisionGuardStop,
  recordVisionRead,
  visionGuardFor,
  withVisionCall,
  type VisionAttemptPurpose,
  type VisionAttemptTarget,
  type VisionGuardStop,
} from "../lib/vision-attempt-guard.js";
import { findVisionServedRoute, isBilledVisionRoute, type VisionServedRoute } from "../lib/vision-pricing.js";
import { VISION_ROUTING_VERSION_SLOT, resolveRunRoutingV2, routingVersion } from "../lib/vision-routing-v2.js";
import { visionAllowedForDocument } from "../lib/vision-page-budget.js";
import { createProductionExecutorDeps } from "../routing/executors/deps.js";
import { PLAN_QUALITY_METHOD } from "../routing/quality.js";
import { runRoutedVision, visionConfigForModel, type RoutedVisionArgs, type RoutedVisionResult } from "../routing/routed-vision.js";
import { createDecisionVerifier, escalationThreshold } from "../routing/verifier.js";
import {
  buildRoutedValidation,
  buildRuntimeCatalog,
  groupAssignmentsByTarget,
  loadRuntimePolicyPack,
  type RoutedExecution,
} from "../routing/runtime.js";
import type { CanonicalDocument, PlanValidation, RoutePlan } from "@docslurp/shared";
import { MIXED_SCAN_IMAGE_SIGNAL, tableLeakPageCap } from "@docslurp/shared";
import { buildVisionPageFacts, recordPageFacts, type VisionPageOutcome } from "../pipeline/page-facts.js";
import { VISUAL_CANDIDATE_STATS_KEY, type BBox } from "@docslurp/shared";
import { chargeChartExports, chartExportCanSpend } from "../chart-export/billing.js";
import { chartCallRuntimeOptions, chartExportActive, chartExportConfigOf, chartExportModelsActive } from "../chart-export/config.js";
import { chartExportReasoning, chartExportVisionConfig } from "../chart-export/model-selection.js";
import { ChartExportSession, type ChartExportRunBudget } from "../chart-export/session.js";
import {
  clearChartExport,
  finishChartExport,
  prepareChartExport,
  type ChartExportPassInput,
  type PageImage,
  type PreparedChartExport,
} from "../chart-export/stage.js";
import { quarantineChartFacts, storedRoutePlan } from "../chart-export/free-stats.js";
import { CHART_INLINE_SLOT, chartInlineSlotHasWork, freeInlineMode } from "../chart-export/inline.js";
import { FIGURE_CHARTS_SLOT, figureChartsSlotHasWork } from "../chart-export/figure-charts.js";
import type { ChartModelClient } from "../chart-export/types.js";
import { chartExportFreeVmCap } from "../db/chart-export-free-vm-cap.js";
import { deterministicSourceKind } from "../chart-export/vm-extractor.js";
import chartSharp from "../tools/isolated-image.js";
import type { DocumentStageResult } from "../pipeline/checkpoints.js";
import { sanitizeVisionPageTables } from "../pipeline/vision-tables-vm.js";
import type { PageImageReaderProvider } from "../extractors/plugins.js";
import { ocrPageReaderMaxPages, ocrPageReaderOrgDailyMaxCostCents, PAGE_READER_STOP_REASONS, pageReaderOrgHasHeadroom, pageReaderPagesRemaining, readPageImagesWithProvider, type PageImageInput } from "../ocr/page-reader.js";
import { VISION_PAGE_READER_METRIC, VISION_READER_WARMING_HOSTED_CHUNK, VISION_READER_WARMING_LANES, visionPageReaderFor } from "./vision-page-reader.js";
import {
  logPageReaderWarmSummary, pageReaderWarmGate, pageReaderWarmPolicy, pageReaderWarmState, recordPageReaderWarmRouting,
  releasePageReaderWarmReservation,
} from "../ocr/page-reader-warm.js";

export interface VisionPageOutput {
  pageNumber: number;
  runtime: string;
  model: string;
  prompt: string;
  baseUrl: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  usageSource: string;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  text: string;
  costCents: number;
  /** Provider finish reason (`stop`, `length`, ...) when the runtime reported one. */
  finishReason?: string | null;
  /** Model id the provider reports having served, when it differs in form from `model` or is the only report. */
  servedModel?: string;
  /** The provider on this read's usage row, so the page record names the same model as the usage event. */
  provider?: string;
  /** The OCR engine's reader label for the page (a recogniser, or `hosted:`/`escalated:`/`page-reader:` + id). */
  reader?: string;
  orientation?: import("../lib/image-orientation.js").OrientationResult | { status: "skipped-limit" };
  /** Present when the served model differs from the requested one (see `VISION_MODEL_SWAP_POLICY`). */
  modelSwap?: { requested: string; served: string; provider: string | null };
}

/**
 * A selected page that produced no vision output, and why. Page tasks store it as their result
 * (instead of null), so the stage pass that assembles the document knows each page's outcome.
 */
export interface VisionPageSkip extends VisionPageOutcome {
  pageNumber: number;
}

/** Per-page hints from page triage for the legacy path. */
export interface LegacyPageHints {
  /** Pages nominated only by drawn-content bytes: call vision only if the render is not blank. */
  inkCheckPages: ReadonlySet<number>;
  /** Pages with usable native or OCR text to keep when vision gives nothing. */
  fallbackTextPages: ReadonlySet<number>;
  /**
   * Scans beside native text (MIXED_SCAN_IMAGE_SIGNAL): in `vm` OCR mode these are read by the OCR engine in its VM, as
   * scanned pages are, never rasterized on the host for a hosted vision model.
   */
  vmOcrPages?: ReadonlySet<number>;
  /**
   * Pages authorized by table-leak signals alone (TABLE_LEAK_ONLY_SIGNAL): read under the guard's durable `table-rescue`
   * budget of tableLeakPageCap(pages) distinct pages per document, so retries and restarts cannot widen the cap.
   */
  tableRescuePages?: ReadonlySet<number>;
  /**
   * Pages page triage routed as figure- or chart-bearing (`chart-or-figure`, `image-heavy`): the vision page reader, an
   * OCR specialist that skips image insets, leaves them to the hosted route (vision-page-reader.ts).
   */
  figurePages?: ReadonlySet<number>;
  /** Built from page triage (legacyPageHints): without it no page is known not to be a figure, so none goes to the reader. */
  triaged?: boolean;
}

export { VisionGuardStopError } from "../lib/vision-attempt-guard.js";

export function isVisionPageSkip(value: unknown): value is VisionPageSkip {
  return typeof value === "object" && value !== null && typeof (value as { outcome?: unknown }).outcome === "string" &&
    typeof (value as { pageNumber?: unknown }).pageNumber === "number";
}

/** Text a page keeps when vision gives nothing is usable when it has some words and is not garbled. */
const USABLE_FALLBACK_DENSITY = 0.02;

export function legacyPageHints(pages: Array<{ pageNumber: number; textDensityScore: number; signals: string[];
  route?: string; ocrDecision?: { signals: string[] } }>): LegacyPageHints {
  const inkCheckPages = new Set<number>();
  const fallbackTextPages = new Set<number>();
  const vmOcrPages = new Set<number>();
  const tableRescuePages = new Set<number>();
  const figurePages = new Set<number>();
  for (const page of pages) {
    if (page.route === "chart-or-figure" || page.route === "image-heavy") figurePages.add(page.pageNumber);
    if (page.ocrDecision?.signals.includes(TABLE_LEAK_ONLY_SIGNAL)) tableRescuePages.add(page.pageNumber);
    if (page.ocrDecision?.signals.includes(DRAWN_CONTENT_SIGNAL)) inkCheckPages.add(page.pageNumber);
    if (page.ocrDecision?.signals.includes(MIXED_SCAN_IMAGE_SIGNAL)) vmOcrPages.add(page.pageNumber);
    if (page.textDensityScore >= USABLE_FALLBACK_DENSITY && !page.signals.includes("garbled-text")) {
      fallbackTextPages.add(page.pageNumber);
    }
  }
  return { inkCheckPages, fallbackTextPages, vmOcrPages, tableRescuePages, figurePages, triaged: true };
}

/** Errors whose vision attempt `recordFailedVisionAttempt` already recorded (once per call). */
const recordedVisionErrors = new WeakSet<object>();

const NO_HINTS: LegacyPageHints = { inkCheckPages: new Set(), fallbackTextPages: new Set() };

/** Per worker process: the pages a document's ladder plan allows, by run, document and limits (page tasks, ladderAllowsPageTask). */
const LADDER_TASK_PLANS = new Map<string, Promise<Set<number>>>();

export class VisionExtractStage implements Stage {
  readonly name = "vision-extract";

  constructor(
    private readonly runner: CommandRunner,
    private readonly storage: ArtifactStore,
    private readonly cfg: Config,
    private readonly rasters: PdfRasterCache,
  ) {}

  async planPageTasks(state: WorkflowState, signal?: AbortSignal, progress?: (phase: string, completed?: number) => void) {
    const checkpoint = () => { signal?.throwIfAborted(); progress?.("planning-pages", tasks.length); };
    const tasks: import("../temporal/shared.js").VisionPageTask[] = [];
    checkpoint();
    // Budget-capped runs retain sequential admission, rather than oversubscribing a cap.
    if (!state.run.pipeline.visionFallback || (state.run.pipeline.maxCostCents ?? 0) > 0) return tasks;
    // Fast never reads a page; pages without a text layer were kept as page images (render-images).
    if (!qualityAllowsPageReading(state.run.pipeline.quality)) return tasks;
    if (!(await this.visionAllowed(state))) return tasks;
    for (const document of healthyDocuments(state)) {
      checkpoint();
      if (document.mimeType.startsWith("text/") || state.documentStages.get(document.id)?.get(this.name)?.status === "completed") continue;
      const vision = state.run.pipeline.vision;
      // Active page router: one task per page served by exactly one VLM group, on that group's model
      // (a task's output is cached by page, so a page two groups both serve stays sequential, as do
      // executor-only pages, which are local and cheap). Orchestration is unchanged for the workflow:
      // activities only return a different task list, which replayed histories never re-evaluate.
      const routed = await this.loadRoutedExecution(state, document);
      checkpoint();
      if (routed) {
        // Non-standard privacy modes gate every group's model per call; keep that on the sequential path.
        if (state.run.pipeline.privacyMode !== "standard") continue;
        const groupsByPage = new Map<number, typeof routed.execution.groups>();
        for (const group of routed.execution.groups) {
          for (const page of group.pages) groupsByPage.set(page, [...(groupsByPage.get(page) ?? []), group]);
        }
        const fanOut = [...groupsByPage.entries()]
          .filter(([page, groups]) => groups.length === 1 && !routed.execution.fallbackPages.includes(page))
          .sort(([a], [b]) => a - b);
        for (const [pageNumber, [group]] of fanOut) {
          if (tasks.length % 100 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            checkpoint();
          }
          tasks.push({
            runId: state.run.id,
            documentId: document.id,
            pageNumber,
            pageCount: fanOut.length,
            vision: visionConfigForModel(vision, group!.modelUri),
          });
        }
        continue;
      }
      const routing = await this.checkNeedsVision(document, maxInt(1, document.pageCount), state, signal);
      checkpoint();
      if (!routing.needed) continue;
      // Pages the vision page reader will read are not fanned out: run() reads them in batched reader jobs (one job per
      // page would pay the reader's admission and reservation per page). The document's other pages still fan out.
      const readerPages = new Set(await this.plannedReaderPages(state, document, vision, routing.selectedPages, routing.hints));
      const pages = [...routing.selectedPages].filter((page) => !readerPages.has(page)).sort((a, b) => a - b);
      for (const pageNumber of pages) {
        if (tasks.length % 100 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          checkpoint();
        }
        tasks.push({
          runId: state.run.id, documentId: document.id, pageNumber, pageCount: pages.length, vision,
          ...(routing.hints.inkCheckPages.has(pageNumber) ? { inkCheck: true } : {}),
          ...(routing.hints.fallbackTextPages.has(pageNumber) ? { fallbackText: true } : {}),
          ...(routing.hints.vmOcrPages?.has(pageNumber) ? { vmOcr: true } : {}),
        });
      }
    }
    checkpoint();
    return tasks.length > 1 ? tasks : [];
  }

  async runPageTask(state: WorkflowState, task: import("../temporal/shared.js").VisionPageTask, signal?: AbortSignal) {
    const document = state.documents.find((doc) => doc.id === task.documentId);
    if (!document) throw new Error("Page task document is not part of run");
    const skips = new Map<number, VisionPageSkip>();
    const hints: LegacyPageHints = {
      inkCheckPages: new Set(task.inkCheck ? [task.pageNumber] : []),
      fallbackTextPages: new Set(task.fallbackText ? [task.pageNumber] : []),
      vmOcrPages: new Set(task.vmOcr ? [task.pageNumber] : []),
    };
    // Defense in depth: page tasks come from the ladder plan (planPageTasks); a page outside this run's plan for the
    // document is not read. Without a pin yet (planning does not persist the ledger) the plan is made again here, from the
    // same stored inputs, once per document and worker process (fail closed: never "no pin, so allowed").
    if (effectiveLadder(state.run.pipeline).active && !(await this.ladderAllowsPageTask(state, document, task.pageNumber))) {
      console.warn(`[ladder] page task outside the document's plan document=${document.id} page=${task.pageNumber}: not read`);
      return { pageNumber: task.pageNumber, outcome: "ladder-capped", fallbackText: task.fallbackText === true } satisfies VisionPageSkip;
    }
    const outputs = await this.extractVisionPagesFromCache(state, document, task.vision, [task.pageNumber], signal,
      undefined, undefined, false, { hints, skips });
    // An optional fail-open result is also a checkpoint; do not repeatedly call the provider. A
    // skipped page stores why, never model text.
    return outputs[0] ?? skips.get(task.pageNumber) ?? null;
  }

  /** Pages this run's ladder plan lets vision read in the document: the pinned plan, else a fresh plan (cached). */
  private async ladderAllowsPageTask(state: WorkflowState, document: import("../models.js").Document, pageNumber: number): Promise<boolean> {
    const pin = readLadderPin(state.artifactLedger, document.id, state.run.id);
    if (pin) return pin.escalated.has(pageNumber);
    const key = `${state.run.id}:${document.id}:${JSON.stringify(state.run.pipeline.ladder ?? null)}`;
    let allowed = LADDER_TASK_PLANS.get(key);
    if (!allowed) {
      allowed = this.checkNeedsVision(document, maxInt(1, document.pageCount), state).then((needs) => {
        // A plan made without page triage (a transient storage failure) is used once and not cached.
        if (!needs.routing) LADDER_TASK_PLANS.delete(key);
        return new Set(needs.needed ? needs.selectedPages : []);
      });
      LADDER_TASK_PLANS.set(key, allowed);
      allowed.catch(() => LADDER_TASK_PLANS.delete(key));
      while (LADDER_TASK_PLANS.size > 64) LADDER_TASK_PLANS.delete(LADDER_TASK_PLANS.keys().next().value!);
    }
    return (await allowed).has(pageNumber);
  }

  /**
   * Vision fallback is optional page rescue: when the configured route is hosted
   * and privacyMode forbids it, the stage is skipped (and audited) rather than failed.
   */
  private async visionAllowed(state: WorkflowState): Promise<boolean> {
    return await allowHostedCall(
      state,
      visionCall(resolveVisionRoute(state.run.pipeline.vision)),
      state.documents.filter((document) => !document.mimeType.startsWith("text/")).map((document) => document.id),
    );
  }

  async run(state: WorkflowState, signal?: AbortSignal): Promise<void> {
    // Fast never reads a page; pages without a text layer were kept as page images (render-images).
    const readsPages = visionRunMayReadPages(state.run.pipeline) && (await this.visionAllowed(state));
    const exportCharts = chartExportActive(state.run.pipeline);
    if (!readsPages) {
      // Chart export runs without general vision: the free tier (the default) exports only charts that carry their own
      // data and never renders a page or calls a model; the billed `models` tier also reads crops (each call gated by
      // privacy mode and the cost cap on its own). With export off the stage stays as inert as before (render-images
      // records the free candidate stats); only a reprocess of a document an earlier run exported charts for removes
      // those blocks.
      if (exportCharts) await this.runChartExportOnly(state, signal);
      else await this.clearStaleChartExports(state);
      return;
    }

    await runDocuments(
      healthyDocuments(state),
      (state.run.pipeline.maxCostCents ?? 0) > 0 ? 1 : state.docConcurrency,
      async (document) => {
        if (isCostCapExceeded(state)) {
          console.log(
            `[extract-debug] stage=${this.name} document=${document.id} skipped=cost-cap`,
          );
          state.pendingPerformance.push({
            documentId: document.id,
            scope: "document",
            stageName: this.name,
            metric: "cost-cap-skip",
            value: 1,
            unit: "document",
            tags: ["cost", "cap"],
            metadata: {
              cap: state.run.pipeline.maxCostCents,
              totalCost: runSpentCents(state),
            },
          });
          await recordPageFacts(state, buildVisionPageFacts({
            documentId: document.id, runId: state.run.id, pageCount: maxInt(1, document.pageCount),
            selected: [], processed: [], costCapped: true,
          }));
          return;
        }

        const key = `${runArtifactRoot(state.run, document.userId)}/vision/${document.id}.json`;
        const pages = maxInt(1, document.pageCount);
        const artifactSlot = `${document.id}:vision`;
        const playbook = this.resolveParserPlaybook(state, document.id);
        const selection: VisionConfig = state.run.pipeline.vision;
        const route = resolveVisionRoute(selection);
        const routingV2 = resolveRunRoutingV2(state);
        const chartExport = exportCharts ? this.chartExportSession(state, document) : null;

        console.log(
          `[extract-debug] stage=${this.name} document=${document.id} ` +
            `playbook=${playbook} pages=${pages} visionAllowed=${this.visionAllowed_(state, document.id)} ` +
            `model=${route.model} runtime=${route.runtime}`,
        );

        await runDocumentStage(
          state,
          document,
          this.name,
          artifactSlot,
          "vision fallback manifest ready",
          async () => this.withChartExport(state, document, chartExport, signal, async () => {
            if (visionSkipsTextNativeSource(document)) {
              await this.storage.putJson(key, {
                documentId: document.id,
                selection,
                skipped: true,
                reason: "text-native-source",
                pages,
                selectedPages: [],
                routing: null,
              });

              return {
                artifactUri: this.storage.uri(key),
                stats: {
                  pages: 0,
                  skipped: true,
                  reason: "text-native-source",
                  selectedPages: [],
                },
              };
            }

            // Active page router: the stored plan replaces page selection and the single global
            // model. Off/shadow, project force-all-pages, or no plan: unchanged legacy path.
            const routed = await this.loadRoutedExecution(state, document);
            const needsVision = routed
              ? this.routedSelection(routed)
              : await this.checkNeedsVision(document, pages, state, signal);
            console.log(
              `[extract-debug] document=${document.id} needsVision=${needsVision.needed} ` +
                `reason=${needsVision.reason} score=${needsVision.score.toFixed(3)} ` +
                `selectedPages=${needsVision.selectedPages.length} ` +
                `routingPolicy=${needsVision.routing?.visionPolicy ?? "none"}`,
            );

            if (!needsVision.needed) {
              if (routed) await this.recordRoutedValidation(state, document, routed.plan, routed.execution, null, key);
              await this.storage.putJson(key, {
                documentId: document.id,
                selection,
                skipped: true,
                reason: needsVision.reason,
                score: needsVision.score,
                pages,
                selectedPages: needsVision.selectedPages,
                routing: needsVision.routing,
                routingVersion: routingVersion(routingV2),
                ...(needsVision.ladder ? { ladder: needsVision.ladder } : {}),
              });

              await recordPageFacts(state, buildVisionPageFacts({
                documentId: document.id, runId: state.run.id, pageCount: pages,
                selected: [], processed: [],
              }));
              return {
                artifactUri: this.storage.uri(key),
                stats: {
                  pages,
                  skipped: true,
                  score: needsVision.score,
                  selectedPages: needsVision.selectedPages,
                  reason: needsVision.reason,
                  routingVersion: routingVersion(routingV2),
                  ...(needsVision.ladder ? { ladder: needsVision.ladder.summary } : {}),
                },
              };
            }

            let outputs: any[] = [];
            let routedResult: RoutedVisionResult | null = null;
            const skips = new Map<number, VisionPageSkip>();

            try {
              if (routed) {
                routedResult = await this.extractRoutedPages(state, document, selection, routed, signal, key, skips, chartExport ?? undefined);
                outputs = routedResult.outputs;
              } else {
                outputs = await this.extractVisionPagesFromCache(
                  state,
                  document,
                  selection,
                  needsVision.selectedPages,
                  signal,
                  key,
                  undefined,
                  false,
                  // Only this legacy, whole-document read may use the vision page reader: routed groups, cascade legs and
                  // page tasks always keep the hosted route they were planned on.
                  { hints: needsVision.hints, skips, pageReader: true },
                );
              }
            } catch (error) {
              if (!shouldFailOpenVisionError(error)) {
                // extractVisionPages now handles partial saving internally for fatal errors
                throw error;
              }

              const reason = toError(error).message;
              console.warn(
                `[vision-extract] skipped optional vision fallback document=${document.id} reason=${reason}`,
              );

              await this.storage.putJson(key, {
                documentId: document.id,
                selection,
                skipped: true,
                failOpen: true,
                reason,
                score: needsVision.score,
                pages,
                selectedPages: needsVision.selectedPages,
                routing: needsVision.routing,
                routingVersion: routingVersion(routingV2),
                visionGuard: findVisionGuardStop(error),
              });

              state.pendingPerformance.push({
                documentId: document.id,
                scope: "document",
                stageName: this.name,
                metric: "vision-fail-open",
                value: 1,
                unit: "document",
                tags: ["document", "vision", "fallback"],
                metadata: {
                  runtime: route.runtime,
                  model: route.model,
                  reason,
                  routingVersion: routingVersion(routingV2),
                },
              });

              await recordPageFacts(state, buildVisionPageFacts({
                documentId: document.id, runId: state.run.id, pageCount: pages,
                selected: needsVision.selectedPages, processed: [],
              }));
              return {
                artifactUri: this.storage.uri(key),
                stats: {
                  pages: 0,
                  skipped: true,
                  failOpen: true,
                  score: needsVision.score,
                  selectedPages: needsVision.selectedPages,
                  reason,
                  routingVersion: routingVersion(routingV2),
                },
              };
            }

            // Model HTML tables are read in the parser VM, all of this document's pages in one job, and rebuilt on the host
            // from the typed result (vision-tables-vm.ts); nothing reads the model's own table markup after this.
            outputs = await this.rebuildModelTables(state, document, outputs, signal);
            if (routedResult) routedResult = { ...routedResult, outputs };

            const routedValidation = routed && routedResult
              ? await this.recordRoutedValidation(state, document, routed.plan, routed.execution, routedResult, key)
              : null;

            const failedPages = [...skips.values()].sort((left, right) => left.pageNumber - right.pageNumber);
            const guardStop = visionGuardFor(state).stop;
            this.recordVisionOutcomeTelemetry(state, document, outputs.length, failedPages, guardStop, routingV2);

            const inputTokens = outputs.reduce(
              (sum, page) => sum + page.inputTokens,
              0,
            );
            const outputTokens = outputs.reduce(
              (sum, page) => sum + page.outputTokens,
              0,
            );
            const totalLatencyMs = outputs.reduce(
              (sum, page) => sum + page.latencyMs,
              0,
            );
            const costCents = outputs.reduce(
              (sum, page) => sum + page.costCents,
              0,
            );

            await this.storage.putJson(key, {
              documentId: document.id,
              selection,
              reason:
                "fallback for scans, ligatures, tables, and image-heavy pages",
              skipped: false,
              score: needsVision.score,
              pages,
              selectedPages: needsVision.selectedPages,
              routing: needsVision.routing,
              ...(routed ? { pageRouter: this.routedSummary(routed, routedResult, routedValidation) } : {}),
              routingVersion: routingVersion(routingV2),
              ...(needsVision.ladder ? { ladder: needsVision.ladder } : {}),
              processedPages: outputs.length,
              // Selected pages without vision output and why; their model text (if any) is never kept.
              failedPages: failedPages,
              visionGuard: guardStop,
              totals: {
                inputTokens,
                outputTokens,
                latencyMs: totalLatencyMs,
                costCents,
              },
              pagesDetail: outputs.map((page) => ({
                pageNumber: page.pageNumber,
                runtime: page.runtime,
                model: page.model,
                baseUrl: page.baseUrl,
                prompt: page.prompt,
                latencyMs: page.latencyMs,
                inputTokens: page.inputTokens,
                outputTokens: page.outputTokens,
                usageSource: page.usageSource,
                fallbackUsed: page.fallbackUsed,
                fallbackReason: page.fallbackReason,
                costCents: page.costCents,
                ...(page.servedModel ? { servedModel: page.servedModel } : {}),
                ...(page.modelSwap ? { modelSwap: page.modelSwap } : {}),
                ...(page.orientation ? { orientation: page.orientation } : {}),
                text: page.text,
              })),
            });

            for (const page of outputs) {
              state.pendingPerformance.push({
                documentId: document.id,
                scope: "page",
                stageName: this.name,
                metric: "vision-latency",
                pageNumber: page.pageNumber,
                value: page.latencyMs,
                unit: "ms",
                tags: ["page", "vision", "latency"],
                metadata: {
                  runtime: page.runtime,
                  model: page.model,
                  fallbackUsed: page.fallbackUsed,
                  ...(page.modelSwap ? { modelSwap: page.modelSwap } : {}),
                ...(page.orientation ? { orientation: page.orientation } : {}),
                },
              });
            }

            state.pendingPerformance.push({
              documentId: document.id,
              scope: "document",
              stageName: this.name,
              metric: "vision-total-latency",
              value: totalLatencyMs,
              unit: "ms",
              tags: ["document", "vision", "latency"],
              metadata: {
                pages: outputs.length,
                runtime: route.runtime,
                model: route.model,
              },
            });

            await recordPageFacts(state, buildVisionPageFacts({
              documentId: document.id, runId: state.run.id, pageCount: pages,
              selected: needsVision.selectedPages, processed: outputs,
              costCapped: isCostCapExceeded(state),
              outcomes: skips,
            }));

            const reconciliation = await this.reconcileExtractionArtifacts(
              state,
              document,
              selection,
              outputs,
              this.storage.uri(key),
            );

            recordPageExtracts(state, document, visionPageRecords({
              outputs, skips: failedPages, reconciliation, ocrPageClass: runUsesOcrPageClass(state.artifactLedger),
            }));

            const tableCells = await this.storeTableCellsForEmbed(state, document, reconciliation, signal);

            console.log(
              `[extract-debug] document=${document.id} visionCompleted ` +
                `documentPages=${pages} selectedPages=${needsVision.selectedPages.length} failedPages=${failedPages.length} ` +
                `routingVersion=${routingVersion(routingV2)} ` +
                `processedPages=${outputs.length} inputTokens=${inputTokens} ` +
                `outputTokens=${outputTokens} costCents=${costCents}`,
            );

            return {
              artifactUri: this.storage.uri(key),
              stats: {
                ...(tableCells ? { tableCells } : {}),
                pages: outputs.length,
                inputTokens,
                outputTokens,
                costCents,
                skipped: false,
                score: needsVision.score,
                latencyMs: totalLatencyMs,
                selectedPages: needsVision.selectedPages,
                // Counts beside the page lists, so dashboards read selected vs read vs failed without unpacking arrays.
                documentPages: pages,
                selectedPageCount: needsVision.selectedPages.length,
                failedPageCount: failedPages.length,
                routingPolicy: needsVision.routing?.visionPolicy ?? null,
                routingVersion: routingVersion(routingV2),
                // Each page's Auto ladder rung and why (counts, limits and the first pages; the manifest keeps every page).
                ...(needsVision.ladder ? { ladder: needsVision.ladder.summary } : {}),
                failedPages: failedPages.map((page) => ({ pageNumber: page.pageNumber, reason: page.outcome, fallbackText: page.fallbackText })),
                visionGuard: guardStop?.reason ?? null,
                reconciledPages: reconciliation.changedPages,
                reconciliationDecisions: reconciliation.decisions.map((decision) => ({
                  pageNumber: decision.pageNumber,
                  outcome: decision.outcome,
                  reason: decision.reason,
                })),
              },
            };
          }),
          signal,
        );
      },
    );
  }

  private async rebuildModelTables<T extends { text?: string | null }>(
    state: WorkflowState, document: import("../models.js").Document, outputs: T[], signal?: AbortSignal,
  ): Promise<T[]> {
    const { texts, stats } = await sanitizeVisionPageTables(outputs.map((page) => page.text ?? ""), this.runner, { signal, documentId: document.id });
    if (stats.pages === 0) return outputs;
    console.log(
      `[vision-tables] document=${document.id} pages=${stats.pages} tables=${stats.tables} spansDropped=${stats.spansDropped} ` +
        `gfm=${stats.gfm} textFallback=${stats.textFallback} escapedPages=${stats.escapedPages} rawRegions=${stats.rawRegions}${stats.rawRegions ? ` rawReasons=${JSON.stringify(stats.rawReasons)}` : ""} vmCalls=${stats.vmCalls} vmMs=${stats.vmMs}`,
    );
    state.pendingPerformance.push({
      documentId: document.id, scope: "document", stageName: this.name, metric: "vision-table-rebuild-latency",
      value: stats.vmMs, unit: "ms", tags: ["document", "vision", "tables"],
      metadata: { ...stats },
    });
    return outputs.map((page, index) => (texts[index] === (page.text ?? "") ? page : { ...page, text: texts[index]! }));
  }

  private async checkNeedsVision(
    document: import("../models.js").Document,
    pageCount: number,
    state: WorkflowState,
    _signal?: AbortSignal,
  ): Promise<{
    needed: boolean;
    score: number;
    selectedPages: number[];
    reason: string;
    routing: {
      documentComplexity: string;
      visionPolicy: string;
      dominantRoutes: string[];
    } | null;
    hints: LegacyPageHints;
    /** The document's Auto ladder plan (auto quality on the triage path): each page's rung and why. */
    ladder?: { summary: Record<string, unknown>; decisions: LadderPlan["decisions"] };
  }> {
    const routing = await this.loadAdaptiveRouting(state, document.id);
    const routingV2 = resolveRunRoutingV2(state);
    let selectedPages = selectLegacyVisionPages(routing?.pages ?? [], { routingV2 });
    let score = 0;
    let needed = false;
    let reason = "persisted-text-density-sufficient";

    if (routing) {
      score =
        routing.pages.reduce((sum, page) => sum + page.textDensityScore, 0) /
        Math.max(1, routing.pages.length);
      needed = selectedPages.length > 0;
      reason = needed ? "page-triage-selected" : "page-triage-skip";
      if (needed && routing.visionPolicy === "aggressive") {
        reason = "adaptive-routing-aggressive";
      } else if (needed && routing.visionPolicy === "selective") {
        reason = "adaptive-routing-selective";
      } else if (
        routing.pages.some((page) => page.ocrDecision !== undefined) &&
        selectedPages.length === 0
      ) {
        reason = "calibrated-routing-skip";
      }
    } else {
      const text = await this.loadPersistedExtractionText(state, document.id);
      const playbook = this.resolveParserPlaybook(state, document.id);
      const threshold =
        parserPlaybookCatalog[playbook]?.guidance?.visionDensityThreshold ??
        this.cfg.visionDensityThreshold;
      score = this.scoreTextDensity(text ?? "", pageCount);
      // Without routing evidence, a document that has text keeps it under evidence routing: characters per page say
      // nothing about whether a page's content is pixels. Only a document with no text at all has no other reader.
      needed = !text || (!routingV2 && this.needsVision(text, pageCount, threshold));
      reason = !text
        ? "routing-and-extraction-evidence-unavailable"
        : needed
          ? "persisted-text-density-low"
          : "persisted-text-density-sufficient";
      if (needed) {
        selectedPages = Array.from({ length: pageCount }, (_, index) => index + 1);
      }
    }

    if (needed && !this.visionAllowed_(state, document.id)) {
      needed = false;
      reason = "playbook-disallows-vision";
    }

    // Pages whose OCR read failed in its boundary stay failed: vision never reads them in OCR's place.
    const ocrFailed = ocrFailedPages(state.artifactLedger, document.id);
    if (ocrFailed.size > 0) {
      selectedPages = selectedPages.filter((page) => !ocrFailed.has(page));
      needed = needed && selectedPages.length > 0;
      console.warn(`[ocr] vision skips pages whose OCR failed document=${document.id} pages=${[...ocrFailed].join(",")}`);
    }

    // The Auto ladder: every selected page gets a rung from page triage; the project's limits (pipeline.ladder) cap it.
    // Without limits the plan keeps every selected page on the rung it asked for, so the reads are unchanged.
    let hints: LegacyPageHints = routing ? legacyPageHints(routing.pages) : NO_HINTS;
    // Smartest has no OCR step: a mixed scan triage would send to the OCR engine is read by the vision model. A page an
    // above-ocr share cap lowers gets the OCR hint back from the ladder plan below.
    if (ladderSkipsOcr(state.run.pipeline) && hints.vmOcrPages?.size) hints = { ...hints, vmOcrPages: new Set<number>() };
    let ladder: { summary: Record<string, unknown>; decisions: LadderPlan["decisions"] } | undefined;
    // An image the ladder kept unread in extraction (a format that can hold several frames, under an above-fast share) is
    // not read here either: it stays its page image, as quoted.
    if (state.run.pipeline.quality === "auto" && (document.mimeType ?? "").startsWith("image/") && needed
      && ladderKeepsImageUnread(documentLadderPolicy(state.run.pipeline, pageCount), { filename: document.filename, mimeType: document.mimeType, sniffedMimeType: document.fileFacts?.sniffedMimeType ?? null })) {
      needed = false;
      reason = "ladder-kept-image";
    }
    if (state.run.pipeline.quality === "auto") {
      const planned = this.planLadder(state, document, pageCount, routing?.pages ?? [], needed ? selectedPages : [], hints);
      // Recorded only under a limit: without one, stats and manifests keep their shape and the reads are unchanged.
      if (planned.active) {
        ladder = { summary: planned.summary, decisions: planned.decisions };
        selectedPages = planned.selectedPages;
        hints = planned.hints;
        if (needed && selectedPages.length === 0) reason = "ladder-capped";
        needed = needed && selectedPages.length > 0;
      }
    }

    if (!needed) {
      selectedPages = [];
    }

    state.pendingPerformance.push({
      documentId: document.id,
      scope: "document",
      stageName: this.name,
      metric: "vision-text-density-score",
      value: score,
      unit: "ratio",
      tags: ["document", "vision", "cost-gate"],
      metadata: {
        needsVision: needed,
        pageCount,
        reason,
        selectedPages,
        evidenceSource: routing ? "page-triage" : "persisted-extraction",
        routingPolicy: routing?.visionPolicy ?? null,
        documentComplexity: routing?.documentComplexity ?? null,
        routingVersion: routingVersion(routingV2),
      },
    });

    return {
      needed,
      score,
      selectedPages,
      reason,
      hints,
      ...(ladder ? { ladder } : {}),
      routing: routing
        ? {
            documentComplexity: routing.documentComplexity,
            visionPolicy: routing.visionPolicy,
            dominantRoutes: routing.dominantRoutes,
          }
        : null,
    };
  }

  /**
   * The document's ladder plan over the pages vision selected (routing/auto-ladder.ts), and, under a limit, the pages and
   * hints vision reads with: pages a limit kept at `fast` are dropped, and pages lowered from `intelligent` to `ocr` are
   * read by an OCR-rung reader: the OCR engine in its VM (as mixed scans are), else the vision page reader, else the run's
   * vision route when it is plain page transcription. With none of those the page is not read and keeps its text layer.
   * The first plan of the run is pinned (pinLadderPlan): page tasks, retries and the whole-document pass read within it.
   */
  private planLadder(
    state: WorkflowState,
    document: import("../models.js").Document,
    pageCount: number,
    triage: readonly import("@docslurp/shared").AdaptivePageRoutingEntry[],
    selectedPages: readonly number[],
    hints: LegacyPageHints,
  ): { active: boolean; selectedPages: number[]; hints: LegacyPageHints; summary: Record<string, unknown>; decisions: LadderPlan["decisions"] } {
    const { policy, plan } = planDocumentLadder({
      pipeline: state.run.pipeline, runId: state.run.id, documentId: document.id, pageCount, selectedPages, triage, ledger: state.artifactLedger,
    });
    const active = policy.ladder.active;
    if (!active) {
      return { active, selectedPages: [...selectedPages], hints, summary: ladderPlanSummary(plan, policy.ladder), decisions: plan.decisions };
    }
    const pinned = pinLadderPlan(state.artifactLedger, document.id, state.run.id, plan);
    const decisions = plan.decisions.map((decision) => {
      if (decision.rung === "fast") return decision;
      if (!pinned.escalated.has(decision.pageNumber)) {
        return { ...decision, rung: "fast" as const, cappedBy: decision.cappedBy ?? "share-above-fast" as const, reason: `${decision.reason};pinned-plan` };
      }
      if (decision.rung === "intelligent" && !pinned.intelligent.has(decision.pageNumber)) {
        return { ...decision, rung: "ocr" as const, cappedBy: decision.cappedBy ?? "share-above-ocr" as const, reason: `${decision.reason};pinned-plan` };
      }
      return decision;
    });
    // Fastest (a highest rung below intelligent) never calls a vision model: every page it reads here is read by the OCR
    // engine in its VM, or not at all (its scans were already read by OCR during extraction). Under Smartest only pages
    // a share cap lowered from intelligent are read on the OCR rung, by the OCR engine, the page reader or transcription.
    const forbidsVision = ladderForbidsVision(state.run.pipeline);
    const lowered = decisions.filter((decision) => decision.rung === "ocr" && (forbidsVision || decision.need === "intelligent")).map((decision) => decision.pageNumber);
    const vmOcr = resolveOcrMode() === "vm" && document.mimeType === "application/pdf";
    const vision = state.run.pipeline.vision;
    const reader = !forbidsVision && !vmOcr && document.mimeType === "application/pdf" && hints.triaged ? visionPageReaderFor(state, vision) : null;
    const transcription = !forbidsVision && isPageTranscription({ vision, outputSchema: state.run.pipeline.outputSchema ?? null });
    const unread = new Set<number>();
    if (!vmOcr && !reader && !transcription) for (const page of lowered) unread.add(page);
    const finalDecisions = decisions.map((decision) => unread.has(decision.pageNumber)
      ? { ...decision, rung: "fast" as const, reason: `${decision.reason};no-ocr-reader` }
      : decision);
    const allowed = new Set(finalDecisions.filter((decision) => decision.rung !== "fast").map((decision) => decision.pageNumber));
    const loweredRead = new Set(lowered.filter((page) => !unread.has(page)));
    const nextHints: LegacyPageHints = {
      ...hints,
      ...(vmOcr ? { vmOcrPages: new Set([...(hints.vmOcrPages ?? []), ...loweredRead]) } : {}),
      ...(hints.figurePages ? { figurePages: new Set([...hints.figurePages].filter((page) => !loweredRead.has(page))) } : {}),
    };
    const finalPlan = { ...plan, decisions: finalDecisions };
    const summary = { ...ladderPlanSummary(finalPlan, policy.ladder), loweredReader: vmOcr ? "ocr-vm" : reader ? "page-reader" : transcription ? "vision-transcription" : "none" };
    console.log(`[ladder] document=${document.id} pages=${pageCount} selected=${selectedPages.length} read=${allowed.size} ` +
      `intelligent=${finalDecisions.filter((decision) => decision.rung === "intelligent").length} capped=${finalDecisions.filter((decision) => decision.cappedBy).length} ` +
      `maxRung=${policy.ladder.maxRung} aboveFast=${policy.ladder.aboveFast ?? "none"} aboveOcr=${policy.ladder.aboveOcr ?? "none"}`);
    return { active, selectedPages: selectedPages.filter((page) => allowed.has(page)), hints: nextHints, summary, decisions: finalDecisions };
  }

  private async loadPersistedExtractionText(
    state: WorkflowState,
    documentId: string,
  ): Promise<string | null> {
    const canonicalUri = state.artifactLedger.readDocument(
      documentId,
      "canonical-document",
    );
    if (canonicalUri) {
      const key = keyFromStorageUri(canonicalUri, this.storage.bucket);
      if (key) {
        try {
          const canonicalDocument = canonicalDocumentSchema.parse(
            await this.storage.getJson(key),
          );
          const text = canonicalDocument.blocks
            .map((block) => block.text.trim())
            .filter(Boolean)
            .join("\n\n");
          if (text) return text;
        } catch {
          // Fall through to the extraction contract.
        }
      }
    }

    const contractUri = state.artifactLedger.readDocument(
      documentId,
      "extraction-contract",
    );
    if (!contractUri) return null;
    const key = keyFromStorageUri(contractUri, this.storage.bucket);
    if (!key) return null;
    try {
      const contract = extractionContractSchema.parse(
        await this.storage.getJson(key),
      );
      return contract.markdown.trim() || contract.rawText.trim() || null;
    } catch {
      return null;
    }
  }

  private visionAllowed_(state: WorkflowState, documentId: string): boolean {
    return visionAllowedForDocument(
      state.run.pipeline,
      state.artifactLedger.readDocument(documentId, "parser-playbook"),
      { evidenceRouting: resolveRunRoutingV2(state) },
    );
  }

  private resolveParserPlaybook(
    state: WorkflowState,
    documentId: string,
  ): ParserPlaybookKey {
    const artifactPlaybook = state.artifactLedger.readDocument(documentId, "parser-playbook");
    if (
      typeof artifactPlaybook === "string" &&
      artifactPlaybook in parserPlaybookCatalog
    ) {
      return artifactPlaybook as ParserPlaybookKey;
    }

    return parserPlaybookForQuality(state.run.pipeline.quality);
  }

  private scoreTextDensity(text: string, pageCount: number): number {
    if (!text || pageCount === 0) {
      return 0;
    }

    const charsPerPage = text.length / pageCount;
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    const wordsPerPage = wordCount / pageCount;
    const score = (charsPerPage / 500) * 0.5 + (wordsPerPage / 100) * 0.5;
    return Math.min(1, score);
  }

  private needsVision(
    text: string,
    pageCount: number,
    threshold = this.cfg.visionDensityThreshold,
  ): boolean {
    return this.scoreTextDensity(text, pageCount) < threshold;
  }

  /** The document's active route plan grouped by target, or null on every non-routed path. */
  private async loadRoutedExecution(
    state: WorkflowState,
    document: import("../models.js").Document,
  ): Promise<{ plan: RoutePlan; execution: RoutedExecution; catalog: ReturnType<typeof buildRuntimeCatalog>["allTargets"] } | null> {
    // Fast reads no page at all; Fastest never runs routed targets (some are vision models): its pages take the ladder path.
    if (ladderForbidsVision(state.run.pipeline) || !qualityAllowsPageReading(state.run.pipeline.quality)) return null;
    const plan = await loadActiveRoutePlan(state, this.storage, document.id, this.cfg);
    if (!plan) return null;
    const catalog = buildRuntimeCatalog({ privacyMode: state.run.pipeline.privacyMode }).allTargets;
    const execution = groupAssignmentsByTarget(plan, catalog);
    // Pages whose OCR read failed in its boundary are read by no routed target either.
    const failed = ocrFailedPages(state.artifactLedger, document.id);
    if (failed.size > 0) {
      for (const group of execution.groups) group.pages = group.pages.filter((page) => !failed.has(page));
      execution.groups = execution.groups.filter((group) => group.pages.length > 0);
      execution.requests = execution.requests.filter((request) => !failed.has(request.assignment.pageNumber));
      execution.fallbackPages = execution.fallbackPages.filter((page) => !failed.has(page));
      console.warn(`[ocr] routed vision skips pages whose OCR failed document=${document.id} pages=${[...failed].join(",")}`);
    }
    return { plan, execution, catalog };
  }

  private routedSelection(routed: { execution: RoutedExecution }): Awaited<ReturnType<VisionExtractStage["checkNeedsVision"]>> {
    const selectedPages = [...new Set([
      ...routed.execution.groups.flatMap((group) => group.pages),
      ...routed.execution.fallbackPages,
      // Executor pages that produce a replacement: everything except accept-text-only pages.
      ...routed.execution.requests
        .filter((request) => request.assignment.role !== "accept-text")
        .map((request) => request.assignment.pageNumber),
    ])].sort((a, b) => a - b);
    const needed = selectedPages.length > 0;
    return { needed, score: 0, selectedPages, reason: needed ? "page-router-plan" : "page-router-no-pixels", routing: null, hints: NO_HINTS };
  }

  private async extractRoutedPages(
    state: WorkflowState,
    document: import("../models.js").Document,
    selection: VisionConfig,
    routed: NonNullable<Awaited<ReturnType<VisionExtractStage["loadRoutedExecution"]>>>,
    signal: AbortSignal | undefined,
    key: string,
    skips: Map<number, VisionPageSkip> = new Map(),
    chartExport?: ChartExportSession,
  ): Promise<RoutedVisionResult> {
    const allow = (vision: VisionConfig) => allowHostedCall(state, visionCall(resolveVisionRoute(vision)), [document.id]);
    // Routed plans choose pixels themselves (no ink check); triage still says which pages keep usable text.
    const adaptive = await this.loadAdaptiveRouting(state, document.id).catch(() => null);
    const hints: LegacyPageHints = {
      inkCheckPages: new Set(),
      fallbackTextPages: adaptive ? legacyPageHints(adaptive.pages).fallbackTextPages : new Set(),
    };
    /** Why a page's executor call gave nothing; kept only if the page ends with no output at all. */
    const executorOutcomes = new Map<number, VisionPageSkip>();
    const noteExecutorFailure = (pageNumber: number, error: unknown) => {
      const stop = findVisionGuardStop(error);
      const outcome: VisionPageSkip["outcome"] = stop
        ? stop.reason
        : findVisionOutputRejected(error) ? "rejected" : "failed";
      const previous = executorOutcomes.get(pageNumber);
      // A guard stop or rejection says more than a generic failure on another region of the page.
      if (previous && previous.outcome !== "failed" && outcome === "failed") return;
      executorOutcomes.set(pageNumber, { pageNumber, outcome, fallbackText: hints.fallbackTextPages.has(pageNumber) });
    };
    const deps = routed.execution.requests.length > 0
      ? createProductionExecutorDeps({
          runId: state.run.id,
          document,
          storage: this.storage,
          rasters: this.rasters,
          runner: this.runner,
          ocrLanguage: state.run.pipeline.documentExtraction?.ocr?.language,
          canonicalUri: () => state.artifactLedger.readDocument(document.id, "canonical-document") ?? null,
          selection,
          allow,
          callVision: async (vision, image, abort) => {
            try {
              // Routed regions have their own per-page request bound.
              return await this.callVisionOnImage(state, document, vision, image, abort, undefined, "region");
            } catch (error) {
              noteExecutorFailure(image.pageNumber, error);
              throw error;
            }
          },
          // Router OCR is billed like every OCR read (ocr/ledger.ts: an uploaded image per read, a PDF page with words), not
          // as a local model.
          recordOcrRead: (outcome) => {
            recordOcrReads(state.usageLedger, document.id, outcome, { stage: this.name, kind: document.mimeType.startsWith("image/") ? "image" : "pdf" });
          },
          hostedReader: createHostedOcrReader({ state, cfg: this.cfg, runner: this.runner }),
          // Chart export on: chart/diagram crops go through the generator instead of the role's vision prompt.
          ...(chartExport?.runs ? {
            exportVisual: async ({ role, scope, assignmentIndex, raster, pageNumber, signal: abort }) => {
              const out = await chartExport.exportRouted({
                assignment: { role, scope, pageNumber }, assignmentIndex, image: { path: raster.path, mimeType: raster.mimeType }, ...(abort ? { signal: abort } : {}),
              });
              const reading = (text: string, model: string): VisionPageOutput => ({
                pageNumber, runtime: "chart-export", model, prompt: "chart-export", baseUrl: null,
                latencyMs: out.usage.latencyMs, inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens, usageSource: "provider",
                fallbackUsed: false, fallbackReason: null, text, costCents: out.usage.costCents,
              });
              if (out.result) return { output: reading(out.result.text, out.result.model), modelCalled: out.modelCalled };
              return out.modelCalled
                ? { output: null, modelCalled: true as const, spent: reading("", "chart-export") }
                : { output: null, modelCalled: false as const };
            },
          } : {}),
          recordLocalUsage: (event) => {
            state.usageLedger.record({
                provider: "vision-runtime",
                model: event.model,
                metric: event.metric,
                amount: 1,
                unit: "image",
                costCents: 0,
                inputTokens: 0,
                outputTokens: 0,
                metadata: { documentId: document.id, pageNumber: event.pageNumber, runtime: "local-cli", latencyMs: event.latencyMs, outputChars: event.outputChars },
              },
            );
          },
        })
      : null;
    const verification = await this.routedVerification(state, document, signal);
    try {
      const result = await runRoutedVision({
        ...verification,
        plan: routed.plan,
        execution: routed.execution,
        catalog: routed.catalog,
        selection,
        allow,
        canContinue: () => !isCostCapExceeded(state),
        pack: (() => { try { return loadRuntimePolicyPack("decision-model"); } catch { return null; } })(),
        ...(deps ? { executorDeps: deps, pageHeightPt: (page: number) => deps.pageHeightPt(page) } : {}),
        signal,
        extract: async (vision, pages, options) => {
          const costCentsByPage = new Map<number, number>();
          const outputs = await this.extractVisionPagesFromCache(
            state, document, vision, pages, signal, key,
            (event, pageNumber) => { if (event) costCentsByPage.set(pageNumber, event.costCents); },
            options?.bypassCache ?? false,
            { hints, skips },
          );
          return { outputs, costCentsByPage };
        },
      });
      for (const warning of result.executorWarnings) console.warn(`[page-router] document=${document.id} ${warning}`);
      // Pages whose router OCR failed in its boundary are OCR-failed pages, like scan fill's: no reader serves them.
      const ocrFailed = result.executorFailures.filter((failure) => failure.reason === OCR_BOUNDARY_FAILED).map((failure) => failure.pageNumber);
      if (ocrFailed.length) recordOcrFailedPages(state, document.id, ocrFailed);
      // Executor pages that failed for a reason other than a vision call (no raster, crop, local tool).
      for (const failure of result.executorFailures) {
        if (!executorOutcomes.has(failure.pageNumber)) {
          executorOutcomes.set(failure.pageNumber, { pageNumber: failure.pageNumber, outcome: "failed", fallbackText: hints.fallbackTextPages.has(failure.pageNumber) });
        }
      }
      for (const [pageNumber, outcome] of executorOutcomes) if (!skips.has(pageNumber)) skips.set(pageNumber, outcome);
      // A page with output in the end (a fallback or another region served it) has no failure.
      for (const output of result.outputs) skips.delete(output.pageNumber);
      return result;
    } finally {
      await deps?.dispose();
    }
  }

  /**
   * The decision-model verifier (TL3: clef-omni + clef-flash on page image + cheap output), wired into the
   * cascade only when the project puts a value on quality at or above the fitted minimum (0.5 USD per
   * quality unit). Off by default: below that the free cascade checks capture the gain and no call is made.
   */
  private async routedVerification(
    state: WorkflowState,
    document: import("../models.js").Document,
    signal: AbortSignal | undefined,
  ): Promise<Pick<RoutedVisionArgs, "verifier" | "pageImage">> {
    const value = state.run.pipeline.pageRouter?.valueUsdPerQualityUnit ?? null;
    const gate = { valueUsdPerQualityUnit: value };
    if (escalationThreshold(gate) === null) return {};
    const allowed = await allowHostedCall(
      state,
      { provider: "openrouter-systemone", model: "cloudflare/clef-omni", operation: "worker.routing.verifier", target: "hosted" },
      [document.id],
    );
    if (!allowed) return {};
    const inner = createDecisionVerifier({
      ledger: state.usageLedger,
      privacyMode: state.run.pipeline.privacyMode ?? "standard",
      gate,
      documentId: document.id,
      ...(signal ? { signal } : {}),
    });
    return {
      verifier: { verify: async (request) => (isCostCapExceeded(state) ? null : inner.verify(request)) },
      pageImage: async (pageNumber) => {
        const [raster] = await this.rasters.renderSelectedPages({ document, runId: state.run.id, pageNumbers: [pageNumber], signal });
        if (!raster) return undefined;
        const imagePath = await this.storage.downloadToTempFile(
          raster.artifactKey,
          trustedTempDownloadPattern("docslurp-verifier-raster-", document),
        );
        return { path: imagePath, release: () => cleanupTempFile(imagePath) };
      },
    };
  }

  /** Builds and logs the plan's PlanValidation from the usage events recorded during this run. */
  private async recordRoutedValidation(
    state: WorkflowState,
    document: import("../models.js").Document,
    plan: RoutePlan,
    execution: RoutedExecution,
    result: RoutedVisionResult | null,
    key: string,
  ): Promise<PlanValidation> {
    const validation = buildRoutedValidation(plan, result?.actuals ?? [], result?.qualities ?? []);
    const validationKey = key.replace(/\/vision\/([^/]+)\.json$/, "/page-route/$1.validation.json");
    await this.storage.putJson(validationKey, validation);
    state.pendingPerformance.push({
      documentId: document.id,
      scope: "document",
      stageName: this.name,
      metric: "page-route-validation",
      value: validation.chunk.actual.costUsd,
      unit: "usd",
      tags: ["document", "page-router", "validation"],
      metadata: {
        routerId: plan.routerId,
        policyVersion: plan.policyVersion,
        estimate: validation.chunk.estimate,
        actual: validation.chunk.actual,
        error: validation.chunk.error,
        withinBudget: validation.chunk.withinBudget,
        assignments: validation.assignments.slice(0, 200).map((a) => ({
          pageNumber: a.pageNumber,
          targetId: a.targetId,
          estimateCostUsd: a.estimate.costUsd,
          actualCostUsd: a.actual.costUsd,
          costErrorUsd: a.error.costErrorUsd,
          costAbsPctError: a.error.costAbsPctError,
          latencyErrorMs: a.error.latencyErrorMs,
        })),
        fallbackPages: execution.fallbackPages,
        skipped: result?.skipped ?? [],
        escalations: result?.escalations ?? [],
        executorFailures: result?.executorFailures ?? [],
        executorWarnings: result?.executorWarnings ?? [],
        verifier: result?.verifier ?? { calls: 0, costUsd: 0 },
        qualityMethod: PLAN_QUALITY_METHOD,
      },
    });
    return validation;
  }

  private routedSummary(
    routed: { plan: RoutePlan; execution: RoutedExecution },
    result: RoutedVisionResult | null,
    validation: PlanValidation | null,
  ) {
    return {
      routerId: routed.plan.routerId,
      policyVersion: routed.plan.policyVersion,
      groups: routed.execution.groups.map((group) => ({ targetId: group.targetId, pages: group.pages })),
      fallbackPages: routed.execution.fallbackPages,
      skipped: result?.skipped ?? [],
      escalations: result?.escalations ?? [],
      executorRequests: routed.execution.requests.length,
      executorFailures: result?.executorFailures ?? [],
      executorWarnings: result?.executorWarnings ?? [],
      estimatedCostUsd: routed.plan.chunkEstimate.totalCostUsd,
      actualCostUsd: validation?.chunk.actual.costUsd ?? null,
    };
  }

  /**
   * Read `pages` of a PDF with the OCR engine in its VM boundary (the VM renders them from the stored PDF; the host renders
   * nothing): each batch's Rich pages authorized before its VM starts, every page read charged once by the OCR ledger.
   * A boundary that cannot run is retried (OcrInfrastructureError); a refused or unread page is skipped with the reason,
   * never handed to a hosted model instead.
   */
  private async readPagesWithVmOcr(
    state: WorkflowState,
    document: import("../models.js").Document,
    pages: number[],
    skip: (pageNumber: number, outcome: VisionPageSkip["outcome"]) => VisionPageSkip,
    signal?: AbortSignal,
  ): Promise<VisionPageOutput[]> {
    const source = await this.rasters.sourcePath(document);
    const hostedReader = createHostedOcrReader({ state, cfg: this.cfg, runner: this.runner });
    const outputs: VisionPageOutput[] = [];
    for (let start = 0; start < pages.length; start += OCR_PDF_BATCH_PAGES) {
      const batch = pages.slice(start, start + OCR_PDF_BATCH_PAGES);
      await authorizeOcrRead(state, document.id, batch.length, "pdf-batch");
      const started = Date.now();
      let result: Awaited<ReturnType<typeof ocrDocument>>;
      try {
        result = await ocrDocument({ checkpointStorage: this.storage, runner: this.runner, state, documentId: document.id, source, kind: "pdf", pages: batch, hostedReader,
          stage: this.name, ...(signal ? { signal } : {}) });
      } catch (error) {
        if (signal?.aborted || error instanceof OcrInfrastructureError) throw error;
        console.error(`[ocr] mixed-scan-pages-failed document=${document.id} pages=${batch.join(",")} reason=${toError(error).message.slice(0, 300)}`);
        for (const page of batch) skip(page, "failed");
        continue;
      }
      const latencyMs = Date.now() - started;
      const read = new Set<number>();
      for (const page of result.pages) {
        if (!batch.includes(page.pageNumber)) continue;
        read.add(page.pageNumber);
        outputs.push({
          pageNumber: page.pageNumber, runtime: "ocr-vm", model: "page-ocr", prompt: "", baseUrl: null,
          ...(typeof (page as { reader?: unknown }).reader === "string" ? { reader: (page as { reader: string }).reader } : {}),
          latencyMs: Math.round(latencyMs / batch.length), inputTokens: 0, outputTokens: 0, usageSource: "ocr-ledger",
          fallbackUsed: false, fallbackReason: null, text: page.text, costCents: 0,
        });
      }
      for (const page of batch) if (!read.has(page)) skip(page, "failed");
    }
    console.log(`[ocr] mixed-scan-pages document=${document.id} read=${outputs.length}/${pages.length} boundary=vm`);
    return outputs;
  }

  private async extractVisionPagesFromCache(
    state: WorkflowState,
    document: import("../models.js").Document,
    vision: VisionConfig,
    selectedPageNumbers: number[],
    signal?: AbortSignal,
    storageKey?: string,
    usageSink?: (event: UsageEvent | null, pageNumber: number) => void,
    bypassCache = false,
    pageOptions: { hints?: LegacyPageHints; skips?: Map<number, VisionPageSkip>; pageReader?: boolean } = {},
  ): Promise<VisionPageOutput[]> {
    const hints = pageOptions.hints ?? NO_HINTS;
    const skip = (pageNumber: number, outcome: VisionPageSkip["outcome"]): VisionPageSkip => {
      const entry: VisionPageSkip = { pageNumber, outcome, fallbackText: hints.fallbackTextPages.has(pageNumber) };
      pageOptions.skips?.set(pageNumber, entry);
      return entry;
    };
    const requestedPages = [...new Set(selectedPageNumbers)].sort((a, b) => a - b);
    if (requestedPages.length === 0) {
      return [];
    }

    const isCached = (page: number) => !bypassCache && state.distributedVisionPages.has(`${document.id}:${page}`);
    const cached = requestedPages.filter(isCached);
    const missing = requestedPages.filter((page) => !isCached(page));
    const completed = cached.flatMap((page) => {
      const result = state.distributedVisionPages.get(`${document.id}:${page}`);
      if (isVisionPageSkip(result)) {
        pageOptions.skips?.set(page, { ...result, pageNumber: page });
        return [];
      }
      const output = result as VisionPageOutput | null;
      return output ? [output] : [];
    });
    if (!missing.length) return completed.sort((a, b) => a.pageNumber - b.pageNumber);
    // The run's vision guard already stopped: no render, no call.
    const stopped = visionGuardFor(state).stop;
    if (stopped) {
      for (const page of missing) skip(page, stopped.reason);
      return completed.sort((a, b) => a.pageNumber - b.pageNumber);
    }
    // Capped runs admit one page at a time, including raster work. The ledger
    // records the completed page's charge before the next admission. A single
    // admitted page can cross the cap; the rest of a long scan cannot follow it.
    // run() also serializes documents, and planPageTasks disables page fanout.
    if ((state.run.pipeline.maxCostCents ?? 0) > 0) {
      if (isCostCapExceeded(state)) return completed.sort((a, b) => a.pageNumber - b.pageNumber);
      if (missing.length > 1) {
        for (const pageNumber of missing) {
          if (isCostCapExceeded(state)) break;
          try {
            // Capped runs read one page per admission on the hosted route: a reader job of many pages could pass the cap by
            // its whole batch, and a one-page job pays the reader's per-job reservation for every page.
            completed.push(...await this.extractVisionPagesFromCache(
              state, document, vision, [pageNumber], signal, storageKey, usageSink, bypassCache, { ...pageOptions, pageReader: false },
            ));
          } catch (error) {
            // Infrastructure, cancellation and quarantine errors retain their
            // identity so checkpoint retry/isolation handling remains intact.
            if (!(error instanceof DocumentStageError)) throw error;
            // The inner single-page attempt cannot see earlier successes. Keep
            // those results in the partial manifest when a later page fails.
            if (storageKey) await this.storage.putJson(storageKey, {
              documentId: document.id, partial: completed.length > 0,
              reason: toError(error).message, processedPages: completed.length,
              pagesDetail: completed,
            });
            throw new DocumentStageError(toError(error).message, {
              artifactUri: storageKey ? this.storage.uri(storageKey) : undefined,
              stats: { partial: completed.length > 0, processedPages: completed.length, error: toError(error).message },
            });
          }
        }
        return completed.sort((a, b) => a.pageNumber - b.pageNumber);
      }
    }
    // Scans beside native text go to the OCR engine in its VM (as scanned pages do in extract-markdown), not to the host
    // raster and a hosted vision model. Escalation follows the OCR boundary's own rules.
    const vmOcr = resolveOcrMode() === "vm" && document.mimeType === "application/pdf" ? missing.filter((page) => hints.vmOcrPages?.has(page)) : [];
    if (vmOcr.length > 0) {
      completed.push(...await this.readPagesWithVmOcr(state, document, vmOcr, skip, signal));
      const rest = missing.filter((page) => !vmOcr.includes(page));
      if (rest.length === 0) return completed.sort((a, b) => a.pageNumber - b.pageNumber);
      missing.splice(0, missing.length, ...rest);
    }
    // Plain page transcription goes to the vision page reader first (vision-page-reader.ts); the pages it does not return
    // continue to the hosted route below, unchanged.
    const pageReader = pageOptions.pageReader && !bypassCache ? visionPageReaderFor(state, vision) : null;
    if (pageReader) {
      const readerPages = this.pageReaderCandidates(state, document, vision, missing, hints);
      if (readerPages.length > 0) {
        // While a warm-started reader boots, its pages are read here on the hosted route, a few at a time (warm start).
        // The chunk's own call writes no partial manifest (it would hold only that chunk); this call's caller does.
        const read = await this.readPagesWithPageReader(state, document, pageReader, readerPages, signal, (chunk, chunkSignal) => this.extractVisionPagesFromCache(
          state, document, vision, chunk, chunkSignal, undefined, usageSink, bypassCache, { ...pageOptions, pageReader: false },
        ));
        completed.push(...read.outputs);
        const done = read.handled;
        const rest = missing.filter((page) => !done.has(page));
        if (rest.length === 0) return completed.sort((a, b) => a.pageNumber - b.pageNumber);
        missing.splice(0, missing.length, ...rest);
      }
    }
    // A vision model trained on a set page size gets PDF pages rendered no larger (the renderer lowers each page's DPI
    // from its point size). Raster uploads go as uploaded: resizing one would decode it, which only an isolated
    // provider may do.
    const maxLongEdgePx = visionRenderLongEdge(vision);
    if (maxLongEdgePx !== undefined && document.mimeType !== "application/pdf") {
      console.log(`[vision-profile] document=${document.id} long-edge cap ${maxLongEdgePx}px not applied: raster uploads are sent as uploaded`);
    }
    const rasterPages = await this.rasters.renderSelectedPages({
      document,
      runId: state.run.id,
      pageNumbers: missing,
      ...(maxLongEdgePx !== undefined ? { maxLongEdgePx } : {}),
      signal,
    });
    for (const page of rasterPages) {
      state.artifactLedger.recordDocument(document.id, `page-${page.pageNumber}`, page.artifactUri);
    }
    const attempts = await mapWithConcurrency(rasterPages, 2, async (page) => {
      const imagePath = await this.storage.downloadToTempFile(
        page.artifactKey,
        trustedTempDownloadPattern("docslurp-vision-raster-", document),
      );
      try {
        // The render as vision would receive it: a cached render carries no dimensions, so read
        // them (and its size) from the file itself.
        const facts = page.mimeType === "image/png" ? await readPngFileFacts(imagePath).catch(() => null) : null;
        const image = {
          sizeBytes: facts?.sizeBytes ?? page.sizeBytes,
          widthPx: facts?.widthPx ?? null,
          heightPx: facts?.heightPx ?? null,
          mimeType: page.mimeType,
        };
        // Nominated only by byte counts (drawn content): a blank render has nothing to read, and
        // one that cannot be confirmed to hold ink is not sent either.
        if (hints.inkCheckPages.has(page.pageNumber)) {
          const verdict = inkCheckVerdict(image);
          if (verdict !== "ink") {
            const outcome = verdict === "blank" ? "blank-render" : "unverified-render";
            console.log(`[vision-extract] document=${document.id} page=${page.pageNumber} skipped=${outcome} bytes=${image.sizeBytes} ` +
              `width=${image.widthPx ?? "unknown"} height=${image.heightPx ?? "unknown"}`);
            return { output: null, error: null, skip: skip(page.pageNumber, outcome) };
          }
        }
        await emitDocumentPageProgress(
          state,
          document,
          this.name,
          page.pageNumber,
          rasterPages.length,
          "processing",
        );
        const output = await this.callVisionOnImage(
          state,
          document,
          vision,
          { imagePath, mimeType: page.mimeType, pageNumber: page.pageNumber, artifactUri: page.artifactUri,
            widthPx: image.widthPx, heightPx: image.heightPx },
          signal,
          usageSink,
          hints.tableRescuePages?.has(page.pageNumber) ? "table-rescue" : "page",
          hints.tableRescuePages?.has(page.pageNumber) ? { documentPageLimit: tableLeakPageCap(maxInt(1, document.pageCount)) } : {},
        );
        const result = { inputTokens: output.inputTokens, outputTokens: output.outputTokens, latencyMs: output.latencyMs };
        await emitDocumentPageProgress(
          state,
          document,
          this.name,
          page.pageNumber,
          rasterPages.length,
          "completed",
          {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            latencyMs: result.latencyMs,
          },
        );
        return { output, error: null, skip: null };
      } catch (error) {
        // Refused by the guard: no further request was sent (earlier ones were recorded by callVisionOnImage).
        const stop = findVisionGuardStop(error);
        if (stop) {
          return { output: null, error: null, skip: skip(page.pageNumber, stop.reason) };
        }
        // A failed provider call was recorded by callVisionOnImage; anything else (download,
        // progress) is recorded here as a zero-cost attempt.
        if (!(error instanceof Object && recordedVisionErrors.has(error))) {
          this.recordFailedVisionAttempt(state, document, vision, page, toError(error).message, error);
        }
        if (!shouldFailOpenVisionError(error)) return { output: null, error, skip: null };
        // Fail open: the page keeps its native or OCR text, never the rejected model text.
        return { output: null, error, skip: skip(page.pageNumber, findVisionOutputRejected(error) ? "rejected" : isVisionModelRefusal(error) ? "model-refused" : "failed") };
      } finally {
        await cleanupTempFile(imagePath);
      }
    });

    const outputs = attempts
      .map((attempt) => attempt.output)
      .filter((output): output is VisionPageOutput => output !== null)
      .concat(completed)
      .sort((left, right) => left.pageNumber - right.pageNumber);
    const fatal = attempts.find(
      (attempt) => attempt.error && !shouldFailOpenVisionError(attempt.error),
    );
    if (!fatal?.error) {
      return outputs;
    }

    const message = toError(fatal.error).message;
    if (storageKey) {
      await this.storage.putJson(storageKey, {
        documentId: document.id,
        partial: outputs.length > 0,
        reason: `vision extraction failed: ${message}`,
        processedPages: outputs.length,
        pagesDetail: outputs,
      });
    }
    throw new DocumentStageError(`vision extraction failed: ${message}`, {
      artifactUri: storageKey ? this.storage.uri(storageKey) : undefined,
      stats: {
        partial: outputs.length > 0,
        processedPages: outputs.length,
        error: message,
      },
    });
  }

  /**
   * The pages of `pages` the vision page reader may read for this run and document (vision-page-reader.ts): a PDF with page
   * triage, pages not routed as figures or charts, not drawn-content (ink-checked) and not table rescue. Empty when the
   * run's reads stay hosted.
   */
  private pageReaderCandidates(state: WorkflowState, document: import("../models.js").Document, vision: VisionConfig, pages: readonly number[], hints: LegacyPageHints): number[] {
    if (document.mimeType !== "application/pdf" || !hints.triaged || !visionPageReaderFor(state, vision)) return [];
    return pages.filter((page) => !hints.inkCheckPages.has(page) && !hints.tableRescuePages?.has(page) && !hints.figurePages?.has(page));
  }

  /**
   * The reader candidates planPageTasks holds back from fan-out for run() to read in batches: at most the document's
   * remaining reader page budget, and none when the organization's daily reader cap has no headroom (or the ledger cannot
   * say). Every other page fans out to the hosted route as without the reader.
   */
  private async plannedReaderPages(state: WorkflowState, document: import("../models.js").Document, vision: VisionConfig, pages: readonly number[], hints: LegacyPageHints): Promise<number[]> {
    const candidates = this.pageReaderCandidates(state, document, vision, pages, hints);
    if (!candidates.length || !state.run.orgId) return [];
    let maxPages: number;
    let capCents: number;
    try {
      maxPages = ocrPageReaderMaxPages();
      capCents = ocrPageReaderOrgDailyMaxCostCents();
    } catch {
      return [];
    }
    if (!(await pageReaderOrgHasHeadroom(state, state.run.orgId, capCents))) return [];
    const held = candidates.slice(0, pageReaderPagesRemaining(state.usageLedger, document.id, maxPages));
    // Warm start: only a document with at least the threshold of reader pages is held back from fan-out. run() (often in
    // another worker) sees exactly these pages and so reaches the same threshold, starting the reader there and reading
    // hosted while it boots. A smaller document fans out to the hosted route and never starts a reader.
    const warm = pageReaderWarmPolicy(visionPageReaderFor(state, vision));
    if (warm && held.length < warm.minPages) return [];
    return held;
  }

  /**
   * Read plain-transcription PDF pages with the vision page reader (vision-page-reader.ts), in jobs of the provider's page
   * cap, two in flight: each batch rendered at the reader's long edge, downloaded to temp files and sent under the run's
   * tenant scope by readPageImagesWithProvider (budget, caps, validation, usage, Rich page charge). Returns the pages it
   * read; every other page is the caller's, for the hosted route. Nothing is rendered past the document's remaining reader
   * budget, and no batch starts once a budget, cap or ledger stopped one. A reader failure never fails the document; render
   * and download errors propagate as they would on the hosted route (which renders the same pages).
   */
  private async readPagesWithPageReader(
    state: WorkflowState,
    document: import("../models.js").Document,
    provider: PageImageReaderProvider,
    pages: number[],
    signal?: AbortSignal,
    readHosted?: (pages: number[], signal: AbortSignal) => Promise<VisionPageOutput[]>,
  ): Promise<{ outputs: VisionPageOutput[]; handled: Set<number> }> {
    const outputs: VisionPageOutput[] = [];
    // Pages this call settled: read by the reader, or read on the hosted route while a warm-started reader booted.
    const handled = new Set<number>();
    const maxLongEdgePx = provider.maxLongEdgePx;
    let maxPages: number;
    let orgDailyMaxCostCents: number;
    try {
      maxPages = ocrPageReaderMaxPages();
      orgDailyMaxCostCents = ocrPageReaderOrgDailyMaxCostCents();
    } catch (error) {
      console.error(`[vision-extract] page-reader configuration invalid document=${document.id}; pages go hosted: ${toError(error).message.slice(0, 300)}`);
      return { outputs, handled };
    }
    // Never render pages the per-document budget cannot send.
    const sendable = pages.slice(0, pageReaderPagesRemaining(state.usageLedger, document.id, maxPages));
    // Warm start (page-reader-warm.ts): jobs go to the reader only once it is ready for this run; never waited on.
    const warm = pageReaderWarmPolicy(provider);
    const scope = state.run.orgId ? { orgId: state.run.orgId, runId: state.run.id } : null;
    if (warm && scope && sendable.length) {
      const gate = await pageReaderWarmGate(provider, { state, logTag: "[vision-extract] page-reader", minPages: warm.minPages, orgDailyMaxCostCents }, sendable.length);
      if (gate === "below-threshold" || gate === "unavailable") {
        recordPageReaderWarmRouting(scope, gate === "below-threshold" ? "hostedBelowThreshold" : "hostedUnavailable", sendable.length);
        logPageReaderWarmSummary(scope, "vision", document.id, "[vision-extract] page-reader");
        return { outputs, handled };
      }
    }
    const queue = [...sendable];
    let stopped: string | null = null;
    // Two batches in flight. The first error (a render or download failure) stops the other worker and aborts its job, and
    // is rethrown only once both workers have finished: no batch keeps reading after the stage failed.
    const local = new AbortController();
    const batchSignal = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
    let failure: { error: unknown } | null = null;
    let readerJobs = 0;
    let readersInFlight = 0;
    const work = async () => {
      while (queue.length && !failure && !stopped) {
        try {
          const state_ = warm && scope ? pageReaderWarmState(provider, scope, "[vision-extract] page-reader") : "ready";
          if (state_ === "ready") {
            // At most two reader jobs in flight per document; a lane past that retires (the others carry the queue).
            if (readersInFlight >= 2) return;
            const batch = queue.splice(0, provider.maxPagesPerJob);
            readerJobs += 1;
            readersInFlight += 1;
            try {
              await readBatch(batch);
            } finally {
              readersInFlight -= 1;
            }
          } else if (state_ === "booting" && readHosted) {
            // The reader is starting: these pages go hosted now (and stay there); the next chunk checks again.
            const chunk = queue.splice(0, VISION_READER_WARMING_HOSTED_CHUNK);
            for (const page of chunk) handled.add(page);
            recordPageReaderWarmRouting(scope!, "hostedWhileWarming", chunk.length);
            outputs.push(...await readHosted(chunk, batchSignal));
          } else {
            // The start failed or was refused (or the reader went away): the rest go hosted after this call.
            return;
          }
        } catch (error) {
          failure ??= { error };
          local.abort();
        }
      }
    };
    const readBatch = async (batch: number[]) => {
      batchSignal.throwIfAborted();
      if (stopped) return;
      const temps: string[] = [];
      try {
        const rasters = await this.rasters.renderSelectedPages({
          document, runId: state.run.id, pageNumbers: batch, ...(maxLongEdgePx !== undefined ? { maxLongEdgePx } : {}), signal: batchSignal,
        });
        const inputs: Array<PageImageInput & { artifactUri: string }> = [];
        for (const raster of rasters) {
          if (raster.mimeType !== "image/png" || !batch.includes(raster.pageNumber)) continue;
          const imagePath = await this.storage.downloadToTempFile(raster.artifactKey, trustedTempDownloadPattern("docslurp-vision-reader-", document));
          temps.push(imagePath);
          inputs.push({ pageNumber: raster.pageNumber, imagePath, artifactUri: raster.artifactUri });
        }
        if (stopped) return;
        for (const input of inputs) await emitDocumentPageProgress(state, document, this.name, input.pageNumber, pages.length, "processing");
        const started = Date.now();
        const read: Array<{ page: PageImageInput & { artifactUri: string }; output: VisionPageOutput }> = [];
        let summary: Awaited<ReturnType<typeof readPageImagesWithProvider>> | null = null;
        try {
          summary = await readPageImagesWithProvider(inputs, provider, {
            state, documentId: document.id, mode: "all", maxPages, orgDailyMaxCostCents, signal: batchSignal,
          }, {
            metric: VISION_PAGE_READER_METRIC,
            logTag: "[vision-extract] page-reader",
            requireCostEstimate: true,
            // Warm start: sent only because the reader reported ready; the provider never boots a reader for this job.
            ...(warm ? { requireReady: true } : {}),
            ...(maxLongEdgePx !== undefined ? { maxLongEdgePx } : {}),
            // Kept as soon as it is validated: a later error in this batch never sends a read page to the hosted route too.
            onRead: (page, result) => {
              const output: VisionPageOutput = {
                pageNumber: page.pageNumber, runtime: "page-reader", provider: `page-reader:${provider.id}`, model: provider.model, prompt: "", baseUrl: null,
                latencyMs: 0, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
                usageSource: "page-reader", fallbackUsed: false, fallbackReason: null, text: result.text,
                // Provider cost is on the usage ledger (vision-page-reader, 0 credits); the page's charge is its Rich page.
                costCents: 0,
              };
              read.push({ page: page as PageImageInput & { artifactUri: string }, output });
              outputs.push(output);
              handled.add(page.pageNumber);
            },
          });
        } catch (error) {
          // readPageImagesWithProvider never fails a page; anything it throws (a ledger write) is telemetry, and the unread
          // pages go hosted. Only an abort propagates.
          if (batchSignal.aborted) throw error;
          console.error(`[vision-extract] page-reader error document=${document.id} pages=${batch.join(",")}; unread pages go hosted: ${toError(error).message.slice(0, 300)}`);
        }
        // A capacity failure stops the reader for this document at once (page-reader.ts), before another batch is rendered.
        const stop = summary && (PAGE_READER_STOP_REASONS.find((reason) => (summary!.skipped[reason] ?? 0) > 0)
          ?? (!warm && (summary.failed.capacity ?? 0) > 0 ? "reader-capacity" : undefined));
        if (stop) stopped = stop;
        if (warm && scope && summary) {
          // The first job on the warmed reader records its boot: the start-up reservation goes back.
          if (summary.replaced + summary.empty > 0) await releasePageReaderWarmReservation(scope);
          recordPageReaderWarmRouting(scope, "reader", summary.replaced);
        }
        // The job's wall time, shared by the pages it read (pages per minute stay comparable with hosted reads).
        const latencyMs = read.length ? Math.round((Date.now() - started) / read.length) : 0;
        for (const { page, output } of read) {
          output.latencyMs = latencyMs;
          state.artifactLedger.recordDocument(document.id, `page-${page.pageNumber}`, page.artifactUri);
          await emitDocumentPageProgress(state, document, this.name, page.pageNumber, pages.length, "completed", { inputTokens: output.inputTokens, outputTokens: output.outputTokens, latencyMs });
        }
      } finally {
        for (const temp of temps) await cleanupTempFile(temp);
      }
    };
    // Two lanes; with warm start four, so pages read hosted while the reader boots keep eight in flight (two per lane).
    await Promise.all(Array.from({ length: warm ? VISION_READER_WARMING_LANES : 2 }, () => work()));
    if (failure) throw (failure as { error: unknown }).error;
    // Every page not settled here goes hosted after this call, once.
    if (warm && scope) recordPageReaderWarmRouting(scope, "hostedUnavailable", sendable.length - handled.size);
    const byReader = outputs.filter((output) => output.runtime === "page-reader").length;
    console.log(`[vision-extract] page-reader document=${document.id} read=${byReader}/${pages.length} jobs=${readerJobs} provider=${provider.id}${stopped ? ` stopped=${stopped}` : ""}` +
      (warm ? ` hostedWhileWarming=${handled.size - byReader}` : ""));
    if (warm && scope) logPageReaderWarmSummary(scope, "vision", document.id, "[vision-extract] page-reader");
    return { outputs, handled };
  }

  /**
   * One vision call over an image on disk: runs the runtime, prices it, and records the usage
   * event. Shared by whole-page extraction and the page router's region/image-scoped calls.
   */
  private async callVisionOnImage(
    state: WorkflowState,
    document: import("../models.js").Document,
    vision: VisionConfig,
    image: {
      imagePath: string; mimeType: string; pageNumber: number; artifactUri?: string;
      widthPx?: number | null; heightPx?: number | null;
    },
    signal?: AbortSignal,
    usageSink?: (event: UsageEvent | null, pageNumber: number) => void,
    purpose: VisionAttemptPurpose = "page",
    limits: Pick<VisionAttemptTarget, "documentPageLimit" | "documentAttemptLimit"> = {},
  ): Promise<VisionPageOutput> {
    const imagePath = image.imagePath;
    const page = { mimeType: image.mimeType, pageNumber: image.pageNumber, artifactUri: image.artifactUri ?? "" };
    const outputPath = `${imagePath}.vision.json`;
    const pageRef = { documentId: document.id, pageNumber: page.pageNumber };
    // Every request of every vision call of the run (legacy page, routed region, refusal fallback,
    // cascade leg; first try, inline retries, streaming fallback, alternate route) is admitted by the
    // run's attempt guard through this gate before it is sent.
    return await withVisionCall(state, { ...pageRef, purpose, ...limits }, async (gate) => {
      let skippedLimit = false;
      const normalized = imageOrientationEnabled() ? await withOrientationAdmission(gate, async () => {
        if (isCostCapExceeded(state)) throw new Error("Image orientation refused: run cost cap exceeded");
        if (!reserveOrientationAttempt(state)) { skippedLimit = true; return null; }
        return await normalizeImageOrientation(imagePath, event => {
        state.usageLedger.enqueue({ ...event, metadata: { ...event.metadata, documentId: document.id, stage: "image-orientation", pageNumber: image.pageNumber } });
      }, signal);
      }) : null;
      try {
        const result = await this.runVisionCall(state, document, vision,
          { ...image, imagePath: normalized?.path ?? imagePath, outputPath },
          { ...page, mimeType: normalized ? "image/png" : page.mimeType }, gate, signal, usageSink);
        return normalized ? { ...result, orientation: normalized.metadata } : skippedLimit ? { ...result, orientation: { status: "skipped-limit" } } : result;
      } finally { await normalized?.release(); }
    });
  }

  private async runVisionCall(
    state: WorkflowState,
    document: import("../models.js").Document,
    vision: VisionConfig,
    image: { imagePath: string; outputPath: string },
    page: { mimeType: string; pageNumber: number; artifactUri: string },
    gate: import("../lib/vision-attempt-guard.js").VisionCallGate,
    signal?: AbortSignal,
    usageSink?: (event: UsageEvent | null, pageNumber: number) => void,
  ): Promise<VisionPageOutput> {
    const { imagePath, outputPath } = image;
    const pageRef = { documentId: document.id, pageNumber: page.pageNumber };
    try {
      let result: Awaited<ReturnType<typeof executeVisionRuntime>>;
      try {
        result = await executeVisionRuntime({
          imagePath,
          mimeType: page.mimeType,
          privacyMode: state.run.pipeline.privacyMode,
          outputPath,
          vision,
          cfg: this.cfg,
          runner: this.runner,
          outputSchema: state.run.pipeline.outputSchema,
          signal,
          gate,
          // A page read of the vision capability: region-checked routes, pool serves and the pool default fallback.
          pageRead: true,
        });
      } catch (caught) {
        // Recorded here, once, for every caller (whole page, routed region and their fallbacks). A
        // request refused by the guard was never sent; requests before it are recorded if billed.
        const error = caught instanceof Object ? caught : toError(caught);
        if (!findVisionGuardStop(error)) {
          this.recordFailedVisionAttempt(state, document, vision, page, toError(error).message, error);
        } else {
          // Refused before this request was sent: record only what was billed before it, once (the route's own
          // earlier attempts, and a billed primary whose fallback was refused), with no zero-cost failure marker.
          recordVisionFailureUsages(state, visionFailureUsages(error, vision, this.cfg, {
            documentId: document.id, pageNumber: page.pageNumber, rasterArtifactUri: page.artifactUri,
          }));
        }
        recordedVisionErrors.add(error);
        throw error;
      }
      // The fallback served this page: the primary route's billed failure is ours too.
      recordVisionFailureUsages(state, primaryFailureUsages(result.primaryFailure, this.cfg, {
        documentId: document.id, pageNumber: page.pageNumber, rasterArtifactUri: page.artifactUri,
      }));
      const output: VisionPageOutput = {
        pageNumber: page.pageNumber,
        runtime: result.runtime,
        provider: result.route.provider,
        model: result.model,
        prompt: result.prompt,
        baseUrl: result.baseUrl,
        latencyMs: result.latencyMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        usageSource: result.usageSource,
        fallbackUsed: result.fallbackUsed,
        fallbackReason: result.fallbackReason,
        text: result.text,
        costCents: priceVisionResult(result, this.cfg),
        ...(result.finishReason !== undefined ? { finishReason: result.finishReason } : {}),
        ...(result.servedModel ? { servedModel: result.servedModel } : {}),
        ...(result.modelSwap ? { modelSwap: result.modelSwap } : {}),
      };
      // A page read charges the customer one Rich page, once per run and page: the first read of the
      // page un-counts its request from the org's uncharged attempts; a second read does not.
      const usageEvent = recordVisionRead(state.usageLedger, gate, pageRef, {
          provider: result.route.provider,
          model: result.model,
          metric: "page-analysis",
          amount: 1,
          unit: "page",
          costCents: output.costCents,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          metadata: {
            ...result.costMetadata,
            costSource: result.costMetadata?.costSource ?? (result.costCents !== undefined ? "provider" : "estimate"),
            ...(result.costCents === undefined ? { pricingSource: visionPricingSource(result.route) } : {}),
            billing: result.route.billing,
            documentId: document.id,
            pageNumber: page.pageNumber,
            rasterArtifactUri: page.artifactUri,
            runtime: result.runtime,
            prompt: result.prompt,
            outcome: result.text.trim() ? "completed" : "empty-output",
            fallbackUsed: result.fallbackUsed,
            usageSource: result.usageSource,
            ...(result.servedModel ? { servedModel: result.servedModel } : {}),
            ...(result.modelSwap ? { modelSwap: result.modelSwap } : {}),
          },
        },
      );
      usageSink?.(usageEvent, page.pageNumber);
      return output;
    } finally {
      try {
        // Sidecar only: cleanupTempFile would delete the directory holding the caller's image.
        await rm(outputPath, { force: true });
      } catch (error) {
        // A cleanup failure never replaces the call's own result or error.
        console.warn(`[vision-extract] document=${document.id} page=${page.pageNumber} sidecar cleanup failed: ${toError(error).message}`);
      }
    }
  }

  /**
   * Records a failed vision attempt once: a rejected page's summed spend, a failed call's billed
   * usage (earlier attempts, a model swap, a response cut off mid-stream), or a zero-cost marker
   * when the provider never accepted the call. Returns the provider cost recorded.
   */
  private recordFailedVisionAttempt(
    state: WorkflowState,
    document: import("../models.js").Document,
    vision: VisionConfig,
    page: Pick<RasterPageArtifact, "pageNumber" | "artifactUri">,
    reason: string,
    error?: unknown,
  ): { providerCostCents: number; rejected: boolean } {
    // Priced and labelled on the route each request was billed on (a fallback's, the configured OpenAI base URL),
    // never the configured primary: both attempts of a rejected page, a failure billed mid-stream, and the primary's
    // billed failure before a failed fallback.
    const pageMetadata = { documentId: document.id, pageNumber: page.pageNumber, rasterArtifactUri: page.artifactUri };
    const usages = visionFailureUsages(error, vision, this.cfg, pageMetadata);
    const route = findVisionServedRoute(error) ?? configuredVisionServedRoute(vision, this.cfg);
    const rejected = findVisionOutputRejected(error);
    const providerCostCents = recordVisionFailureUsages(state, usages);
    if (!rejected && !findVisionBilledUsage(error)) {
      // The provider never accepted the call on its last route: a zero-cost marker.
      state.usageLedger.enqueue(buildFailedVisionAttemptUsage({
        ...pageMetadata,
        runtime: route.runtime as VisionRuntime,
        provider: route.provider,
        model: route.model,
        reason,
      }), { logAiUsage: true });
    }
    state.pendingPerformance.push({
      documentId: document.id,
      scope: "page",
      stageName: this.name,
      metric: "vision-attempt-failure",
      pageNumber: page.pageNumber,
      value: 1,
      unit: "attempt",
      tags: ["page", "vision", "failure"],
      metadata: {
        model: route.model,
        runtime: route.runtime,
        billing: route.billing,
        reason,
        usagePersisted: true,
        rejected: rejected !== null,
        providerCostCents,
        routingVersion: state.artifactLedger?.read(VISION_ROUTING_VERSION_SLOT) ?? null,
      },
    });
    return { providerCostCents, rejected: rejected !== null };
  }

  /**
   * Per-document vision outcome telemetry: the rejection rate (alertable per org in SigNoz from
   * the `[vision-rejections]` log line and the `vision-rejection-rate` performance metric), each
   * page without output, and a guard stop with its reason.
   */
  private recordVisionOutcomeTelemetry(
    state: WorkflowState,
    document: import("../models.js").Document,
    extractedPages: number,
    failedPages: VisionPageSkip[],
    guardStop: VisionGuardStop | null,
    routingV2: boolean,
  ): void {
    const rejected = failedPages.filter((page) => page.outcome === "rejected").length;
    const attempted = extractedPages + failedPages.filter((page) => page.outcome === "rejected" || page.outcome === "failed").length;
    const orgId = state.run.orgId ?? null;
    if (attempted > 0) {
      const rate = rejected / attempted;
      console.log(
        `[vision-rejections] org=${orgId ?? "none"} run=${state.run.id} document=${document.id} ` +
          `rejected=${rejected} attempted=${attempted} rate=${rate.toFixed(4)} routingVersion=${routingVersion(routingV2)}`,
      );
      state.pendingPerformance.push({
        documentId: document.id,
        scope: "document",
        stageName: this.name,
        metric: "vision-rejection-rate",
        value: rate,
        unit: "ratio",
        tags: ["document", "vision", "rejection", "alert"],
        metadata: { orgId, rejectedPages: rejected, attemptedPages: attempted, routingVersion: routingVersion(routingV2) },
      });
    }
    for (const page of failedPages) {
      if (page.outcome === "blank-render") continue;
      recordPageEscalation("vision", page.outcome, 1);
      state.pendingPerformance.push({
        documentId: document.id,
        scope: "page",
        stageName: this.name,
        metric: "vision-page-outcome",
        pageNumber: page.pageNumber,
        value: 1,
        unit: "page",
        tags: ["page", "vision", page.outcome],
        metadata: { outcome: page.outcome, fallbackText: page.fallbackText, routingVersion: routingVersion(routingV2) },
      });
    }
    if (guardStop) {
      console.warn(
        `[vision-guard] org=${orgId ?? "none"} run=${state.run.id} document=${document.id} stopped=${guardStop.reason} ` +
          `runFailures=${guardStop.runFailures}/${guardStop.runAttempts} orgCents=${guardStop.orgCents}/${guardStop.orgLimitCents}`,
      );
      state.pendingPerformance.push({
        documentId: document.id,
        scope: "document",
        stageName: this.name,
        metric: "vision-guard-stop",
        value: 1,
        unit: "document",
        tags: ["document", "vision", "cost", guardStop.reason],
        metadata: { orgId, ...guardStop, routingVersion: routingVersion(routingV2) },
      });
    }
  }

  private async loadAdaptiveRouting(
    state: WorkflowState,
    documentId: string,
  ): Promise<Extract<ReturnType<typeof adaptiveRoutingDecisionSurfaceSchema.parse>, { status: "ready" }> | null> {
    const artifactUri = state.artifactLedger.readDocument(documentId, "classification");
    if (!artifactUri) {
      return null;
    }

    try {
      const key = keyFromStorageUri(artifactUri, this.storage.bucket);
      if (!key) {
        return null;
      }

      const payload = adaptiveRoutingDecisionSurfaceSchema.parse(
        await this.storage.getJson(key),
      );
      return payload.status === "ready" ? payload : null;
    } catch {
      return null;
    }
  }

  /**
   * Chart export without general vision (vision fallback off, Fast quality, or vision refused by privacy mode): no page
   * is re-read; each document runs only the chart export pass, which exports detected visuals from crops or page
   * rasters. Documents run one at a time under a cost cap, like the vision path, so the cap cannot be overshot.
   */
  private async runChartExportOnly(state: WorkflowState, signal?: AbortSignal): Promise<void> {
    const freeInline = freeInlineMode(state.run.pipeline);
    await runDocuments(healthyDocuments(state), (state.run.pipeline.maxCostCents ?? 0) > 0 ? 1 : state.docConcurrency, async (document) => {
      if (freeInline && !this.freeInlineHasWork(state, document)) {
        console.log(`[extract-debug] stage=${this.name} document=${document.id} chart-export-skipped=free-no-signal`);
        return;
      }
      if (isCostCapExceeded(state)) {
        console.log(`[extract-debug] stage=${this.name} document=${document.id} chart-export-skipped=cost-cap`);
        return;
      }
      const session = this.chartExportSession(state, document);
      await runDocumentStage(state, document, this.name, `${document.id}:vision`, "chart export ready", async () =>
        this.withChartExport(state, document, session, signal, async () => ({
          stats: { pages: 0, skipped: true, reason: "chart-export-only", selectedPages: [] },
        })));
    });
  }

  /**
   * Free tier, inline mode: whether the pass has anything to do for this document: a previous export to replace, an
   * inline answer with visuals (or one too big to carry inline), or figure charts from the Doppler VM (protocol 15) with
   * visuals. Anything else does no chart work. A source quarantined before inline mode was on gets no free charts.
   */
  private freeInlineHasWork(state: WorkflowState, document: import("../models.js").Document): boolean {
    // Ledger only, no reads: quarantine records the chart-inline slot exactly when its inline answer has work.
    return Boolean(state.artifactLedger.readDocument(document.id, "chart-export"))
      || chartInlineSlotHasWork(state.artifactLedger.readDocument(document.id, CHART_INLINE_SLOT))
      || figureChartsSlotHasWork(state.artifactLedger.readDocument(document.id, FIGURE_CHARTS_SLOT));
  }

  /**
   * Export off and vision not reading pages: nothing runs, except that a partial reprocess of a document an earlier run
   * exported charts for (its seeded `chart-export` slot) removes those blocks and `charts[]`. No slot, no read.
   */
  private async clearStaleChartExports(state: WorkflowState): Promise<void> {
    const documents = healthyDocuments(state).filter((document) => state.artifactLedger.readDocument(document.id, "chart-export"));
    if (documents.length === 0) return;
    await runDocuments(documents, state.docConcurrency, async (document) => {
      await this.clearChartExportFor(state, document);
    });
  }

  private async clearChartExportFor(state: WorkflowState, document: import("../models.js").Document): Promise<void> {
    try {
      if (await clearChartExport({ document, run: state.run, storage: this.storage, ledger: state.artifactLedger })) {
        console.log(`[chart-export] cleared previous export document=${document.id} reason=chart-export-off`);
      }
    } catch (error) {
      console.warn(`[chart-export] clearing previous export failed document=${document.id} error=${toError(error).message}`);
    }
  }

  /** Generator calls across this run's documents (per-run cap). */
  private readonly chartRunBudgets = new WeakMap<WorkflowState, ChartExportRunBudget>();

  /**
   * Chart export for one document: config, admitted generator catalog, model client, usage ledger and caps. The model
   * client is built only for the billed `models` tier with the kill switch `on`: a free-tier session has no client, so
   * it cannot call a model whatever happens downstream (the session's `canCallModel` is the second fence).
   */
  private chartExportSession(state: WorkflowState, document: import("../models.js").Document): ChartExportSession {
    let runBudget = this.chartRunBudgets.get(state);
    if (!runBudget) {
      runBudget = { calls: 0 };
      this.chartRunBudgets.set(state, runBudget);
    }
    const config = chartExportConfigOf(state.run.pipeline);
    const models = chartExportModelsActive(state.run.pipeline);
    const session: ChartExportSession = new ChartExportSession({
      documentId: document.id,
      config,
      catalog: () => buildRuntimeCatalog({ privacyMode: state.run.pipeline.privacyMode }).targets,
      envModel: process.env.CHART_EXPORT_GENERATOR_MODEL?.trim() || null,
      client: models ? this.chartModelClient(state, document) : null,
      recordUsage: (input) => { state.usageLedger.record(input); },
      // The session combines this with its per-document and per-run call caps.
      canCallModel: () => chartExportCanSpend(state),
      runBudget,
      // Charged as soon as the read is done (idempotent), so the cost cap and credit lease see it before the next call.
      onModelRead: (attempt) => {
        chargeChartExports(state, { documentId: document.id, attempts: [attempt], calls: session.calls, config });
      },
    });
    return session;
  }

  /**
   * One chart-export model call through the vision runtime: privacy gate, the run's attempt guard, model-swap and
   * fallback handling. Billed failures are recorded like any vision attempt; the generator records the success.
   */
  private chartModelClient(state: WorkflowState, document: import("../models.js").Document): ChartModelClient {
    return {
      complete: async (request) => {
        // Never the project's vision fallback model: chart calls are priced per visual, not per page read.
        const vision = chartExportVisionConfig(state.run.pipeline.vision, request.modelUri);
        if (!(await allowHostedCall(state, visionCall(resolveVisionRoute(vision)), [document.id]))) {
          throw new Error("chart export model refused by privacy mode");
        }
        const page = { documentId: document.id, pageNumber: request.pageNumber, rasterArtifactUri: "" };
        const outputPath = `${request.image.path}.chart-export-${request.purpose}-${Date.now()}.json`;
        return await withVisionCall(state, { documentId: document.id, pageNumber: request.pageNumber, purpose: "region" }, async (gate) => {
          try {
            const result = await executeVisionRuntime({
              imagePath: request.image.path,
              mimeType: request.image.mimeType,
              outputPath,
              vision,
              cfg: this.cfg,
              runner: this.runner,
              privacyMode: state.run.pipeline.privacyMode,
              outputSchema: null,
              gate,
              promptText: request.prompt,
              ...(chartExportReasoning(request.modelUri) ? { reasoning: chartExportReasoning(request.modelUri)! } : {}),
              ...chartCallRuntimeOptions(request),
              ...(request.signal ? { signal: request.signal } : {}),
            });
            recordVisionFailureUsages(state, primaryFailureUsages(result.primaryFailure, this.cfg, page));
            return {
              text: result.text,
              model: result.model,
              provider: result.route.provider,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              costCents: priceVisionResult(result, this.cfg),
              latencyMs: result.latencyMs,
              finishReason: result.finishReason ?? null,
              ...promptCacheCounts(result.costMetadata),
            };
          } catch (error) {
            // Refused before admission (image above the chart limit): nothing was sent, so there is no attempt to record.
            if (error instanceof VisionImageOverBudgetError) throw error;
            if (!findVisionGuardStop(error)) {
              this.recordFailedVisionAttempt(state, document, vision, { pageNumber: request.pageNumber, artifactUri: "" }, toError(error).message, error);
            } else {
              recordVisionFailureUsages(state, visionFailureUsages(error, vision, this.cfg, page));
            }
            throw error;
          } finally {
            await rm(outputPath, { force: true }).catch(() => undefined);
          }
        });
      },
    };
  }

  /**
   * Runs the stage body inside the document's chart export pass: candidates and deterministic partials first (so
   * routed crops in the body see them), the body, then the end-of-stage export. With export off (`session` null) the
   * body runs alone, plus the removal of a previous run's blocks when a reprocess seeded them. Export is optional
   * enrichment: its failure is logged and the stage result stands. Every generator call is billed per visual, whatever
   * happens to the pass.
   */
  private async withChartExport(
    state: WorkflowState,
    document: import("../models.js").Document,
    session: ChartExportSession | null,
    signal: AbortSignal | undefined,
    body: () => Promise<DocumentStageResult>,
  ): Promise<DocumentStageResult> {
    if (!session) {
      const result = await body();
      if (state.artifactLedger.readDocument(document.id, "chart-export")) await this.clearChartExportFor(state, document);
      return result;
    }
    try {
      let input: ChartExportPassInput | null = null;
      let prepared: PreparedChartExport | null = null;
      try {
        input = await this.chartPassInput(state, document, session, signal);
        prepared = await prepareChartExport(input);
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn(`[chart-export] prepare failed document=${document.id} error=${toError(error).message}`);
      }
      const result = await body();
      if (!input || !prepared) return result;
      try {
        const pass = await finishChartExport(input, prepared);
        const totals = session.calls.reduce((acc, call) => ({
          calls: acc.calls + 1, inputTokens: acc.inputTokens + call.inputTokens, outputTokens: acc.outputTokens + call.outputTokens, costCents: acc.costCents + call.costCents,
        }), { calls: 0, inputTokens: 0, outputTokens: 0, costCents: 0 });
        return {
          ...result,
          stats: {
            ...result.stats,
            [VISUAL_CANDIDATE_STATS_KEY]: pass.stats,
            chartExport: {
              ...totals, lowConfidenceCandidates: pass.lowConfidence, changedPages: pass.changedPages, artifactUri: pass.artifactUri,
              // Repeated pictures read once (readsAvoided: placements served by another placement's read, never charged).
              dedupe: pass.dedupe,
              ...(pass.facts ? { factsCandidates: pass.facts } : {}),
            },
          },
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn(`[chart-export] pass failed document=${document.id} error=${toError(error).message}`);
        return result;
      }
    } finally {
      // Each read is charged when it completes (`onModelRead`); this sweep in `finally` catches anything not yet charged
      // whatever happened to the pass. Idempotent per visual (ledger slot and event id), so a retried document stage
      // never charges a visual twice.
      if (session.modelReads.size > 0) {
        chargeChartExports(state, { documentId: document.id, attempts: [...session.modelReads.values()], calls: session.calls, config: session.config });
      }
    }
  }

  /** The pass's inputs: stored plan or classifier pages, quarantine presence (Office sources), rasters and crops. */
  private async chartPassInput(
    state: WorkflowState,
    document: import("../models.js").Document,
    session: ChartExportSession,
    signal: AbortSignal | undefined,
  ): Promise<ChartExportPassInput> {
    const routed = await this.loadRoutedExecution(state, document).catch(() => null);
    // Without routed vision, any stored plan (shadow included) still names the chart and diagram pages.
    const routedPlan = routed?.plan ?? await storedRoutePlan(this.storage, state.artifactLedger, document.id);
    const adaptive = routedPlan ? null : await this.loadAdaptiveRouting(state, document.id);
    // One quarantine artifact read: Office presence, and the inline chart answer for any chart-capable source.
    const facts = deterministicSourceKind(document.mimeType) !== null
      ? await quarantineChartFacts(this.storage, state.artifactLedger, document.id)
      : null;
    const presence = deterministicSourceKind(document.mimeType) === "office" ? facts?.presence : undefined;
    return {
      session,
      document,
      run: state.run,
      storage: this.storage,
      ledger: state.artifactLedger,
      routedPlan,
      legacyPages: adaptive?.pages ?? [],
      ...(presence ? { presence } : {}),
      ...(facts?.inline ? { inline: facts.inline } : {}),
      pageImage: async (pageNumber) => {
        const [raster] = await this.rasters.renderSelectedPages({ document, runId: state.run.id, pageNumbers: [pageNumber], signal });
        if (!raster) return null;
        const path = await this.storage.downloadToTempFile(raster.artifactKey, trustedTempDownloadPattern("docslurp-chart-export-raster-", document));
        return {
          path, mimeType: raster.mimeType ?? "image/png", dpi: raster.dpi ?? null, release: () => cleanupTempFile(path),
          // A customer's own image (an image document) is never decoded here, so it is never cropped.
          ...(raster.customerOriginal ? { customerOriginal: true } : {}),
        } as PageImage;
      },
      cropImage: (image, bbox) => this.cropChartImage(image, bbox),
      // Parser-VM time of the deterministic extractor: a cost-only event in this run's ledger, scoped to the document.
      recordUsage: (event) => { state.usageLedger.enqueue(event); },
      // The per-org hourly cap on free-tier VM runs, shared by every worker. No store or no org: refused (fail closed).
      reserveFreeVmRun: async () => {
        const reserve = state.store?.budgets.reserveChartExportFreeVmRun.bind(state.store.budgets);
        if (!reserve || !state.run.orgId) return false;
        try {
          return await reserve({ orgId: state.run.orgId, runId: state.run.id, documentId: document.id, perHour: chartExportFreeVmCap() });
        } catch (error) {
          console.warn(`[chart-export] free VM reservation failed document=${document.id} error=${toError(error).message}`);
          return false;
        }
      },
      ...(signal ? { signal } : {}),
    };
  }

  /** A placement crop of a page raster we rendered (page points -> raster pixels), through the isolated image codec. */
  private async cropChartImage(image: PageImage & { customerOriginal?: boolean }, bbox: BBox): Promise<PageImage | null> {
    if (image.customerOriginal || !(bbox.width > 0 && bbox.height > 0)) return null;
    const scale = (image.dpi && image.dpi > 0 ? image.dpi : 150) / 72;
    const decoded = chartSharp(image.path);
    const meta = await decoded.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < 1 || height < 1) return null;
    const left = Math.max(0, Math.min(width - 1, Math.floor(bbox.x * scale)));
    const top = Math.max(0, Math.min(height - 1, Math.floor(bbox.y * scale)));
    const cropWidth = Math.max(1, Math.min(width - left, Math.ceil(bbox.width * scale)));
    const cropHeight = Math.max(1, Math.min(height - top, Math.ceil(bbox.height * scale)));
    const path = `${image.path}.chart-crop-${left}-${top}-${cropWidth}x${cropHeight}.png`;
    await decoded.extract({ left, top, width: cropWidth, height: cropHeight }).png().toFile(path);
    return { path, mimeType: "image/png", dpi: image.dpi ?? null, release: () => rm(path, { force: true }) };
  }

  private async reconcileExtractionArtifacts(
    state: WorkflowState,
    document: import("../models.js").Document,
    selection: any,
    outputs: VisionPageOutput[],
    visionArtifactUri: string,
  ): Promise<{
    changedPages: number[];
    decisions: CanonicalReconciliationDecision[];
    /** The reconciled Markdown (and its slot URI) and canonical document now in the document's slots (absent when nothing was reconciled). */
    markdown?: string;
    markdownUri?: string;
    canonicalDocument?: CanonicalDocument;
  }> {
    const contractUri = state.artifactLedger.readDocument(document.id, "extraction-contract");
    const canonicalUri = state.artifactLedger.readDocument(document.id, "canonical-document");
    if (!contractUri || !canonicalUri) {
      console.warn(
        `[vision-extract] reconciliation skipped document=${document.id} ` +
          `contract=${contractUri ? "present" : "missing"} canonical=${canonicalUri ? "present" : "missing"}`,
      );
      return { changedPages: [], decisions: [] };
    }

    const contractKey = keyFromStorageUri(contractUri, this.storage.bucket);
    const canonicalKey = keyFromStorageUri(canonicalUri, this.storage.bucket);
    if (!contractKey || !canonicalKey) {
      return { changedPages: [], decisions: [] };
    }

    // Independent reads: fetch them together rather than one storage round trip after another.
    const [contractJson, canonicalJson, routing] = await Promise.all([
      this.storage.getJson(contractKey),
      this.storage.getJson(canonicalKey),
      this.loadAdaptiveRouting(state, document.id),
    ]);
    const contract = extractionContractSchema.parse(contractJson);
    const canonicalDocument = canonicalDocumentSchema.parse(canonicalJson);
    const routingByPage = new Map(
      (routing?.pages ?? []).map((page) => [page.pageNumber, page]),
    );
    const reconciled = reconcileCanonicalArtifacts({
      canonicalDocument,
      extractionContract: contract,
      // Smartest has no OCR read to fall back on: a page it sent to vision takes the vision read.
      minimumConfidence: ladderSkipsOcr(state.run.pipeline) ? 0 : undefined,
      replacements: outputs.map((output) => {
        const pageEvidence = routingByPage.get(output.pageNumber);
        return {
          pageNumber: output.pageNumber,
          markdown: output.text,
          source: {
            adapter: "vision",
            model: output.model,
            confidence: pageEvidence?.confidence ?? 0,
            confidenceBasis: "page-triage" as const,
            reason: pageEvidence
              ? `${pageEvidence.route}:${pageEvidence.signals.join(",") || "selected"}`
              : "missing-page-triage-evidence",
            artifactUri: visionArtifactUri,
          },
        };
      }),
    });

    const acceptedConfidence = reconciled.decisions
      .filter((decision) => decision.outcome === "accepted")
      .map((decision) => decision.source.confidence);
    reconciled.extractionContract.metadata.ocrStats = {
      method: selection.model,
      confidence:
        acceptedConfidence.length > 0
          ? acceptedConfidence.reduce((sum, value) => sum + value, 0) / acceptedConfidence.length
          : 0,
      pageCount: reconciled.changedPages.length,
    };
    for (const output of outputs) {
      if (!output.text.trim()) continue;
      const imageId = `vision-${output.pageNumber}`;
      if (reconciled.extractionContract.images.some((image) => image.id === imageId)) continue;
      reconciled.extractionContract.images.push({
        id: imageId,
        path: `vision-page-${output.pageNumber}.png`,
        description: output.text.slice(0, 500),
        pageNumber: output.pageNumber,
        bbox: null,
      });
    }

    const reconciledCanonicalKey = `${runArtifactRoot(state.run, document.userId)}/canonical-reconciled/${document.id}.json`;
    const reconciledContractKey = `${runArtifactRoot(state.run, document.userId)}/extraction-reconciled/${document.id}.contract.json`;
    const reconciledMarkdownKey = `${runArtifactRoot(state.run, document.userId)}/markdown-reconciled/${document.id}.md`;
    const reconciliationKey = `${runArtifactRoot(state.run, document.userId)}/canonical-reconciliation/${document.id}.json`;
    // The four new keys are written together. Every write settles before a failure propagates, so none is left
    // running; only then is the published summary evidence overwritten and the ledger pointed at the new keys.
    await settleAll([
      this.storage.putJson(reconciledCanonicalKey, reconciled.canonicalDocument),
      this.storage.putJson(reconciledContractKey, reconciled.extractionContract),
      this.storage.putBytes(
        reconciledMarkdownKey,
        Buffer.from(reconciled.markdown, "utf8"),
        "text/markdown; charset=utf-8",
      ),
      this.storage.putJson(reconciliationKey, {
        documentId: document.id,
        changedPages: reconciled.changedPages,
        decisions: reconciled.decisions,
        sourceCanonicalUri: canonicalUri,
        sourceContractUri: contractUri,
      }),
    ]);
    // Summary evidence was cut from the pre-reconciliation markdown; rebuild it from this one.
    await refreshSummaryEvidence({
      storage: this.storage, ledger: state.artifactLedger, document,
      text: reconciled.markdown, sourceUri: this.storage.uri(reconciledMarkdownKey),
    });

    state.artifactLedger.recordDocument(
      document.id,
      "canonical-document",
      this.storage.uri(reconciledCanonicalKey),
    );
    state.artifactLedger.recordDocument(
      document.id,
      "extraction-contract",
      this.storage.uri(reconciledContractKey),
    );
    state.artifactLedger.recordDocument(
      document.id,
      "markdown",
      this.storage.uri(reconciledMarkdownKey),
    );
    state.artifactLedger.recordDocument(
      document.id,
      "canonical-reconciliation",
      this.storage.uri(reconciliationKey),
    );

    return {
      changedPages: reconciled.changedPages,
      decisions: reconciled.decisions,
      markdown: reconciled.markdown,
      markdownUri: this.storage.uri(reconciledMarkdownKey),
      canonicalDocument: reconciled.canonicalDocument,
    };
  }

  /**
   * vision-extract is the last stage that writes the document's tables before pii-detect: when it re-read pages, store
   * the cells of every HTML table of the reconciled document (extract-markdown left them to it) from this activity's VM
   * lane, warm from rebuilding the pages' tables, so embed reuses them (DOCSLURP_TABLE_CELLS_CACHE). Best effort.
   */
  async storeTableCellsForEmbed(
    state: WorkflowState,
    document: import("../models.js").Document,
    reconciliation: { changedPages: number[]; markdown?: string; markdownUri?: string; canonicalDocument?: CanonicalDocument },
    signal?: AbortSignal,
  ): Promise<StoreEmbedTableCellsStats | null> {
    if (reconciliation.changedPages.length === 0 || reconciliation.markdown === undefined) return null;
    if (!mayHaveHtmlTables(reconciliation.markdown, reconciliation.canonicalDocument?.blocks)) return { status: "no-tables" };
    return await storeEmbedTableCells({
      run: state.run, document, runner: this.runner, storage: this.storage, stage: this.name,
      markdown: reconciliation.markdown, canonicalDocument: reconciliation.canonicalDocument, signal,
    });
  }
}

/**
 * Records billed vision failures (one [ai-usage] line each): a rejected page's summed attempts as an AI call, a
 * failure billed mid-stream as a cost event. Returns the provider cost recorded.
 */
function recordVisionFailureUsages(state: WorkflowState, usages: VisionFailureUsage[]): number {
  let providerCostCents = 0;
  for (const usage of usages) {
    providerCostCents += usage.input.costCents ?? 0;
    if (usage.kind === "rejected") {
      state.usageLedger.record(usage.input);
      continue;
    }
    state.usageLedger.enqueue({
      ...usage.input,
      amount: usage.input.amount ?? 1,
      unit: usage.input.unit ?? "attempt",
      costCents: usage.input.costCents ?? 0,
      inputTokens: usage.input.inputTokens ?? 0,
      outputTokens: usage.input.outputTokens ?? 0,
    }, { logAiUsage: true });
  }
  return providerCostCents;
}

/** How a receipt-less vision result was priced on the route that served it; recorded on the usage event. */
export function visionPricingSource(route: VisionServedRoute) {
  if (!isBilledVisionRoute(route.billing)) return "non-billable-runtime";
  return visionModelTokenPricing(route.model) ? "vision-catalog-list-price" : "configured-fallback";
}

export function buildFailedVisionAttemptUsage(args: {
  documentId: string;
  pageNumber: number;
  rasterArtifactUri: string;
  runtime: VisionRuntime;
  /** Usage-ledger label of the route that failed (`VisionServedRoute.provider`). */
  provider?: string;
  model: string;
  reason: string;
}): UsageEvent {
  return {
    provider: args.provider ?? (args.runtime === "remote-openai" ? "openai" : "vision-runtime"),
    model: args.model,
    metric: "page-analysis-attempt",
    amount: 1,
    unit: "attempt",
    costCents: 0,
    inputTokens: 0,
    outputTokens: 0,
    metadata: {
      documentId: args.documentId,
      pageNumber: args.pageNumber,
      rasterArtifactUri: args.rasterArtifactUri,
      runtime: args.runtime,
      outcome: "failure",
      reason: args.reason,
      usageSource: "unavailable",
      billable: false,
    },
  };
}

/** A refusal of the run's vision route before anything was sent: an unadmitted or unpriced model, or an unproven host region. */
export function isVisionModelRefusal(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 8; current = (current as { cause?: unknown }).cause, depth += 1) {
    const name = (current as { name?: unknown }).name;
    if (name === "VisionRouteRegionError" || name === "UnpricedVisionRouteError") return true;
  }
  return false;
}

export function shouldFailOpenVisionError(error: unknown): boolean {
  // Throttling (429/5xx after retries) is transient: fail the page task so
  // Temporal retries it, rather than silently dropping the page's content.
  if (findProviderRetryableError(error)) return false;
  // Output rejected after the alternate-route retry (degenerate, refusal, truncated): the page
  // keeps its native or OCR text instead of failing the whole document (and records `rejected`,
  // or `failed` when it has no usable text).
  if (findVisionOutputRejected(error)) return true;
  // The run's vision attempt guard refused the request: it was never sent.
  if (findVisionGuardStop(error)) return true;
  // The run's vision model is refused (not admitted, or no host with a stated US or EU region): nothing was sent, and a
  // stored setting naming it must not fail the document. The page keeps its own text.
  if (isVisionModelRefusal(error)) return true;
  const message = toError(error).message.toLowerCase();

  return [
    "insufficient_quota",
    "vision request failed: 401",
    "vision request failed: 402",
    "vision request failed: 403",
    "api key",
    "invalid_api_key",
    "incorrect_api_key",
    "billing",
  ].some((needle) => message.includes(needle));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await operation(values[index]!, index);
      }
    }),
  );
  return results;
}

/** Awaits every promise, then rethrows the first rejection (in argument order); unlike `Promise.all`, none is left running. */
async function settleAll(promises: Array<Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

/** The prompt-cache counts a vision result's cost metadata carries (summed over its attempts), for chart usage rows. */
function promptCacheCounts(metadata: Record<string, unknown> | undefined): { cachedInputTokens?: number; cacheWriteInputTokens?: number } {
  const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  const cached = count(metadata?.cachedInputTokens), written = count(metadata?.cacheWriteInputTokens);
  return { ...(cached ? { cachedInputTokens: cached } : {}), ...(written ? { cacheWriteInputTokens: written } : {}) };
}

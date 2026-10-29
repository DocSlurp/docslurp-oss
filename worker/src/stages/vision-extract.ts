import { rm } from "node:fs/promises";
import {
  adaptiveRoutingDecisionSurfaceSchema,
  canonicalDocumentSchema,
  parserPlaybookCatalog,
  resolveVisionRoute,
  visionListPriceCents,
  visionModelTokenPricing,
  type AdaptivePageRoutingEntry,
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
import { executeVisionRuntime, rejectedVisionUsageInput, visionCall } from "../tools/vision-runtime.js";
import { findVisionOutputRejected } from "../tools/vision-stream.js";
import { allowHostedCall } from "../lib/privacy-guard.js";
import { trustedTempDownloadPattern } from "../lib/temp-file-names.js";
import { maxInt } from "./utils.js";
import { refreshSummaryEvidence } from "./summary-evidence-refresh.js";
import {
  reconcileCanonicalArtifacts,
  type CanonicalReconciliationDecision,
} from "../lib/canonical-reconciliation.js";
import { loadActiveRoutePlan } from "../routing/active-plan.js";
import { prioritizePagesWithoutNativeText } from "./classify-route.js";
import { resolveVisionPageBudget } from "../lib/vision-page-budget.js";
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
import type { PlanValidation, RoutePlan } from "@docslurp/shared";
import { buildVisionPageFacts, recordPageFacts } from "../pipeline/page-facts.js";

type PipelineWithPlaybook = WorkflowState["run"]["pipeline"] & {
  parserPlaybook?: ParserPlaybookKey;
};

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
  /** Present when the served model differs from the requested one (see `VISION_MODEL_SWAP_POLICY`). */
  modelSwap?: { requested: string; served: string; provider: string | null };
}

export class VisionExtractStage implements Stage {
  readonly name = "vision-extract";

  constructor(
    private readonly runner: CommandRunner,
    private readonly storage: ArtifactStore,
    private readonly cfg: Config,
    private readonly rasters: PdfRasterCache,
  ) {}

  async planPageTasks(state: WorkflowState, signal?: AbortSignal) {
    const tasks: import("../temporal/shared.js").VisionPageTask[] = [];
    // Budget-capped runs retain sequential admission, rather than oversubscribing a cap.
    if (!state.run.pipeline.visionFallback || (state.run.pipeline.maxCostCents ?? 0) > 0) return tasks;
    if (!(await this.visionAllowed(state))) return tasks;
    for (const document of healthyDocuments(state)) {
      if (document.mimeType.startsWith("text/") || state.documentStages.get(document.id)?.get(this.name)?.status === "completed") continue;
      const vision = { ...state.run.pipeline.vision, maxPagesPerDocument: this.visionPageBudget(state, document.id) };
      // Active page router: one task per page served by exactly one VLM group, on that group's model
      // (a task's output is cached by page, so a page two groups both serve stays sequential, as do
      // executor-only pages, which are local and cheap). Orchestration is unchanged for the workflow:
      // activities only return a different task list, which replayed histories never re-evaluate.
      const routed = await this.loadRoutedExecution(state, document);
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
          tasks.push({
            runId: state.run.id,
            documentId: document.id,
            pageNumber,
            pageCount: fanOut.length,
            vision: visionConfigForModel(vision, group!.modelUri, 1),
          });
        }
        continue;
      }
      const routing = await this.checkNeedsVision(document, maxInt(1, document.pageCount), state, signal);
      if (!routing.needed) continue;
      const pages = routing.selectedPages.slice(0, this.resolveMaxVisionPages(vision)).sort((a, b) => a - b);
      for (const pageNumber of pages) tasks.push({ runId: state.run.id, documentId: document.id, pageNumber, pageCount: pages.length, vision });
    }
    return tasks.length > 1 ? tasks : [];
  }

  async runPageTask(state: WorkflowState, task: import("../temporal/shared.js").VisionPageTask, signal?: AbortSignal) {
    const document = state.documents.find((doc) => doc.id === task.documentId);
    if (!document) throw new Error("Page task document is not part of run");
    const outputs = await this.extractVisionPagesFromCache(state, document, task.vision, [task.pageNumber], signal);
    // An optional fail-open result is also a checkpoint; do not repeatedly call the provider.
    return outputs[0] ?? null;
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
    if (!state.run.pipeline.visionFallback) {
      return;
    }
    if (!(await this.visionAllowed(state))) {
      return;
    }

    await runDocuments(
      healthyDocuments(state),
      state.docConcurrency,
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
          await recordPageFacts(state.store, buildVisionPageFacts({
            documentId: document.id, runId: state.run.id, pageCount: maxInt(1, document.pageCount),
            selected: [], processed: [], cap: 0, costCapped: true,
          }));
          return;
        }

        const key = `${runArtifactRoot(state.run, document.userId)}/vision/${document.id}.json`;
        const pages = maxInt(1, document.pageCount);
        const artifactSlot = `${document.id}:vision`;
        const playbook = this.resolveParserPlaybook(state, document.id);
        const selection: VisionConfig = {
          ...state.run.pipeline.vision,
          maxPagesPerDocument: this.visionPageBudget(state, document.id),
        };
        const route = resolveVisionRoute(selection);

        console.log(
          `[extract-debug] stage=${this.name} document=${document.id} ` +
            `playbook=${playbook} pages=${pages} maxPages=${selection.maxPagesPerDocument} ` +
            `model=${route.model} runtime=${route.runtime}`,
        );

        await runDocumentStage(
          state,
          document,
          this.name,
          artifactSlot,
          "vision fallback manifest ready",
          async () => {
            if (document.mimeType.startsWith("text/")) {
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
            // model. Off/shadow, workspace force-all-pages, or no plan: unchanged legacy path.
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
              });

              await recordPageFacts(state.store, buildVisionPageFacts({
                documentId: document.id, runId: state.run.id, pageCount: pages,
                selected: [], processed: [], cap: selection.maxPagesPerDocument,
              }));
              return {
                artifactUri: this.storage.uri(key),
                stats: {
                  pages,
                  skipped: true,
                  score: needsVision.score,
                  selectedPages: needsVision.selectedPages,
                  reason: needsVision.reason,
                },
              };
            }

            let outputs: any[] = [];
            let routedResult: RoutedVisionResult | null = null;

            try {
              if (routed) {
                routedResult = await this.extractRoutedPages(state, document, selection, routed, signal, key);
                outputs = routedResult.outputs;
              } else {
                outputs = await this.extractVisionPagesFromCache(
                  state,
                  document,
                  selection,
                  needsVision.selectedPages,
                  signal,
                  key,
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
                },
              });

              await recordPageFacts(state.store, buildVisionPageFacts({
                documentId: document.id, runId: state.run.id, pageCount: pages,
                selected: needsVision.selectedPages, processed: [], cap: routed ? pages : selection.maxPagesPerDocument,
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
                },
              };
            }

            const routedValidation = routed && routedResult
              ? await this.recordRoutedValidation(state, document, routed.plan, routed.execution, routedResult, key)
              : null;

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
              processedPages: outputs.length,
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

            await recordPageFacts(state.store, buildVisionPageFacts({
              documentId: document.id, runId: state.run.id, pageCount: pages,
              selected: needsVision.selectedPages, processed: outputs, cap: routed ? pages : selection.maxPagesPerDocument,
            }));

            const reconciliation = await this.reconcileExtractionArtifacts(
              state,
              document,
              selection,
              outputs,
              this.storage.uri(key),
            );

            console.log(
              `[extract-debug] document=${document.id} visionCompleted ` +
                `processedPages=${outputs.length} inputTokens=${inputTokens} ` +
                `outputTokens=${outputTokens} costCents=${costCents}`,
            );

            return {
              artifactUri: this.storage.uri(key),
              stats: {
                pages: outputs.length,
                inputTokens,
                outputTokens,
                costCents,
                skipped: false,
                score: needsVision.score,
                latencyMs: totalLatencyMs,
                selectedPages: needsVision.selectedPages,
                routingPolicy: needsVision.routing?.visionPolicy ?? null,
                reconciledPages: reconciliation.changedPages,
                reconciliationDecisions: reconciliation.decisions.map((decision) => ({
                  pageNumber: decision.pageNumber,
                  outcome: decision.outcome,
                  reason: decision.reason,
                })),
              },
            };
          },
          signal,
        );
      },
    );
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
  }> {
    const routing = await this.loadAdaptiveRouting(state, document.id);
    let selectedPages = this.selectRoutingPages(routing?.pages ?? []);
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
      needed = !text || this.needsVision(text, pageCount, threshold);
      reason = !text
        ? "routing-and-extraction-evidence-unavailable"
        : needed
          ? "persisted-text-density-low"
          : "persisted-text-density-sufficient";
      if (needed) {
        selectedPages = Array.from({ length: pageCount }, (_, index) => index + 1);
      }
    }

    if (state.run.pipeline.vision.forceAllPages) {
      needed = true;
      selectedPages = Array.from({ length: pageCount }, (_, index) => index + 1);
      reason = "workspace-force-all-pages";
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
      },
    });

    return {
      needed,
      score,
      selectedPages,
      reason,
      routing: routing
        ? {
            documentComplexity: routing.documentComplexity,
            visionPolicy: routing.visionPolicy,
            dominantRoutes: routing.dominantRoutes,
          }
        : null,
    };
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

  private visionPageBudget(state: WorkflowState, documentId: string): number {
    return resolveVisionPageBudget(
      state.run.pipeline as PipelineWithPlaybook,
      state.artifactLedger.readDocument(documentId, "parser-playbook"),
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

    const pipelinePlaybook = (state.run.pipeline as PipelineWithPlaybook)
      .parserPlaybook;
    if (pipelinePlaybook && pipelinePlaybook in parserPlaybookCatalog) {
      return pipelinePlaybook;
    }

    return "balanced";
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
    // A workspace pin (force all pages) bypasses the router.
    if (state.run.pipeline.vision?.forceAllPages) return null;
    const plan = await loadActiveRoutePlan(state, this.storage, document.id, this.cfg);
    if (!plan) return null;
    const catalog = buildRuntimeCatalog({ privacyMode: state.run.pipeline.privacyMode }).allTargets;
    return { plan, execution: groupAssignmentsByTarget(plan, catalog), catalog };
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
    return { needed, score: 0, selectedPages, reason: needed ? "page-router-plan" : "page-router-no-pixels", routing: null };
  }

  private async extractRoutedPages(
    state: WorkflowState,
    document: import("../models.js").Document,
    selection: VisionConfig,
    routed: NonNullable<Awaited<ReturnType<VisionExtractStage["loadRoutedExecution"]>>>,
    signal: AbortSignal | undefined,
    key: string,
  ): Promise<RoutedVisionResult> {
    const allow = (vision: VisionConfig) => allowHostedCall(state, visionCall(resolveVisionRoute(vision)), [document.id]);
    const deps = routed.execution.requests.length > 0
      ? createProductionExecutorDeps({
          runId: state.run.id,
          document,
          storage: this.storage,
          rasters: this.rasters,
          runner: this.runner,
          canonicalUri: () => state.artifactLedger.readDocument(document.id, "canonical-document") ?? null,
          selection,
          allow,
          callVision: (vision, image, abort) =>
            this.callVisionOnImage(state, document, vision, image, abort),
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
          );
          return { outputs, costCentsByPage };
        },
      });
      for (const warning of result.executorWarnings) console.warn(`[page-router] document=${document.id} ${warning}`);
      return result;
    } finally {
      await deps?.dispose();
    }
  }

  /**
   * The decision-model verifier (TL3: clef-omni + clef-flash on page image + cheap output), wired into the
   * cascade only when the workspace puts a value on quality at or above the fitted minimum (0.5 USD per
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

  private async extractVisionPagesFromCache(
    state: WorkflowState,
    document: import("../models.js").Document,
    vision: VisionConfig,
    selectedPageNumbers: number[],
    signal?: AbortSignal,
    storageKey?: string,
    usageSink?: (event: UsageEvent | null, pageNumber: number) => void,
    bypassCache = false,
  ): Promise<VisionPageOutput[]> {
    const maxPages = this.resolveMaxVisionPages(vision);
    const requestedPages = selectedPageNumbers.slice(0, maxPages).sort((a, b) => a - b);
    if (maxPages === 0 || requestedPages.length === 0) {
      return [];
    }

    const isCached = (page: number) => !bypassCache && state.distributedVisionPages.has(`${document.id}:${page}`);
    const cached = requestedPages.filter(isCached);
    const missing = requestedPages.filter((page) => !isCached(page));
    const completed = cached.flatMap((page) => {
      const output = state.distributedVisionPages.get(`${document.id}:${page}`) as VisionPageOutput | null;
      return output ? [output] : [];
    });
    if (!missing.length) return completed.sort((a, b) => a.pageNumber - b.pageNumber);
    const rasterPages = await this.rasters.renderSelectedPages({
      document,
      runId: state.run.id,
      pageNumbers: missing,
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
          { imagePath, mimeType: page.mimeType, pageNumber: page.pageNumber, artifactUri: page.artifactUri },
          signal,
          usageSink,
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
        return { output, error: null };
      } catch (error) {
        const message = toError(error).message;
        this.recordFailedVisionAttempt(state, document, vision, page, message, error);
        return { output: null, error };
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
   * One vision call over an image on disk: runs the runtime, prices it, and records the usage
   * event. Shared by whole-page extraction and the page router's region/image-scoped calls.
   */
  private async callVisionOnImage(
    state: WorkflowState,
    document: import("../models.js").Document,
    vision: VisionConfig,
    image: { imagePath: string; mimeType: string; pageNumber: number; artifactUri?: string },
    signal?: AbortSignal,
    usageSink?: (event: UsageEvent | null, pageNumber: number) => void,
  ): Promise<VisionPageOutput> {
    const imagePath = image.imagePath;
    const page = { mimeType: image.mimeType, pageNumber: image.pageNumber, artifactUri: image.artifactUri ?? "" };
    const outputPath = `${imagePath}.vision.json`;
    try {
      const result = await executeVisionRuntime({
        imagePath,
        mimeType: page.mimeType,
        privacyMode: state.run.pipeline.privacyMode,
        outputPath,
        vision,
        cfg: this.cfg,
        runner: this.runner,
        outputSchema: state.run.pipeline.outputSchema,
        signal,
      });
      const output: VisionPageOutput = {
        pageNumber: page.pageNumber,
        runtime: result.runtime,
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
        costCents: this.calculateVisionCost(result),
        ...(result.finishReason !== undefined ? { finishReason: result.finishReason } : {}),
        ...(result.servedModel ? { servedModel: result.servedModel } : {}),
        ...(result.modelSwap ? { modelSwap: result.modelSwap } : {}),
      };
      const usageEvent = state.usageLedger.record({
          provider: result.provider ?? (result.baseUrl?.includes("openrouter.ai") ? "openrouter" : result.runtime === "remote-openai" ? "openai" : "vision-runtime"),
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
            ...(result.costCents === undefined ? { pricingSource: this.visionPricingSource(result) } : {}),
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
      // Sidecar only: cleanupTempFile would delete the directory holding the caller's image.
      await rm(outputPath, { force: true });
    }
  }

  private recordFailedVisionAttempt(
    state: WorkflowState,
    document: import("../models.js").Document,
    vision: VisionConfig,
    page: RasterPageArtifact,
    reason: string,
    error?: unknown,
  ): void {
    const route = resolveVisionRoute(vision);
    // Both attempts of a rejected page were billed: record that spend (one [ai-usage] line) instead of a zero-cost marker.
    const rejected = findVisionOutputRejected(error);
    if (rejected) {
      const costCents = rejected.costCents ?? this.calculateVisionCost({
        model: route.model, runtime: route.runtime, baseUrl: route.baseUrl,
        inputTokens: rejected.inputTokens, outputTokens: rejected.outputTokens,
      });
      const input = rejectedVisionUsageInput(rejected, costCents, route.model);
      state.usageLedger.record({
        ...input,
        metadata: {
          ...input.metadata,
          documentId: document.id,
          pageNumber: page.pageNumber,
          rasterArtifactUri: page.artifactUri,
          runtime: route.runtime,
        },
      });
    } else state.usageLedger.enqueue(
      buildFailedVisionAttemptUsage({
        documentId: document.id,
        pageNumber: page.pageNumber,
        rasterArtifactUri: page.artifactUri,
        runtime: route.runtime,
        model: route.model,
        reason,
      }),
      { logAiUsage: true },
    );
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
        reason,
        usagePersisted: true,
      },
    });
  }

  private resolveMaxVisionPages(vision: VisionConfig): number {
    return Math.max(0, vision.maxPagesPerDocument);
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

  private selectRoutingPages(pages: AdaptivePageRoutingEntry[]): number[] {
    // Pages with no native text come first: vision is their only source of searchable
    // text, so they keep their place when maxPagesPerDocument truncates the selection.
    return prioritizePagesWithoutNativeText(pages)
      .filter((page) => {
        if (page.ocrDecision !== undefined) {
          return page.ocrDecision.authorized;
        }
        return (
          page.extractorHint === "vision-rescue" ||
          ((page.route === "form" || page.route === "table-heavy") &&
            page.textDensityScore < 0.45)
        );
      })
      .map((page) => page.pageNumber);
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
      minimumConfidence: state.run.pipeline.vision.forceAllPages ? 0 : undefined,
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
    // Four distinct keys and the summary evidence (rebuilt from the reconciled markdown) are written together;
    // the ledger points at them only after every write succeeded.
    const reconciledMarkdownUri = this.storage.uri(reconciledMarkdownKey);
    await Promise.all([
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
      refreshSummaryEvidence({
        storage: this.storage, ledger: state.artifactLedger, document,
        text: reconciled.markdown, sourceUri: reconciledMarkdownUri,
      }),
    ]);

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
    };
  }

  private isBillableVisionRuntime(result: { runtime: string; baseUrl: string | null }): boolean {
    const normalizedBaseUrl = result.baseUrl?.replace(/\/+$/, "") ?? null;
    const normalizedOpenAiBaseUrl = this.cfg.openAiBaseUrl.replace(/\/+$/, "");
    return (
      result.runtime === "remote-openai" ||
      (result.runtime === "openai-compatible" &&
        (normalizedBaseUrl === normalizedOpenAiBaseUrl || Boolean(normalizedBaseUrl?.includes("openrouter.ai"))))
    );
  }

  /** How a receipt-less vision call was priced; recorded on the usage event. */
  private visionPricingSource(result: { model: string; runtime: string; baseUrl: string | null }) {
    if (!this.isBillableVisionRuntime(result)) return "non-billable-runtime";
    return visionModelTokenPricing(result.model) ? "vision-catalog-list-price" : "configured-fallback";
  }

  private calculateVisionCost(result: {
    costCents?: number;
    model: string;
    runtime: string;
    baseUrl: string | null;
    inputTokens: number;
    outputTokens: number;
  }): number {
    if (result.costCents !== undefined) return result.costCents;
    if (!this.isBillableVisionRuntime(result)) {
      return 0;
    }

    // Without a provider charge (OpenAI direct never returns one; OpenRouter BYOK may not), price cataloged
    // hosted models at their own list price. The generic COST_PER_1K_* fallback is in cents per 1k tokens
    // (defaults $0.10/M input, $0.30/M output), below most cataloged hosted list prices, so this usually raises
    // receipt-less charges to list price; the cheapest entries (GLM 5.3 Flash) list below the fallback and
    // are priced at their real, lower list price.
    return (
      visionListPriceCents(result.model, result) ??
        (result.inputTokens / 1000) * this.cfg.costPer1kInputTokens +
          (result.outputTokens / 1000) * this.cfg.costPer1kOutputTokens
    );
  }
}

export function buildFailedVisionAttemptUsage(args: {
  documentId: string;
  pageNumber: number;
  rasterArtifactUri: string;
  runtime: VisionRuntime;
  model: string;
  reason: string;
}): UsageEvent {
  return {
    provider: args.runtime === "remote-openai" ? "openai" : "vision-runtime",
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

export function shouldFailOpenVisionError(error: unknown): boolean {
  // Throttling (429/5xx after retries) is transient: fail the page task so
  // Temporal retries it, rather than silently dropping the page's content.
  if (findProviderRetryableError(error)) return false;
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

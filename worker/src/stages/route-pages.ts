import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  adaptiveRoutingDecisionSurfaceSchema,
  defaultPageRouterConfig,
  pageRouterDecisionModels,
  routePlanSchema,
  type AdaptiveRoutingArtifact,
  type BBox,
  type DecisionFormat,
  type DecisionModel,
  type PageInput,
  type PageRouterConfig,
  type PageRouterMode,
  type PolicyPack,
  type RoutePlan,
  type RoutingBudget,
  type Router,
} from "@docslurp/shared";

import type { Config } from "../config.js";
import type { Document } from "../models.js";
import { readRasterEngine, type PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import { loadNativePdfEngine } from "../native-pdf/loader.js";
import { logNativePdfFallback } from "../native-pdf/types.js";
import type { NativePdfDocument } from "../native-pdf/types.js";
import { renderClipNative } from "../native-pdf/render.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import { isCostCapExceeded, runDocumentStage, runDocuments, runSpentCents } from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import { allowHostedCall } from "../lib/privacy-guard.js";
import { buildPageInputs, createProbeRunner, parseProbeOutput, type ProbeRunner } from "../routing/page-input.js";
import { sandboxedTesseract } from "../routing/probe/ocr-layer.js";
import { readRoutingFlags, type TableGateMode } from "../routing/flags.js";
import { PAGE_ROUTE_TABLE_GATE_METRIC, runTableGateShadow } from "../routing/gates/shadow.js";
import { createInsetGate, type InsetGate } from "../routing/inset-gate.js";
import { CONTENT_EXCERPT_CHARS, TEXT_STATE_EXCERPT_CHARS } from "../routing/triage.js";
import { freeTrustVerdict } from "../routing/trust.js";
import type { EmbeddingPrefilter } from "../routing/routers/embedding-prefilter.js";
import {
  PAGE_ROUTE_DECISION_CANARY_METRIC,
  createDecisionClient,
  recordDecisionUsage,
  type DecisionClient,
} from "../routing/decision-client.js";
import {
  DecisionModelChainRouter,
  decisionModelHealth,
  getDecisionHealthHistory,
  QUARANTINED_DECISION_MODELS,
  withHealthHistory,
  type ChainModel,
  type DecisionModelHealthHistory,
  type ChainTraceEntry,
  type DecisionModelHealthRegistry,
} from "../routing/health/index.js";
import { BaselineRouter } from "../routing/routers/baseline.js";
import { hasHealthyTextLayer } from "../routing/routers/decision-model.js";
import { HeuristicRouter } from "../routing/routers/heuristic.js";
import {
  PAGE_ROUTE_PLAN_SLOT,
  buildRuntimeCatalog,
  effectivePageRouterMode,
  loadRuntimePolicyPack,
  type RuntimeCatalog,
} from "../routing/runtime.js";
import type { CommandRunner } from "../tools/runner.js";
import { type ArtifactStore, keyFromStorageUri } from "../tools/storage.js";
import { runArtifactRoot } from "../lib/artifact-root.js";

import { assertCompleteActivePlan, assertSupportedActiveMargin } from "../routing/active-plan.js";

export const PAGE_ROUTE_DECISION_METRIC = "page-route-decision";
export const PAGE_ROUTE_CHUNK_ESTIMATE_METRIC = "page-route-chunk-estimate";
export const PAGE_ROUTE_TIMING_METRIC = "page-route-timing";
export const PAGE_ROUTE_ERROR_METRIC = "page-route-error";

/** Test seams; production uses the defaults. */
export interface RoutePagesDeps {
  probe?: ProbeRunner;
  /** Builds the decision client for one document (usage is recorded by the stage). */
  decisionClient?: (args: {
    privacyMode: string;
    onUsage: NonNullable<Parameters<typeof createDecisionClient>[0]["onUsage"]>;
  }) => DecisionClient;
  /**
   * Whether the run may still spend on decision-model calls. Defaults to the run's own cost cap;
   * org-level credit and budget checks run at every stage boundary (Store.completeRunStage ->
   * enforceRunSpend) and pause the run before this stage starts, so this stage reads no spend SQL.
   */
  canSpend?: (state: WorkflowState) => boolean;
  catalog?: (privacyMode: string) => RuntimeCatalog;
  /** Policy pack for the decision-model chain (defaults to the bundled fitted pack). */
  policyPack?: PolicyPack;
  /** Decision-model health registry (defaults to the process-wide one). */
  health?: DecisionModelHealthRegistry;
  /** Clip renderer for inset crops (tests); defaults to the native engine when PDF_RASTER_ENGINE=native-pdf. */
  renderClip?: (pdfPath: string, pageNumber: number, clip: [number, number, number, number]) => Promise<Uint8Array | null>;
  /**
   * Multi-day canary history behind quarantine (defaults to the process-wide one at
   * DOCSLURP_DECISION_HEALTH_HISTORY). Quarantined models serve only after three clean noul+choice days; null disables.
   */
  healthHistory?: DecisionModelHealthHistory | null;
  /**
   * Optional embedding pre-filter (W8): pages whose content questions the embedding probe settles
   * confidently never reach the paid decision model. Disabled unless an embedding provider is configured.
   */
  embeddingPrefilter?: EmbeddingPrefilter;
  /** Table gate mode (defaults to PAGE_ROUTER_TABLE_GATE via flags.ts). */
  tableGate?: TableGateMode;
  /** Opens the document with the native-pdf engine for the table gate (tests); null when the engine is unavailable. */
  openNativePdf?: (pdfPath: string, signal?: AbortSignal) => Promise<NativePdfDocument | null>;
}

interface ChainReport {
  trace: ChainTraceEntry[];
  servedBy: string | null;
}

interface RoutingTiming {
  pages: number;
  /** Probe wall time without the OCR-layer agreement check. */
  probeMs: number;
  /** Band re-OCR of OCR-layer pages (summed over pages). */
  agreementMs: number;
  /** Inset crop triage (decision-model calls plus crops). */
  insetMs: number;
  triageMs: number;
  planningMs: number;
  totalMs: number;
  perPageMs: { probe: number; agreement: number; inset: number; triage: number; planning: number; total: number };
}

/** Page render used to cut insets from (long edge, px); the crops are then scaled to the 384 px model tile. */
const INSET_RENDER_PX = 1600;

/**
 * Plans, per page, which extraction target each page needs (accept the text layer, OCR, a
 * chart extractor, a caption, ...) with cost estimates and a chunk budget. `shadow` records the
 * plan and one performance_log row per page without touching extraction; `active` lets
 * render-images and vision-extract execute it. Decisions come from decision models plus free
 * features, never from a generative LLM. Ordinary routing errors leave the legacy path;
 * unsupported margin floors and budget-stripped active plans fail closed.
 */
export class RoutePagesStage implements Stage {
  readonly name = "route-pages";

  constructor(
    private readonly storage: ArtifactStore,
    private readonly cfg: Config,
    private readonly sources: PdfSourceCache,
    private readonly runner?: CommandRunner,
    private readonly deps: RoutePagesDeps = {},
  ) {}

  async run(state: WorkflowState, signal?: AbortSignal): Promise<void> {
    const mode = effectivePageRouterMode(state, this.cfg);
    if (mode === "off") return;
    if (mode === "active") assertSupportedActiveMargin((state.run.pipeline.pageRouter ?? defaultPageRouterConfig).marginFloor);

    await runDocuments(healthyDocuments(state), state.docConcurrency, async (document) => {
      const key = `${runArtifactRoot(state.run, document.userId)}/page-route/${document.id}.json`;
      await runDocumentStage(
        state,
        document,
        this.name,
        `${document.id}:${PAGE_ROUTE_PLAN_SLOT}`,
        "page route plan ready",
        async () => {
          if (document.mimeType !== "application/pdf") {
            return { stats: { skipped: true, reason: "unsupported-format", mode } };
          }
          try {
            return await this.routeDocument(state, document, mode, key, signal);
          } catch (error) {
            if (signal?.aborted || (error instanceof Error && error.message.startsWith("page-router-incomplete:"))) throw error;
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[route-pages] document=${document.id} routing failed open: ${message}`);
            state.pendingPerformance.push({
              documentId: document.id,
              scope: "document",
              stageName: this.name,
              metric: PAGE_ROUTE_ERROR_METRIC,
              value: 1,
              unit: "document",
              tags: ["page-router", "error"],
              metadata: { mode, reason: message.slice(0, 300) },
            });
            return { stats: { skipped: true, failOpen: true, reason: message.slice(0, 200), mode } };
          }
        },
        signal,
      );
    });
  }

  private async routeDocument(
    state: WorkflowState,
    document: Document,
    mode: Exclude<PageRouterMode, "off">,
    key: string,
    signal?: AbortSignal,
  ): Promise<{ artifactUri: string; stats: Record<string, unknown> }> {
    const settings: PageRouterConfig = state.run.pipeline.pageRouter ?? defaultPageRouterConfig;
    const privacyMode = state.run.pipeline.privacyMode ?? "standard";
    const catalog = (this.deps.catalog ?? ((privacy) => buildRuntimeCatalog({ privacyMode: privacy })))(privacyMode);
    const routing = await this.loadClassification(state, document);

    const requestedModels = pageRouterDecisionModels(settings);
    const decisionModels = settings.router === "decision-model"
      ? requestedModels.flatMap((id) => catalog.decisionModels.find((m) => m.id === id) ?? [])
      : [];
    const wantsThumbnails = decisionModels.some((m) => m.modalities.image) && settings.triageFormat !== "text-state";
    const thumbDir = wantsThumbnails ? await mkdtemp(path.join(tmpdir(), "docslurp-route-thumbs-")) : undefined;
    try {
      const source = await this.sources.get(document);
      const probeStarted = performance.now();
      const pages = await buildPageInputs({
        pdfPath: source.path,
        thumbDir,
        thumbPx: settings.tilePx,
        routing,
        documentFormat: "pdf",
        // TL1: OCR-layer pages are verified against a band re-OCR (about 1 s CPU, OCR-layer pages only).
        verifyOcrLayer: true,
        recognise: this.runner ? sandboxedTesseract(this.runner) : undefined,
        probe: this.deps.probe ?? createProbeRunner(),
        signal,
      });

      const probeWallMs = performance.now() - probeStarted;
      const agreementMs = Math.min(probeWallMs, pages.reduce((sum, page) => sum + (page.textFacts.ocrLayerMs ?? 0), 0));
      const probeMs = probeWallMs - agreementMs;

      const decisionLatency = { sumMs: 0 };
      const inset = { wallMs: 0, callMs: 0 };
      const insetRender = this.insetRenderer(source.path, signal);
      const { router, routerNote: selectNote, chain } = await this.selectRouter({
        state, document, settings, requestedModels, decisionModels, pages, privacyMode, signal, decisionLatency, inset,
        renderPage: insetRender.render,
        renderClip: insetRender.clip,
      });
      const budget = this.budgetFor(state, settings);
      const planStarted = performance.now();
      let raw: RoutePlan;
      try {
        raw = await router.plan(pages, catalog.targets, budget, settings.objective);
      } finally {
        await insetRender.dispose();
      }
      const routerWallMs = performance.now() - planStarted;
      const insetMs = Math.min(inset.wallMs, routerWallMs);
      // Decision calls can overlap, so their summed latency is capped by the router's remaining wall time.
      const triageMs = Math.min(Math.max(0, decisionLatency.sumMs - inset.callMs), Math.max(0, routerWallMs - insetMs));
      const planningMs = Math.max(0, routerWallMs - insetMs - triageMs);
      const n = Math.max(1, pages.length);
      const totalMs = probeWallMs + routerWallMs;
      const timing: RoutingTiming = {
        pages: pages.length,
        probeMs,
        agreementMs,
        insetMs,
        triageMs,
        planningMs,
        totalMs,
        perPageMs: {
          probe: probeMs / n,
          agreement: agreementMs / n,
          inset: insetMs / n,
          triage: triageMs / n,
          planning: planningMs / n,
          total: totalMs / n,
        },
      };
      const chainReport: ChainReport | undefined = chain ? { trace: chain.trace, servedBy: chain.servedBy } : undefined;
      const routerNote = chainReport
        ? [selectNote, `decision-chain:${chainReport.trace.map((t) => `${t.model}=${t.outcome}`).join(",")}`].filter(Boolean).join(" ")
        : selectNote;
      const plan: RoutePlan = routePlanSchema.parse({
        ...raw,
        documentId: document.id,
        runId: state.run.id,
        mode,
      });

      if (mode === "active") assertCompleteActivePlan(plan);
      await this.storage.putJson(key, plan);
      const artifactUri = this.storage.uri(key);
      this.recordDecisions(state, document, plan, pages, routerNote, timing, chainReport);
      const tableGate = (this.deps.tableGate ?? readRoutingFlags().tableGate) === "shadow"
        ? await this.shadowTableGate(state, document, source.path, plan, pages, catalog.targets, signal)
        : undefined;

      const nonNative = new Set(plan.assignments.filter((a) => a.role !== "accept-text" && a.role !== "skip").map((a) => a.pageNumber));
      return {
        artifactUri,
        stats: {
          mode,
          router: plan.routerId,
          pages: pages.length,
          assignments: plan.assignments.length,
          pagesNeedingPixels: nonNative.size,
          estimatedCostUsd: plan.chunkEstimate.totalCostUsd,
          routerCostUsd: plan.chunkEstimate.routerCostUsd,
          timing,
          triageRan: plan.triage.ran,
          ...(plan.triage.skippedReason ? { triageSkippedReason: plan.triage.skippedReason } : {}),
          ...(routerNote ? { routerNote } : {}),
          ...(chainReport ? { decisionModel: chainReport.servedBy, decisionChain: chainReport.trace } : {}),
          ...(tableGate ? { tableGate } : {}),
        },
      };
    } finally {
      if (thumbDir) await rm(thumbDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Renders pages large enough to crop insets from, on demand and only for pages the inset gate asks about.
   * Uses the probe's thumbnail writer, so no second rasterizer is needed.
   */
  private insetRenderer(pdfPath: string, signal?: AbortSignal): {
    render: (pageNumber: number) => Promise<string | null>;
    /** Native clip render of one inset box; undefined unless PDF_RASTER_ENGINE=native-pdf and the binding loads. */
    clip?: (pageNumber: number, box: BBox) => Promise<Uint8Array | null>;
    dispose: () => Promise<void>;
  } {
    const probe = this.deps.probe ?? createProbeRunner();
    let dir: string | undefined;
    const cache = new Map<number, Promise<string | null>>();
    const clip = readRasterEngine() === "native-pdf" || this.deps.renderClip
      ? async (pageNumber: number, box: BBox): Promise<Uint8Array | null> => {
        const [x, y, width, height] = [box.x, box.y, box.width, box.height];
        const region: [number, number, number, number] = [x, y, x + width, y + height];
        if (this.deps.renderClip) return this.deps.renderClip(pdfPath, pageNumber, region);
        const loaded = await loadNativePdfEngine();
        if (!loaded.ok) return null; // Engine absence is reported once at load; the caller crops a full render.
        try {
          return (await renderClipNative(loaded.engine, pdfPath, pageNumber, region, { dpi: 150, signal })).bytes;
        } catch (error) {
          if (signal?.aborted) throw error;
          logNativePdfFallback(`route-clip page=${pageNumber}`, error, "full-page render and crop");
          return null;
        }
      }
      : undefined;
    return {
      ...(clip ? { clip } : {}),
      render: (pageNumber) => {
        const hit = cache.get(pageNumber);
        if (hit) return hit;
        const pending = (async () => {
          dir ??= await mkdtemp(path.join(tmpdir(), "docslurp-route-insets-"));
          const stdout = await probe({ pdfPath, pages: String(pageNumber), thumbDir: dir, thumbPx: INSET_RENDER_PX, signal });
          return parseProbeOutput(stdout).find((row) => row.pageNumber === pageNumber)?.thumbnail ?? null;
        })().catch(() => null);
        cache.set(pageNumber, pending);
        return pending;
      },
      dispose: async () => {
        await Promise.allSettled([...cache.values()]);
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  }

  /**
   * PAGE_ROUTER_TABLE_GATE=shadow: the ruled-grid-or-crop rule on pages with a table signal, logged per page with
   * the crop estimate. Never changes the plan or extraction, and never fails the stage.
   */
  private async shadowTableGate(
    state: WorkflowState,
    document: Document,
    pdfPath: string,
    plan: RoutePlan,
    pages: PageInput[],
    catalog: RuntimeCatalog["targets"],
    signal?: AbortSignal,
  ): Promise<{ pages: number; regions: number; accepted: number; escalated: number; cropCostUsd: number } | { error: string }> {
    let doc: NativePdfDocument | null = null;
    try {
      doc = await (this.deps.openNativePdf ?? openNativePdfDocument)(pdfPath, signal);
      if (!doc) return { error: "native-pdf engine unavailable" };
      const rows = await runTableGateShadow({ document: doc, pages, plan, catalog, signal });
      for (const row of rows) {
        state.pendingPerformance.push({
          documentId: document.id,
          scope: "page",
          stageName: this.name,
          metric: PAGE_ROUTE_TABLE_GATE_METRIC,
          pageNumber: row.pageNumber,
          value: row.cropEstimate?.costUsd ?? 0,
          unit: "usd",
          tags: ["page", "page-router", "table-gate", "shadow"],
          metadata: { ...row, mode: "shadow", rule: "ruled-grid-or-crop" },
        });
      }
      return {
        pages: rows.length,
        regions: rows.reduce((n, r) => n + r.regions.length, 0),
        accepted: rows.reduce((n, r) => n + r.accepted, 0),
        escalated: rows.reduce((n, r) => n + r.escalated, 0),
        cropCostUsd: rows.reduce((n, r) => n + (r.cropEstimate?.costUsd ?? 0), 0),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      const failure = logNativePdfFallback("table-gate-shadow", error, "no table gate estimate");
      return { error: `${failure.code}: ${failure.message}`.slice(0, 4000) };
    } finally {
      await doc?.close().catch(() => undefined);
    }
  }

  private budgetFor(state: WorkflowState, settings: PageRouterConfig): RoutingBudget {
    let limitUsd = settings.budgetPerDocumentUsd;
    const capCents = state.run.pipeline.maxCostCents;
    if (capCents !== null && capCents !== undefined && capCents > 0) {
      const remaining = Math.max(0, capCents - runSpentCents(state));
      limitUsd = Math.min(limitUsd, remaining / 100);
    }
    return { limitUsd, marginFloor: settings.marginFloor };
  }

  private async selectRouter(args: {
    state: WorkflowState;
    document: Document;
    settings: PageRouterConfig;
    requestedModels: string[];
    decisionModels: DecisionModel[];
    pages: PageInput[];
    privacyMode: string;
    signal?: AbortSignal;
    decisionLatency: { sumMs: number };
    inset: { wallMs: number; callMs: number };
    renderPage: (pageNumber: number) => Promise<string | null>;
    renderClip?: (pageNumber: number, box: BBox) => Promise<Uint8Array | null>;
  }): Promise<{ router: Router; routerNote?: string; chain?: DecisionModelChainRouter }> {
    const { state, document, settings } = args;
    const ids = { documentId: document.id, runId: state.run.id };
    const disallowedPrivacy = new Set<string>(args.privacyMode === "standard" ? [] : ["hosted"]);
    const heuristic = () => new HeuristicRouter(ids);
    const baseline = (carry?: ConstructorParameters<typeof BaselineRouter>[0]["carry"]) => new BaselineRouter({
      pack: loadRuntimePolicyPack("baseline"),
      ...ids,
      config: { disallowedPrivacy },
      ...(carry ? { carry } : {}),
    });

    if (settings.router === "heuristic") return { router: heuristic() };
    if (settings.router === "baseline") return { router: baseline() };

    if (args.decisionModels.length === 0) {
      return { router: baseline(), routerNote: `decision-model-unavailable:${args.requestedModels.join("|")}` };
    }
    // Decision calls cost money and send page images or text to a hosted provider: the run's own
    // cost cap and the workspace privacy mode both gate them (strict-privacy audits the block).
    const canSpend = (this.deps.canSpend ?? ((s: WorkflowState) => !isCostCapExceeded(s)))(state);
    if (!canSpend) return { router: baseline(), routerNote: "decision-model-skipped:cost-cap" };
    let models = args.decisionModels;
    const firstHosted = models.find((m) => m.availability.privacyClass === "hosted");
    if (firstHosted) {
      const allowed = await allowHostedCall(
        state,
        { provider: firstHosted.endpoint, model: firstHosted.id, operation: "worker.routing.decision", target: "hosted" },
        [document.id],
      );
      if (!allowed) models = models.filter((m) => m.availability.privacyClass !== "hosted");
      if (models.length === 0) return { router: baseline(), routerNote: "decision-model-skipped:privacy-mode" };
    }

    const formatOf = (model: DecisionModel): DecisionFormat => (model.modalities.image ? settings.triageFormat : "text-state");
    const triageUsage = (model: DecisionModel, result: Parameters<typeof recordDecisionUsage>[2]) => {
      args.decisionLatency.sumMs += result.latencyMs;
      recordDecisionUsage(state.usageLedger, model, result, { documentId: document.id, role: "triage", format: formatOf(model) });
    };
    // Canary probes are recorded under their own metric and never count toward triage latency.
    const canaryUsage = (model: DecisionModel, result: Parameters<typeof recordDecisionUsage>[2]) => {
      recordDecisionUsage(state.usageLedger, model, result, {
        documentId: document.id,
        role: "canary",
        metric: PAGE_ROUTE_DECISION_CANARY_METRIC,
      });
    };
    const insetUsage = (model: DecisionModel, result: Parameters<typeof recordDecisionUsage>[2]) => {
      args.decisionLatency.sumMs += result.latencyMs;
      args.inset.callMs += result.latencyMs;
      recordDecisionUsage(state.usageLedger, model, result, { documentId: document.id, role: "inset-triage", format: "crop" });
    };
    const makeClient = (onUsage: typeof triageUsage) => this.deps.decisionClient
      ? this.deps.decisionClient({ privacyMode: args.privacyMode, onUsage })
      : createDecisionClient({ privacyMode: args.privacyMode, onUsage });
    const client = makeClient(triageUsage);
    const insetClient = makeClient(insetUsage);
    const history = this.deps.healthHistory === undefined ? getDecisionHealthHistory() : this.deps.healthHistory;
    const canaryBase = makeClient(canaryUsage);
    const canaryClient = history ? withHealthHistory(canaryBase, { history, quarantined: QUARANTINED_DECISION_MODELS }) : canaryBase;
    // Facts line + a short native-text excerpt travel with every thumbnail and text state (W4/TL1).
    const textExcerpts = await this.loadTextExcerpts(state, document);
    const entries: ChainModel[] = models.map((model) => {
      const format = formatOf(model);
      // Image models look at inset crops; text-only models cannot, so pages with insets are not trusted (null).
      const baseGate = model.modalities.image
        ? createInsetGate({ client: insetClient, model, renderPage: args.renderPage, ...(args.renderClip ? { renderClip: args.renderClip } : {}), signal: args.signal })
        : null;
      const insetGate: InsetGate | null = baseGate && {
        model: baseGate.model,
        assess: async (page, candidates) => {
          const started = performance.now();
          try {
            return await baseGate.assess(page, candidates);
          } finally {
            args.inset.wallMs += performance.now() - started;
          }
        },
      };
      return {
        model,
        client,
        insetGate,
        triageOptions: {
          format,
          pagesPerCall: settings.pagesPerCall,
          tileLongEdge: settings.tilePx,
          ...(textExcerpts ? { textExcerpts, excerptChars: format === "text-state" ? TEXT_STATE_EXCERPT_CHARS : CONTENT_EXCERPT_CHARS } : {}),
        },
      };
    });
    const resolved = new Set(args.decisionModels.map((m) => m.id));
    const chain = new DecisionModelChainRouter({
      pack: this.deps.policyPack ?? loadRuntimePolicyPack("decision-model"),
      models: entries,
      unresolved: args.requestedModels.filter((id) => !resolved.has(id)),
      health: this.deps.health ?? decisionModelHealth,
      canaryClient,
      baseline,
      ...(this.deps.embeddingPrefilter ? { prefilter: this.deps.embeddingPrefilter } : {}),
      ...ids,
      config: { disallowedPrivacy },
      signal: args.signal,
    });
    return { router: chain, chain };
  }

  private recordDecisions(
    state: WorkflowState,
    document: Document,
    plan: RoutePlan,
    pages: PageInput[],
    routerNote: string | undefined,
    timing: RoutingTiming,
    chain?: ChainReport,
  ): void {
    const byPage = new Map<number, RoutePlan["assignments"]>();
    for (const assignment of plan.assignments) {
      byPage.set(assignment.pageNumber, [...(byPage.get(assignment.pageNumber) ?? []), assignment]);
    }
    const rejectedByPage = new Map<number, Array<{ targetId: string; reason: string }>>();
    for (const r of plan.rejected) {
      rejectedByPage.set(r.pageNumber, [...(rejectedByPage.get(r.pageNumber) ?? []), { targetId: r.targetId, reason: r.reason }]);
    }
    for (const page of pages) {
      const pageNumber = page.features.pageNumber;
      const assignments = byPage.get(pageNumber) ?? [];
      state.pendingPerformance.push({
        documentId: document.id,
        scope: "page",
        stageName: this.name,
        metric: PAGE_ROUTE_DECISION_METRIC,
        pageNumber,
        value: assignments.reduce((sum, a) => sum + a.estimate.costUsd, 0),
        unit: "usd",
        tags: ["page", "page-router", plan.mode],
        metadata: {
          routerId: plan.routerId,
          routerKind: plan.routerKind,
          policyVersion: plan.policyVersion,
          mode: plan.mode,
          objective: plan.objective,
          assignments: assignments.map((a) => ({
            role: a.role,
            targetId: a.targetId,
            scope: a.scope.kind,
            reason: a.reason.slice(0, 200),
            estimate: a.estimate,
            cascade: a.cascade,
          })),
          estimates: {
            costUsd: assignments.reduce((sum, a) => sum + a.estimate.costUsd, 0),
            latencyMs: assignments.reduce((max, a) => Math.max(max, a.estimate.latencyMs), 0),
            pPass: assignments.length ? Math.min(...assignments.map((a) => a.estimate.pPass)) : null,
          },
          rejected: rejectedByPage.get(pageNumber) ?? [],
          chunkEstimate: plan.chunkEstimate,
          trustRule: freeTrustVerdict(page).reason,
          timing: timing.perPageMs,
          decisionServedBy: chain
            ? chain.servedBy === null
              ? plan.routerKind
              : !page.features.decisions && hasHealthyTextLayer(page) ? "free-shortcut" : chain.servedBy
            : plan.routerKind,
          ...(chain ? { decisionChain: chain.trace } : {}),
          ...(routerNote ? { routerNote } : {}),
        },
      });
    }
    state.pendingPerformance.push({
      documentId: document.id,
      scope: "document",
      stageName: this.name,
      metric: PAGE_ROUTE_TIMING_METRIC,
      value: timing.totalMs,
      unit: "ms",
      tags: ["document", "page-router", "latency", plan.mode],
      metadata: { routerId: plan.routerId, ...timing },
    });
    state.pendingPerformance.push({
      documentId: document.id,
      scope: "document",
      stageName: this.name,
      metric: PAGE_ROUTE_CHUNK_ESTIMATE_METRIC,
      value: plan.chunkEstimate.totalCostUsd,
      unit: "usd",
      tags: ["document", "page-router", plan.mode],
      metadata: {
        routerId: plan.routerId,
        routerKind: plan.routerKind,
        policyVersion: plan.policyVersion,
        mode: plan.mode,
        objective: plan.objective,
        pages: pages.length,
        assignments: plan.assignments.length,
        chunkEstimate: plan.chunkEstimate,
        triage: plan.triage,
        verifier: plan.verifier,
        decisionModelCalls: plan.decisionModelCalls.length,
        timing,
        ...(chain ? { decisionModel: chain.servedBy, decisionChain: chain.trace } : {}),
        ...(routerNote ? { routerNote } : {}),
      },
    });
  }

  private async loadClassification(state: WorkflowState, document: Document): Promise<AdaptiveRoutingArtifact | null> {
    const uri = state.artifactLedger.readDocument(document.id, "classification");
    const key = uri ? keyFromStorageUri(uri, this.storage.bucket) : null;
    if (!key) return null;
    try {
      const parsed = adaptiveRoutingDecisionSurfaceSchema.safeParse(await this.storage.getJson<unknown>(key));
      return parsed.success && parsed.data.status === "ready" ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Native text-layer excerpts per page for text-only decision models. */
  private async loadTextExcerpts(state: WorkflowState, document: Document): Promise<Map<number, string> | undefined> {
    const uri = state.artifactLedger.readDocument(document.id, "canonical-document");
    const key = uri ? keyFromStorageUri(uri, this.storage.bucket) : null;
    if (!key) return undefined;
    try {
      const json = (await this.storage.getJson<unknown>(key)) as {
        blocks?: Array<{ text?: string; pageNumber?: number | null; order?: number }>;
      } | null;
      if (!Array.isArray(json?.blocks)) return undefined;
      const perPage = new Map<number, string[]>();
      for (const block of [...json.blocks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
        if (!block.text || typeof block.pageNumber !== "number") continue;
        perPage.set(block.pageNumber, [...(perPage.get(block.pageNumber) ?? []), block.text]);
      }
      return new Map([...perPage].map(([page, texts]) => [page, texts.join("\n").slice(0, TEXT_STATE_EXCERPT_CHARS)]));
    } catch {
      return undefined;
    }
  }
}

async function openNativePdfDocument(pdfPath: string, signal?: AbortSignal): Promise<NativePdfDocument | null> {
  const loaded = await loadNativePdfEngine();
  return loaded.ok ? loaded.engine.openPath(pdfPath, { signal }) : null;
}

import {
  type DecisionAnswers,
  type DecisionModel,
  type DecisionModelCall,
  type PageInput,
  type PolicyPack,
  type RoutePlan,
  type Router,
  type RoutingBudget,
  type RoutingObjective,
  type RoutingTarget,
} from "@docslurp/shared";
import { aiBilledUsd, estimateRouterCost } from "../estimate.js";
import {
  DEFAULT_PLANNER_CONFIG,
  assemblePlan,
  needsFromDecisions,
  MATH_GATED_TRUST,
  needsFromFeatures,
  planPages,
  type PageNeeds,
  type PlannerConfig,
} from "../planner.js";
import { calibrateAnswers, createPolicyEstimator, indexCalibrations } from "../policy.js";
import {
  CONTENT_QUESTION_IDS,
  createTriage,
  shouldTriage,
  type Triage,
  type TriageOptions,
} from "../triage.js";
import type { DecisionClient } from "../decision-client.js";
import { insetVerdict, withInsetAssessments, type InsetGate } from "../inset-gate.js";
import type { InsetTriageResult } from "../inset-triage.js";
import { TRUST_RULE, freeTrustVerdict, insetGateCandidates } from "../trust.js";
import { isUncertain, type EmbeddingPrefilter } from "./embedding-prefilter.js";

/** Thrown (instead of being swallowed) when `failOnTriageError` is set; carries the calls already billed. */
export class RouterTriageError extends Error {
  constructor(
    readonly modelId: string,
    readonly cause: unknown,
    readonly calls: DecisionModelCall[],
    readonly costUsd: number,
  ) {
    super(`${modelId} triage failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "RouterTriageError";
  }
}

export interface DecisionModelRouterOptions {
  pack: PolicyPack;
  /** Full catalog entry of the triage model (pricing, limits). */
  model: DecisionModel;
  /** Either a client (W6 createTriage is used) or a ready-made Triage (tests). */
  client?: DecisionClient;
  triage?: Triage;
  /** Passed through to Triage.triagePages (format, pagesPerCall, thumbnails, excerpts, ...). */
  triageOptions?: Omit<TriageOptions, "onCall">;
  id?: string;
  documentId?: string;
  runId?: string;
  config?: Partial<PlannerConfig>;
  /** Skip the decision model for pages whose free features already prove a healthy text layer. */
  freeShortcut?: boolean;
  /**
   * Rethrow triage failures (as RouterTriageError) instead of degrading to free features, so a
   * fallback chain can move on to the next model. Default false: fail soft to free features.
   */
  failOnTriageError?: boolean;
  /** Awaited right before the first model call, only when triage will actually run (e.g. the health canary). */
  beforeTriage?: () => Promise<void>;
  /** Billed calls of earlier chain attempts for this document; folded into this plan's totals. */
  carry?: { calls: DecisionModelCall[]; costUsd: number };
  /** Fraction of the chunk budget the router itself may spend before triage is skipped. */
  maxRouterBudgetShare?: number;
  /**
   * Inset gate (TL1 + TL2). `undefined`: no gate, pages with 2-85% insets are never certain and go to the
   * content questions. `null`: the serving model cannot see images, pages with such insets are not trusted.
   */
  insetGate?: InsetGate | null;
  /** Optional embedding pre-filter: pages the probe is confident about never reach the paid model. */
  prefilter?: EmbeddingPrefilter;
  /** Ask the minimal content question set (default true); false asks every attribute question (legacy). */
  contentQuestions?: boolean;
}

/** Healthy body text: enough words, plausible glyph mapping, no table rules (independent of status and images). */
export function hasHealthyBody(page: PageInput): boolean {
  const f = page.features;
  return (
    f.native.wordCount >= 150 &&
    !f.native.garbled &&
    f.native.plausibility >= 0.9 &&
    f.native.mathGlyphRatio < TRUST_RULE.mathGlyphRatio &&
    f.native.tableRuleScore < 1 &&
    f.native.unmappedGlyphRatio < 0.02
  );
}

/** Free shortcut: born-digital prose with a healthy text layer needs no model and no render. */
export function hasHealthyTextLayer(page: PageInput): boolean {
  return page.textFacts.textLayerStatus === "ok" && page.images.length === 0 && hasHealthyBody(page);
}

/** Pages the trust cascade accepts need no content question when the body is healthy and every inset was cleared. */
function bodyIsPlainProse(page: PageInput): boolean {
  const f = page.features;
  return (
    f.native.wordCount >= 150 &&
    !f.native.garbled &&
    f.native.mathGlyphRatio < TRUST_RULE.mathGlyphRatio &&
    f.native.tableRuleScore < 1 &&
    f.native.unmappedGlyphRatio < 0.02 &&
    (page.textFacts.textLayerStatus === "ocr-layer" || f.native.plausibility >= 0.9)
  );
}

interface PageGate {
  /** Inset triage result when the gate ran for this page. */
  result: InsetTriageResult | null;
  /** The page carried gate candidates but the gate could not clear them (no image model, failure, over budget). */
  unverified: boolean;
  /** An inset must be transcribed: not accept-text-only. */
  transcribes: boolean;
}

export class DecisionModelRouter implements Router {
  readonly kind = "decision-model" as const;
  readonly id: string;
  private readonly triage: Triage;
  constructor(private readonly o: DecisionModelRouterOptions) {
    this.id = o.id ?? `decision-model:${o.model.id}`;
    if (o.triage) this.triage = o.triage;
    else if (o.client) this.triage = createTriage({ client: o.client, model: o.model });
    else throw new Error("DecisionModelRouter needs a client or a triage");
  }

  async plan(
    pages: PageInput[],
    catalog: RoutingTarget[],
    budget: RoutingBudget,
    objective: RoutingObjective,
  ): Promise<RoutePlan> {
    const cfg: PlannerConfig = { ...DEFAULT_PLANNER_CONFIG, ...this.o.config };
    const calIndex = indexCalibrations(this.o.pack);
    const shortcut = this.o.freeShortcut ?? true;
    const content = this.o.contentQuestions ?? true;
    const questionIds = content ? CONTENT_QUESTION_IDS : undefined;
    const needsByIndex: Array<PageNeeds | undefined> = new Array(pages.length);
    const gates = new Map<number, PageGate>();
    const tOpts: Omit<TriageOptions, "onCall"> = {
      ...(content ? { questionIds: CONTENT_QUESTION_IDS, imageKindQuestions: false } : {}),
      ...(this.o.triageOptions ?? {}),
    };
    let routerCost = this.o.carry?.costUsd ?? 0;
    const calls: DecisionModelCall[] = [...(this.o.carry?.calls ?? [])];
    const failStep = (err: unknown): never => {
      throw new RouterTriageError(this.o.model.id, err, calls.slice(this.o.carry?.calls.length ?? 0), routerCost - (this.o.carry?.costUsd ?? 0));
    };
    let modelCalled = false;
    let beforeDone = false;
    const before = async () => {
      if (beforeDone) return;
      beforeDone = true;
      await this.o.beforeTriage?.();
    };

    // 1. Free trust cascade + pages that already carry decision answers.
    const trusted = new Map<number, boolean>();
    const pendingIdx: number[] = [];
    pages.forEach((p, i) => {
      if (p.features.decisions) {
        const probs = calibrateAnswers(calIndex, p.features.decisions);
        needsByIndex[i] = needsFromDecisions(p, p.features.decisions, probs, cfg);
        return;
      }
      trusted.set(i, freeTrustVerdict(p).trusted);
      pendingIdx.push(i);
    });

    // 2. Inset gate: only where a "yes" changes the plan, i.e. text-layer-trusted pages with 2-85% insets.
    const gate = this.o.insetGate;
    const gatePages = pendingIdx.filter((i) => trusted.get(i) && insetGateCandidates(pages[i]!).length > 0);
    let skippedReason: string | undefined;
    if (gate !== undefined && gatePages.length > 0) {
      const insetCount = gatePages.reduce((n, i) => n + insetGateCandidates(pages[i]!).length, 0);
      const insetEstimate = estimateRouterCost({
        model: gate?.model ?? this.o.model,
        pages: insetCount,
        questionsPerPage: 1,
        pagesPerCall: 1,
        tilePx: 384,
      });
      const share = this.o.maxRouterBudgetShare ?? 0.25;
      const overBudget = insetEstimate.costUsd > budget.limitUsd * share;
      for (const i of gatePages) gates.set(i, { result: null, unverified: true, transcribes: false });
      if (gate !== null && !overBudget) {
        try {
          await before();
          let next = 0;
          const worker = async () => {
            while (next < gatePages.length) {
              const i = gatePages[next++]!;
              const page = pages[i]!;
              const result = await gate.assess(page, insetGateCandidates(page));
              if (!result) continue;
              modelCalled = true;
              const costUsd = result.costCents / 100;
              routerCost += costUsd;
              calls.push({
                model: gate.model.id,
                stage: "triage",
                questions: [`page-${page.features.pageNumber}-insets`],
                inputTokens: result.usage.inputTokens,
                costUsd,
              });
              const verdict = insetVerdict(result);
              gates.set(i, { result, unverified: false, transcribes: !verdict.canAcceptTextOnly });
            }
          };
          await Promise.all(Array.from({ length: Math.min(3, gatePages.length) }, worker));
        } catch (err) {
          if (this.o.failOnTriageError) failStep(err);
          skippedReason = `inset-gate-failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
        }
      } else if (overBudget) {
        skippedReason = "router-over-budget";
      }
    }

    // 3. Pages the free rules and the inset gate settle need no content question.
    const toTriage: number[] = [];
    for (const i of pendingIdx) {
      const p = pages[i]!;
      const g = gates.get(i);
      const insetCleared = insetGateCandidates(p).length === 0 || (g !== undefined && !g.unverified && !g.transcribes);
      if (shortcut && trusted.get(i) && insetCleared && bodyIsPlainProse(p)) {
        const n = this.applyGate(needsFromFeatures(p, cfg), g);
        needsByIndex[i] = { ...n, pTrustTextLayer: Math.max(n.pTrustTextLayer, 0.9), source: "heuristic" };
      } else {
        toTriage.push(i);
      }
    }

    // 4. Optional embedding pre-filter: confident pages skip the paid model.
    let uncertain = toTriage;
    const pre = this.o.prefilter;
    if (pre && toTriage.length > 0) {
      try {
        const probes = await pre.provider(toTriage.map((i) => pages[i]!));
        uncertain = [];
        for (const i of toTriage) {
          const page = pages[i]!;
          const probe = probes.get(page.features.pageNumber);
          if (!probe || isUncertain(probe.probabilities, pre.band, CONTENT_QUESTION_IDS)) {
            uncertain.push(i);
            continue;
          }
          routerCost += probe.costUsd ?? 0;
          const answers: DecisionAnswers = {
            probabilities: probe.probabilities,
            choices: {},
            source: { decisionModel: pre.model.id, format: "per-page", pagesPerCall: 1, tilePx: pre.model.tilePx },
          };
          needsByIndex[i] = this.applyGate(
            needsFromDecisions(page, answers, calibrateAnswers(calIndex, answers), cfg),
            gates.get(i),
          );
        }
      } catch {
        uncertain = toTriage; // a failing pre-filter only costs the saving
      }
    }

    // 5. Content questions on the pages still uncertain (skip rules: nothing to look at, or over budget).
    const subset = uncertain.map((i) => pages[i]!);
    const triageGate = shouldTriage(subset);
    const pre0 = estimateRouterCost({
      model: this.o.model,
      pages: subset.length,
      questionsPerPage: questionIds?.length ?? 13,
      pagesPerCall: tOpts.pagesPerCall ?? 9,
      tilePx: this.o.model.modalities.image ? (tOpts.tileLongEdge ?? 384) : null,
    });
    const share = this.o.maxRouterBudgetShare ?? 0.25;
    let triageSkipped: string | undefined;
    if (!triageGate.triage) triageSkipped = triageGate.reason;
    else if (pre0.costUsd > budget.limitUsd * share) triageSkipped = "router-over-budget";

    let format: RoutePlan["triage"]["format"] = null;
    let pagesPerCall: number | null = null;
    let triageRan = false;
    if (!triageSkipped) {
      try {
        await before();
        const answers = await this.triage.triagePages(subset, {
          ...tOpts,
          onCall: (result, info) => {
            const costUsd = result.costCents / 100;
            routerCost += costUsd;
            calls.push({
              model: info.model.id,
              stage: "triage",
              questions: info.pages.map((n) => `page-${n}`),
              inputTokens: result.usage.inputTokens,
              costUsd,
            });
          },
        });
        triageRan = true;
        modelCalled = true;
        for (const pi of uncertain) {
          const page = pages[pi]!;
          const a: DecisionAnswers | null = answers.get(page.features.pageNumber) ?? null;
          if (a) {
            format = a.source.format;
            pagesPerCall = a.source.pagesPerCall;
          }
          needsByIndex[pi] = this.applyGate(needsFromDecisions(page, a, calibrateAnswers(calIndex, a), cfg), gates.get(pi));
        }
      } catch (err) {
        if (this.o.failOnTriageError) failStep(err);
        triageSkipped = `triage-failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
        // Calls already billed before the failure still count (routerCost accumulated via onCall).
      }
    }
    pages.forEach((p, i) => {
      needsByIndex[i] ??= this.applyGate(needsFromFeatures(p, cfg), gates.get(i));
    });
    const ran = triageRan || modelCalled;
    if (!ran) skippedReason = triageSkipped ?? skippedReason;
    else if (triageSkipped && !triageRan && !skippedReason) skippedReason = triageSkipped;

    const { planned, rejected, attention } = planPages({
      needs: needsByIndex as PageNeeds[],
      pages,
      catalog,
      objective,
      estimator: createPolicyEstimator(this.o.pack, { decisionModel: this.o.model.id }),
      config: this.o.config,
    });
    return assemblePlan({
      documentId: this.o.documentId ?? "unknown-document",
      runId: this.o.runId ?? "unknown-run",
      routerId: this.id,
      routerKind: this.kind,
      objective,
      policyVersion: this.o.pack.metadata.policyVersion,
      planned,
      rejected,
      attention,
      budget,
      decisionModelCalls: calls,
      triage: {
        ran,
        ...(skippedReason ? { skippedReason } : {}),
        decisionModel: this.o.model.id,
        format,
        pagesPerCall,
        costUsd: routerCost,
      },
      routerCost: { costUsd: routerCost, billedUsd: aiBilledUsd(routerCost) },
      catalog,
      concurrency: cfg.concurrency,
    }).plan;
  }

  /** Applies the inset gate to a page's needs: cleared insets become image-scoped needs, anything else stops accept-text-only. */
  private applyGate(needs: PageNeeds, gate: PageGate | undefined): PageNeeds {
    if (!gate) return needs;
    let out = needs;
    if (gate.result) out = withInsetAssessments(out, gate.result.assessments);
    if (gate.unverified || gate.transcribes) {
      out = { ...out, pTrustTextLayer: Math.min(out.pTrustTextLayer, MATH_GATED_TRUST) };
    }
    return out;
  }
}


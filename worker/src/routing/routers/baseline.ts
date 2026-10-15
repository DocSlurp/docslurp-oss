import type {
  BetaPosterior,
  DecisionModelCall,
  PageInput,
  PassProbabilities,
  PolicyBaseline,
  PolicyCell,
  PolicyFeaturePredicate,
  PolicyPack,
  RoutePlan,
  Router,
  RoutingBudget,
  RoutingObjective,
  RoutingTarget,
} from "@docslurp/shared";
import { aiBilledUsd, estimateTargetCost } from "../estimate.js";
import { DEFAULT_PLANNER_CONFIG as DEFAULTS, assemblePlan, needsFromFeatures, planPages, type PlannerConfig } from "../planner.js";
import {
  buildScoredEstimate,
  createPolicyEstimator,
  dimensionForRole,
  type TargetEstimator,
} from "../policy.js";

// No-model baseline: Beta-cell posteriors per (cell x target), selected with a
// pessimistic lower bound. Kept only as the baseline the decision-model router must beat.
// Tolerates a pack without a `baseline` block by falling back to the pack's target priors.

const MIN_CELL_N = 5;

export function getFeature(page: PageInput, path: string): unknown {
  let cur: unknown = page.features;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function predicateMatches(page: PageInput, p: PolicyFeaturePredicate): boolean {
  const v = getFeature(page, p.feature);
  if (v === undefined) return false;
  const x = p.value;
  switch (p.op) {
    case "eq": return v === x;
    case "neq": return v !== x;
    case "lt": return typeof v === "number" && typeof x === "number" && v < x;
    case "lte": return typeof v === "number" && typeof x === "number" && v <= x;
    case "gt": return typeof v === "number" && typeof x === "number" && v > x;
    case "gte": return typeof v === "number" && typeof x === "number" && v >= x;
    case "in": return Array.isArray(x) && (x as Array<string | number>).includes(v as string | number);
  }
}

const betaMean = (b: BetaPosterior) => b.alpha / (b.alpha + b.beta);

export class BaselineCells {
  private readonly cells: Map<string, PolicyCell>;
  private readonly stats: Map<string, PolicyBaseline["stats"][number]>;
  private readonly depth = new Map<string, number>();
  constructor(readonly baseline: PolicyBaseline) {
    this.cells = new Map(baseline.cells.map((c) => [c.id, c]));
    this.stats = new Map(baseline.stats.map((s) => [`${s.cellId}|${s.targetId}`, s]));
  }
  private depthOf(id: string, seen = new Set<string>()): number {
    const cached = this.depth.get(id);
    if (cached !== undefined) return cached;
    const c = this.cells.get(id);
    if (!c || seen.has(id)) return 0;
    seen.add(id);
    const d = c.parentId ? 1 + this.depthOf(c.parentId, seen) : 0;
    this.depth.set(id, d);
    return d;
  }
  /** Most specific cell whose predicates all match. */
  cellFor(page: PageInput): PolicyCell | undefined {
    let best: PolicyCell | undefined;
    let bestDepth = -1;
    for (const c of this.cells.values()) {
      if (!c.predicates.every((p) => predicateMatches(page, p))) continue;
      const d = this.depthOf(c.id);
      if (d > bestDepth) { best = c; bestDepth = d; }
    }
    return best;
  }
  /** Walks parent links until a cell has >= MIN_CELL_N observations for the target. */
  statsFor(cell: PolicyCell | undefined, targetId: string) {
    let cur = cell;
    let last;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const s = this.stats.get(`${cur.id}|${targetId}`);
      if (s) { last = s; if (s.n >= MIN_CELL_N) return s; }
      cur = cur.parentId ? this.cells.get(cur.parentId) : undefined;
    }
    return last;
  }
}

function betaLowerBound(b: BetaPosterior, z = 1.2816): number {
  const n = b.alpha + b.beta;
  const m = betaMean(b);
  return Math.max(0, m - z * Math.sqrt((m * (1 - m)) / (n + 1)));
}

export function createBaselineEstimator(pack: PolicyPack): TargetEstimator {
  const prior = createPolicyEstimator(pack);
  if (!pack.baseline) return prior;
  const cells = new BaselineCells(pack.baseline);
  return (ctx) => {
    const stats = cells.statsFor(cells.cellFor(ctx.page), ctx.target.id);
    if (!stats) return prior({ ...ctx, probs: {} });
    const cost = estimateTargetCost(ctx.target, ctx.role, ctx.scope, ctx.page);
    if (!cost.priced && stats.n > 0) {
      cost.costUsd = stats.cost.meanUsd;
      cost.latencyP50Ms = stats.latency.p50Ms || cost.latencyP50Ms;
      cost.latencyP95Ms = stats.latency.p95Ms || cost.latencyP95Ms;
    }
    const pPass: PassProbabilities = {
      text: betaMean(stats.pass.text),
      math: betaMean(stats.pass.math),
      tables: betaMean(stats.pass.tables),
      overall: betaMean(stats.pass.overall),
    };
    const dim = dimensionForRole(ctx.role);
    const est = buildScoredEstimate({ targetId: ctx.target.id, pPass, n: stats.n, dim, cost, calibrationBucket: `cell:${stats.cellId}` });
    // Use the exact Beta lower bound for the selected dimension.
    est.pPassLowerBound = {
      text: betaLowerBound(stats.pass.text),
      math: betaLowerBound(stats.pass.math),
      tables: betaLowerBound(stats.pass.tables),
      overall: betaLowerBound(stats.pass.overall),
    };
    return est;
  };
}

export interface BaselineRouterOptions {
  pack: PolicyPack;
  id?: string;
  documentId?: string;
  runId?: string;
  config?: Partial<PlannerConfig>;
  /** Decision-model spend already incurred for this document before falling back to the baseline. */
  carry?: { calls: DecisionModelCall[]; costUsd: number; skippedReason: string };
}

export class BaselineRouter implements Router {
  readonly kind = "baseline" as const;
  readonly id: string;
  private readonly estimator: TargetEstimator;
  constructor(private readonly opts: BaselineRouterOptions) {
    this.id = opts.id ?? "baseline:beta-cells";
    this.estimator = createBaselineEstimator(opts.pack);
  }
  get hasBaselineCells(): boolean {
    return !!this.opts.pack.baseline;
  }

  async plan(
    pages: PageInput[],
    catalog: RoutingTarget[],
    budget: RoutingBudget,
    objective: RoutingObjective,
  ): Promise<RoutePlan> {
    const needs = pages.map((p) => needsFromFeatures(p, { ...DEFAULTS, ...this.opts.config } as PlannerConfig));
    const { planned, rejected, attention } = planPages({
      needs, pages, catalog, objective, estimator: this.estimator, config: this.opts.config,
    });
    return assemblePlan({
      documentId: this.opts.documentId ?? "unknown-document",
      runId: this.opts.runId ?? "unknown-run",
      routerId: this.id,
      routerKind: this.kind,
      objective,
      policyVersion: `${this.opts.pack.metadata.policyVersion}${this.hasBaselineCells ? "" : "+no-baseline-cells"}`,
      planned,
      rejected,
      attention,
      budget,
      catalog,
      ...(this.opts.carry
        ? {
            decisionModelCalls: this.opts.carry.calls,
            routerCost: { costUsd: this.opts.carry.costUsd, billedUsd: aiBilledUsd(this.opts.carry.costUsd) },
            triage: { ran: false, skippedReason: this.opts.carry.skippedReason.slice(0, 1200), costUsd: this.opts.carry.costUsd },
          }
        : {}),
    }).plan;
  }
}

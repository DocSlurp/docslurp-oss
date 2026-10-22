import {
  CREDIT_RATE_CARD,
  creditsToDollars,
  slotCreditsPerHour,
  slotInfraUsdPerHour,
  type Assignment,
  type AssignmentRole,
  type AssignmentScope,
  type ChunkEstimate,
  type DecisionModel,
  type OverBudgetAction,
  type PageInput,
  type RoutingBudget,
  type RoutingTarget,
} from "@docslurp/shared";

// ---------------------------------------------------------------------------
// Cost / latency estimation and the budget guard.
//
// COST MODEL
//   Hosted VLM targets: provider list cost = (inputTokens * in + outputTokens * out) / 1e6,
//   with tokens from the explicit assumptions below (image tokens come from
//   the catalog `imageTokensPerImage` when present).
//   Local / private compute targets: cost = hourlyUsd / 60 / pagesPerMinute when the
//   catalog observed both; otherwise seconds-per-page assumption * infra $/second
//   (worker slot from infra-costs.ts for CPU targets, GPU hourly assumption for GPU targets).
//   Decision models bill input tokens only: thumbnail tiles (~1 token per 1000 px,
//   i.e. ~1000 tok/MP) + facts text + per-call question overhead amortised over pages.
//
// MARGIN MODEL (billing.ts)
//   DocSlurp bills credits at list rate (CREDIT_RATE_CARD): AI provider cost is billed
//   at cost * (1 + aiMarkupPercent/100); CPU/memory/GPU compute is billed per second
//   at the card rate (a worker slot = slotCreditsPerHour). So for every priced unit we
//   know both the *cost* we incur and the *billed* amount (`billedUsd`). The margin of
//   a chunk is 1 - totalCost / totalBilled; budget.marginFloor is the minimum allowed.
//   Hosted AI is only marked up 20% (16.7% margin), so a high floor pushes the
//   guard toward local compute; the router's own decision-model calls count as AI
//   spend at the same markup. Storage/egress and the per-document baseline pipeline
//   fee are outside the routing decision and excluded.
// ---------------------------------------------------------------------------

export const ESTIMATE_ASSUMPTIONS = {
  /** Used when the catalog has no imageTokensPerImage (≈1 MP page at ~1000 tok/MP). */
  defaultImageTokensPerImage: 1100,
  promptTokens: 250,
  /** Output tokens by role when the page word count is unknown. */
  outputTokensByRole: {
    "accept-text": 0,
    "extract-text": 900,
    ocr: 900,
    table: 800,
    "table-region": 400,
    math: 800,
    "chart-data": 500,
    diagram: 400,
    "image-label": 60,
    skip: 0,
  } as Record<AssignmentRole, number>,
  tokensPerWord: 1.4,
  maxTextOutputTokens: 3000,
  /** Fallback seconds of one worker slot per page for unobserved local targets. */
  localSecondsPerPage: {
    native: 0.3,
    "accept-text": 0.02,
    "local-ocr": 1.5,
    "local-labeler": 1.0,
    "private-vlm": 1.2,
  } as Record<string, number>,
  /** 24 GB-class GPU hourly infra assumption for private/local GPU targets lacking hourlyUsd. */
  gpuHourlyUsd: 0.45,
  /** Fallback p50 latency by target kind when the catalog has no measurement. */
  latencyMsByKind: {
    native: 40,
    "local-ocr": 900,
    "local-labeler": 600,
    "private-vlm": 2500,
    "hosted-vlm": 4000,
    skip: 0,
  } as Record<string, number>,
  p95OverP50: 2.2,
  /** Decision-model state: pixels per input token (~1000 tok/MP). */
  pixelsPerImageToken: 1000,
  factsTokensPerPage: 40,
  questionTokens: 18,
} as const;

const AI_MULTIPLIER = 1 + CREDIT_RATE_CARD.aiMarkupPercent / 100;
const slotCostUsdPerSec = () => slotInfraUsdPerHour() / 3600;
const slotBilledUsdPerSec = () => creditsToDollars(slotCreditsPerHour()) / 3600;
const gpuBilledUsdPerSec = () =>
  creditsToDollars(CREDIT_RATE_CARD.gpuStandardHour) / 3600;

export interface CostBreakdown {
  costUsd: number;
  billedUsd: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  /** False when the target had no pricing basis and an assumption was used. */
  priced: boolean;
}

/** Observed/estimated corrections fed back from validation (ratio actual / estimate). */
export type EstimateCorrections = Record<
  string,
  { cost?: number; latency?: number }
>;

export function pageOutputTokens(role: AssignmentRole, page?: PageInput): number {
  const base = ESTIMATE_ASSUMPTIONS.outputTokensByRole[role] ?? 0;
  const words = page?.textFacts.wordCount ?? page?.features.native.wordCount;
  if (
    (role === "extract-text" || role === "ocr" || role === "table" || role === "math") &&
    words &&
    words > 0
  ) {
    return Math.min(
      ESTIMATE_ASSUMPTIONS.maxTextOutputTokens,
      Math.max(300, Math.round(words * ESTIMATE_ASSUMPTIONS.tokensPerWord)),
    );
  }
  return base;
}

function scopeImageFraction(scope: AssignmentScope, page?: PageInput): number {
  if (scope.kind === "page") return 1;
  if (scope.kind === "region") return 0.5;
  const cov = page?.images.find((i) => i.index === scope.imageIndex)?.coverage;
  return Math.min(1, Math.max(0.25, cov ?? 0.5));
}

export function estimateTargetCost(
  target: RoutingTarget,
  role: AssignmentRole,
  scope: AssignmentScope,
  page?: PageInput,
  corrections?: EstimateCorrections,
): CostBreakdown {
  const A = ESTIMATE_ASSUMPTIONS;
  let costUsd = 0;
  let billedUsd = 0;
  let priced = true;
  const pr = target.pricing;
  let seconds = 0;

  if (target.kind === "skip") {
    // free
  } else if (target.kind === "hosted-vlm") {
    const imgTok = (pr.imageTokensPerImage ?? A.defaultImageTokensPerImage) * scopeImageFraction(scope, page);
    const inTok = imgTok + A.promptTokens;
    const outTok = pageOutputTokens(role, page);
    if (pr.inputUsdPerMTok === undefined || pr.outputUsdPerMTok === undefined) priced = false;
    costUsd = (inTok * (pr.inputUsdPerMTok ?? 0) + outTok * (pr.outputUsdPerMTok ?? 0)) / 1e6;
    billedUsd = costUsd * AI_MULTIPLIER;
  } else {
    const ppm = pr.pagesPerMinuteObserved;
    seconds =
      ppm && ppm > 0
        ? 60 / ppm
        : (A.localSecondsPerPage[
            target.kind === "native" && role === "accept-text" ? "accept-text" : target.kind
          ] ?? 1) * (scope.kind === "page" ? 1 : scopeImageFraction(scope, page));
    const gpu = target.kind === "private-vlm" || target.kind === "local-labeler";
    if (pr.hourlyUsd !== undefined && ppm && ppm > 0) {
      costUsd = pr.hourlyUsd / 60 / ppm;
    } else if (gpu && target.kind === "private-vlm") {
      priced = pr.hourlyUsd !== undefined;
      costUsd = (pr.hourlyUsd ?? A.gpuHourlyUsd) * (seconds / 3600);
    } else {
      priced = target.kind === "native" || target.kind === "local-ocr" || target.kind === "local-labeler";
      costUsd = seconds * slotCostUsdPerSec();
    }
    billedUsd =
      target.kind === "private-vlm"
        ? seconds * gpuBilledUsdPerSec()
        : seconds * slotBilledUsdPerSec();
  }

  const measured = target.latency.n > 0;
  let p50 = measured ? target.latency.p50Ms : (A.latencyMsByKind[target.kind] ?? 1000);
  if (!measured && seconds > 0 && target.kind !== "native") p50 = Math.max(p50, seconds * 1000);
  let p95 = measured && target.latency.p95Ms > 0 ? target.latency.p95Ms : p50 * A.p95OverP50;

  const corr = corrections?.[target.id];
  if (corr?.cost) {
    costUsd *= corr.cost;
    billedUsd = Math.max(billedUsd, 0); // billing is list-rate; unaffected by cost error
  }
  if (corr?.latency) {
    p50 *= corr.latency;
    p95 *= corr.latency;
  }
  return { costUsd, billedUsd, latencyP50Ms: p50, latencyP95Ms: p95, priced };
}

// ---- Router (decision model) cost ----------------------------------------

export interface RouterCostInput {
  model: Pick<DecisionModel, "pricing" | "maxQuestionsPerRequest"> & Partial<Pick<DecisionModel, "billingMode">>;
  pages: number;
  questionsPerPage: number;
  pagesPerCall: number;
  /** Thumbnail edge in px; null for text-state calls. */
  tilePx: number | null;
  /** Average text-state excerpt tokens per page (text-only models). */
  textExcerptTokensPerPage?: number;
}

export function estimateRouterCost(input: RouterCostInput): {
  inputTokens: number;
  calls: number;
  costUsd: number;
  billedUsd: number;
} {
  const A = ESTIMATE_ASSUMPTIONS;
  const pages = Math.max(0, input.pages);
  const perPageImage =
    input.tilePx === null ? 0 : (input.tilePx * input.tilePx * 0.77) / A.pixelsPerImageToken;
  const perPage = perPageImage + A.factsTokensPerPage + (input.textExcerptTokensPerPage ?? 0);
  const callLimitPages = Math.max(
    1,
    Math.min(
      input.pagesPerCall,
      Math.floor(input.model.maxQuestionsPerRequest / Math.max(1, input.questionsPerPage)),
    ),
  );
  const calls = Math.ceil(pages / callLimitPages);
  // per-question billing (pplx-decider, d1) re-bills the state tokens for every question asked.
  const stateRepeats = input.model.billingMode === "per-question" ? Math.max(1, input.questionsPerPage) : 1;
  const inputTokens = Math.round(
    pages * (perPage * stateRepeats + input.questionsPerPage * A.questionTokens) + calls * 60,
  );
  const costUsd = (inputTokens * input.model.pricing.inputUsdPerMTok) / 1e6;
  return { inputTokens, calls, costUsd, billedUsd: costUsd * AI_MULTIPLIER };
}

export const aiBilledUsd = (costUsd: number): number => costUsd * AI_MULTIPLIER;

// ---- Chunk estimate -------------------------------------------------------

export interface Alternative {
  targetId: string;
  costUsd: number;
  billedUsd: number;
  latencyMs: number;
  latencyP95Ms: number;
  pPass: number;
  pPassLowerBound: number;
}

/** An assignment plus the side data the guard and chunk estimator need. */
export interface PlannedAssignment {
  assignment: Assignment;
  billedUsd: number;
  latencyP95Ms: number;
  /** Primary leg alone (no cascade expectation). */
  primary: Alternative;
  /** Capable alternatives (any cost); the guard picks cheaper ones. */
  alternatives: Alternative[];
  /** Expected cost/latency of the cascade leg, already folded into the assignment estimate. */
  cascade?: Alternative;
}

export function margin(costUsd: number, billedUsd: number): number {
  if (billedUsd <= 0) return costUsd <= 0 ? 1 : 0;
  return 1 - costUsd / billedUsd;
}

export function estimateChunk(
  planned: readonly PlannedAssignment[],
  router: { costUsd: number; billedUsd: number; latencyMs?: number },
  budget: RoutingBudget,
  overBudgetActions: OverBudgetAction[] = [],
  concurrency = 4,
): ChunkEstimate & { billedUsd: number; margin: number } {
  let extraction = 0;
  let billed = router.billedUsd;
  const perPage = new Map<number, { p50: number; p95: number }>();
  let work50 = 0;
  let work95 = 0;
  for (const p of planned) {
    extraction += p.assignment.estimate.costUsd;
    billed += p.billedUsd;
    const e = perPage.get(p.assignment.pageNumber) ?? { p50: 0, p95: 0 };
    e.p50 += p.assignment.estimate.latencyMs;
    e.p95 += p.latencyP95Ms;
    perPage.set(p.assignment.pageNumber, e);
    work50 += p.assignment.estimate.latencyMs;
    work95 += p.latencyP95Ms;
  }
  let maxPage50 = 0;
  let maxPage95 = 0;
  for (const e of perPage.values()) {
    if (e.p50 > maxPage50) maxPage50 = e.p50;
    if (e.p95 > maxPage95) maxPage95 = e.p95;
  }
  const c = Math.max(1, concurrency);
  const routerMs = router.latencyMs ?? 0;
  const total = router.costUsd + extraction;
  return {
    routerCostUsd: router.costUsd,
    extractionCostUsd: extraction,
    totalCostUsd: total,
    latencyP50Ms: routerMs + Math.max(maxPage50, work50 / c),
    latencyP95Ms: routerMs + Math.max(maxPage95, work95 / c),
    budget,
    overBudgetActions,
    billedUsd: billed,
    margin: margin(total, billed),
  };
}

// ---- Budget guard ---------------------------------------------------------

export interface GuardAction {
  action: OverBudgetAction;
  pageNumber: number;
  role: AssignmentRole;
  fromTargetId: string;
  toTargetId: string | null;
  reason: string;
}

export interface GuardResult {
  planned: PlannedAssignment[];
  deferred: PlannedAssignment[];
  actions: GuardAction[];
  /** True when the final plan satisfies limit and margin floor. */
  withinBudget: boolean;
}

/** Roles that are enrichment: skipped (not deferred) when nothing cheaper exists. */
const SKIPPABLE_ROLES = new Set<AssignmentRole>(["image-label", "chart-data", "diagram"]);

const withEstimate = (
  p: PlannedAssignment,
  alt: Alternative,
  reason: string,
  dropCascade = true,
): PlannedAssignment => ({
  assignment: {
    ...p.assignment,
    targetId: alt.targetId,
    reason: `${p.assignment.reason}; ${reason}`,
    estimate: { costUsd: alt.costUsd, latencyMs: alt.latencyMs, pPass: alt.pPass },
    cascade: dropCascade ? [] : p.assignment.cascade,
  },
  billedUsd: alt.billedUsd,
  latencyP95Ms: alt.latencyP95Ms,
  primary: alt,
  alternatives: p.alternatives,
});

/**
 * Walks the most expensive assignments and degrades them until the chunk fits
 * both `limitUsd` and `marginFloor`: (1) drop the cascade leg, (2) downgrade to the
 * highest-pPass strictly cheaper capable target, (3) skip enrichment roles or
 * defer content roles (extract/ocr/math/table). accept-text and free assignments are
 * never touched. Every step is recorded.
 */
export function applyBudgetGuard(
  input: readonly PlannedAssignment[],
  router: { costUsd: number; billedUsd: number },
  budget: RoutingBudget,
  skipTargetAvailable = true,
): GuardResult {
  let planned = input.map((p) => p);
  const deferred: PlannedAssignment[] = [];
  const actions: GuardAction[] = [];

  const totals = () => {
    let cost = router.costUsd;
    let billed = router.billedUsd;
    for (const p of planned) {
      cost += p.assignment.estimate.costUsd;
      billed += p.billedUsd;
    }
    return { cost, billed };
  };
  const ok = () => {
    const { cost, billed } = totals();
    return cost <= budget.limitUsd + 1e-12 && margin(cost, billed) >= budget.marginFloor - 1e-12;
  };
  const routerAloneOk = router.costUsd <= budget.limitUsd + 1e-12 && margin(router.costUsd, router.billedUsd) >= budget.marginFloor - 1e-12;

  let guardRounds = planned.length * 3 + 3;
  while (!ok() && guardRounds-- > 0) {
    let target: PlannedAssignment | undefined;
    for (const p of planned) {
      if (p.assignment.estimate.costUsd <= 0) continue;
      if (!target || p.assignment.estimate.costUsd > target.assignment.estimate.costUsd) target = p;
    }
    if (!target) break;
    const idx = planned.indexOf(target);
    const a = target.assignment;
    const reasonTag = `budget(limit=$${budget.limitUsd.toFixed(6)},floor=${budget.marginFloor})`;

    if (a.cascade.length > 0) {
      const next = withEstimate(target, target.primary, `${reasonTag} dropped cascade`);
      next.cascade = undefined;
      planned[idx] = next;
      actions.push({ action: "downgrade", pageNumber: a.pageNumber, role: a.role, fromTargetId: a.targetId, toTargetId: a.targetId, reason: "drop-cascade" });
      continue;
    }
    const cheaper = target.alternatives
      .filter((alt) => alt.costUsd < a.estimate.costUsd - 1e-12 && alt.targetId !== a.targetId)
      .sort((x, y) => y.pPass - x.pPass || x.costUsd - y.costUsd)[0];
    if (cheaper) {
      planned[idx] = withEstimate(target, cheaper, `${reasonTag} downgraded from ${a.targetId}`);
      actions.push({ action: "downgrade", pageNumber: a.pageNumber, role: a.role, fromTargetId: a.targetId, toTargetId: cheaper.targetId, reason: "cheaper-capable-target" });
      continue;
    }
    if (SKIPPABLE_ROLES.has(a.role) && skipTargetAvailable) {
      planned[idx] = {
        assignment: {
          ...a,
          targetId: "skip",
          role: "skip",
          reason: `${a.reason}; ${reasonTag} skipped ${a.role}`,
          estimate: { costUsd: 0, latencyMs: 0, pPass: 1 },
          cascade: [],
        },
        billedUsd: 0,
        latencyP95Ms: 0,
        primary: { targetId: "skip", costUsd: 0, billedUsd: 0, latencyMs: 0, latencyP95Ms: 0, pPass: 1, pPassLowerBound: 1 },
        alternatives: [],
      };
      actions.push({ action: "skip", pageNumber: a.pageNumber, role: a.role, fromTargetId: a.targetId, toTargetId: "skip", reason: "no-cheaper-target" });
      continue;
    }
    // Content roles: defer to a later chunk/run. When the router's own (already spent) cost breaks
    // the margin floor even with no assignments, deferring cannot restore the floor and would just
    // leave pages unrouted, so stop, but only while the hard spend limit still holds.
    if (!routerAloneOk && totals().cost <= budget.limitUsd + 1e-12) break;
    planned = planned.filter((p) => p !== target);
    deferred.push(target);
    actions.push({ action: "defer", pageNumber: a.pageNumber, role: a.role, fromTargetId: a.targetId, toTargetId: null, reason: "no-cheaper-target" });
  }
  return { planned, deferred, actions, withinBudget: ok() };
}

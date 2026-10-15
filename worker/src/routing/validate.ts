import {
  ESTIMATE_ERROR_REPORT_SCHEMA_VERSION,
  PLAN_VALIDATION_SCHEMA_VERSION,
  type ActualOutcome,
  type AssignmentEstimate,
  type EstimateError,
  type EstimateErrorReport,
  type PlanValidation,
  type RoutePlan,
} from "@docslurp/shared";
import type { EstimateCorrections } from "./estimate.js";

// Post-execution validation of a plan's estimates against what actually happened.

const absPct = (actual: number, est: number): number | null =>
  actual > 0 ? Math.abs(actual - est) / actual : null;

export function estimateError(estimate: AssignmentEstimate, actual: ActualOutcome): EstimateError {
  return {
    costErrorUsd: actual.costUsd - estimate.costUsd,
    costAbsPctError: absPct(actual.costUsd, estimate.costUsd),
    latencyErrorMs: actual.latencyMs - estimate.latencyMs,
    latencyAbsPctError: absPct(actual.latencyMs, estimate.latencyMs),
    passBrier: actual.passed === null ? null : (estimate.pPass - (actual.passed ? 1 : 0)) ** 2,
  };
}

export interface ValidatePlanInput {
  plan: RoutePlan;
  /** Actual outcome per plan.assignments[i] (same index); null/undefined = not executed. */
  assignmentActuals: ReadonlyArray<ActualOutcome | null | undefined>;
  /**
   * Whole-chunk actual. When omitted it is the sum of assignment actuals plus the plan's
   * router cost (triage + verifier), so router overhead is included.
   */
  chunkActual?: ActualOutcome;
  /** Actual billed USD for the chunk; enables the margin-floor budget check. */
  actualBilledUsd?: number;
}

export function validatePlan(input: ValidatePlanInput): PlanValidation {
  const { plan } = input;
  const rows: PlanValidation["assignments"] = [];
  let cost = plan.triage.costUsd + plan.verifier.costUsd;
  let latencyMax = 0;
  let latencySum = 0;
  plan.assignments.forEach((a, i) => {
    const actual = input.assignmentActuals[i];
    if (!actual) return;
    rows.push({
      assignmentIndex: i,
      pageNumber: a.pageNumber,
      targetId: a.targetId,
      estimate: a.estimate,
      actual,
      error: estimateError(a.estimate, actual),
    });
    cost += actual.costUsd;
    latencyMax = Math.max(latencyMax, actual.latencyMs);
    latencySum += actual.latencyMs;
  });
  const ce = plan.chunkEstimate;
  const chunkActual: ActualOutcome = input.chunkActual ?? {
    costUsd: cost,
    // Wall time proxy: bounded below by the slowest assignment.
    latencyMs: Math.max(latencyMax, latencySum / 4),
    quality: null,
    passed: null,
  };
  const chunkEst: AssignmentEstimate = {
    costUsd: ce.totalCostUsd,
    latencyMs: ce.latencyP50Ms,
    pPass: 1,
  };
  const marginOk =
    input.actualBilledUsd === undefined ||
    (input.actualBilledUsd > 0
      ? 1 - chunkActual.costUsd / input.actualBilledUsd >= ce.budget.marginFloor
      : chunkActual.costUsd <= 0);
  return {
    schemaVersion: PLAN_VALIDATION_SCHEMA_VERSION,
    documentId: plan.documentId,
    runId: plan.runId,
    routerId: plan.routerId,
    assignments: rows,
    chunk: {
      estimate: {
        totalCostUsd: ce.totalCostUsd,
        latencyP50Ms: ce.latencyP50Ms,
        latencyP95Ms: ce.latencyP95Ms,
      },
      actual: chunkActual,
      error: { ...estimateError(chunkEst, chunkActual), passBrier: null },
      withinBudget: chunkActual.costUsd <= ce.budget.limitUsd + 1e-12 && marginOk,
    },
  };
}

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;

export function buildEstimateErrorReport(
  routerId: string,
  validations: readonly PlanValidation[],
  binCount = 10,
): EstimateErrorReport {
  const costPct: number[] = [];
  const latPct: number[] = [];
  const costErr: number[] = [];
  const brier: number[] = [];
  const bins = Array.from({ length: binCount }, (_, i) => ({
    lo: i / binCount,
    hi: (i + 1) / binCount,
    n: 0,
    sumP: 0,
    hits: 0,
  }));
  let nAssignments = 0;
  for (const v of validations) {
    for (const a of v.assignments) {
      nAssignments++;
      if (a.error.costAbsPctError !== null) costPct.push(a.error.costAbsPctError);
      if (a.error.latencyAbsPctError !== null) latPct.push(a.error.latencyAbsPctError);
      costErr.push(a.error.costErrorUsd);
      if (a.actual.passed !== null && a.error.passBrier !== null) {
        brier.push(a.error.passBrier);
        const p = a.estimate.pPass;
        const bin = bins[Math.min(binCount - 1, Math.floor(p * binCount))]!;
        bin.n++;
        bin.sumP += p;
        if (a.actual.passed) bin.hits++;
      }
    }
  }
  const within = validations.filter((v) => v.chunk.withinBudget).length;
  return {
    schemaVersion: ESTIMATE_ERROR_REPORT_SCHEMA_VERSION,
    routerId,
    nAssignments,
    nChunks: validations.length,
    costMape: mean(costPct),
    latencyMape: mean(latPct),
    costBiasUsd: mean(costErr),
    passBrier: mean(brier),
    calibrationBins: bins.map((b) => ({
      lo: b.lo,
      hi: b.hi,
      n: b.n,
      meanPredicted: b.n ? b.sumP / b.n : null,
      observedRate: b.n ? b.hits / b.n : null,
    })),
    budgetAdherence: {
      chunks: validations.length,
      withinBudget: within,
      rate: validations.length ? within / validations.length : null,
    },
  };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Feedback loop: per-target median ratio actual/estimate for cost and latency, to feed
 * back into estimateTargetCost via `corrections`. Targets with fewer than `minN`
 * observations are left uncorrected.
 */
export function deriveCorrections(
  validations: readonly PlanValidation[],
  minN = 5,
): EstimateCorrections {
  const cost = new Map<string, number[]>();
  const lat = new Map<string, number[]>();
  for (const v of validations) {
    for (const a of v.assignments) {
      if (a.estimate.costUsd > 0 && a.actual.costUsd > 0) {
        (cost.get(a.targetId) ?? cost.set(a.targetId, []).get(a.targetId)!).push(a.actual.costUsd / a.estimate.costUsd);
      }
      if (a.estimate.latencyMs > 0 && a.actual.latencyMs > 0) {
        (lat.get(a.targetId) ?? lat.set(a.targetId, []).get(a.targetId)!).push(a.actual.latencyMs / a.estimate.latencyMs);
      }
    }
  }
  const out: EstimateCorrections = {};
  for (const id of new Set([...cost.keys(), ...lat.keys()])) {
    const c = cost.get(id) ?? [];
    const l = lat.get(id) ?? [];
    const entry: { cost?: number; latency?: number } = {};
    if (c.length >= minN) entry.cost = median(c);
    if (l.length >= minN) entry.latency = median(l);
    if (entry.cost !== undefined || entry.latency !== undefined) out[id] = entry;
  }
  return out;
}

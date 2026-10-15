import { readFileSync } from "node:fs";
import {
  parsePolicyPack,
  type AssignmentRole,
  type AssignmentScope,
  type DecisionAnswers,
  type DecisionProbabilities,
  type DecisionQuestionId,
  type PageInput,
  type PassMapping,
  type PassProbabilities,
  type PolicyPack,
  type PolicyTargetMapping,
  type QuestionCalibration,
  type RoutingDimension,
  type RoutingTarget,
  type TargetEstimate,
} from "@docslurp/shared";
import {
  estimateTargetCost,
  type CostBreakdown,
  type EstimateCorrections,
} from "./estimate.js";

// ---------------------------------------------------------------------------
// PolicyPack loading, question calibration and pass mapping.
// ---------------------------------------------------------------------------

export function loadPolicyPack(input: unknown): PolicyPack {
  const pack = parsePolicyPack(input);
  const problems: string[] = [];
  const questions = new Set<string>(pack.questions);
  const mappingKeys = new Set<string>();
  const defaults = new Set(pack.targets.filter((t) => !t.decisionModel).map((t) => t.targetId));
  for (const t of pack.targets) {
    const key = `${t.targetId}|${t.decisionModel ?? ""}`;
    if (mappingKeys.has(key)) problems.push(`duplicate target mapping ${t.targetId}${t.decisionModel ? ` for ${t.decisionModel}` : ""}`);
    mappingKeys.add(key);
    if (t.decisionModel) {
      if (!pack.decisionModels.includes(t.decisionModel)) problems.push(`${t.targetId} mapping for unlisted decision model ${t.decisionModel}`);
      if (!defaults.has(t.targetId)) problems.push(`${t.targetId} has a ${t.decisionModel} mapping but no default mapping`);
    }
    for (const dim of ["text", "math", "tables", "overall"] as const) {
      for (const q of Object.keys(t.pass[dim].weights)) {
        if (!questions.has(q)) problems.push(`${t.targetId}.${dim} weights unknown question ${q}`);
      }
    }
  }
  for (const c of pack.calibrations) {
    if (!questions.has(c.questionId)) problems.push(`calibration for unlisted question ${c.questionId}`);
    if (!pack.decisionModels.includes(c.decisionModel)) {
      problems.push(`calibration for unlisted decision model ${c.decisionModel}`);
    }
    if (c.method === "isotonic") {
      if (c.table.xs.length !== c.table.ys.length) problems.push(`isotonic table length mismatch ${c.questionId}`);
      for (let i = 1; i < c.table.xs.length; i++) {
        if (c.table.xs[i]! < c.table.xs[i - 1]!) problems.push(`isotonic xs not sorted ${c.questionId}`);
        if (c.table.ys[i]! < c.table.ys[i - 1]!) problems.push(`isotonic ys not monotone ${c.questionId}`);
      }
    }
  }
  if (problems.length) throw new Error(`Invalid policy pack: ${problems.join("; ")}`);
  return pack;
}

export function loadPolicyPackFromFile(path: string): PolicyPack {
  return loadPolicyPack(JSON.parse(readFileSync(path, "utf8")));
}


// ---- Calibration ----------------------------------------------------------

const clip = (p: number, eps = 1e-6) => Math.min(1 - eps, Math.max(eps, p));
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
export const logit = (p: number) => Math.log(clip(p) / (1 - clip(p)));

export function applyCalibration(cal: QuestionCalibration | undefined, raw: number): number {
  if (!cal) return raw;
  if (cal.method === "platt") return sigmoid(cal.params.a * logit(raw) + cal.params.b);
  const { xs, ys } = cal.table;
  let y = ys[0]!;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i]! <= raw) y = ys[i]!;
    else break;
  }
  return y;
}

export type CalibrationIndex = Map<string, QuestionCalibration>;

export function indexCalibrations(pack: PolicyPack): CalibrationIndex {
  const m: CalibrationIndex = new Map();
  for (const c of pack.calibrations) m.set(`${c.decisionModel}|${c.questionId}`, c);
  return m;
}

export type CalibratedProbabilities = Partial<Record<DecisionQuestionId, number>>;

export function calibrateAnswers(
  index: CalibrationIndex,
  answers: DecisionAnswers | null | undefined,
): CalibratedProbabilities {
  const out: CalibratedProbabilities = {};
  if (!answers) return out;
  const model = answers.source.decisionModel;
  for (const [q, raw] of Object.entries(answers.probabilities as DecisionProbabilities)) {
    if (typeof raw !== "number") continue;
    out[q as DecisionQuestionId] = applyCalibration(index.get(`${model}|${q}`), raw);
  }
  return out;
}

// ---- Pass mapping ---------------------------------------------------------

/**
 * P(pass) = sigmoid(intercept + sum w_q * p_q). Questions the model did not answer are
 * imputed at 0.5 (maximum uncertainty); when none of the weighted questions were
 * answered the mapping's `baseRate` prior is returned unchanged.
 */
export function applyPassMapping(m: PassMapping, probs: CalibratedProbabilities): number {
  let z = m.intercept;
  let seen = 0;
  for (const [q, w] of Object.entries(m.weights)) {
    const p = probs[q as DecisionQuestionId];
    if (typeof p === "number") seen++;
    z += (w as number) * (typeof p === "number" ? p : 0.5);
  }
  if (seen === 0) return m.baseRate;
  return sigmoid(z);
}

/** Pessimistic lower bound: normal approx. to a Beta(p*(n+2), (1-p)*(n+2)) 10th percentile. */
export function lowerBound(p: number, n: number, z = 1.2816): number {
  const lb = p - z * Math.sqrt((p * (1 - p)) / (Math.max(0, n) + 2));
  return Math.min(p, Math.max(0, lb));
}

export const PRIOR_PSEUDO_N = 30;

export function dimensionForRole(role: AssignmentRole): RoutingDimension {
  switch (role) {
    case "accept-text":
    case "extract-text":
    case "ocr":
      return "text";
    case "math":
      return "math";
    case "table":
      return "tables";
    default:
      return "overall";
  }
}

/** A target estimate plus the extra fields the planner/guard need. */
export interface ScoredEstimate extends TargetEstimate {
  latencyP95Ms: number;
  billedUsd: number;
}

export interface EstimatorContext {
  page: PageInput;
  role: AssignmentRole;
  scope: AssignmentScope;
  target: RoutingTarget;
  /** Calibrated decision-model probabilities for this page (empty when triage did not run). */
  probs: CalibratedProbabilities;
}

/** Universal estimator: any router (policy, baseline, heuristic) supplies one to the planner. */
export type TargetEstimator = (ctx: EstimatorContext) => ScoredEstimate | null;

const bucket = (p: number) => {
  const lo = Math.min(9, Math.floor(p * 10)) / 10;
  return `p${lo.toFixed(1)}-${(lo + 0.1).toFixed(1)}`;
};

export function buildScoredEstimate(args: {
  targetId: string;
  pPass: PassProbabilities;
  n: number;
  dim: RoutingDimension;
  cost: CostBreakdown;
  calibrationBucket?: string;
}): ScoredEstimate {
  const { pPass, dim, n, cost } = args;
  const lb: PassProbabilities = {
    text: lowerBound(pPass.text, n),
    math: lowerBound(pPass.math, n),
    tables: lowerBound(pPass.tables, n),
    overall: lowerBound(pPass.overall, n),
  };
  return {
    targetId: args.targetId,
    pPass,
    pPassLowerBound: lb,
    qualityMean: pPass.overall,
    qualityCi: [lb.overall, Math.min(1, pPass.overall + (pPass.overall - lb.overall))],
    expectedCostUsd: cost.costUsd,
    expectedLatencyMs: cost.latencyP50Ms,
    calibrationBucket: args.calibrationBucket ?? bucket(pPass[dim]),
    latencyP95Ms: cost.latencyP95Ms,
    billedUsd: cost.billedUsd,
  };
}

export interface PolicyEstimatorOptions {
  corrections?: EstimateCorrections;
  /**
   * Decision model whose answers feed the estimator. Its own target mappings (fit on its calibrated answers) win;
   * targets without one use the default mapping.
   */
  decisionModel?: string;
}

/** Default mappings, overlaid with the serving model's own mappings when the pack has them. */
export function targetMappings(pack: PolicyPack, decisionModel?: string): Map<string, PolicyTargetMapping> {
  const out = new Map<string, PolicyTargetMapping>(pack.targets.filter((t) => !t.decisionModel).map((t) => [t.targetId, t]));
  if (decisionModel) for (const t of pack.targets) if (t.decisionModel === decisionModel) out.set(t.targetId, t);
  return out;
}

/**
 * Estimator backed by a PolicyPack: calibrated decision answers -> pass mapping per target (the serving
 * model's own mapping when the pack has one, else the default),
 * costs from catalog pricing (estimate.ts). Targets without a mapping return null;
 * targets without a catalog pricing basis fall back to the mapping's mean cost.
 */
export function createPolicyEstimator(
  pack: PolicyPack,
  opts: PolicyEstimatorOptions = {},
): TargetEstimator {
  const byTarget = targetMappings(pack, opts.decisionModel);
  return ({ page, role, scope, target, probs }) => {
    const mapping = byTarget.get(target.id);
    if (!mapping) return null;
    const cost = estimateTargetCost(target, role, scope, page, opts.corrections);
    if (!cost.priced && mapping.n > 0) {
      cost.costUsd = mapping.cost.meanUsd;
      cost.billedUsd = Math.max(cost.billedUsd, mapping.cost.meanUsd);
      cost.latencyP50Ms = mapping.latency.p50Ms || cost.latencyP50Ms;
      cost.latencyP95Ms = mapping.latency.p95Ms || cost.latencyP95Ms;
    }
    const pPass: PassProbabilities = {
      text: applyPassMapping(mapping.pass.text, probs),
      math: applyPassMapping(mapping.pass.math, probs),
      tables: applyPassMapping(mapping.pass.tables, probs),
      overall: applyPassMapping(mapping.pass.overall, probs),
    };
    const answered = Object.keys(probs).length > 0;
    const dim = dimensionForRole(role);
    return buildScoredEstimate({
      targetId: target.id,
      pPass,
      // Hand-set priors (n=0) count as PRIOR_PSEUDO_N pseudo-observations so the bound is
      // pessimistic but not degenerate; fitted packs carry their real n.
      n: Math.max(mapping.n, PRIOR_PSEUDO_N),
      dim,
      cost,
      calibrationBucket: answered ? bucket(pPass[dim]) : `prior:${bucket(pPass[dim])}`,
    });
  };
}

import { describe, expect, it } from "vitest";
import type { ActualOutcome, RoutePlan } from "@docslurp/shared";
import { assemblePlan } from "./planner.js";
import { buildEstimateErrorReport, deriveCorrections, estimateError, validatePlan } from "./validate.js";

const a = (costUsd: number, latencyMs: number, passed: boolean | null): ActualOutcome => ({ costUsd, latencyMs, quality: null, passed });

function makePlan(limitUsd = 1): RoutePlan {
  const mk = (page: number, cost: number, lat: number, p: number) => ({
    assignment: { pageNumber: page, scope: { kind: "page" as const }, targetId: "t", role: "extract-text" as const, reason: "r", estimate: { costUsd: cost, latencyMs: lat, pPass: p }, cascade: [] },
    billedUsd: cost * 1.2, latencyP95Ms: lat * 2,
    primary: { targetId: "t", costUsd: cost, billedUsd: cost * 1.2, latencyMs: lat, latencyP95Ms: lat * 2, pPass: p, pPassLowerBound: p },
    alternatives: [],
  });
  const plan = assemblePlan({
    documentId: "d", runId: "r", routerId: "x", routerKind: "baseline", objective: "cost-quality", policyVersion: "v",
    planned: [mk(1, 0.01, 100, 0.9), mk(2, 0.02, 200, 0.6)], budget: { limitUsd: 1e6, marginFloor: 0 }, catalog: [],
    triage: { costUsd: 0.001 }, routerCost: { costUsd: 0.001, billedUsd: 0.0012 },
  }).plan;
  plan.chunkEstimate.budget.limitUsd = limitUsd;
  return plan;
}

describe("estimateError", () => {
  it("computes signed and absolute-percentage errors and Brier", () => {
    const e = estimateError({ costUsd: 0.01, latencyMs: 100, pPass: 0.8 }, a(0.015, 80, true));
    expect(e.costErrorUsd).toBeCloseTo(0.005);
    expect(e.costAbsPctError).toBeCloseTo(0.005 / 0.015);
    expect(e.latencyErrorMs).toBe(-20);
    expect(e.latencyAbsPctError).toBeCloseTo(0.25);
    expect(e.passBrier).toBeCloseTo(0.04);
  });
  it("null pct when actual is 0 and null Brier when pass unknown", () => {
    const e = estimateError({ costUsd: 0.01, latencyMs: 100, pPass: 0.8 }, a(0, 0, null));
    expect(e.costAbsPctError).toBeNull();
    expect(e.latencyAbsPctError).toBeNull();
    expect(e.passBrier).toBeNull();
  });
});

describe("validatePlan / report", () => {
  it("includes router cost in the chunk actual and checks budget", () => {
    const v = validatePlan({ plan: makePlan(), assignmentActuals: [a(0.012, 110, true), a(0.02, 190, false)] });
    expect(v.assignments).toHaveLength(2);
    expect(v.chunk.actual.costUsd).toBeCloseTo(0.012 + 0.02 + 0.001);
    expect(v.chunk.withinBudget).toBe(true);
    const over = validatePlan({ plan: makePlan(0.03), assignmentActuals: [a(0.02, 110, true), a(0.02, 190, true)] });
    expect(over.chunk.withinBudget).toBe(false);
  });
  it("margin floor makes the chunk out of budget", () => {
    const plan = makePlan();
    plan.chunkEstimate.budget.marginFloor = 0.5;
    const v = validatePlan({ plan, assignmentActuals: [a(0.01, 100, true), null], actualBilledUsd: 0.012 });
    expect(v.chunk.withinBudget).toBe(false);
  });
  it("aggregates MAPE, bias, Brier, calibration bins, budget adherence", () => {
    const v1 = validatePlan({ plan: makePlan(), assignmentActuals: [a(0.02, 100, true), a(0.02, 400, false)] });
    const v2 = validatePlan({ plan: makePlan(0.0001), assignmentActuals: [a(0.01, 100, true), a(0.02, 200, true)] });
    const r = buildEstimateErrorReport("x", [v1, v2]);
    expect(r.nAssignments).toBe(4);
    expect(r.nChunks).toBe(2);
    // cost abs pct errors: |0.02-0.01|/0.02=.5, 0, 0, .5 (exact for a2: 0.02 vs 0.02)
    expect(r.costMape).toBeCloseTo((0.5 + 0 + 0 + 0.5 * 0) / 4 + 0.125 * 0, 5);
    expect(r.passBrier).toBeCloseTo(((0.9 - 1) ** 2 + (0.6 - 0) ** 2 + (0.9 - 1) ** 2 + (0.6 - 1) ** 2) / 4);
    const bin9 = r.calibrationBins[9]!;
    expect(bin9).toMatchObject({ n: 2, observedRate: 1 });
    expect(bin9.meanPredicted).toBeCloseTo(0.9);
    const bin6 = r.calibrationBins[6]!;
    expect(bin6).toMatchObject({ n: 2, observedRate: 0.5 });
    expect(r.budgetAdherence).toEqual({ chunks: 2, withinBudget: 1, rate: 0.5 });
  });
  it("derives per-target corrections only with enough observations", () => {
    const plan = makePlan();
    const vs = Array.from({ length: 5 }, () => validatePlan({ plan, assignmentActuals: [a(0.02, 200, true), a(0.04, 400, true)] }));
    const c = deriveCorrections(vs);
    expect(c.t!.cost).toBeCloseTo(2);
    expect(c.t!.latency).toBeCloseTo(2);
    expect(deriveCorrections(vs.slice(0, 2))).toEqual({});
  });
});

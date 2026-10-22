import { describe, expect, it } from "vitest";
import type { DecisionAnswers, RoutingObjective } from "@docslurp/shared";
import { assemblePlan, chooseCandidate, needsFromDecisions, needsFromFeatures, planPages, rolesForPage, DEFAULT_PLANNER_CONFIG } from "./planner.js";
import { createPolicyEstimator, calibrateAnswers, indexCalibrations } from "./policy.js";
import { BIG_BUDGET, makePage, testCatalog, testPack } from "./testing.js";

const catalog = testCatalog();
const pack = testPack();
const estimator = createPolicyEstimator(pack);

function answers(p: DecisionAnswers["probabilities"], image_kind?: NonNullable<DecisionAnswers["choices"]["image_kind"]>): DecisionAnswers {
  return {
    probabilities: p,
    choices: image_kind ? { image_kind } : {},
    source: { decisionModel: "perplexity/pplx-decider-v1.1-27b", format: "named-images", pagesPerCall: 8, tilePx: 384 },
  };
}
function needs(page: ReturnType<typeof makePage>, a: DecisionAnswers) {
  return needsFromDecisions(page, a, calibrateAnswers(indexCalibrations(pack), a));
}
function run(pages: ReturnType<typeof makePage>[], ns: ReturnType<typeof needs>[], objective: RoutingObjective, config = {}) {
  return planPages({ needs: ns, pages, catalog, objective, estimator, config });
}

describe("chooseCandidate objectives", () => {
  const c = (id: string, p: number, lb: number, costUsd: number, latencyMs: number) => ({ id, p, lb, costUsd, latencyMs });
  const cands = [c("cheap", 0.7, 0.6, 0.0001, 100), c("mid", 0.88, 0.82, 0.001, 900), c("fast", 0.86, 0.81, 0.003, 50), c("best", 0.97, 0.95, 0.01, 3000)];
  it("cost-quality picks the cheapest with LB >= floor", () => {
    expect(chooseCandidate(cands, "cost-quality", 0.8, 1)!.chosen.id).toBe("mid");
    expect(chooseCandidate(cands, "cost-quality", 0.9, 1)!.chosen.id).toBe("best");
  });
  it("cost-speed picks the fastest under the cost cap, else cheapest feasible", () => {
    expect(chooseCandidate(cands, "cost-speed", 0.8, 0.005)!.chosen.id).toBe("fast");
    expect(chooseCandidate(cands, "cost-speed", 0.8, 0.0005)!.chosen.id).toBe("mid");
  });
  it("quality picks max pPass, cost breaks ties", () => {
    expect(chooseCandidate(cands, "quality", 0.8, 1)!.chosen.id).toBe("best");
    const tie = [c("a", 0.9, 0.8, 0.01, 1), c("b", 0.9, 0.8, 0.001, 1)];
    expect(chooseCandidate(tie, "quality", 0.8, 1)!.chosen.id).toBe("b");
  });
  it("falls back to highest lower bound when nothing clears the floor", () => {
    const r = chooseCandidate(cands, "cost-quality", 0.99, 1)!;
    expect(r.chosen.id).toBe("best");
    expect(r.metFloor).toBe(false);
  });
  it("is monotone: a higher floor never selects a cheaper target; quality >= cost-quality pPass", () => {
    let prev = -1;
    for (const floor of [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]) {
      const cost = chooseCandidate(cands, "cost-quality", floor, 1)!.chosen.costUsd;
      expect(cost).toBeGreaterThanOrEqual(prev);
      prev = cost;
    }
    expect(chooseCandidate(cands, "quality", 0.8, 1)!.chosen.p).toBeGreaterThanOrEqual(chooseCandidate(cands, "cost-quality", 0.8, 1)!.chosen.p);
  });
});

describe("planner on real catalog/prior pack", () => {
  const prose = makePage({ pageNumber: 1 });
  const proseAns = answers({ trust_text_layer: 0.97, native_text_faithful: 0.95, text_layer_ok: 0.95, needs_math_extraction: 0.02, needs_table_structure: 0.03, has_math: 0.02, has_table: 0.03 });

  it("trusted text layer -> accept-text via native:accept-text-layer", () => {
    const r = run([prose], [needs(prose, proseAns)], "cost-quality");
    expect(r.planned).toHaveLength(1);
    expect(r.planned[0]!.assignment).toMatchObject({ role: "accept-text", targetId: "native:accept-text-layer", scope: { kind: "page" } });
  });

  it("text page with a chart -> accept-text + chart-data (multi-target)", () => {
    const page = makePage({ pageNumber: 2, images: [{ coverage: 0.25 }] });
    const a = answers(proseAns.probabilities, [{ imageIndex: 0, probabilities: { "chart-graph": 0.9, "decorative-photo": 0.05 } }]);
    const r = run([page], [needs(page, a)], "cost-quality");
    const roles = r.planned.map((p) => p.assignment.role).sort();
    expect(roles).toEqual(["accept-text", "chart-data"]);
    const chart = r.planned.find((p) => p.assignment.role === "chart-data")!.assignment;
    expect(chart.scope).toMatchObject({ kind: "image", imageIndex: 0 });
    const target = catalog.find((t) => t.id === chart.targetId)!;
    expect(target.roles).toContain("chart-data");
  });

  it("image kinds route to label / ocr / skip", () => {
    const page = makePage({ pageNumber: 3, images: [{ coverage: 0.2 }, { coverage: 0.01 }, { coverage: 0.2 }] });
    const a = answers(proseAns.probabilities, [
      { imageIndex: 0, probabilities: { "decorative-photo": 0.9 } },
      { imageIndex: 1, probabilities: { logo: 0.9 } },
      { imageIndex: 2, probabilities: { "scanned-text": 0.8 } },
    ]);
    const roles = run([page], [needs(page, a)], "cost-quality").planned.map((p) => p.assignment.role);
    expect(roles).toEqual(expect.arrayContaining(["accept-text", "image-label", "skip", "ocr"]));
    const label = run([page], [needs(page, a)], "cost-quality").planned.find((p) => p.assignment.role === "image-label")!;
    expect(label.assignment.targetId).toBe("local:florence-2-small");
  });

  it("math and table needs pick capable targets and replace text assignment", () => {
    const page = makePage({ pageNumber: 4 });
    const a = answers({ trust_text_layer: 0.6, needs_math_extraction: 0.95, needs_table_structure: 0.9 });
    const r = run([page], [needs(page, a)], "cost-quality");
    expect(r.planned.map((p) => p.assignment.role).sort()).toEqual(["math", "table"]);
    for (const p of r.planned) {
      const t = catalog.find((x) => x.id === p.assignment.targetId)!;
      expect(t.roles).toContain(p.assignment.role);
    }
  });

  it("scanned page (full-page image, no text layer) -> ocr page scope", () => {
    const page = makePage({ pageNumber: 5, words: 0, fullPageImage: true, images: [{ coverage: 0.98 }] });
    const n = needsFromFeatures(page);
    const roles = rolesForPage(n, DEFAULT_PLANNER_CONFIG);
    expect(roles.map((r) => r.role)).toEqual(["ocr"]);
    expect(roles[0]!.scope.kind).toBe("page");
  });

  it.each([0.2, 0.65])("keeps native prose and OCRs an unknown embedded image at coverage %s", coverage => {
    const page = makePage({ words: 400, images: [{ coverage }] });
    const roles = rolesForPage(needsFromFeatures(page), DEFAULT_PLANNER_CONFIG);
    expect(roles.map(r => r.role)).toEqual(["accept-text", "ocr"]);
    expect(roles[1].scope).toEqual({ kind: "image", imageIndex: 0, bbox: page.images[0].bbox });
  });

  it("skips proven blank pages but does not discard vector-only or annotated pages", () => {
    const blank = makePage({ words: 0 });
    expect(rolesForPage(needsFromFeatures(blank), DEFAULT_PLANNER_CONFIG)).toMatchObject([{ role: "skip" }]);
    for (const page of [makePage({ words: 0, vectors: 10 }), { ...blank, unusualFeatures: ["annotation-freetext"] }]) {
      expect(rolesForPage(needsFromFeatures(page), DEFAULT_PLANNER_CONFIG).map(r => r.role)).not.toContain("skip");
    }
  });

  it("does not OCR each tile again after scheduling OCR for a scanned page", () => {
    const page = makePage({ words: 0, images: [{ coverage: 0.45 }, { coverage: 0.45 }] });
    expect(rolesForPage(needsFromFeatures(page), DEFAULT_PLANNER_CONFIG)).toMatchObject([{ role: "ocr", scope: { kind: "page" } }]);
    expect(rolesForPage(needsFromFeatures(page), DEFAULT_PLANNER_CONFIG)).toHaveLength(1);
  });

  it("objective monotonicity on real estimates: cost-quality <= quality in cost; quality >= in pPass", () => {
    const page = makePage({ pageNumber: 6 });
    const a = answers({ trust_text_layer: 0.2, needs_math_extraction: 0.9, text_layer_ok: 0.3 });
    const n = [needs(page, a)];
    const cq = run([page], n, "cost-quality").planned[0]!.assignment;
    const q = run([page], n, "quality").planned[0]!.assignment;
    expect(q.estimate.pPass).toBeGreaterThanOrEqual(cq.estimate.pPass - 1e-9);
    expect(cq.estimate.costUsd).toBeLessThanOrEqual(q.estimate.costUsd + 1e-12);
    let prevCost = -1;
    for (const passFloor of [0.5, 0.7, 0.8, 0.9, 0.93]) {
      const c = run([page], n, "cost-quality", { passFloor }).planned[0]!;
      expect(c.primary.costUsd).toBeGreaterThanOrEqual(prevCost - 1e-12);
      prevCost = c.primary.costUsd;
    }
  });

  it("emits at most one cascade leg and never cascades to the same target", () => {
    const page = makePage({ pageNumber: 7 });
    const a = answers({ trust_text_layer: 0.1, needs_math_extraction: 0.9 });
    for (const p of run([page], [needs(page, a)], "cost-quality").planned) {
      expect(p.assignment.cascade.length).toBeLessThanOrEqual(1);
      for (const c of p.assignment.cascade) expect(c.targetId).not.toBe(p.assignment.targetId);
    }
  });

  it("privacy gate rejects hosted targets", () => {
    const page = makePage({ pageNumber: 8 });
    const a = answers({ trust_text_layer: 0.1, needs_table_structure: 0.9 });
    const r = run([page], [needs(page, a)], "quality", { disallowedPrivacy: new Set(["hosted"]) });
    expect(r.rejected.some((x) => x.reason === "privacy")).toBe(true);
    expect(r.planned[0]!.assignment.targetId).not.toMatch(/^vlm:openrouter/);
  });
});

describe("assemblePlan + budget guard", () => {
  const page = makePage({ pageNumber: 1, images: [{ coverage: 0.3 }] });
  const a = answers({ trust_text_layer: 0.1, needs_table_structure: 0.9 }, [{ imageIndex: 0, probabilities: { "chart-graph": 0.95 } }]);
  const base = () => planPages({ needs: [needs(page, a)], pages: [page], catalog, objective: "quality", estimator });

  it("within budget: no actions; chunk estimate sums assignments", () => {
    const { planned, rejected } = base();
    const { plan } = assemblePlan({ documentId: "d", runId: "r", routerId: "x", routerKind: "baseline", objective: "quality", policyVersion: "v", planned, rejected, budget: BIG_BUDGET, catalog });
    expect(plan.chunkEstimate.overBudgetActions).toEqual([]);
    const sum = plan.assignments.reduce((s, x) => s + x.estimate.costUsd, 0);
    expect(plan.chunkEstimate.extractionCostUsd).toBeCloseTo(sum, 12);
  });

  it("over budget: downgrades, then skips/defers, and records the actions", () => {
    const { planned } = base();
    const total = planned.reduce((s, p) => s + p.assignment.estimate.costUsd, 0);
    const { plan, guard } = assemblePlan({ documentId: "d", runId: "r", routerId: "x", routerKind: "baseline", objective: "quality", policyVersion: "v", planned, budget: { limitUsd: total / 20, marginFloor: 0 }, catalog });
    expect(plan.chunkEstimate.overBudgetActions.length).toBeGreaterThan(0);
    expect(plan.chunkEstimate.overBudgetActions[0]).toBe("downgrade");
    expect(plan.chunkEstimate.totalCostUsd).toBeLessThanOrEqual(total / 20 + 1e-12);
    expect(guard.withinBudget).toBe(true);
    expect(guard.actions.length).toBe(plan.chunkEstimate.overBudgetActions.length);
  });

  it("zero budget skips enrichment and defers content, recording budget rejections", () => {
    const { planned } = base();
    const { plan } = assemblePlan({ documentId: "d", runId: "r", routerId: "x", routerKind: "baseline", objective: "quality", policyVersion: "v", planned, budget: { limitUsd: 0, marginFloor: 0 }, catalog });
    expect(plan.chunkEstimate.overBudgetActions).toContain("skip");
    expect(plan.rejected.some((r) => r.reason === "budget")).toBe(true);
    expect(plan.chunkEstimate.totalCostUsd).toBeLessThanOrEqual(1e-12);
  });
});

describe("performance", () => {
  // Host load (CI, parallel agents) inflates wall-clock, so the budget is checked two load-insensitive ways:
  // the fastest of 25 runs against the absolute 50 ms budget (idle ~5 ms), and the median relative to a fixed
  // CPU-bound loop timed in the same iterations (idle ratio ~0.5; a 4x regression trips the 2.0 bound under any load).
  const spin = () => {
    let s = 0;
    for (let i = 1; i <= 2_000_000; i++) s += Math.sqrt(i) % 7;
    return s;
  };
  it("routes 500 synthetic pages within budget (best run < 50 ms, median < 2x a same-load baseline loop)", () => {
    const pages = Array.from({ length: 500 }, (_, i) =>
      makePage({ pageNumber: i + 1, words: i % 7 === 0 ? 20 : 400, images: i % 3 === 0 ? [{ coverage: 0.3 }] : [], math: i % 11 === 0 ? 0.1 : 0, tableRule: i % 13 === 0 ? 5 : 0 }),
    );
    const ns = pages.map((p) => needsFromFeatures(p));
    const plan: number[] = [];
    const base: number[] = [];
    for (let k = 0; k < 25; k++) {
      let t0 = performance.now();
      spin();
      base.push(performance.now() - t0);
      t0 = performance.now();
      const { planned, rejected } = planPages({ needs: ns, pages, catalog, objective: "cost-quality", estimator });
      assemblePlan({ documentId: "d", runId: "r", routerId: "x", routerKind: "baseline", objective: "cost-quality", policyVersion: "v", planned, rejected, budget: BIG_BUDGET, catalog });
      plan.push(performance.now() - t0);
    }
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;
    const best = Math.min(...plan);
    const ratio = median(plan) / median(base);
    console.log(`500-page route best=${best.toFixed(2)}ms median=${median(plan).toFixed(2)}ms baseline-ratio=${ratio.toFixed(2)}`);
    expect(best).toBeLessThan(50);
    expect(ratio).toBeLessThan(2);
  });
});

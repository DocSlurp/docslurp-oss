import { describe, expect, it } from "vitest";
import { routePlanSchema, type PolicyPack } from "@docslurp/shared";
import { BaselineCells, BaselineRouter, createBaselineEstimator, predicateMatches } from "./baseline.js";
import { BIG_BUDGET, makePage, testCatalog, testPack } from "../testing.js";

const beta = (a: number, b: number) => ({ alpha: a, beta: b });
const passes = (a: number, b: number) => ({ text: beta(a, b), math: beta(a, b), tables: beta(a, b), overall: beta(a, b) });

function packWithBaseline(): PolicyPack {
  return {
    ...testPack(),
    baseline: {
      cells: [
        { id: "global", parentId: null, predicates: [] },
        { id: "wordy", parentId: "global", predicates: [{ feature: "native.wordCount", op: "gte", value: 100 }] },
      ],
      stats: [
        // pymupdf is great in "wordy", cheapest-capable; kreuzberg is bad there
        { cellId: "wordy", targetId: "native:pymupdf", pass: passes(95, 5), cost: { meanUsd: 0, p90Usd: 0 }, latency: { p50Ms: 30, p95Ms: 60 }, n: 100 },
        { cellId: "wordy", targetId: "native:kreuzberg", pass: passes(2, 20), cost: { meanUsd: 0, p90Usd: 0 }, latency: { p50Ms: 60, p95Ms: 120 }, n: 22 },
        { cellId: "global", targetId: "native:pymupdf", pass: passes(5, 5), cost: { meanUsd: 0, p90Usd: 0 }, latency: { p50Ms: 30, p95Ms: 60 }, n: 10 },
      ],
    },
  };
}

describe("baseline cells", () => {
  it("evaluates generic feature predicates and picks the most specific cell", () => {
    const cells = new BaselineCells(packWithBaseline().baseline!);
    expect(cells.cellFor(makePage({ words: 400 }))!.id).toBe("wordy");
    expect(cells.cellFor(makePage({ words: 10 }))!.id).toBe("global");
    expect(predicateMatches(makePage(), { feature: "heuristic.route", op: "in", value: ["straightforward-text"] })).toBe(true);
    expect(predicateMatches(makePage(), { feature: "nope.x", op: "eq", value: 1 })).toBe(false);
  });
  it("backs off to the parent cell when the child has too few observations", () => {
    const cells = new BaselineCells({
      cells: [{ id: "g", parentId: null, predicates: [] }, { id: "c", parentId: "g", predicates: [] }],
      stats: [
        { cellId: "c", targetId: "t", pass: passes(1, 1), cost: { meanUsd: 0, p90Usd: 0 }, latency: { p50Ms: 1, p95Ms: 1 }, n: 2 },
        { cellId: "g", targetId: "t", pass: passes(9, 1), cost: { meanUsd: 0, p90Usd: 0 }, latency: { p50Ms: 1, p95Ms: 1 }, n: 50 },
      ],
    });
    expect(cells.statsFor(cells.cellFor(makePage()), "t")!.cellId).toBe("g");
  });
  it("uses Beta means and lower bounds from the matching cell", () => {
    const est = createBaselineEstimator(packWithBaseline());
    const e = est({ page: makePage(), role: "extract-text", scope: { kind: "page" }, target: testCatalog().find((t) => t.id === "native:pymupdf")!, probs: {} })!;
    expect(e.pPass.text).toBeCloseTo(0.95);
    expect(e.pPassLowerBound!.text).toBeLessThan(0.95);
    expect(e.calibrationBucket).toBe("cell:wordy");
  });
});

describe("BaselineRouter", () => {
  it("plans with Beta cells and yields a valid plan", async () => {
    const plan = await new BaselineRouter({ pack: packWithBaseline() }).plan([makePage({ words: 400, textLayer: "suspect" })], testCatalog(), BIG_BUDGET, "cost-quality");
    expect(() => routePlanSchema.parse(plan)).not.toThrow();
    expect(plan.routerKind).toBe("baseline");
    expect(plan.assignments.length).toBeGreaterThan(0);
  });
  it("tolerates a pack without a baseline block", async () => {
    const r = new BaselineRouter({ pack: testPack() });
    expect(r.hasBaselineCells).toBe(false);
    const plan = await r.plan([makePage({ pageNumber: 1 }), makePage({ pageNumber: 2, words: 0, fullPageImage: true, images: [{ coverage: 0.95 }] })], testCatalog(), BIG_BUDGET, "cost-quality");
    expect(plan.policyVersion).toMatch(/no-baseline-cells/);
    expect(plan.assignments.map((a) => a.role)).toEqual(["accept-text", "ocr"]);
  });
});

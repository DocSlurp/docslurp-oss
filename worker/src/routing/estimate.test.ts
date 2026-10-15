import { describe, expect, it } from "vitest";
import {
  applyBudgetGuard,
  estimateChunk,
  estimateRouterCost,
  estimateTargetCost,
  margin,
  type PlannedAssignment,
} from "./estimate.js";
import { makePage, testCatalog } from "./testing.js";

const catalog = testCatalog();
const t = (id: string) => catalog.find((x) => x.id === id)!;
const page = { kind: "page" } as const;

function planned(id: string, role: "chart-data" | "extract-text", cost: number, alts: Array<[string, number, number]> = []): PlannedAssignment {
  const alt = (tid: string, c: number, p: number) => ({ targetId: tid, costUsd: c, billedUsd: c * 1.2, latencyMs: 100, latencyP95Ms: 200, pPass: p, pPassLowerBound: p });
  const primary = alt(id, cost, 0.9);
  return {
    assignment: { pageNumber: 1, scope: page, targetId: id, role, reason: "t", estimate: { costUsd: cost, latencyMs: 100, pPass: 0.9 }, cascade: [] },
    billedUsd: cost * 1.2,
    latencyP95Ms: 200,
    primary,
    alternatives: [primary, ...alts.map(([i, c, p]) => alt(i, c, p))],
  };
}

describe("estimateTargetCost", () => {
  it("prices hosted VLMs from tokens and catalog pricing, with AI markup in billed", () => {
    const c = estimateTargetCost(t("vlm:openrouter/google/gemini-3.5-flash"), "chart-data", page);
    expect(c.costUsd).toBeGreaterThan(0);
    expect(c.billedUsd).toBeCloseTo(c.costUsd * 1.2, 10);
    const cheap = estimateTargetCost(t("vlm:openrouter/google/gemini-2.5-flash-lite"), "chart-data", page);
    expect(cheap.costUsd).toBeLessThan(c.costUsd);
  });
  it("prices local compute from hourly cost and observed throughput", () => {
    const c = estimateTargetCost(t("vlm:private/lightonocr-3"), "ocr", page);
    expect(c.costUsd).toBeCloseTo(0.45 / 60 / 160, 10);
    expect(c.priced).toBe(true);
  });
  it("native accept-text costs almost nothing and skip is free", () => {
    expect(estimateTargetCost(t("native:accept-text-layer"), "accept-text", page).costUsd).toBeLessThan(1e-6);
    expect(estimateTargetCost(t("skip"), "skip", page)).toMatchObject({ costUsd: 0, billedUsd: 0 });
  });
  it("scales image-scope cost down and applies corrections", () => {
    const g = t("vlm:openrouter/google/gemini-3.5-flash");
    const full = estimateTargetCost(g, "image-label", page).costUsd;
    const region = estimateTargetCost(g, "image-label", { kind: "image", imageIndex: 0 }, makePage({ images: [{ coverage: 0.3 }] })).costUsd;
    expect(region).toBeLessThan(full);
    expect(estimateTargetCost(g, "chart-data", page, undefined, { [g.id]: { cost: 2 } }).costUsd).toBeCloseTo(estimateTargetCost(g, "chart-data", page).costUsd * 2, 10);
  });
});

describe("estimateRouterCost", () => {
  const model = { pricing: { inputUsdPerMTok: 0.02, outputUsdPerMTok: 0 as const, checkedAt: "x" }, maxQuestionsPerRequest: 128 };
  it("bills input tokens only and batches by question limit", () => {
    const e = estimateRouterCost({ model, pages: 100, questionsPerPage: 8, pagesPerCall: 16, tilePx: 384 });
    expect(e.calls).toBe(Math.ceil(100 / 16));
    expect(e.costUsd).toBeCloseTo((e.inputTokens * 0.02) / 1e6, 12);
    const text = estimateRouterCost({ model, pages: 100, questionsPerPage: 8, pagesPerCall: 16, tilePx: null });
    expect(text.costUsd).toBeLessThan(e.costUsd);
  });
});

describe("chunk estimate and margin", () => {
  it("margin is 1 - cost/billed", () => {
    expect(margin(0.8, 1)).toBeCloseTo(0.2);
    expect(margin(0, 0)).toBe(1);
  });
  it("sums router + extraction and computes latency under concurrency", () => {
    const p = [planned("a", "extract-text", 0.01), planned("b", "extract-text", 0.02)];
    const c = estimateChunk(p, { costUsd: 0.005, billedUsd: 0.006 }, { limitUsd: 1, marginFloor: 0 });
    expect(c.totalCostUsd).toBeCloseTo(0.035);
    expect(c.routerCostUsd).toBe(0.005);
    expect(c.latencyP95Ms).toBeGreaterThanOrEqual(c.latencyP50Ms);
  });
});

describe("applyBudgetGuard", () => {
  const router = { costUsd: 0, billedUsd: 0 };
  it("does nothing when within budget", () => {
    const r = applyBudgetGuard([planned("a", "extract-text", 0.01)], router, { limitUsd: 1, marginFloor: 0 });
    expect(r.actions).toEqual([]);
    expect(r.withinBudget).toBe(true);
  });
  it("downgrades to a cheaper capable target first and records it", () => {
    const r = applyBudgetGuard([planned("big", "extract-text", 0.05, [["small", 0.01, 0.8]])], router, { limitUsd: 0.02, marginFloor: 0 });
    expect(r.actions.map((a) => a.action)).toEqual(["downgrade"]);
    expect(r.planned[0]!.assignment.targetId).toBe("small");
    expect(r.withinBudget).toBe(true);
  });
  it("skips enrichment roles and defers content roles when nothing cheaper exists", () => {
    const r = applyBudgetGuard(
      [planned("chart", "chart-data", 0.05), planned("text", "extract-text", 0.04)],
      router,
      { limitUsd: 0, marginFloor: 0 },
    );
    expect(r.actions.map((a) => a.action).sort()).toEqual(["defer", "skip"]);
    expect(r.deferred).toHaveLength(1);
    expect(r.planned.find((p) => p.assignment.role === "skip")).toBeTruthy();
    expect(r.withinBudget).toBe(true);
  });
  it("enforces the margin floor, not just the limit", () => {
    // billed = 1.2x cost -> margin 16.7%; floor 0.5 forces degradation
    const r = applyBudgetGuard([planned("big", "extract-text", 0.05, [["free", 0, 0.7]])], router, { limitUsd: 10, marginFloor: 0.5 });
    expect(r.actions.length).toBeGreaterThan(0);
    expect(r.planned[0]!.assignment.targetId).toBe("free");
  });
});

import { describe, expect, it } from "vitest";
import {
  aiBilledUsd,
  applyBudgetGuard,
  estimateChunk,
  estimateRouterCost,
  estimateTargetCost,
  margin,
  type PlannedAssignment,
} from "./estimate.js";
import { priceAiUsageEvent } from "@docslurp/shared";
import { buildLocalComputeUsageEvent } from "../pipeline/local-compute-cost.js";
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
  it("prices hosted VLMs from tokens and catalog pricing, without inventing resource revenue", () => {
    const c = estimateTargetCost(t("vlm:openrouter/google/gemini-3.5-flash"), "chart-data", page);
    expect(c.costUsd).toBeGreaterThan(0);
    expect(c.billedUsd).toBe(0);
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

describe("receipt revenue parity", () => {
  it("does not turn CPU/GPU internal list references into customer revenue", () => {
    const receipt = buildLocalComputeUsageEvent({
      metric: "worker-page",
      observation: { cpuSeconds: 1, memoryGbSeconds: 2, gpuSeconds: 1 },
      env: { DOCSLURP_BILL_COMPUTE: "true" },
    });
    expect(receipt.metadata?.billable).toBe(false);
    expect(Number(receipt.metadata?.internalListCredits)).toBeGreaterThan(0);
    for (const target of catalog.filter((x) => ["native", "local-ocr", "local-labeler", "private-vlm"].includes(x.kind))) {
      for (const scope of [page, { kind: "region", bbox: { x: 0, y: 0, width: 10, height: 10 } } as const]) {
        const estimate = estimateTargetCost(target, "ocr", scope, undefined, { [target.id]: { cost: 2 } });
        expect(estimate.costUsd).toBeGreaterThan(0);
        expect(estimate.billedUsd).toBe(0);
      }
    }
  });

  it("keeps hosted and decision AI estimates consistent with cost-only receipts", () => {
    const target = t("vlm:openrouter/google/gemini-3.5-flash");
    const estimate = estimateTargetCost(target, "ocr", page);
    const receipt = priceAiUsageEvent<{ provider: string; metric: string; costCents: number; metadata?: Record<string, unknown> }>({ provider: "openrouter", metric: "page-analysis", costCents: estimate.costUsd * 100 });
    expect(receipt.metadata?.billable).toBe(false);
    expect(receipt.costCents).toBe(0);
    expect(estimate.billedUsd).toBe(0);
    expect(aiBilledUsd(estimate.costUsd)).toBe(0);
    expect(estimateRouterCost({ model: { pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 0, checkedAt: "x" }, maxQuestionsPerRequest: 128 }, pages: 1, questionsPerPage: 1, pagesPerCall: 1, tilePx: 384 }).billedUsd).toBe(0);
  });

  it("still defers positive-cost local work at a positive margin floor", () => {
    const target = t("vlm:private/lightonocr-3");
    const estimate = estimateTargetCost(target, "ocr", page);
    const p = planned(target.id, "extract-text", estimate.costUsd);
    p.billedUsd = estimate.billedUsd;
    p.primary.billedUsd = estimate.billedUsd;
    const result = applyBudgetGuard([p], { costUsd: 0, billedUsd: 0 }, { limitUsd: 1, marginFloor: 0.5 });
    expect(result.deferred).toHaveLength(1);
    expect(result.planned).toHaveLength(0);
    expect(result.actions[0]?.action).toBe("defer");
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
  it("keeps content assignments when the router's own sunk cost alone breaks the budget", () => {
    // A decision-model triage call billed at 1.2x has a 16.7% margin, below a 0.5 floor. Deferring
    // the page's only (high-margin) local OCR assignment cannot restore the floor; it would only
    // leave the page unrouted.
    const triage = { costUsd: 0.0000644, billedUsd: 0.0000644 * 1.2 };
    const ocr = planned("ocr", "extract-text", 0.0000088);
    ocr.billedUsd = 0.0000292;
    ocr.primary = { ...ocr.primary, billedUsd: 0.0000292 };
    const r = applyBudgetGuard([ocr], triage, { limitUsd: 1, marginFloor: 0.5 });
    expect(r.planned.map((p) => p.assignment.targetId)).toEqual(["ocr"]);
    expect(r.deferred).toEqual([]);
    expect(r.withinBudget).toBe(false);
  });
  it("still defers content past the spend limit even when the router alone breaks the margin floor", () => {
    const triage = { costUsd: 0.001, billedUsd: 0.0012 };
    const r = applyBudgetGuard([planned("vlm", "extract-text", 0.05)], triage, { limitUsd: 0.02, marginFloor: 0.5 });
    expect(r.deferred).toHaveLength(1);
    expect(r.planned).toEqual([]);
  });
  it("still defers content when removing it can restore the budget", () => {
    const r = applyBudgetGuard([planned("text", "extract-text", 0.04)], { costUsd: 0.001, billedUsd: 0.01 }, { limitUsd: 0.02, marginFloor: 0.5 });
    expect(r.deferred).toHaveLength(1);
    expect(r.withinBudget).toBe(true);
  });
  it("enforces the margin floor, not just the limit", () => {
    // billed = 1.2x cost -> margin 16.7%; floor 0.5 forces degradation
    const r = applyBudgetGuard([planned("big", "extract-text", 0.05, [["free", 0, 0.7]])], router, { limitUsd: 10, marginFloor: 0.5 });
    expect(r.actions.length).toBeGreaterThan(0);
    expect(r.planned[0]!.assignment.targetId).toBe("free");
  });
});

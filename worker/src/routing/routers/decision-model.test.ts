import { describe, expect, it } from "vitest";
import { routePlanSchema, buildDecisionModelCatalog, type DecisionAnswers, type PageInput } from "@docslurp/shared";
import { DecisionModelRouter, hasHealthyTextLayer } from "./decision-model.js";
import type { Triage } from "../triage.js";
import { BIG_BUDGET, makePage, testCatalog, testPack } from "../testing.js";

const model = buildDecisionModelCatalog({ env: { PERPLEXITYAI_API_KEY: true } }).models[0]!;

const src = { decisionModel: model.id, format: "named-images" as const, pagesPerCall: 9, tilePx: 384 };
const ans = (p: DecisionAnswers["probabilities"], image_kind?: NonNullable<DecisionAnswers["choices"]["image_kind"]>): DecisionAnswers => ({
  probabilities: p, choices: image_kind ? { image_kind } : {}, source: src,
});

function mockTriage(byPage: Record<number, DecisionAnswers>, costCents = 0.01) {
  const seen: number[][] = [];
  const triage: Triage = {
    async triagePages(pages, opts) {
      seen.push(pages.map((p) => p.features.pageNumber));
      opts?.onCall?.(
        { answers: {}, usage: { inputTokens: 1000, outputTokens: 0 }, latencyMs: 5, costCents, model: model.id, provider: "mock" },
        { pages: pages.map((p) => p.features.pageNumber), format: "named-images", model },
      );
      return new Map(pages.map((p) => [p.features.pageNumber, byPage[p.features.pageNumber]!] as const).filter(([, a]) => a));
    },
  };
  return { triage, seen };
}

describe("DecisionModelRouter", () => {
  const catalog = testCatalog();
  const pack = testPack();
  const prose = makePage({ pageNumber: 1, words: 500 });
  const withChart = makePage({ pageNumber: 2, words: 300, images: [{ coverage: 0.3 }] });
  const unsure = makePage({ pageNumber: 3, words: 40, textLayer: "suspect" });

  it("skips the decision model for healthy text pages and triages the rest", async () => {
    expect(hasHealthyTextLayer(prose)).toBe(true);
    const { triage, seen } = mockTriage({
      2: ans({ trust_text_layer: 0.95, needs_math_extraction: 0.02, needs_table_structure: 0.02 }, [{ imageIndex: 0, probabilities: { "chart-graph": 0.92 } }]),
      3: ans({ trust_text_layer: 0.1, needs_math_extraction: 0.9 }),
    });
    const router = new DecisionModelRouter({ pack, model, triage });
    const plan = await router.plan([prose, withChart, unsure], catalog, BIG_BUDGET, "cost-quality");
    expect(() => routePlanSchema.parse(plan)).not.toThrow();
    expect(seen).toEqual([[2, 3]]);
    expect(plan.triage).toMatchObject({ ran: true, decisionModel: model.id, format: "named-images", pagesPerCall: 9 });
    expect(plan.triage.costUsd).toBeCloseTo(0.0001);
    expect(plan.chunkEstimate.routerCostUsd).toBeCloseTo(0.0001);
    expect(plan.decisionModelCalls).toHaveLength(1);
    const roles = (n: number) => plan.assignments.filter((a) => a.pageNumber === n).map((a) => a.role).sort();
    expect(roles(1)).toEqual(["accept-text"]);
    expect(roles(2)).toEqual(["accept-text", "chart-data"]);
    expect(roles(3)).toEqual(["math"]);
  });

  it("skips triage when no page needs it (shouldTriage) and never calls the model", async () => {
    const { triage, seen } = mockTriage({});
    const plan = await new DecisionModelRouter({ pack, model, triage, freeShortcut: false }).plan([prose], catalog, BIG_BUDGET, "cost-quality");
    expect(seen).toEqual([]);
    expect(plan.triage.ran).toBe(false);
    expect(plan.triage.skippedReason).toBeTruthy();
    expect(plan.assignments[0]!.role).toBe("accept-text");
  });

  it("skips triage when the router would eat the budget", async () => {
    const { triage, seen } = mockTriage({});
    const plan = await new DecisionModelRouter({ pack, model, triage }).plan([unsure], catalog, { limitUsd: 1e-9, marginFloor: 0 }, "cost-quality");
    expect(seen).toEqual([]);
    expect(plan.triage.skippedReason).toBe("router-over-budget");
  });

  it("falls back to free features and keeps billed spend when triage throws", async () => {
    const triage: Triage = {
      async triagePages(pages: PageInput[], opts) {
        opts?.onCall?.({ answers: {}, usage: { inputTokens: 10, outputTokens: 0 }, latencyMs: 1, costCents: 0.5, model: model.id, provider: "m" }, { pages: [3], format: "named-images", model });
        throw new Error("boom");
      },
    };
    const plan = await new DecisionModelRouter({ pack, model, triage }).plan([unsure], catalog, BIG_BUDGET, "cost-quality");
    expect(plan.triage.ran).toBe(false);
    expect(plan.triage.skippedReason).toMatch(/triage-failed: boom/);
    expect(plan.chunkEstimate.routerCostUsd).toBeCloseTo(0.005);
    expect(plan.assignments.length).toBeGreaterThan(0);
  });

  it("uses precomputed page decisions without calling triage", async () => {
    const { triage, seen } = mockTriage({});
    const page = makePage({ pageNumber: 4, words: 40, textLayer: "suspect" });
    page.features.decisions = ans({ trust_text_layer: 0.1, needs_table_structure: 0.95 });
    const plan = await new DecisionModelRouter({ pack, model, triage }).plan([page], catalog, BIG_BUDGET, "cost-quality");
    expect(seen).toEqual([]);
    expect(plan.assignments.map((a) => a.role)).toEqual(["table"]);
  });
});

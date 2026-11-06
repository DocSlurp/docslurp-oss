import { afterEach, describe, expect, it } from "vitest";
import { compilePipelinePlan, DISTINCT_TEST_PRICING, installTestPricing, type PipelineRunStage } from "@docslurp/shared";
import { pageBaseFeeMultiplier } from "../db/page-base-fee.js";

const plan = (stageOrder: PipelineRunStage[], reusedStages: PipelineRunStage[] = []) => ({ stageOrder, reusedStages });

describe("pageBaseFeeMultiplier", () => {
  afterEach(() => { installTestPricing(DISTINCT_TEST_PRICING); });

  it("charges full runs the whole fee", () => {
    expect(pageBaseFeeMultiplier(compilePipelinePlan({}))).toBe(1);
  });

  it("asks the pricing provider for a partial run's share, with the stages it executes and reuses", () => {
    const seen: unknown[] = [];
    installTestPricing({ ...DISTINCT_TEST_PRICING, pageChargeShare: (args) => { seen.push(args); return 0.25; } });
    const reindex = compilePipelinePlan({ stageSubset: ["embed", "index"] } as never);
    expect(reindex.reusedStages.length).toBeGreaterThan(0);
    expect(pageBaseFeeMultiplier(reindex)).toBe(0.25);
    expect(seen).toEqual([{ stageOrder: reindex.stageOrder, reusedStages: reindex.reusedStages }]);
  });

  it("clamps a provider's share to [0, 1] and refuses a non-number", () => {
    installTestPricing({ ...DISTINCT_TEST_PRICING, pageChargeShare: () => 7 });
    expect(pageBaseFeeMultiplier(plan(["embed"], ["extract-markdown"]))).toBe(1);
    installTestPricing({ ...DISTINCT_TEST_PRICING, pageChargeShare: () => -2 });
    expect(pageBaseFeeMultiplier(plan(["embed"], ["extract-markdown"]))).toBe(0);
    installTestPricing({ ...DISTINCT_TEST_PRICING, pageChargeShare: () => Number.NaN });
    expect(() => pageBaseFeeMultiplier(plan(["embed"], ["extract-markdown"]))).toThrow(/invalid page charge share/);
  });
});

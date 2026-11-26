import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { estimatePipelineWork } from "../config-change.js";
import {
  compilePipelinePlan,
  defaultPipelineFeatures,
  installPricingProvider,
  normalizePipelineFeatures,
  OPEN_PRICING,
  pipelineFieldsForQuality,
  pipelineProfileIdFor,
  resetPricingProviderForTests,
  withoutStageSelection,
  type IngestEstimate,
  type IngestEstimateInput,
  type PipelineFeatures,
  type PipelineRunStage,
} from "../index.js";

/*
 * A run or reprocess estimate is what a caller agrees to before the run charges. Its high end must cover what the
 * worker can then charge for the same pages (db/page-base-fee.ts): every OCR or vision read in full, as the page is read,
 * and the remaining pages Fast at completion at the provider's page charge share. These tests price with a synthetic
 * provider (illustrative unit prices, not the hosted price list) and compare the estimate with that charge.
 */

const UNIT = { fast: 1, ocr: 3, rich: 10 } as const;
/** Illustrative: an answer up to 1,000 output tokens is one Rich page, each further 1,000 one more. */
const richPagesFor = (tokens: number | null | undefined) => 1 + Math.max(0, Math.ceil(((tokens ?? 0) - 1_000) / 1_000));

function testEstimateIngest(input: IngestEstimateInput): IngestEstimate {
  const open = OPEN_PRICING.estimateIngest(input);
  const total = Math.max(0, (input.mix.text ?? 0) + (input.mix.complex ?? 0) + (input.mix.scanned ?? 0)) || 1;
  const pages = Math.max(0, Math.round(input.pages));
  const scanned = pages * (input.mix.scanned ?? 0) / total;
  const other = pages - scanned;
  const profile = input.profile ?? "fastest";
  const ocrPages = profile === "fastest" ? scanned : 0;
  const richPages = profile === "smartest" || profile === "visual" ? scanned : 0;
  const fastPages = other + (profile === "fast" ? scanned : 0) + Math.max(0, input.fastOnlyPages ?? 0);
  const breakdown = { fast: fastPages * UNIT.fast, ocr: ocrPages * UNIT.ocr, rich: richPages * UNIT.rich, media: 0, features: 0 };
  return { ...open, fastPages, ocrPages, richPages, credits: { totalCredits: breakdown.fast + breakdown.ocr + breakdown.rich, breakdown } };
}

const env = { STRIPE_SECRET_KEY: "sk_test" };
const base = normalizePipelineFeatures(defaultPipelineFeatures);
const at = (quality: "fastest" | "smartest"): PipelineFeatures => ({ ...base, ...pipelineFieldsForQuality(quality, { readScans: true }) }) as PipelineFeatures;

/** The stages a reprocess of `subset` executes, compiled as the worker compiles it. */
const subsetStages = (features: PipelineFeatures, subset: PipelineRunStage[]) =>
  compilePipelinePlan({ ...withoutStageSelection(features), stageSubset: subset } as PipelineFeatures);

/** The provider's completion share for a run of `stages` out of the full plan (pageChargeShare). */
const countShare = (stages: readonly string[], planned: readonly string[]) => {
  const reused = planned.filter((stage) => !stages.includes(stage));
  return reused.length === 0 ? 1 : stages.length / (stages.length + reused.length);
};

beforeEach(() => {
  installPricingProvider({
    ...OPEN_PRICING,
    id: "test-run-estimate",
    estimateIngest: testEstimateIngest,
    pageCredits: (mode, pages) => UNIT[mode as keyof typeof UNIT] * pages,
    richPagesForOutputTokens: richPagesFor,
    pageChargeShare: (plan) => countShare(plan.stageOrder, [...plan.stageOrder, ...plan.reusedStages]),
  });
});
afterEach(() => resetPricingProviderForTests());

describe("run estimate high end covers the charge that follows", () => {
  const pages = 400;

  it("Fastest, every page a scan, full run: each page is one OCR read", () => {
    const features = at("fastest");
    expect(pipelineProfileIdFor(features)).toBe("fastest");
    const stages = compilePipelinePlan(features).stageOrder;
    const estimate = estimatePipelineWork({ features, stages, pages, documents: 4, env });
    expect(estimate.credits!.high).toBeGreaterThanOrEqual(pages * UNIT.ocr);
  });

  it("Smartest, every page a scan read by the vision model with a dense page's output", () => {
    const features = at("smartest");
    expect(pipelineProfileIdFor(features)).toBe("smartest");
    const stages = compilePipelinePlan(features).stageOrder;
    const estimate = estimatePipelineWork({ features, stages, pages, documents: 4, env });
    // A dense full page's answer (the upload quote's high end assumes the same output) bills richPagesFor(2,000) pages.
    expect(estimate.credits!.high).toBeGreaterThanOrEqual(pages * UNIT.rich * richPagesFor(2_000));
  });

  it("a reprocess that re-runs extraction pays every read in full, not the stage's share of the run", () => {
    const features = at("fastest");
    const plan = subsetStages(features, ["extract-markdown"]);
    expect(plan.stageOrder).toContain("extract-markdown");
    const estimate = estimatePipelineWork({ features, stages: plan.stageOrder, pages, documents: 4, env });
    expect(estimate.credits!.high).toBeGreaterThanOrEqual(pages * UNIT.ocr);
  });

  it("a reprocess that reads no page pays the provider's completion share of every page Fast", () => {
    const features = at("fastest");
    const planned = compilePipelinePlan(features).stageOrder;
    const plan = subsetStages(features, ["embed"]);
    expect(plan.stageOrder).not.toContain("extract-markdown");
    const charge = pages * UNIT.fast * countShare(plan.stageOrder, planned);
    const estimate = estimatePipelineWork({ features, stages: plan.stageOrder, pages, documents: 4, env });
    expect(estimate.credits!.high).toBeGreaterThanOrEqual(charge);
  });

  it("keeps the low end at the all-text price and never above the high end", () => {
    const features = at("fastest");
    const stages = compilePipelinePlan(features).stageOrder;
    const estimate = estimatePipelineWork({ features, stages, pages, documents: 4, env });
    expect(estimate.credits!.low).toBeCloseTo(pages * UNIT.fast, 3);
    expect(estimate.credits!.low).toBeLessThanOrEqual(estimate.credits!.high);
  });

  it("an Auto ladder share caps the pages the high end reads", () => {
    const features = { ...at("smartest"), ladder: { ...at("smartest").ladder, maxEscalationShare: { aboveFast: 0.25 } } } as PipelineFeatures;
    const stages = compilePipelinePlan(features).stageOrder;
    const capped = estimatePipelineWork({ features, stages, pages, documents: 4, env });
    const uncapped = estimatePipelineWork({ features: at("smartest"), stages: compilePipelinePlan(at("smartest")).stageOrder, pages, documents: 4, env });
    expect(capped.credits!.high).toBeLessThan(uncapped.credits!.high);
  });
});

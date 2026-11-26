import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { estimatePipelineWork, ladderReadPagesHigh, PAGE_READ_CHARGING_STAGES } from "../config-change.js";
import {
  compilePipelinePlan,
  defaultPipelineFeatures,
  DISTINCT_TEST_PRICING,
  installTestPricing,
  ladderShareBudget,
  normalizePipelineFeatures,
  OPEN_PRICING,
  pipelineFieldsForQuality,
  pipelineProfileIdFor,
  resetPricingProviderForTests,
  TEST_PAGE_CREDITS,
  withoutStageSelection,
  type IngestEstimate,
  type IngestEstimateInput,
  type PipelineFeatures,
  type PipelineRunStage,
} from "../index.js";

/*
 * A run or reprocess estimate is what a caller agrees to before the run charges. Its high end must cover what the worker
 * can then charge for the same pages: every OCR or vision read in full, as the page is read, and the remaining pages Fast at
 * completion at the provider's page charge share. These tests price with core's distinct test provider (arbitrary numbers,
 * not any deployment's) and an equally arbitrary test ingest estimate, and compare the estimate with that charge.
 */

/** Test only: Rich pages the high end counts per vision read. Arbitrary, distinct from the open default's 1. */
const TEST_HIGH_RICH_PAGES_PER_READ = 3;

/** Test only: scans read by OCR on `fastest`, by vision on `smartest` and `visual`, Fast otherwise. */
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
  const breakdown = { fast: fastPages * TEST_PAGE_CREDITS.fast, ocr: ocrPages * TEST_PAGE_CREDITS.ocr, rich: richPages * TEST_PAGE_CREDITS.rich, media: 0, features: 0 };
  return { ...open, fastPages, ocrPages, richPages, credits: { totalCredits: breakdown.fast + breakdown.ocr + breakdown.rich, breakdown } };
}

const env = { STRIPE_SECRET_KEY: "sk_test" };
const base = normalizePipelineFeatures(defaultPipelineFeatures);
/** Optional features off, so page charges are compared alone. */
const plain = (features: PipelineFeatures): PipelineFeatures => ({ ...features, summarize: false, outputSchema: undefined, graphRag: false, propositionIndex: false } as PipelineFeatures);
const at = (quality: "fastest" | "smartest"): PipelineFeatures => plain({ ...base, ...pipelineFieldsForQuality(quality, { readScans: true }) } as PipelineFeatures);
const withShare = (features: PipelineFeatures, aboveFast: number): PipelineFeatures =>
  ({ ...features, ladder: { ...features.ladder, maxEscalationShare: { aboveFast } } }) as PipelineFeatures;

/** The stages a reprocess of `subset` executes, compiled as the worker compiles it. */
const subsetStages = (features: PipelineFeatures, subset: PipelineRunStage[]) =>
  compilePipelinePlan({ ...withoutStageSelection(features), stageSubset: subset } as PipelineFeatures);

const full = (features: PipelineFeatures) => compilePipelinePlan(features).stageOrder;
const rich = TEST_PAGE_CREDITS.rich;
const ocr = TEST_PAGE_CREDITS.ocr;
const fast = TEST_PAGE_CREDITS.fast;

describe("run estimate high end covers the charge that follows", () => {
  beforeEach(() => {
    installTestPricing({ ...DISTINCT_TEST_PRICING, estimateIngest: testEstimateIngest, estimateHighRichPagesPerRead: () => TEST_HIGH_RICH_PAGES_PER_READ });
  });
  afterEach(() => resetPricingProviderForTests());
  const pages = 400;

  it("Fastest, every page a scan, full run: each page one OCR read, and no more", () => {
    const features = at("fastest");
    expect(pipelineProfileIdFor(features)).toBe("fastest");
    const estimate = estimatePipelineWork({ features, stages: full(features), pages, documents: 4, env });
    expect(estimate.credits!.high).toBeGreaterThanOrEqual(pages * ocr);
    expect(estimate.credits!.high).toBeLessThan(pages * ocr * 1.01);
  });

  it("Smartest, every page a vision read at the provider's planning size", () => {
    const features = at("smartest");
    expect(pipelineProfileIdFor(features)).toBe("smartest");
    const estimate = estimatePipelineWork({ features, stages: full(features), pages, documents: 4, env });
    expect(estimate.credits!.high).toBeGreaterThanOrEqual(pages * rich * TEST_HIGH_RICH_PAGES_PER_READ);
    expect(estimate.credits!.high).toBeLessThan(pages * rich * TEST_HIGH_RICH_PAGES_PER_READ * 1.01);
    expect(estimate.basis).toMatch(/Very dense pages .* can bill more than the high end/);
    expect(estimate.basis).toMatch(/cost cap/);
  });

  it("the open default counts one Rich page per vision read", () => {
    installTestPricing({ ...DISTINCT_TEST_PRICING, estimateIngest: testEstimateIngest });
    const features = at("smartest");
    const estimate = estimatePipelineWork({ features, stages: full(features), pages, documents: 4, env });
    expect(estimate.credits!.high).toBeGreaterThanOrEqual(pages * rich);
    expect(estimate.credits!.high).toBeLessThan(pages * rich * 1.01);
  });

  it("a reprocess that re-runs extraction pays every read in full, not the stage's share of the run", () => {
    const features = at("fastest");
    const plan = subsetStages(features, ["extract-markdown"]);
    expect(plan.stageOrder).toContain("extract-markdown");
    const estimate = estimatePipelineWork({ features, stages: plan.stageOrder, pages, documents: 4, env });
    expect(estimate.credits!.high).toBeGreaterThanOrEqual(pages * ocr);
    expect(estimate.credits!.high).toBeLessThan(pages * ocr * 1.01);
  });

  it("a reprocess that reads no page pays the provider's completion share of every page Fast, and its low end is no higher", () => {
    const features = at("fastest");
    const plan = subsetStages(features, ["embed"]);
    expect(plan.stageOrder.some((stage) => PAGE_READ_CHARGING_STAGES.includes(stage))).toBe(false);
    // The test provider charges a partial run half the completion page charge.
    const charge = pages * fast * 0.5;
    const estimate = estimatePipelineWork({ features, stages: plan.stageOrder, pages, documents: 4, env });
    expect(estimate.credits!.high).toBeGreaterThanOrEqual(charge);
    expect(estimate.credits!.high).toBeLessThan(charge * 1.01);
    expect(estimate.credits!.low).toBeLessThanOrEqual(charge);
  });

  it("a partial reprocess is strictly cheaper than a full run under a provider with a partial completion share", () => {
    const features = at("fastest");
    const whole = estimatePipelineWork({ features, stages: full(features), pages, documents: 4, env });
    const small = estimatePipelineWork({ features, stages: subsetStages(features, ["index"]).stageOrder, pages, documents: 4, env });
    expect(small.credits!.high).toBeLessThan(whole.credits!.high);
    expect(small.credits!.low).toBeLessThan(whole.credits!.low);
  });

  it("the low end is the all-text price over the pages the completion charge includes, never above the high end", () => {
    const features = at("fastest");
    const estimate = estimatePipelineWork({ features, stages: full(features), pages, documents: 4, env });
    expect(estimate.credits!.low).toBeCloseTo(pages * fast, 3);
    expect(estimate.credits!.low).toBeLessThanOrEqual(estimate.credits!.high);
    // Only 100 of the pages are measured documents the completion charge includes: the low end counts those.
    const partly = estimatePipelineWork({ features, stages: full(features), pages, documents: 4, low: { pages: 100, documents: 1 }, unmeasuredDocuments: 3, env });
    expect(partly.credits!.low).toBeCloseTo(100 * fast, 3);
    expect(partly.credits!.high).toBeCloseTo(estimate.credits!.high, 3);
    expect(partly.basis).toMatch(/3 not yet measured/);
  });

  it("an Auto ladder share caps reads per document with a floor of one page each", () => {
    const features = withShare(at("smartest"), 0.1);
    // 1,000 one-page scans: the worker may read every one (ladderShareBudget floors each document at 1 page).
    const documents = 1_000;
    const perDocument = Array.from({ length: documents }, () => ladderShareBudget(0.1, 1));
    const charge = perDocument.reduce((sum, count) => sum + count, 0) * rich * TEST_HIGH_RICH_PAGES_PER_READ;
    expect(charge).toBe(1_000 * rich * TEST_HIGH_RICH_PAGES_PER_READ);
    const estimate = estimatePipelineWork({ features, stages: full(features), pages: 1_000, documents, env });
    expect(estimate.credits!.high).toBeGreaterThanOrEqual(charge);
    expect(estimate.credits!.high).toBeLessThan(charge * 1.01);
  });

  it("with each document's page count the ladder cap is exact, and still caps a large document", () => {
    const features = withShare(at("smartest"), 0.25);
    expect(ladderReadPagesHigh({ features, pages: 400, documents: 4, documentPages: [100, 100, 100, 100] })).toBe(100);
    expect(ladderReadPagesHigh({ features, pages: 400, documents: 4 })).toBe(104);
    const capped = estimatePipelineWork({ features, stages: full(features), pages: 400, documents: 4, documentPages: [100, 100, 100, 100], env });
    const uncapped = estimatePipelineWork({ features: at("smartest"), stages: full(at("smartest")), pages: 400, documents: 4, env });
    expect(capped.credits!.high).toBeLessThan(uncapped.credits!.high);
    expect(capped.credits!.high).toBeGreaterThanOrEqual(100 * rich * TEST_HIGH_RICH_PAGES_PER_READ);
  });

  it("a reprocess of page embedding alone charges exactly one Rich page per page, at both ends", () => {
    const features = { ...at("smartest"), indexingMode: "visual" } as PipelineFeatures;
    const plan = subsetStages(features, ["page-embed"]);
    expect(plan.stageOrder).toContain("page-embed");
    expect(plan.stageOrder).not.toContain("extract-markdown");
    const estimate = estimatePipelineWork({ features, stages: plan.stageOrder, pages, documents: 4, env });
    // One Rich page per embedded page, never the planning figure for a dense answer (an embedding has no output tokens).
    expect(estimate.credits!.high).toBeGreaterThanOrEqual(pages * rich);
    expect(estimate.credits!.high).toBeLessThan(pages * rich * 1.01);
    // The charge is certain: the low end carries it too.
    expect(estimate.credits!.low).toBeCloseTo(pages * rich, 3);
    expect(estimate.basis).toMatch(/one Rich page per page it embeds/);
  });

  it("an Auto ladder limit keeps page embedding off: a visual run under Fastest reads no page and bills Fast at completion", () => {
    const features = { ...at("fastest"), indexingMode: "visual" } as PipelineFeatures;
    // Visual mode runs page-embed in place of extraction, and page-embed refuses under a ladder limit (worker page-embed.ts).
    expect(full(features)).not.toContain("extract-markdown");
    const estimate = estimatePipelineWork({ features, stages: full(features), pages, documents: 4, env });
    expect(estimate.credits!.high).toBeGreaterThanOrEqual(pages * fast * 0.05);
    expect(estimate.credits!.high).toBeLessThan(pages * ocr);
  });

  it("pages of fast-only formats bill Fast at both ends, whatever the quality", () => {
    const features = at("smartest");
    const officePages = 300;
    const estimate = estimatePipelineWork({ features, stages: full(features), pages, documents: 4, fastOnlyPages: officePages,
      low: { pages, documents: 4, fastOnlyPages: officePages }, env });
    const charge = (pages - officePages) * rich * TEST_HIGH_RICH_PAGES_PER_READ + officePages * fast;
    expect(estimate.credits!.high).toBeGreaterThanOrEqual(charge);
    expect(estimate.credits!.high).toBeLessThan(charge * 1.01);
    // A failed spreadsheet only: every page Fast, so the high end is the Fast charge of its pages, not a vision read of each.
    const sheet = estimatePipelineWork({ features, stages: full(features), pages: 4_096, documents: 1, fastOnlyPages: 4_096, low: { pages: 0, documents: 0 }, env });
    expect(sheet.credits!.high).toBeGreaterThanOrEqual(4_096 * fast);
    expect(sheet.credits!.high).toBeLessThan(4_096 * fast * 1.01);
    expect(sheet.basis).toMatch(/4096 pages of Word, slide, sheet and other Office files bill Fast/);
  });

  it("the document map reads at most min(60, ceil(5% of pages)) per document, not every page", () => {
    const features = { ...at("smartest"), indexingMode: "map" } as PipelineFeatures;
    const plan = subsetStages(features, ["document-map"]);
    expect(plan.stageOrder).toContain("document-map");
    expect(plan.stageOrder).not.toContain("extract-markdown");
    expect(plan.stageOrder).not.toContain("vision-extract");
    // 4 documents of 100 pages: at most ceil(0.05 x 100) = 5 reads each.
    const reads = 4 * Math.min(60, Math.ceil(0.05 * 100));
    const estimate = estimatePipelineWork({ features, stages: plan.stageOrder, pages, documents: 4, env });
    // Over totals the bound is ceil(5% of 400) + one per document = 24 reads; the rest Fast at completion.
    expect(estimate.credits!.high).toBeGreaterThanOrEqual(reads * rich * TEST_HIGH_RICH_PAGES_PER_READ);
    expect(estimate.credits!.high).toBeLessThanOrEqual(24 * rich * TEST_HIGH_RICH_PAGES_PER_READ + pages * fast + 1e-6);
    expect(estimate.credits!.high).toBeLessThan(pages * rich);
  });

  it("audio and video left out of the pages are named in the basis", () => {
    const features = at("fastest");
    const estimate = estimatePipelineWork({ features, stages: full(features), pages, documents: 4, mediaDocuments: 2, env });
    expect(estimate.basis).toMatch(/2 audio or video documents are not included/);
  });

  it("features allow one more block per document than an even split", () => {
    const features = { ...at("fastest"), outputSchema: { type: "object", properties: { total: { type: "number" } } } } as unknown as PipelineFeatures;
    const stages = full(features);
    expect(stages).toContain("structured-extract");
    // 9 documents of 1 page and one of 71: the test provider prices 0.4 per started 8 pages per document.
    const charge = 9 * 0.4 + 0.4 * Math.ceil(71 / 8);
    const evenSplit = 10 * 0.4 * Math.ceil(8 / 8);
    expect(charge).toBeGreaterThan(evenSplit);
    const pagesOnly = estimatePipelineWork({ features: at("fastest"), stages: full(at("fastest")), pages: 80, documents: 10, env }).credits!.high;
    const estimate = estimatePipelineWork({ features, stages, pages: 80, documents: 10, env });
    expect(estimate.credits!.high - pagesOnly).toBeGreaterThanOrEqual(charge);
    expect(estimate.basis).toMatch(/text-dense documents/);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compilePipelinePlan,
  defaultPipelineFeatures,
  DISTINCT_TEST_PRICING,
  documentLadderPolicy,
  estimatePipelineWork,
  featureCredits,
  installTestPricing,
  normalizePipelineFeatures,
  OPEN_PRICING,
  PAGE_READ_CHARGING_STAGES,
  pageCredits,
  pipelineFieldsForQuality,
  resetPricingProviderForTests,
  TEST_PAGE_CREDITS,
  withoutStageSelection,
  type IngestEstimate,
  type IngestEstimateInput,
  type PipelineFeatures,
  type PipelineRunStage,
} from "@docslurp/shared";

import { pageBaseFeeMultiplier, remainingFastPages } from "./page-base-fee.js";
import { documentFeaturePages } from "../pipeline/feature-charges.js";
import { OCR_PAGE_READ_METRICS, PipelineUsageEventLedger, RICH_PAGE_READ_METRICS } from "../pipeline/usage-ledger.js";

/*
 * The run and reprocess estimate's high end against the charge the worker's own code computes for the same work: page reads
 * through the usage ledger, the completion Fast charge (remainingFastPages x pageBaseFeeMultiplier), the ladder's per-document
 * budget (documentLadderPolicy) and feature charges (documentFeaturePages). Core's distinct test pricing, not any deployment's.
 */

/** Test only: Rich pages the estimate's high end counts per vision read. */
const PER_READ = 3;
/** Test only: output tokens of a dense page's answer that the test pricing bills as PER_READ Rich pages (one more per started 800 past 800). */
const DENSE_OUTPUT_TOKENS = 2_400;

function testEstimateIngest(input: IngestEstimateInput): IngestEstimate {
  const open = OPEN_PRICING.estimateIngest(input);
  const total = Math.max(0, (input.mix.text ?? 0) + (input.mix.complex ?? 0) + (input.mix.scanned ?? 0)) || 1;
  const pages = Math.max(0, Math.round(input.pages));
  const scanned = pages * (input.mix.scanned ?? 0) / total;
  const profile = input.profile ?? "fastest";
  const ocrPages = profile === "fastest" ? scanned : 0;
  const richPages = profile === "smartest" || profile === "visual" ? scanned : 0;
  const fastPages = pages - ocrPages - richPages;
  const breakdown = { fast: fastPages * TEST_PAGE_CREDITS.fast, ocr: ocrPages * TEST_PAGE_CREDITS.ocr, rich: richPages * TEST_PAGE_CREDITS.rich, media: 0, features: 0 };
  return { ...open, fastPages, ocrPages, richPages, credits: { totalCredits: breakdown.fast + breakdown.ocr + breakdown.rich, breakdown } };
}

const env = { STRIPE_SECRET_KEY: "sk_test" };
const plain = (quality: "fastest" | "smartest"): PipelineFeatures => ({
  ...normalizePipelineFeatures(defaultPipelineFeatures), ...pipelineFieldsForQuality(quality, { readScans: true }),
  summarize: false, outputSchema: undefined, graphRag: false, propositionIndex: false,
}) as PipelineFeatures;
const withShare = (features: PipelineFeatures, aboveFast: number): PipelineFeatures =>
  ({ ...features, ladder: { ...features.ladder, maxEscalationShare: { aboveFast } } }) as PipelineFeatures;

/** What the worker charges a run over `documents` (page counts), every page a scan read by vision where the ladder allows. */
function workerCharge(features: PipelineFeatures, documents: readonly number[], vision: boolean): number {
  const ledger = new PipelineUsageEventLedger();
  ledger.runId = "run-estimate";
  let fast = 0;
  documents.forEach((pages, index) => {
    const documentId = `doc-${index}`;
    const policy = documentLadderPolicy(features, pages);
    for (let page = 1; page <= policy.aboveFastBudget; page += 1) {
      if (vision) ledger.chargeRichPage({ documentId, pageNumber: page, readBy: "page-analysis", outputTokens: DENSE_OUTPUT_TOKENS });
      else ledger.chargeOcrPage({ documentId, pageNumber: page, readBy: "page-ocr" });
    }
    fast += remainingFastPages({ pages, richRead: ledger.readPagesOf(documentId).size });
  });
  return ledger.pendingBillableCents + pageCredits("fast", fast) * pageBaseFeeMultiplier(compilePipelinePlan(features));
}

describe("estimate high end against the worker's charge", () => {
  beforeEach(() => {
    installTestPricing({ ...DISTINCT_TEST_PRICING, estimateIngest: testEstimateIngest, estimateHighRichPagesPerRead: () => PER_READ });
  });
  afterEach(() => resetPricingProviderForTests());

  it("bills a dense test answer as the planning figure's Rich pages (the fixture's premise)", () => {
    const ledger = new PipelineUsageEventLedger();
    ledger.runId = "run";
    ledger.chargeRichPage({ documentId: "d", pageNumber: 1, readBy: "page-analysis", outputTokens: DENSE_OUTPUT_TOKENS });
    expect(ledger.pendingBillableCents).toBeCloseTo(PER_READ * TEST_PAGE_CREDITS.rich, 6);
  });

  it("1,000 one-page scans under a 0.1 above-fast share: every page read, and the high end covers it", () => {
    const features = withShare(plain("smartest"), 0.1);
    const documents = Array.from({ length: 1_000 }, () => 1);
    const charge = workerCharge(features, documents, true);
    expect(charge).toBeCloseTo(1_000 * PER_READ * TEST_PAGE_CREDITS.rich, 6);
    const estimate = estimatePipelineWork({ features, stages: compilePipelinePlan(features).stageOrder, pages: 1_000, documents: 1_000, env });
    expect(estimate.credits!.high).toBeGreaterThanOrEqual(charge - 1e-9);
    expect(estimate.credits!.high).toBeLessThan(charge * 1.05);
  });

  it("mixed document sizes under a share: exact with page counts, bounded without", () => {
    const features = withShare(plain("fastest"), 0.25);
    const documents = [1, 3, 7, 40, 149];
    const pages = documents.reduce((sum, count) => sum + count, 0);
    const charge = workerCharge(features, documents, false);
    const stages = compilePipelinePlan(features).stageOrder;
    const exact = estimatePipelineWork({ features, stages, pages, documents: documents.length, documentPages: documents, env });
    const totals = estimatePipelineWork({ features, stages, pages, documents: documents.length, env });
    expect(exact.credits!.high).toBeGreaterThanOrEqual(charge - 1e-9);
    expect(exact.credits!.high).toBeLessThan(charge * 1.05);
    expect(totals.credits!.high).toBeGreaterThanOrEqual(exact.credits!.high);
    expect(totals.credits!.low).toBeLessThanOrEqual(charge + 1e-9);
  });

  it("an embed-only reprocess: the high end is the completion share of every page Fast, the low end no higher", () => {
    const features = plain("fastest");
    const plan = compilePipelinePlan({ ...withoutStageSelection(features), stageSubset: ["embed"] } as PipelineFeatures);
    const charge = pageCredits("fast", 400) * pageBaseFeeMultiplier(plan);
    const estimate = estimatePipelineWork({ features, stages: plan.stageOrder, pages: 400, documents: 4, env });
    expect(estimate.credits!.high).toBeGreaterThanOrEqual(charge - 1e-9);
    expect(estimate.credits!.high).toBeLessThan(charge * 1.05);
    expect(estimate.credits!.low).toBeLessThanOrEqual(charge + 1e-9);
  });

  it("structured fields over uneven documents: the per-document charge is within the high end", () => {
    const features = { ...plain("fastest"), outputSchema: { type: "object", properties: { total: { type: "number" } } } } as unknown as PipelineFeatures;
    const documents = [1, 1, 1, 1, 1, 1, 1, 1, 1, 71];
    const pages = documents.reduce((sum, count) => sum + count, 0);
    const featureCharge = documents.reduce((sum, count) => sum + featureCredits("structuredFields", documentFeaturePages({ pageCount: count, pageCountSource: "counted" })), 0);
    const stages = compilePipelinePlan(features).stageOrder;
    const withFeature = estimatePipelineWork({ features, stages, pages, documents: documents.length, env }).credits!.high;
    const pagesOnly = estimatePipelineWork({ features: plain("fastest"), stages: compilePipelinePlan(plain("fastest")).stageOrder, pages, documents: documents.length, env }).credits!.high;
    expect(withFeature - pagesOnly).toBeGreaterThanOrEqual(featureCharge);
  });
});

describe("PAGE_READ_CHARGING_STAGES", () => {
  it("lists every stage whose code charges a page read (OCR or Rich)", () => {
    const dir = join(import.meta.dirname, "..", "stages");
    const metrics = [...OCR_PAGE_READ_METRICS, ...RICH_PAGE_READ_METRICS].map((metric) => metric.replace(/[-]/g, "\\-")).join("|");
    const charges = new RegExp(`chargeOcrPage\\(|chargeRichPage\\(|metric:\\s*"(?:${metrics})"`);
    const charging = readdirSync(dir)
      .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
      .filter((file) => charges.test(readFileSync(join(dir, file), "utf8")))
      .map((file) => file.replace(/\.ts$/, ""));
    expect(charging.length).toBeGreaterThan(0);
    for (const stage of charging) expect(PAGE_READ_CHARGING_STAGES).toContain(stage as PipelineRunStage);
  });
});

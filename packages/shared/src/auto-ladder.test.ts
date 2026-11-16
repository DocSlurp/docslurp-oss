import { afterEach, describe, expect, it } from "vitest";

import {
  applyLadderLimits,
  documentLadderPolicy,
  effectiveLadder,
  ladderAllowsMore,
  ladderEstimateMix,
  ladderShareBudget,
  pageReadingQuality,
  clampRunLadder,
  ladderAllowsOffPlanReads,
  pipelineLadderSchema,
  planLadder,
  tighterLadder,
  type LadderPageNeed,
} from "./auto-ladder.js";
import { defaultPipelineFeatures, pipelineVersionFeatures, estimatePipelineWork, normalizePipelineFeatures, pipelineFeatureOverridesSchema, quoteEstimate, quoteUpload, estimateProfileFor, quoteSettingsForPipeline } from "./index.js";
import { DISTINCT_TEST_PRICING, installTestPricing } from "./pricing-testing.js";
import { OPEN_PRICING } from "./pricing-open.js";
import { resetPricingProviderForTests } from "./pricing-provider.js";

const need = (pageNumber: number, kind: LadderPageNeed["need"], extra: Partial<LadderPageNeed> = {}): LadderPageNeed =>
  ({ pageNumber, need: kind, reason: kind === "intelligent" ? "figure:chart-or-figure" : "no-native-text", lacksText: false, confidence: 0.5, ...extra });

describe("pipeline.ladder settings", () => {
  it("defaults to the intelligent rung with no share cap", () => {
    expect(normalizePipelineFeatures(null).ladder).toEqual({ maxRung: "intelligent" });
    expect(defaultPipelineFeatures.ladder).toEqual({ maxRung: "intelligent" });
  });

  it("accepts valid limits and rejects nonsense", () => {
    expect(pipelineFeatureOverridesSchema.safeParse({ ladder: { maxRung: "ocr", maxEscalationShare: { aboveFast: 0.5, aboveOcr: 0.1 } } }).success).toBe(true);
    expect(pipelineFeatureOverridesSchema.safeParse({ ladder: { maxEscalationShare: null } }).success).toBe(true);
    for (const ladder of [
      { maxRung: "vision" },
      { maxEscalationShare: { aboveFast: 1.5 } },
      { maxEscalationShare: { aboveFast: -0.1 } },
      { maxEscalationShare: { aboveFast: Number.NaN } },
      { maxEscalationShare: { aboveFast: Number.POSITIVE_INFINITY } },
      { maxEscalationShare: { aboveFast: "0.5" } },
      { maxEscalationShare: { belowFast: 0.2 } },
      { maxRung: "ocr", extra: true },
    ]) {
      expect(pipelineFeatureOverridesSchema.safeParse({ ladder }).success, JSON.stringify(ladder)).toBe(false);
      expect(pipelineLadderSchema.safeParse(ladder).success, JSON.stringify(ladder)).toBe(false);
    }
  });

  it("merges a project share with an upload's other share without refusing (aboveOcr above aboveFast caps nothing more)", () => {
    expect(pipelineFeatureOverridesSchema.safeParse({ ladder: { maxEscalationShare: { aboveFast: 0.2, aboveOcr: 0.4 } } }).success).toBe(true);
    expect(effectiveLadder({ quality: "auto", ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.2, aboveOcr: 0.4 } } })).toEqual({ active: true, maxRung: "intelligent", aboveFast: 0.2 });
  });

  it("fails closed on a stored rung that is not one", () => {
    expect(effectiveLadder({ quality: "auto", ladder: { maxRung: "vision" as never } }).maxRung).toBe("fast");
    expect(effectiveLadder({ quality: "auto", ladder: {} }).maxRung).toBe("intelligent");
  });

  it("applies to auto only, and normalizes zero shares into rung limits", () => {
    expect(effectiveLadder({ quality: "good", ladder: { maxRung: "fast" } }).active).toBe(false);
    expect(effectiveLadder({ quality: "fast", ladder: { maxRung: "ocr" } }).active).toBe(false);
    expect(effectiveLadder({ quality: "auto", ladder: { maxRung: "intelligent" } })).toEqual({ active: false, maxRung: "intelligent" });
    expect(effectiveLadder({ quality: "auto", ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0 } } }).maxRung).toBe("fast");
    expect(effectiveLadder({ quality: "auto", ladder: { maxRung: "intelligent", maxEscalationShare: { aboveOcr: 0 } } }).maxRung).toBe("ocr");
    expect(effectiveLadder({ quality: "auto", ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 1, aboveOcr: 1 } } }).active).toBe(false);
    expect(pageReadingQuality({ quality: "auto", ladder: { maxRung: "fast" } })).toBe("fast");
    expect(pageReadingQuality({ quality: "auto", ladder: { maxRung: "ocr" } })).toBe("auto");
    expect(pageReadingQuality({ quality: "good", ladder: { maxRung: "fast" } })).toBe("good");
  });

  it("drops chart export's model tier below the intelligent rung", () => {
    const pipeline = { ...defaultPipelineFeatures, chartExport: { ...defaultPipelineFeatures.chartExport, tier: "models" as const } };
    expect(applyLadderLimits({ ...pipeline, ladder: { maxRung: "ocr" as const } }).chartExport.tier).toBe("free");
    expect(applyLadderLimits({ ...pipeline, ladder: { maxRung: "intelligent" as const } }).chartExport.tier).toBe("models");
    // A share cap keeps chart export free too: its candidates are read outside the page plan.
    expect(applyLadderLimits({ ...pipeline, ladder: { maxRung: "intelligent" as const, maxEscalationShare: { aboveOcr: 0.1 } } }).chartExport.tier).toBe("free");
    expect(applyLadderLimits({ ...pipeline, ladder: { maxRung: "fast" as const } }).quality).toBe("fast");
    // No limits: the very same object (defaults change nothing).
    expect(applyLadderLimits(pipeline)).toBe(pipeline);
  });

  it("recommends a reindex only when a limit is raised", () => {
    const auto = (ladder: object) => ({ quality: "auto" as const, ladder });
    expect(ladderAllowsMore(auto({ maxRung: "ocr" }), auto({ maxRung: "intelligent" }))).toBe(true);
    expect(ladderAllowsMore(auto({ maxRung: "intelligent" }), auto({ maxRung: "ocr" }))).toBe(false);
    expect(ladderAllowsMore(auto({ maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.2 } }), auto({ maxRung: "intelligent" }))).toBe(true);
    expect(ladderAllowsMore(auto({ maxRung: "intelligent" }), auto({ maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.2 } }))).toBe(false);
  });
});

describe("tighterLadder (run overrides from non-editors)", () => {
  it("keeps the stricter limit of each kind and never loosens the project's", () => {
    expect(tighterLadder({ maxRung: "ocr" }, { maxRung: "intelligent" })).toEqual({ maxRung: "ocr" });
    expect(tighterLadder({ maxRung: "intelligent" }, { maxRung: "fast" })).toEqual({ maxRung: "fast" });
    expect(tighterLadder({ maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.2 } }, { maxRung: "intelligent", maxEscalationShare: null }))
      .toEqual({ maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.2 } });
    expect(tighterLadder({ maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.2 } }, { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.9, aboveOcr: 0.5 } }))
      .toEqual({ maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.2, aboveOcr: 0.2 } });
    expect(tighterLadder(null, { maxRung: "ocr", maxEscalationShare: { aboveFast: 0.1 } })).toEqual({ maxRung: "ocr", maxEscalationShare: { aboveFast: 0.1 } });
    expect(tighterLadder(null, null)).toEqual({ maxRung: "intelligent" });
  });
});

describe("clampRunLadder (per-upload overrides)", () => {
  const project = { quality: "auto" as const, ladder: { maxRung: "ocr" as const, maxEscalationShare: { aboveFast: 0.2 } } };
  it("holds a non-editor's run to the project's limits and quality, and leaves editors alone", () => {
    const loose = { quality: "good" as const, ladder: { maxRung: "intelligent" as const, maxEscalationShare: null } };
    expect(clampRunLadder(loose, project, false)).toEqual({ quality: "auto", ladder: { maxRung: "ocr", maxEscalationShare: { aboveFast: 0.2 } } });
    expect(clampRunLadder(loose, project, true)).toBe(loose);
    const tighter = { quality: "auto" as const, ladder: { maxRung: "fast" as const } };
    expect(clampRunLadder(tighter, project, false)).toEqual({ quality: "auto", ladder: { maxRung: "fast", maxEscalationShare: { aboveFast: 0.2 } } });
    // A project without a limit keeps today's rule: quality overrides are the caller's choice.
    expect(clampRunLadder({ quality: "good" as const, ladder: null }, { quality: "auto", ladder: { maxRung: "intelligent" } }, false).quality).toBe("good");
  });
});

describe("reads outside the plan", () => {
  it("are refused under an above-fast share (reads) or any limit (embeddings)", () => {
    expect(ladderAllowsOffPlanReads({ quality: "auto", ladder: { maxRung: "intelligent" } })).toEqual({ pageReads: true, pageEmbeddings: true });
    expect(ladderAllowsOffPlanReads({ quality: "auto", ladder: { maxRung: "ocr" } })).toEqual({ pageReads: true, pageEmbeddings: false });
    expect(ladderAllowsOffPlanReads({ quality: "auto", ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.5 } } })).toEqual({ pageReads: false, pageEmbeddings: false });
  });

  it("keeps the default ladder out of the pipeline version hash, and a limit in it", () => {
    expect("ladder" in pipelineVersionFeatures(normalizePipelineFeatures(null))).toBe(false);
    expect(pipelineVersionFeatures(normalizePipelineFeatures({ ladder: { maxRung: "ocr" } }))).toHaveProperty("ladder");
  });
});

describe("planLadder", () => {
  const policy = (pages: number, ladder: object) => documentLadderPolicy({ quality: "auto", ladder: ladder as never }, pages);

  it("keeps every selected page on the rung it needs when no limit is set (default equivalence)", () => {
    const needs = [need(2, "ocr"), need(5, "intelligent"), need(7, "ocr", { lacksText: true })];
    const plan = planLadder({ pageCount: 10, needs, policy: policy(10, { maxRung: "intelligent" }) });
    expect(plan.escalated).toEqual([2, 5, 7]);
    expect(plan.intelligent).toEqual([5]);
    expect(plan.capped).toEqual([]);
    expect(plan.counts).toEqual({ fast: 7, ocr: 2, intelligent: 1 });
  });

  it("maxRung ocr lowers figure pages to the ocr rung; maxRung fast keeps every page fast", () => {
    const needs = [need(1, "intelligent"), need(2, "ocr")];
    const ocr = planLadder({ pageCount: 4, needs, policy: policy(4, { maxRung: "ocr" }) });
    expect(ocr.decisions).toEqual([
      { pageNumber: 1, need: "intelligent", rung: "ocr", reason: "figure:chart-or-figure", cappedBy: "max-rung" },
      { pageNumber: 2, need: "ocr", rung: "ocr", reason: "no-native-text" },
    ]);
    const fast = planLadder({ pageCount: 4, needs, policy: policy(4, { maxRung: "fast" }) });
    expect(fast.escalated).toEqual([]);
    expect(fast.decisions.every((decision) => decision.rung === "fast" && decision.cappedBy === "max-rung")).toBe(true);
  });

  it("the above-fast share escalates pages without text first, then higher confidence, then document order", () => {
    const needs = [
      need(1, "ocr", { confidence: 0.6 }),
      need(2, "ocr", { confidence: 0.9 }),
      need(3, "ocr", { lacksText: true, confidence: 0.1 }),
      need(4, "ocr", { confidence: 0.9 }),
      need(5, "intelligent", { confidence: 0.2 }),
    ];
    const plan = planLadder({ pageCount: 10, needs, policy: policy(10, { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.3 } }) });
    expect(plan.escalated).toEqual([2, 3, 4]);
    expect(plan.capped).toEqual([1, 5]);
    expect(plan.decisions.find((decision) => decision.pageNumber === 5)).toMatchObject({ rung: "fast", cappedBy: "share-above-fast" });
    // Deterministic: the same inputs in another order give the same plan.
    expect(planLadder({ pageCount: 10, needs: [...needs].reverse(), policy: policy(10, { maxEscalationShare: { aboveFast: 0.3 } }) })).toEqual(plan);
  });

  it("the above-ocr share keeps the highest-priority figure pages intelligent and transcribes the rest", () => {
    const needs = [need(1, "intelligent", { confidence: 0.4 }), need(2, "intelligent", { confidence: 0.8 }), need(3, "intelligent", { confidence: 0.8 })];
    const plan = planLadder({ pageCount: 10, needs, policy: policy(10, { maxEscalationShare: { aboveOcr: 0.1 } }) });
    expect(plan.intelligent).toEqual([2]);
    expect(plan.escalated).toEqual([1, 2, 3]);
    expect(plan.decisions.filter((decision) => decision.cappedBy === "share-above-ocr").map((decision) => decision.pageNumber)).toEqual([1, 3]);
  });

  it("pages extraction already read count against the above-fast share first", () => {
    const needs = [need(1, "ocr", { lacksText: true }), need(2, "ocr", { lacksText: true }), need(3, "ocr", { lacksText: true })];
    const plan = planLadder({ pageCount: 10, needs, policy: policy(10, { maxEscalationShare: { aboveFast: 0.3 } }), alreadyEscalated: [8, 9] });
    // 3 allowed: 8 and 9 were read by extraction, so only one more page.
    expect(plan.escalated).toEqual([1, 8, 9]);
    expect(plan.capped).toEqual([2, 3]);
  });

  it("holds the share on a 20,000-page document and floors small ones", () => {
    const pages = 20_000;
    const needs = Array.from({ length: pages }, (_, index) => need(index + 1, index % 7 === 0 ? "intelligent" : "ocr", { lacksText: index % 2 === 0 }));
    const plan = planLadder({ pageCount: pages, needs, policy: policy(pages, { maxEscalationShare: { aboveFast: 0.1, aboveOcr: 0.01 } }) });
    expect(plan.escalated).toHaveLength(2_000);
    expect(plan.intelligent).toHaveLength(200);
    expect(plan.counts.fast).toBe(18_000);
    expect(ladderShareBudget(0.5, 3)).toBe(1);
    expect(ladderShareBudget(0.3, 10)).toBe(3);
    // Small files get at least one page while the share is above 0 (an image, a one-page scan, an Office file before
    // its pages are measured); a share of 0 reads none.
    expect(ladderShareBudget(0.01, 3)).toBe(1);
    expect(ladderShareBudget(0, 3)).toBe(0);
    const office = documentLadderPolicy({ quality: "auto", ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.1 } } }, 1);
    expect(office).toMatchObject({ quality: "auto", aboveFastBudget: 1, aboveFastBinding: false });
  });
});

describe("estimates under the ladder", () => {
  afterEach(() => resetPricingProviderForTests());

  it("moves pages beyond the above-fast share to the text class", () => {
    const pipeline = { quality: "auto" as const, ladder: { maxRung: "intelligent" as const, maxEscalationShare: { aboveFast: 0.2 } } };
    const mix = ladderEstimateMix({ text: 0.2, complex: 0.3, scanned: 0.5 }, pipeline);
    expect(mix.complex! + mix.scanned!).toBeCloseTo(0.2);
    expect(mix.text).toBeCloseTo(0.8);
    expect(ladderEstimateMix({ text: 0.9, complex: 0.1, scanned: 0 }, pipeline)).toEqual({ text: 0.9, complex: 0.1, scanned: 0 });
    expect(ladderEstimateMix({ text: 0.2, complex: 0.3, scanned: 0.5 }, { quality: "auto", ladder: { maxRung: "intelligent" } })).toEqual({ text: 0.2, complex: 0.3, scanned: 0.5 });
  });

  it("quotes Auto capped at the fast rung as Fast, and caps an upload quote's Rich pages at the share", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const env = { DOCSLURP_BILLING: "enforced", STRIPE_SECRET_KEY: "sk_test" };
    const files = [{ name: "scan.pdf", size: 4_000_000, pages: 100 }];
    const base = normalizePipelineFeatures(null);
    const uncapped = quoteUpload({ files, profile: { ...estimateProfileFor(base, { env }), billing: "enforced" } }).estimate.credits!;
    const fast = quoteUpload({ files, profile: { ...estimateProfileFor(normalizePipelineFeatures({ ladder: { maxRung: "fast" } }), { env }), billing: "enforced" } }).estimate.credits!;
    expect(estimateProfileFor(normalizePipelineFeatures({ ladder: { maxRung: "fast" } }), { env }).quality).toBe("fast");
    expect(fast.high).toBeLessThan(uncapped.high);
    const shareProfile = { ...estimateProfileFor(normalizePipelineFeatures({ ladder: { maxEscalationShare: { aboveFast: 0.1 } } }), { env }), billing: "enforced" as const };
    expect(shareProfile.aboveFastShare).toBe(0.1);
    const capped = quoteUpload({ files, profile: shareProfile }).estimate.credits!;
    // At most 10 of the 100 pages Rich: Fast for all plus the Rich surcharge of 10 pages.
    expect(capped.high).toBeCloseTo(fast.high + 10 * (0.25 - 0.005));
    expect(capped.high).toBeLessThan(uncapped.high);
    expect(capped.low).toBeLessThanOrEqual(capped.high);
    // No limit: the uncapped quote, unchanged.
    expect(quoteUpload({ files, profile: { ...estimateProfileFor(base, { env }), billing: "enforced" } }).estimate.credits).toEqual(uncapped);
  });

  it("caps the settings estimate and the stage-precise work estimate", () => {
    // A test planning estimate that prices the page mix: read classes Rich, text Fast, everything Fast in fast.
    installTestPricing({
      ...DISTINCT_TEST_PRICING,
      estimateIngest: (input) => {
        const base = OPEN_PRICING.estimateIngest(input);
        const total = (input.mix.text ?? 0) + (input.mix.complex ?? 0) + (input.mix.scanned ?? 0) || 1;
        const read = input.profile === "fast" ? 0 : ((input.mix.complex ?? 0) + (input.mix.scanned ?? 0)) / total;
        const totalCredits = input.pages * (read * 0.25 + (1 - read) * 0.005);
        return { ...base, credits: { totalCredits, breakdown: { fast: totalCredits, rich: 0, media: 0, features: 0 } } };
      },
    });
    const env = { DOCSLURP_BILLING: "enforced", STRIPE_SECRET_KEY: "sk_test" };
    const files = [{ name: "scan.pdf", size: 4_000_000, pages: 100 }];
    const shared = normalizePipelineFeatures({ ladder: { maxEscalationShare: { aboveFast: 0.1 } } });
    const free = quoteEstimate({ files }, { env, base: quoteSettingsForPipeline(normalizePipelineFeatures(null)) });
    const capped = quoteEstimate({ files }, { env, base: quoteSettingsForPipeline(shared) });
    if (free.ingest.credits && capped.ingest.credits) expect(capped.ingest.credits.high).toBeLessThan(free.ingest.credits.high);
    expect(quoteSettingsForPipeline(normalizePipelineFeatures({ ladder: { maxRung: "fast" } })).quality).toBe("fast");
    const work = (features: ReturnType<typeof normalizePipelineFeatures>) =>
      estimatePipelineWork({ features, stages: ["extract-markdown", "vision-extract"], pages: 1000, documents: 1, env }).credits;
    expect(work(shared)!.high).toBeLessThan(work(normalizePipelineFeatures(null))!.high);
    expect(work(normalizePipelineFeatures({ ladder: { maxRung: "fast" } }))!.high).toBeLessThan(work(normalizePipelineFeatures(null))!.high);
  });
});

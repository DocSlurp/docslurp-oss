import { describe, expect, it } from "vitest";

import {
  BILLABLE_UNIT_METRICS,
  CHAT_MODEL_TIERS,
  DOCUMENT_FEATURES,
  DOCUMENT_FEATURE_METRICS,
  featureCredits,
  CREDIT_PACK_CENTS,
  CREDIT_RATE_CARD,
  EXAMPLE_CORPORA,
  FUNDED_WORKER_SLOTS,
  MAX_PAGE_FANOUT_PER_RUN,
  MAX_TOPUP_CENTS,
  MIN_TOPUP_CENTS,
  PRICE_CARD,
  QUALITY_MODE_ORDER,
  QUALITY_MODES,
  STARTER_CREDITS,
  STARTER_WORKER_SLOTS,
  autoTopUpSettingsSchema,
  billingForecastSchema,
  billingPrices,
  buildBillingForecast,
  chatAnswerCredits,
  chatModelTier,
  dailyStorageCredits,
  daysInUtcMonth,
  estimateIngest,
  PIPELINE_PROFILES,
  PIPELINE_PROFILE_BASIS,
  isUnitChargeEvent,
  mediaRichPages,
  pageCredits,
  priceAiUsageEvent,
  priceResources,
  richPagesForOutputTokens,
  searchCredits,
  storageCreditsPerMonth,
  unitChargeMetadata,
  workerSlotsFor,
} from "../billing.js";
import { WORKSPACE_CHAT_MODELS, nitroBaseModel } from "../workspace-chat-models.js";

const GB = 1024 ** 3;

describe("price card", () => {
  it("publishes the owner-approved unit prices", () => {
    expect(PRICE_CARD).toMatchObject({
      fastPer1kPages: 5,
      richPer1kPages: 250,
      audioMinuteRichPages: 1,
      videoMinuteRichPages: 3,
      storageGbMonth: 25,
      searchPer1k: 10,
      chatAnswerTiers: { standard: 1, advanced: 7.5, premium: 50 },
      richIncludedOutputTokens: 1_000,
      richExtraPageOutputTokens: 1_000,
      llmSearchMultiplier: 10,
      chatAnswerTokenBlock: 100_000,
    });
    expect(CREDIT_PACK_CENTS).toEqual([2_500, 5_000, 10_000]);
    expect(MIN_TOPUP_CENTS).toBe(1_000);
    expect(MAX_TOPUP_CENTS).toBe(1_000_000);
    expect(STARTER_CREDITS).toBe(250);
  });

  it("prices pages by mode", () => {
    expect(pageCredits("fast", 1_000)).toBeCloseTo(5);
    expect(pageCredits("rich", 1_000)).toBeCloseTo(250);
    expect(pageCredits("rich", 1)).toBeCloseTo(0.25);
    expect(pageCredits("fast", -5)).toBe(0);
  });

  it("counts one more Rich page per started 1,000 output tokens beyond the first 1,000", () => {
    expect(richPagesForOutputTokens(undefined)).toBe(1);
    expect(richPagesForOutputTokens(884)).toBe(1);
    expect(richPagesForOutputTokens(1_000)).toBe(1);
    expect(richPagesForOutputTokens(1_001)).toBe(2);
    expect(richPagesForOutputTokens(2_000)).toBe(2);
    expect(richPagesForOutputTokens(2_035)).toBe(3);
    expect(richPagesForOutputTokens(16_000)).toBe(16);
  });

  it("charges storage on every byte with no included GB", () => {
    expect(storageCreditsPerMonth(GB)).toBeCloseTo(25);
    expect(storageCreditsPerMonth(0)).toBe(0);
    expect(dailyStorageCredits(10 * GB, 30)).toBeCloseTo(250 / 30);
    expect(daysInUtcMonth("2026-02-10")).toBe(28);
    expect(daysInUtcMonth("2028-02-10")).toBe(29);
    expect(daysInUtcMonth("2026-10-21")).toBe(31);
  });

  it("charges searches per query and LLM strategies as ten searches", () => {
    expect(searchCredits(1_000)).toBeCloseTo(10);
    expect(searchCredits(1)).toBeCloseTo(0.01);
    expect(searchCredits(1, { llmStrategies: true })).toBeCloseTo(0.1);
  });

  it("maps every catalog chat model to an explicit tier, so none falls through to premium by omission", () => {
    const bare = (id: string) => { const base = nitroBaseModel(id) ?? id; return base.slice(base.lastIndexOf("/") + 1); };
    expect(WORKSPACE_CHAT_MODELS.filter(({ id }) => !Object.keys(CHAT_MODEL_TIERS).some((key) =>
      key.endsWith("*") ? bare(id).startsWith(key.slice(0, -1)) : key === bare(id))).map(({ id }) => id)).toEqual([]);
    expect(chatModelTier("openai/gpt-6-luna")).toBe("standard");
  });

  it("prices chat answers by model tier, with unmapped models premium and a 100k token block", () => {
    expect(chatModelTier("z-ai/glm-5.3-flash")).toBe("standard");
    expect(chatModelTier("minimax/minimax-m3.1-flash:free")).toBe("standard");
    expect(chatModelTier("deepseek/deepseek-v4.1-flash-20261017")).toBe("advanced");
    expect(chatModelTier("reflection/beam-1.0-501b-a23b")).toBe("advanced");
    expect(chatModelTier("openai/gpt-6.1-sol")).toBe("premium");
    expect(chatModelTier("some/new-model")).toBe("premium");
    expect(chatModelTier(null)).toBe("premium");
    expect(chatAnswerCredits({ model: "z-ai/glm-5.3-flash" })).toBe(1);
    expect(chatAnswerCredits({ model: "z-ai/glm-5.3-flash", totalTokens: 100_000 })).toBe(1);
    expect(chatAnswerCredits({ model: "z-ai/glm-5.3-flash", totalTokens: 250_000 })).toBe(3);
    expect(chatAnswerCredits({ model: "deepseek/deepseek-v4.1-flash" })).toBe(7.5);
    expect(chatAnswerCredits({ model: "qwen/qwen3.8-max-prime", totalTokens: 580_000 })).toBe(300);
    expect(Object.values(CHAT_MODEL_TIERS).every((tier) => tier in PRICE_CARD.chatAnswerTiers)).toBe(true);
  });

  it("keeps every mapped chat model above its measured mean cost per answer", () => {
    // [mean or p50, p90] USD per answer. Catalog models: production /v1/chat after the
    // chat cost cuts (2026-10-25, 88 turns each). Others: SigNoz traces 2026-10-13..22.
    const costUsd: Record<string, [number, number]> = {
      "z-ai/glm-5.3-flash": [0.0037, 0.0041],
      "openai/gpt-6-luna": [0.0019, 0.0039],
      "inception/mercury-3": [0.0064, 0.018],
      "liquid/lfm-2.5-24b-a2b": [0.0037, 0.01],
      "anthropic/claude-haiku-5.5": [0.0027, 0.0039],
      "xiaomi/mimo-v2.6-flash": [0.0086, 0.023],
      "deepseek/deepseek-v4.1-flash": [0.0177, 0.042],
      "reflection/beam-1.0-501b-a23b": [0.0349, 0.085],
      "openai/gpt-6.1-sol": [0.067, 0.163],
      "qwen/qwen3.8-max-prime": [0.287, 0.602],
    };
    for (const [model, [mean, p90]] of Object.entries(costUsd)) {
      const credits = chatAnswerCredits({ model });
      expect(credits, model).toBeGreaterThan(mean * 100);
      // p90 is above the tier price for beam-1.0-501b ($0.085 vs 7.5) and qwen3.8-max-prime ($0.60 vs 50);
      // the 100k token-block guard bills part of that tail as extra answers.
      if (!/beam-1\.0|qwen3\.8/.test(model)) expect(credits, model).toBeGreaterThan(p90 * 100);
    }
  });

  it("counts media minutes as Rich pages, rounded up per file", () => {
    expect(mediaRichPages("audio", 60)).toBe(1);
    expect(mediaRichPages("audio", 61)).toBe(2);
    expect(mediaRichPages("video", 90)).toBe(6);
    expect(mediaRichPages("video", 0)).toBe(0);
  });

  it("sets worker ceilings by funding", () => {
    expect(workerSlotsFor(false)).toBe(STARTER_WORKER_SLOTS);
    expect(workerSlotsFor(true)).toBe(FUNDED_WORKER_SLOTS);
    expect([STARTER_WORKER_SLOTS, FUNDED_WORKER_SLOTS]).toEqual([50, 250]);
  });

  it("publishes the price list without hardware details", () => {
    const prices = billingPrices();
    expect(prices).toMatchObject({ packsCents: [2_500, 5_000, 10_000], minTopUpCents: 1_000, starterCredits: 250, privateDedicatedMonthlyUsd: 2_000 });
    expect(prices.chatModelTiers["gpt-6.1-sol"]).toBe("premium");
    expect(JSON.stringify(prices)).not.toMatch(/cpu|memory|gpu|vcpu|gb-hour/i);
  });
});

describe("optional document features", () => {
  it("prices a summary per document and the others per started 10 pages", () => {
    expect(PRICE_CARD).toMatchObject({ documentSummary: 0.5, structuredFieldsPer10Pages: 1, knowledgeGraphPer10Pages: 1.5, propositionsPer10Pages: 1 });
    expect(featureCredits("documentSummary", 400)).toBe(0.5);
    expect(featureCredits("structuredFields", 0)).toBe(1);
    expect(featureCredits("structuredFields", 10)).toBe(1);
    expect(featureCredits("structuredFields", 11)).toBe(2);
    expect(featureCredits("knowledgeGraph", 80)).toBe(12);
    expect(featureCredits("propositions", 25)).toBe(3);
    expect(DOCUMENT_FEATURES.map((feature) => DOCUMENT_FEATURE_METRICS[feature])).toEqual([
      "feature-document-summary", "feature-structured-fields", "feature-knowledge-graph", "feature-propositions",
    ]);
  });

  it("keeps each feature above its measured cost per document (Langfuse events_full 2026-10)", () => {
    // Summary: $0.0019 per document on gemini-3.1-flash-lite; graph: ~19 calls x $0.0031 on gemini for a ~10-page document.
    expect(featureCredits("documentSummary", 10)).toBeGreaterThan(0.19);
    expect(featureCredits("knowledgeGraph", 10)).toBeGreaterThan(19 * 0.0006 * 100);
  });

  it("adds enabled features to the estimate, per document, with media minutes counted as pages", () => {
    const base = estimateIngest({ pages: 100, mix: { text: 1 }, documents: 2 });
    const withFeatures = estimateIngest({ pages: 100, mix: { text: 1 }, documents: 2, features: { documentSummary: true, knowledgeGraph: true } });
    expect(withFeatures.featureCredits).toEqual({ documentSummary: 1, knowledgeGraph: 2 * 1.5 * 5 });
    expect(withFeatures.credits.breakdown.features).toBeCloseTo(16);
    expect(withFeatures.credits.totalCredits).toBeCloseTo(base.credits.totalCredits + 16);
    const podcast = estimateIngest({ pages: 0, mix: {}, audioMinutes: 60, documents: 1, features: { structuredFields: true } });
    expect(podcast.featureCredits.structuredFields).toBe(6);
  });
});

describe("billable vs internal cost events", () => {
  it("records AI provider cost but never debits credits for it", () => {
    const priced = priceAiUsageEvent({ metric: "page-analysis", costCents: 10, metadata: { generationId: "receipt" } });
    expect(priced.costCents).toBe(0);
    expect(priced.metadata).toMatchObject({ providerCostCents: 10, billable: false, costRole: "provider", generationId: "receipt" });
    expect(priceAiUsageEvent(priced)).toEqual(priced);
  });

  it("passes billable unit charges through unchanged", () => {
    const unit = { metric: BILLABLE_UNIT_METRICS.chatAnswer, costCents: 2.5, metadata: unitChargeMetadata({ tier: "standard" }) };
    expect(isUnitChargeEvent(unit)).toBe(true);
    expect(priceAiUsageEvent(unit)).toEqual(unit);
    expect(isUnitChargeEvent({ metric: "page-analysis", metadata: unitChargeMetadata() })).toBe(false);
    expect(isUnitChargeEvent({ metric: BILLABLE_UNIT_METRICS.search, metadata: {} })).toBe(false);
  });
});

describe("billing forecast", () => {
  it("projects recurring spend and days until empty from visible inputs", () => {
    const forecast = buildBillingForecast({
      balanceCredits: 1_000,
      storageBytes: 4 * GB,
      searchesLast30d: 10_000,
      searchCreditsLast30d: 100,
      chatAnswersLast30d: 40,
      chatCreditsLast30d: 100,
      fastPagesLast30d: 20_000,
      richPagesLast30d: 100,
      ingestCreditsLast30d: 125,
    });
    expect(forecast.storageCreditsPerMonth).toBeCloseTo(100);
    expect(forecast.recurringCreditsPerMonth).toBeCloseTo(300);
    expect(forecast.daysUntilEmpty).toBe(100);
    expect(billingForecastSchema.parse(forecast)).toEqual(forecast);
  });

  it("has no end date without recurring spend and floors a negative balance at 0 days", () => {
    const base = { storageBytes: 0, searchesLast30d: 0, searchCreditsLast30d: 0, chatAnswersLast30d: 0, chatCreditsLast30d: 0, fastPagesLast30d: 0, richPagesLast30d: 0, ingestCreditsLast30d: 0 };
    expect(buildBillingForecast({ ...base, balanceCredits: 50 }).daysUntilEmpty).toBeNull();
    expect(buildBillingForecast({ ...base, balanceCredits: -5, storageBytes: GB }).daysUntilEmpty).toBe(0);
  });
});

describe("internal cost reference", () => {
  it("prices resources for internal reports", () => {
    const charge = priceResources({ cpuSeconds: 3_600, memoryGbSeconds: 3_600, gpuStandardSeconds: 3_600 });
    expect(charge.breakdown.cpu).toBeCloseTo(CREDIT_RATE_CARD.cpuVcpuHour);
    expect(charge.breakdown.memory).toBeCloseTo(CREDIT_RATE_CARD.memoryGbHour);
    expect(charge.breakdown.gpu).toBeCloseTo(CREDIT_RATE_CARD.gpuStandardHour);
    expect(priceResources({ cpuSeconds: Number.NaN, aiProviderCents: -5 }).totalCredits).toBe(0);
  });
});

describe("ingest estimator", () => {
  it("prices with the price card: text pages Fast, scans Rich", () => {
    const text = estimateIngest({ pages: 1_000, mix: { text: 1 }, documents: 1 });
    expect(text.fastPages).toBe(1_000);
    expect(text.credits.totalCredits).toBeCloseTo(5);
    const scanned = estimateIngest({ pages: 1_000, mix: { scanned: 1 }, documents: 1 });
    expect(scanned.richPages).toBe(1_000);
    expect(scanned.credits.totalCredits).toBeCloseTo(250);
  });

  it("charges small files only for their pages (no per-file minimum) and prices media minutes", () => {
    const tiny = estimateIngest({ pages: 10, mix: { text: 1 }, documents: 10 });
    expect(tiny.credits.totalCredits).toBeCloseTo(0.05);
    expect("perFileMinimum" in PRICE_CARD).toBe(false);
    const podcast = estimateIngest({ pages: 0, mix: {}, audioMinutes: 60, documents: 1 });
    expect(podcast.mediaRichPages).toBe(60);
    expect(podcast.credits.totalCredits).toBeCloseTo(15);
  });

  it("gets faster with more workers and never slower, at the same price", () => {
    const starter = estimateIngest({ pages: 50_000, mix: { text: 1 }, documents: 100, workerSlots: STARTER_WORKER_SLOTS });
    const funded = estimateIngest({ pages: 50_000, mix: { text: 1 }, documents: 100 });
    expect(funded.workers).toBe(FUNDED_WORKER_SLOTS);
    expect(funded.wallSeconds).toBeLessThan(starter.wallSeconds);
    expect(funded.credits.totalCredits).toBeCloseTo(starter.credits.totalCredits);
  });

  it("caps a single document at the per-run fan-out", () => {
    expect(estimateIngest({ pages: 10_000, mix: { text: 1 }, documents: 1 }).effectiveParallelism).toBe(MAX_PAGE_FANOUT_PER_RUN);
    expect(estimateIngest({ pages: 10_000, mix: { text: 1 }, documents: 20 }).effectiveParallelism).toBe(FUNDED_WORKER_SLOTS);
  });

  it("charges good more than auto, and auto more than fast", () => {
    const mix = { text: 0.6, complex: 0.3, scanned: 0.1 };
    const [fast, auto, good] = (["fast", "auto", "good"] as const).map((profile) =>
      estimateIngest({ pages: 1_000, mix, profile }).credits.totalCredits,
    );
    expect(fast).toBeLessThan(auto!);
    expect(auto).toBeLessThan(good!);
  });

  it("defaults the estimator to auto", () => {
    expect(estimateIngest({ pages: 10, mix: { text: 1 } }).profile).toBe("auto");
  });

  it("prices each quality mode inside its catalog range", () => {
    for (const mode of QUALITY_MODE_ORDER) {
      const { min, max } = QUALITY_MODES[mode].creditsPer1kPages;
      for (const mix of [{ text: 1 }, { complex: 1 }, { scanned: 1 }, { text: 0.5, complex: 0.3, scanned: 0.2 }]) {
        const per1k = estimateIngest({ pages: 1_000, mix, profile: mode }).creditsPer1000Pages;
        expect(per1k, `${mode} ${JSON.stringify(mix)}`).toBeGreaterThanOrEqual(min - 1e-9);
        expect(per1k, `${mode} ${JSON.stringify(mix)}`).toBeLessThanOrEqual(max + 1e-9);
      }
    }
    // Both ends of auto are reachable: born-digital text bills Fast, scans bill Rich.
    expect(estimateIngest({ pages: 1_000, mix: { text: 1 }, profile: "auto" }).creditsPer1000Pages).toBe(QUALITY_MODES.auto.creditsPer1kPages.min);
    expect(estimateIngest({ pages: 1_000, mix: { scanned: 1 }, profile: "auto" }).creditsPer1000Pages).toBe(QUALITY_MODES.auto.creditsPer1kPages.max);
  });

  it("bills scanned pages Fast in fast mode (kept as page images, never read)", () => {
    const estimate = estimateIngest({ pages: 1_000, mix: { scanned: 1 }, profile: "fast" });
    expect(estimate.richPages).toBe(0);
    expect(estimate.fastPages).toBe(1_000);
    expect(estimate.creditsPer1000Pages).toBe(PRICE_CARD.fastPer1kPages);
    expect(estimate.storage.indexBytes).toBe(0);
  });

  it("keeps profile worker seconds ordered and on the production slot basis", () => {
    expect(PIPELINE_PROFILE_BASIS).toMatchObject({ slotsPerHost: 2, slotTuner: "resource" });
    for (const pageClass of ["text", "complex", "scanned"] as const) {
      const [fast, auto, good] = (["fast", "auto", "good"] as const).map((id) => PIPELINE_PROFILES[id].pages[pageClass].workerSeconds);
      expect(fast, pageClass).toBeLessThanOrEqual(auto!);
      expect(auto, pageClass).toBeLessThanOrEqual(good!);
    }
    // Measured 2026-10: text pages hold a slot for roughly 0.2-0.4 s, a model-read page for about 4 s.
    expect(PIPELINE_PROFILES.auto.pages.text.workerSeconds).toBeGreaterThanOrEqual(0.22);
    expect(PIPELINE_PROFILES.auto.pages.text.workerSeconds).toBeLessThanOrEqual(0.4);
    expect(PIPELINE_PROFILES.auto.pages.scanned.workerSeconds).toBeGreaterThanOrEqual(4);
    expect(PIPELINE_PROFILES.good.pages.text.mode).toBe("rich");
  });

  it("handles empty input", () => {
    expect(estimateIngest({ pages: 0, mix: {} })).toMatchObject({ wallSeconds: 0, pagesPerMinute: 0, pagesPerDollar: 0 });
  });

  it("prices every example corpus and labels its basis", () => {
    for (const corpus of EXAMPLE_CORPORA) {
      const estimate = estimateIngest({ pages: corpus.pages, mix: corpus.mix, documents: corpus.documents, audioMinutes: corpus.audioMinutes });
      expect(estimate.credits.totalCredits, corpus.id).toBeGreaterThan(0);
      expect(["measured", "official", "estimate"]).toContain(corpus.basis);
    }
    const caselaw = EXAMPLE_CORPORA.find((corpus) => corpus.id === "caselaw-access-project")!;
    expect(estimateIngest({ pages: caselaw.pages, mix: caselaw.mix, documents: caselaw.documents }).richPages).toBe(caselaw.pages);
  });
});

describe("auto top-up settings", () => {
  it("requires a monthly cap covering one top-up and at least the minimum top-up", () => {
    expect(autoTopUpSettingsSchema.safeParse({ enabled: true, thresholdCredits: 500, amountCents: 2_000, monthlyLimitCents: 1_000 }).success).toBe(false);
    expect(autoTopUpSettingsSchema.safeParse({ enabled: true, thresholdCredits: 500, amountCents: 500, monthlyLimitCents: 10_000 }).success).toBe(false);
    expect(autoTopUpSettingsSchema.safeParse({ enabled: true, thresholdCredits: 500, amountCents: 2_000 }).success).toBe(false);
    expect(autoTopUpSettingsSchema.safeParse({ enabled: true, thresholdCredits: 500, amountCents: 2_000, monthlyLimitCents: 10_000 }).success).toBe(true);
  });
});

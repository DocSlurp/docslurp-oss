import { describe, expect, it } from "vitest";

import {
  CREDIT_RATE_CARD,
  EXAMPLE_CORPORA,
  MAX_PAGE_FANOUT_PER_RUN,
  SERVICE_PLANS,
  STARTER_CREDITS,
  autoRechargeSettingsSchema,
  creditsForSubscriptionPayment,
  dailyStorageCredits,
  estimateIngest,
  getPlan,
  getPlanByLookupKey,
  HOSTED_EQUIVALENT_REFERENCES,
  ROUTE_FACTOR_PERCENT,
  SELF_HOSTED_DISCOUNT_PERCENT,
  SELF_HOSTED_PAGE_TOKENS,
  aiBonusNeutralFactor,
  hostedEquivalentListCredits,
  priceResources,
  priceAiUsageEvent,
  selfHostedPageCredits,
  selfHostedRateCard,
} from "../billing.js";

const GB = 1024 ** 3;

describe("AI receipt credits", () => {
  it("keeps provider cost and applies the rate-card markup exactly once", () => {
    const priced = priceAiUsageEvent({ costCents: 10, metadata: { generationId: "receipt" } });
    expect(priced.costCents).toBe(12);
    expect(priced.metadata).toMatchObject({ providerCostCents: 10, aiMarkupPercent: 20, generationId: "receipt" });
    expect(priceAiUsageEvent(priced)).toEqual(priced);
  });

  it("retains provider evidence for unbilled AI calls without charging credits", () => {
    const priced = priceAiUsageEvent({ costCents: 10, metadata: { billable: false } });
    expect(priced.costCents).toBe(0);
    expect(priced.metadata).toMatchObject({ providerCostCents: 10, billable: false });
    expect(priceAiUsageEvent(priced).costCents).toBe(0);
  });
});

describe("self-hosted inference pricing", () => {
  const privateEvent = (overrides: Record<string, unknown> = {}) => ({
    provider: "private",
    costCents: 0.01,
    inputTokens: 1_500,
    outputTokens: 800,
    metadata: { capability: "vision", costSource: "private-endpoint-hourly" },
    ...overrides,
  });

  it("bills 50% of the hosted-equivalent list price and records the list price", () => {
    const priced = priceAiUsageEvent(privateEvent());
    const reference = HOSTED_EQUIVALENT_REFERENCES.vision;
    const listCents = ((1_500 * reference.inputUsdPerMTok + 800 * reference.outputUsdPerMTok) / 1_000_000) * 100 * 1.2;
    expect(SELF_HOSTED_DISCOUNT_PERCENT).toBe(50);
    expect(priced.costCents).toBeCloseTo(listCents / 2, 10);
    expect(priced.metadata).toMatchObject({
      providerCostCents: 0.01,
      selfHosted: { capability: "vision", discountPercent: 50, referenceModel: reference.model },
    });
    expect((priced.metadata as unknown as { selfHosted: { hostedEquivalentListCents: number } }).selfHosted.hostedEquivalentListCents).toBeCloseTo(listCents, 10);
  });

  it("is idempotent and independent of the GPU cost the endpoint reports", () => {
    const priced = priceAiUsageEvent(privateEvent());
    expect(priceAiUsageEvent(priced)).toEqual(priced);
    expect(priceAiUsageEvent(privateEvent({ costCents: 5 })).costCents).toBeCloseTo(priced.costCents, 10);
  });

  it("bills unpriced private endpoints too, because billing follows tokens not hardware", () => {
    expect(priceAiUsageEvent(privateEvent({ costCents: 0 })).costCents).toBeGreaterThan(0);
  });

  it("falls back to provider cost plus markup without a reference capability or tokens", () => {
    expect(priceAiUsageEvent(privateEvent({ metadata: { capability: "stt" } })).costCents).toBeCloseTo(0.012, 10);
    expect(priceAiUsageEvent(privateEvent({ inputTokens: 0, outputTokens: 0 })).costCents).toBeCloseTo(0.012, 10);
    expect(priceAiUsageEvent({ ...privateEvent(), provider: "openrouter" }).costCents).toBeCloseTo(0.012, 10);
  });

  it("charges nothing for unbilled self-hosted calls", () => {
    expect(priceAiUsageEvent(privateEvent({ metadata: { capability: "vision", billable: false } })).costCents).toBe(0);
  });

  it("prices a model-read page at half of the hosted list, about $0.46 per 1,000", () => {
    const page = selfHostedPageCredits();
    expect(page.billed).toBeCloseTo(page.list / 2, 12);
    expect(page.list * 10).toBeCloseTo(0.911, 3);
    const card = selfHostedRateCard();
    expect(card.discountPercent).toBe(50);
    expect(card.per1000Pages.billedCredits).toBeCloseTo(card.per1000Pages.listCredits / 2, 9);
    expect(hostedEquivalentListCredits({ capability: "vision", ...{ inputTokens: SELF_HOSTED_PAGE_TOKENS.input, outputTokens: SELF_HOSTED_PAGE_TOKENS.output } })).toBeCloseTo(page.list, 12);
  });

  it("charges embeddings on own hardware at half of hosted embedding list", () => {
    const priced = priceAiUsageEvent({ provider: "private", costCents: 0, inputTokens: 1_000_000, outputTokens: 0, metadata: { capability: "embedding" } });
    expect(priced.costCents).toBeCloseTo(2 * 1.2 / 2, 9);
  });
});

describe("plan-neutral AI pricing", () => {
  it("charges bonus plans (1 + bonus) times the credits so a dollar of AI costs the same dollars everywhere", () => {
    const event = { costCents: 10, metadata: {} };
    expect(priceAiUsageEvent(event).costCents).toBeCloseTo(12);
    expect(priceAiUsageEvent(event, { planId: "silver" }).costCents).toBeCloseTo(12);
    expect(priceAiUsageEvent(event, { planId: "gold" }).costCents).toBeCloseTo(13.2);
    expect(priceAiUsageEvent(event, { planId: "platinum" }).costCents).toBeCloseTo(14.4);
    expect(priceAiUsageEvent(event, { planId: "platinum" }).metadata).toMatchObject({ aiPlanCreditFactor: 1.2, providerCostCents: 10 });
  });

  it("realizes at least a 10% margin after 3% payment fees on every paid plan", () => {
    for (const plan of SERVICE_PLANS.filter((entry) => entry.monthlyMinimumCents > 0)) {
      const creditCents = plan.monthlyMinimumCents / plan.includedCreditsPerMonth;
      const revenue = priceAiUsageEvent({ costCents: 100, metadata: {} }, { planId: plan.id }).costCents * creditCents * 0.97;
      expect(revenue / 100 - 1, plan.id).toBeGreaterThanOrEqual(0.1);
    }
  });

  it("is a no-op without a plan or for unknown plans", () => {
    expect(aiBonusNeutralFactor(undefined)).toBe(1);
    expect(aiBonusNeutralFactor("nope")).toBe(1);
  });

  it("reprices from stored provider cost without compounding the plan factor", () => {
    const first = priceAiUsageEvent({ costCents: 10, metadata: {} }, { planId: "platinum" });
    expect(priceAiUsageEvent(first, { planId: "platinum" })).toEqual(first);
  });
});

describe("privacy route factors", () => {
  it("adds 4% for EU-pinned and 1% for zero-retention routes", () => {
    expect(ROUTE_FACTOR_PERCENT).toEqual({ euPinned: 4, zeroRetention: 1 });
    const base = priceAiUsageEvent({ costCents: 10, metadata: {} }).costCents;
    expect(priceAiUsageEvent({ costCents: 10, metadata: { euPinned: true } }).costCents).toBeCloseTo(base * 1.04);
    expect(priceAiUsageEvent({ costCents: 10, metadata: { zeroRetention: true } }).costCents).toBeCloseTo(base * 1.01);
    expect(priceAiUsageEvent({ costCents: 10, metadata: { euPinned: true, zeroRetention: true } }).costCents).toBeCloseTo(base * 1.05);
    expect(priceAiUsageEvent({ costCents: 10, metadata: { euPinned: "yes" } }).costCents).toBeCloseTo(base);
  });
});

describe("service plans", () => {
  it("keeps the one-time starter grant below every paid monthly allowance", () => {
    expect(STARTER_CREDITS).toBe(250);
    for (const plan of SERVICE_PLANS.filter((entry) => entry.monthlyMinimumCents > 0)) {
      expect(plan.includedCreditsPerMonth).toBeGreaterThan(STARTER_CREDITS);
    }
    expect(getPlan("free").highlights).toContain(`${STARTER_CREDITS} one-time starter credits`);
  });

  it("defines the published minimums and worker ceilings", () => {
    const byId = Object.fromEntries(SERVICE_PLANS.map((plan) => [plan.id, plan]));
    expect(byId.silver).toMatchObject({ monthlyMinimumCents: 2_000, workers: 100 });
    expect(byId.free).toMatchObject({ monthlyMinimumCents: 0, workers: 50 });
    expect(byId.gold).toMatchObject({ monthlyMinimumCents: 5_000, workers: 250 });
    expect(byId.platinum).toMatchObject({ monthlyMinimumCents: 50_000, workers: 1_000 });
  });

  it("grants at least the minimum as credits, plus the advertised bonus", () => {
    for (const plan of SERVICE_PLANS) {
      expect(plan.includedCreditsPerMonth).toBe(creditsForSubscriptionPayment(plan.id, plan.monthlyMinimumCents));
      expect(plan.includedCreditsPerMonth).toBeGreaterThanOrEqual(plan.monthlyMinimumCents);
    }
  });

  it("scales prorated grants with the amount actually paid", () => {
    expect(creditsForSubscriptionPayment("gold", 2_500)).toBe(2_750);
    expect(creditsForSubscriptionPayment("free", 2_500)).toBe(0);
    expect(creditsForSubscriptionPayment("silver", -100)).toBe(0);
  });

  it("falls back to free for unknown ids and resolves lookup keys", () => {
    expect(getPlan("nope").id).toBe("free");
    expect(getPlan(null).id).toBe("free");
    expect(getPlanByLookupKey("docslurp_gold_monthly")?.id).toBe("gold");
    expect(getPlanByLookupKey("docslurp_unknown")).toBeNull();
  });
});

describe("rate card", () => {
  it("prices one vCPU-hour, one GB-hour and one GPU-hour at list", () => {
    const charge = priceResources({ cpuSeconds: 3_600, memoryGbSeconds: 3_600, gpuStandardSeconds: 3_600 });
    expect(charge.breakdown.cpu).toBeCloseTo(CREDIT_RATE_CARD.cpuVcpuHour);
    expect(charge.breakdown.memory).toBeCloseTo(CREDIT_RATE_CARD.memoryGbHour);
    expect(charge.breakdown.gpu).toBeCloseTo(CREDIT_RATE_CARD.gpuStandardHour);
  });

  it("marks up AI provider cost and ignores invalid inputs", () => {
    expect(priceResources({ aiProviderCents: 10 }).totalCredits).toBeCloseTo(12);
    expect(priceResources({ cpuSeconds: Number.NaN, aiProviderCents: -5 }).totalCredits).toBe(0);
  });

  it("charges storage daily and applies the included allowance", () => {
    const free = dailyStorageCredits({ objectBytes: 5 * GB, indexBytes: 0.5 * GB, includedGb: 10 });
    expect(free.totalCredits).toBe(0);

    const indexHeavy = dailyStorageCredits({ objectBytes: 0, indexBytes: 100 * GB, includedGb: 1_000 });
    expect(indexHeavy.billableIndexGb).toBeCloseTo(50);

    const over = dailyStorageCredits({ objectBytes: 40 * GB, indexBytes: 2 * GB, includedGb: 10 });
    expect(over.billableObjectGb).toBeCloseTo(30);
    expect(over.billableIndexGb).toBeCloseTo(2);
    const monthly = over.totalCredits * (730 / 24);
    expect(monthly).toBeCloseTo(30 * CREDIT_RATE_CARD.objectStorageGbMonth + 2 * CREDIT_RATE_CARD.indexStorageGbMonth);
  });
});

describe("ingest estimator", () => {
  const textbook = EXAMPLE_CORPORA.find((example) => example.id === "textbook")!;

  it("gets faster with more workers and never slower", () => {
    const times = SERVICE_PLANS.map((plan) =>
      estimateIngest({ pages: textbook.pages, mix: textbook.mix, plan: plan.id }).wallSeconds,
    );
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]).toBeLessThanOrEqual(times[index - 1]!);
    }
  });

  it("charges the same credits regardless of plan", () => {
    const silver = estimateIngest({ pages: textbook.pages, mix: textbook.mix, plan: "silver" });
    const platinum = estimateIngest({ pages: textbook.pages, mix: textbook.mix, plan: "platinum" });
    expect(platinum.credits.totalCredits).toBeCloseTo(silver.credits.totalCredits);
  });

  it("prices own-GPU OCR pages per page at half the hosted list and exposes the struck-through list", () => {
    const scanned = estimateIngest({ pages: 1_000, mix: { scanned: 1 }, plan: "silver", profile: "standard" });
    const page = selfHostedPageCredits();
    expect(scanned.selfHosted.pages).toBe(1_000);
    expect(scanned.credits.breakdown.selfHosted).toBeCloseTo(1_000 * page.billed, 9);
    expect(scanned.selfHosted.listCredits).toBeCloseTo(2 * scanned.selfHosted.billedCredits, 9);
    expect(scanned.credits.breakdown.gpu).toBe(0);
    const text = estimateIngest({ pages: 1_000, mix: { text: 1 }, plan: "silver", profile: "standard" });
    expect(text.selfHosted.pages).toBe(0);
  });

  it("caps a single document at the per-run fan-out", () => {
    const estimate = estimateIngest({ pages: 10_000, mix: { text: 1 }, plan: "platinum", documents: 1 });
    expect(estimate.effectiveParallelism).toBe(MAX_PAGE_FANOUT_PER_RUN);
    const batch = estimateIngest({ pages: 10_000, mix: { text: 1 }, plan: "platinum", documents: 20 });
    expect(batch.effectiveParallelism).toBe(1_000);
  });

  it("orders pipeline profiles by cost", () => {
    const [fast, standard, deep] = (["fast", "standard", "deep"] as const).map((profile) =>
      estimateIngest({ pages: textbook.pages, mix: textbook.mix, plan: "gold", profile }).credits.totalCredits,
    );
    expect(fast).toBeLessThan(standard!);
    expect(standard).toBeLessThan(deep!);
  });

  it("handles empty input", () => {
    const estimate = estimateIngest({ pages: 0, mix: {}, plan: "free" });
    expect(estimate).toMatchObject({ wallSeconds: 0, pagesPerMinute: 0, pagesPerDollar: 0 });
  });
});

describe("auto-recharge settings", () => {
  it("requires the monthly limit to cover one recharge", () => {
    expect(autoRechargeSettingsSchema.safeParse({ enabled: true, thresholdCredits: 500, amountCents: 2_000, monthlyLimitCents: 1_000 }).success).toBe(false);
    expect(autoRechargeSettingsSchema.safeParse({ enabled: true, thresholdCredits: 500, amountCents: 2_000, monthlyLimitCents: 10_000 }).success).toBe(true);
  });
});

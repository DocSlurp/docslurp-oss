import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyFileProfile,
  applySpeedBoostUnitCharge,
  billingPrices,
  chatAnswerCredits,
  DISTINCT_TEST_PRICING,
  estimateProfileFor,
  defaultPipelineFeatures,
  featureCredits,
  fileProfileSchema,
  installPricingProvider,
  installTestPricing,
  mediaRichPages,
  normalizeFileProfile,
  OPEN_CREDITS_PER_PAGE,
  OPEN_PRICING,
  pageCredits,
  pricing,
  pricingVersion,
  quoteUpload,
  resetPricingProviderForTests,
  richPagesForOutputTokens,
  searchCredits,
  speedBoostMultiplier,
  storageCreditsPerMonth,
  unitChargeMetadata,
  workerSlotsFor,
  type FileProfile,
} from "../index.js";

afterEach(() => {
  resetPricingProviderForTests();
  vi.unstubAllEnvs();
});

const profile = { ...estimateProfileFor(defaultPipelineFeatures, { env: {} }), billing: "enforced" as const };

function pdfProfile(overrides: Partial<FileProfile> = {}, pdf: Partial<NonNullable<FileProfile["pdf"]>> = {}): FileProfile {
  return {
    schema: 1,
    profiler: "test",
    kind: "pdf",
    format: "pdf",
    bytes: 100_000,
    pages: 10,
    pdf: {
      sampledPages: 10,
      textLayerPages: 6,
      wordsPerPage: [4, 0, 0, 2, 4, 0],
      lowTextPages: 4,
      blankPages: 0,
      rasterPages: 4,
      imagePages: 4,
      images: 4,
      imageCoverage: [6, 0, 0, 0, 4],
      furnitureImages: 1,
      layoutHeavyPages: 1,
      vectorHeavyPages: 1,
      unmappedFontPages: 0,
      drawnContent: false,
      budgetExhausted: false,
      sampledWords: 1_800,
      sampledChars: 0, sampledTextLines: 0, charsByFontSize: [0, 0, 0, 0, 0], invisibleChars: 0, offCropChars: 0,
      sampledTextEquivalents: 10, sampledAreaEquivalents: 10, sampledPageEquivalents: 10, maxPageEquivalents: 1,
      medianPageAreaSqIn: 94,
      maxPageAreaSqIn: 94,
      ...pdf,
    },
    ...overrides,
  };
}

describe("open pricing default", () => {
  it("charges one flat, published rate per page and per media minute, and nothing else", () => {
    expect(pricing().id).toBe("open");
    expect(pageCredits("fast", 1_000)).toBeCloseTo(1_000 * OPEN_CREDITS_PER_PAGE, 10);
    expect(pageCredits("rich", 1_000)).toBe(pageCredits("fast", 1_000));
    expect(richPagesForOutputTokens(50_000)).toBe(1);
    expect(mediaRichPages("video", 61)).toBe(2);
    expect(mediaRichPages("audio", 61)).toBe(2);
    expect(storageCreditsPerMonth(1024 ** 4)).toBe(0);
    expect(searchCredits(1_000, { llmStrategies: true })).toBe(0);
    expect(chatAnswerCredits({ model: "any/model", totalTokens: 10_000_000 })).toBe(0);
    expect(featureCredits("knowledgeGraph", 500)).toBe(0);
    expect(speedBoostMultiplier(true)).toBe(1);
    expect(unitChargeMetadata()).toMatchObject({ billable: true, unitCharge: true, priceCard: "open-1" });
  });

  it("quotes pages over their size range and ignores profile facts beyond counts", () => {
    const quote = quoteUpload({ files: [{ name: "a.pdf", size: 750 * 1024 }], profile });
    expect(quote.estimate.credits).not.toBeNull();
    expect(quote.estimate.pagesRange).toBeDefined();
    const profiled = quoteUpload({ files: [{ name: "a.pdf", size: 100_000, profile: pdfProfile() }], profile });
    expect(profiled.estimate.pages).toBe(10);
    expect(profiled.estimate.credits).toEqual({ low: 10 * OPEN_CREDITS_PER_PAGE, high: 10 * OPEN_CREDITS_PER_PAGE });
  });

  it("shows no credits when billing is disabled", () => {
    const quote = quoteUpload({ files: [{ name: "a.pdf", size: 100_000 }], profile: { ...profile, billing: "disabled" } });
    expect(quote.estimate.credits).toBeNull();
  });

  it("publishes its rule on the price list", () => {
    expect(billingPrices()).toMatchObject({ rule: "flat", creditsPerPage: OPEN_CREDITS_PER_PAGE, pricingVersion: "open-1" });
  });
});

describe("installed pricing provider", () => {
  it("prices every delegate through the provider", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    expect(pricingVersion()).toBe("test-1");
    expect(pageCredits("rich", 2)).toBeCloseTo(0.5, 12);
    expect(pageCredits("fast", 2)).toBeCloseTo(0.01, 12);
    expect(richPagesForOutputTokens(1_200)).toBe(2);
    expect(speedBoostMultiplier(true)).toBe(4);
    const event = applySpeedBoostUnitCharge({ provider: "docslurp", costCents: 5, metric: "ingest-page-fast", metadata: unitChargeMetadata() }, true);
    expect(event.costCents).toBe(20);
    // Re-applying the same snapshot keeps the base, never compounds.
    expect(applySpeedBoostUnitCharge(event, true).costCents).toBe(20);
  });

  it("rejects incomplete providers and the reserved open id", () => {
    expect(() => installPricingProvider({ ...OPEN_PRICING, id: "open" })).toThrow(/reserved/);
    expect(() => installPricingProvider({ ...OPEN_PRICING, id: "x", apiVersion: 2 as never })).toThrow(/apiVersion/);
    const { quoteUpload: _missing, ...partial } = OPEN_PRICING;
    expect(() => installPricingProvider({ ...partial, id: "x" } as never)).toThrow(/quoteUpload/);
    expect(() => installPricingProvider({ ...OPEN_PRICING, id: "x", plans: { ...OPEN_PRICING.plans, workerSlots: { starter: 0, funded: 1 } } })).toThrow(/plans/);
  });

  it("refuses a second, different provider", () => {
    installTestPricing();
    expect(() => installPricingProvider({ ...OPEN_PRICING, id: "other" })).toThrow(/already installed/);
  });

  it("refuses a provider's invalid speed boost multiplier", () => {
    installTestPricing({ speedBoostMultiplier: () => 0.5 });
    expect(() => speedBoostMultiplier(true)).toThrow(/invalid speed boost/);
  });
});

describe("service profile fails closed", () => {
  it("prices nothing with the open default under DOCSLURP_SERVICE_PROFILE=service", () => {
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
    expect(() => pricing()).toThrow(/no pricing provider installed/);
    expect(() => pageCredits("fast", 1)).toThrow(/no pricing provider installed/);
    expect(() => workerSlotsFor(true)).toThrow(/no pricing provider installed/);
    installTestPricing();
    expect(pricing().id).toBe("test");
  });
});

describe("file profiles are untrusted", () => {
  it("validates shape strictly and refuses oversized or unknown fields", () => {
    expect(fileProfileSchema.safeParse(pdfProfile()).success).toBe(true);
    expect(fileProfileSchema.safeParse({ ...pdfProfile(), credits: 0 }).success).toBe(false);
    expect(fileProfileSchema.safeParse({ ...pdfProfile(), schema: 2 }).success).toBe(false);
    expect(fileProfileSchema.safeParse(pdfProfile({}, { sampledPages: 25 })).success).toBe(false);
    expect(fileProfileSchema.safeParse(pdfProfile({}, { wordsPerPage: [1, 2, 3] })).success).toBe(false);
    expect(fileProfileSchema.safeParse({ ...pdfProfile(), notes: Array.from({ length: 9 }, () => "x") }).success).toBe(false);
    expect(fileProfileSchema.safeParse({ ...pdfProfile(), notes: ["x".repeat(161)] }).success).toBe(false);
    expect(fileProfileSchema.safeParse({ ...pdfProfile(), format: "<script>" }).success).toBe(false);
    expect(fileProfileSchema.safeParse({ ...pdfProfile(), pages: -1 }).success).toBe(false);
  });

  it("drops a profile measured on another file size or with inconsistent histograms", () => {
    expect(normalizeFileProfile(pdfProfile(), { size: 99 })).toBeNull();
    expect(normalizeFileProfile(pdfProfile({}, { wordsPerPage: [10, 0, 0, 0, 0, 5] }), { size: 100_000 })?.pdf).toBeUndefined();
  });

  it("clamps counts to the pages sampled and the duration to a day", () => {
    const clamped = normalizeFileProfile(pdfProfile({}, { rasterPages: 999, images: 10_000 }), { size: 100_000 })!;
    expect(clamped.pdf?.rasterPages).toBe(10);
    expect(clamped.pdf?.images).toBe(640);
    const media = normalizeFileProfile({ schema: 1, profiler: "t", kind: "video", format: "mp4", bytes: 5, durationSeconds: 6 * 24 * 3600 }, { size: 5 })!;
    expect(media.durationSeconds).toBe(24 * 3600);
  });

  it("merges counts only where the caller gave none", () => {
    expect(applyFileProfile({ name: "a.pdf", size: 100_000, pages: 3, profile: pdfProfile() }).pages).toBe(3);
    expect(applyFileProfile({ name: "a.pdf", size: 100_000, profile: pdfProfile() }).pages).toBe(10);
    expect(applyFileProfile({ name: "a.pdf", size: 1, profile: pdfProfile() }).profile).toBeUndefined();
  });

  it("hands the provider only validated, clamped profiles", () => {
    const seen: unknown[] = [];
    installTestPricing({ quoteUpload: (args) => { seen.push(...args.files.map((file) => file.profile)); return OPEN_PRICING.quoteUpload(args); } });
    quoteUpload({ files: [{ name: "a.pdf", size: 100_000, profile: pdfProfile({}, { rasterPages: 50 }) }, { name: "b.pdf", size: 7, profile: pdfProfile() }], profile });
    expect((seen[0] as FileProfile).pdf?.rasterPages).toBe(10);
    expect(seen[1]).toBeUndefined();
  });
});

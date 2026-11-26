import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BILLABLE_UNIT_METRICS,
  isBillableUnitMetric,
  PAGE_MODE_METRICS,
  PAGE_MODES,
  PAGE_READ_METRICS,
  pageUpgradeCredits,
  TEST_PAGE_CREDITS,
  applyFileProfile,
  profilePageEquivalents,
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
  type PricingProvider,
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
      sampledTextEquivalents: 10, sampledAreaEquivalents: 10, sampledPageEquivalents: 10, maxPageEquivalents: 1, textEquivalentsPerPage: [10, 0, 0, 0, 0, 0, 0], areaEquivalentsPerPage: [10, 0, 0, 0, 0, 0, 0, 0], densePages: 0, medianPageWidthPt: 612, medianPageHeightPt: 792, maxPageWidthPt: 612, maxPageHeightPt: 792, offPageChars: 0, tinyCharsDropped: 0, textEstimatedPages: 0, pageEquivalentsByAllowance: [10, 10, 10], maxPageEquivalentsByAllowance: [1, 1, 1], imagePpi: [0, 0, 4, 0], imageBytesPerPixel: [0, 0, 4, 0, 0], glyphsOverImages: 0, textOverImagePages: 0, scanBesideTextPages: 0, scanBesideTextUnknownPages: 0, ruledTablePages: 0,
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

  it("requires the chart seam methods under their one name: chartGeneratorMaxPricesUsdPerMTok, the retry credits and share", () => {
    // Type level: the seam's one name, returning input and output ceilings (a stale singular name does not compile).
    type Ceiling = ReturnType<PricingProvider["internalCost"]["chartGeneratorMaxPricesUsdPerMTok"]>;
    const shape: Ceiling = { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 };
    expect(shape.outputUsdPerMTok).toBe(0.5);
    // @ts-expect-error the singular output-only name is not part of the seam
    void (OPEN_PRICING.internalCost.chartGeneratorMaxOutputUsdPerMTok);
    // Runtime: a provider without it, or with only the old name, is refused at install.
    const { chartGeneratorMaxPricesUsdPerMTok: _ceiling, ...cost } = OPEN_PRICING.internalCost;
    expect(() => installPricingProvider({ ...OPEN_PRICING, id: "x", internalCost: cost } as never)).toThrow(/incomplete internalCost/);
    expect(() => installPricingProvider({ ...OPEN_PRICING, id: "x", internalCost: { ...cost, chartGeneratorMaxOutputUsdPerMTok: () => 1 } } as never))
      .toThrow(/incomplete internalCost/);
    for (const method of ["visualExportRetryCredits", "chartExportExpectedRetriesPerRead"] as const) {
      const { [method]: _missing, ...rest } = OPEN_PRICING;
      expect(() => installPricingProvider({ ...rest, id: "x" } as never)).toThrow(new RegExp(method));
    }
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
    expect(() => pricing()).toThrow(/no pricing provider is installed/);
    expect(() => pageCredits("fast", 1)).toThrow(/no pricing provider is installed/);
    expect(() => workerSlotsFor(true)).toThrow(/no pricing provider is installed/);
    vi.unstubAllEnvs();
    // DOCSLURP_PRICING_REQUIRED=1 (the chat executor's setting) is refused the same way (council E #2).
    vi.stubEnv("DOCSLURP_PRICING_REQUIRED", "1");
    expect(() => pageCredits("fast", 1)).toThrow(/no pricing provider is installed/);
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

  it("accepts page encodings and tagged counts as optional facts, and refuses unknown bits, duplicate masks and partial sums", () => {
    // Profiles from profilers before them stay valid.
    expect(fileProfileSchema.safeParse(pdfProfile()).success).toBe(true);
    const tagged = { taggedFormulas: 3, taggedTables: 1, taggedMathSources: 1 };
    const encoded = pdfProfile({}, { pageEncodings: [[0, 6], [0b11, 3], [1 << 15, 1]], ...tagged });
    expect(fileProfileSchema.safeParse(encoded).success).toBe(true);
    expect(normalizeFileProfile(encoded, { size: 100_000 })?.pdf).toMatchObject({ pageEncodings: encoded.pdf?.pageEncodings, ...tagged });
    expect(fileProfileSchema.safeParse(pdfProfile({}, { pageEncodings: [[1 << 14, 10]] })).success).toBe(false);
    expect(fileProfileSchema.safeParse(pdfProfile({}, { pageEncodings: [[1 << 16, 10]] })).success).toBe(false);
    expect(fileProfileSchema.safeParse(pdfProfile({}, { pageEncodings: [[1, 5], [1, 5]] })).success).toBe(false);
    expect(fileProfileSchema.safeParse(pdfProfile({}, { pageEncodings: [[1, 0], [0, 10]] })).success).toBe(false);
    expect(fileProfileSchema.safeParse(pdfProfile({}, { pageEncodings: Array.from({ length: 25 }, (_, mask) => [mask, 1] as [number, number]) })).success).toBe(false);
    expect(fileProfileSchema.safeParse(pdfProfile({}, { pageEncodings: [[0, 10]], taggedFormulas: -1 })).success).toBe(false);
    // Encodings that do not account for exactly the sampled pages drop the page facts; sources never exceed formulas.
    expect(normalizeFileProfile(pdfProfile({}, { pageEncodings: [[0, 9]] }), { size: 100_000 })?.pdf).toBeUndefined();
    expect(normalizeFileProfile(pdfProfile({}, { pageEncodings: [[0, 10]], taggedFormulas: 1, taggedMathSources: 5 }), { size: 100_000 })?.pdf?.taggedMathSources).toBe(1);
    // Sources with no formula count describe nothing; "not truncated" is said by omission only.
    expect(normalizeFileProfile(pdfProfile({}, { pageEncodings: [[0, 10]], taggedMathSources: 5 }), { size: 100_000 })?.pdf?.taggedMathSources).toBeUndefined();
    expect(fileProfileSchema.safeParse(pdfProfile({}, { taggedFormulas: 1, taggedTruncated: true })).success).toBe(true);
    expect(fileProfileSchema.safeParse(pdfProfile({}, { taggedFormulas: 1, taggedTruncated: false as never })).success).toBe(false);
    const capped = normalizeFileProfile(pdfProfile({}, { pageEncodings: [[0, 10]], taggedFormulas: 1_000_000, taggedTables: 900_000, taggedMathSources: 1_000_000 }), { size: 100_000 })?.pdf;
    expect([capped?.taggedFormulas, capped?.taggedTables, capped?.taggedMathSources]).toEqual([50_000, 50_000, 50_000]);
    expect(normalizeFileProfile(pdfProfile({}, { pageEncodings: [[0, 10]], taggedTruncated: true }), { size: 100_000 })?.pdf?.taggedTruncated).toBeUndefined();
  });

  it("drops a profile measured on another file size or with inconsistent histograms", () => {
    expect(normalizeFileProfile(pdfProfile(), { size: 99 })).toBeNull();
    expect(normalizeFileProfile(pdfProfile({}, { wordsPerPage: [10, 0, 0, 0, 0, 5] }), { size: 100_000 })?.pdf).toBeUndefined();
  });

  it("clamps counts to the pages sampled and the duration to a day", () => {
    const clamped = normalizeFileProfile(pdfProfile({}, { rasterPages: 999, images: 10_000, imagePpi: [0, 0, 10_000, 0], imageBytesPerPixel: [0, 0, 10_000, 0, 0] }), { size: 100_000 })!;
    expect(clamped.pdf?.rasterPages).toBe(10);
    expect(clamped.pdf?.images).toBe(640);
    const media = normalizeFileProfile({ schema: 1, profiler: "t", kind: "video", format: "mp4", bytes: 5, durationSeconds: 6 * 24 * 3600 }, { size: 5 })!;
    expect(media.durationSeconds).toBe(24 * 3600);
  });

  it("widens the page-equivalent high end for estimated text and dense unsampled pages", () => {
    const exact = applyFileProfile({ name: "a.pdf", size: 100_000, profile: pdfProfile() });
    expect([exact.pageEquivalents, exact.pageEquivalentsHigh]).toEqual([10, 10]);
    const estimated = applyFileProfile({ name: "a.pdf", size: 100_000, profile: pdfProfile({}, { textEstimatedPages: 5 }) });
    expect([estimated.pageEquivalents, estimated.pageEquivalentsHigh]).toEqual([10, 15]);
    // 10 of 20 pages sampled: eight ordinary, one with 2 pages of text, one twice Letter. Allowance 1 counts 12, the default
    // allowance (3) 11: the text page counts 1, the tabloid its area.
    const sampled = { sampledTextEquivalents: 11, sampledAreaEquivalents: 11, sampledPageEquivalents: 12, maxPageEquivalents: 2, textEquivalentsPerPage: [9, 1, 0, 0, 0, 0, 0], areaEquivalentsPerPage: [9, 1, 0, 0, 0, 0, 0, 0], pageEquivalentsByAllowance: [12, 11, 11], maxPageEquivalentsByAllowance: [2, 2, 2] };
    const partial = applyFileProfile({ name: "a.pdf", size: 100_000, profile: pdfProfile({ pages: 20 }, sampled) });
    expect(partial.pageEquivalents).toBe(22);
    // Unsampled pages may each be as large as the largest sampled one: 22 + 10 × (2 − 1.1).
    expect(partial.pageEquivalentsHigh).toBe(31);
    expect(profilePageEquivalents({ pages: 20, profile: partial.profile }, 1)).toBe(24);
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

describe("OCR page class", () => {
  it("prices fast, ocr and rich through the provider; the open default charges every class the same", () => {
    for (const mode of PAGE_MODES) expect(OPEN_PRICING.pageCredits(mode, 1_000)).toBeCloseTo(OPEN_CREDITS_PER_PAGE * 1_000);
    installTestPricing(DISTINCT_TEST_PRICING);
    expect(PAGE_MODES.map((mode) => pageCredits(mode, 1_000))).toEqual(PAGE_MODES.map((mode) => TEST_PAGE_CREDITS[mode] * 1_000));
    expect(PAGE_MODE_METRICS).toEqual({ fast: "ingest-page-fast", ocr: "ingest-page-ocr", rich: "ingest-page-rich" });
    expect(PAGE_READ_METRICS).toEqual([BILLABLE_UNIT_METRICS.ocrPage, BILLABLE_UNIT_METRICS.richPage]);
    expect(isBillableUnitMetric("ingest-page-ocr")).toBe(true);
  });

  it("charges an upgrade the difference only, never a negative amount", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    expect(pageUpgradeCredits("fast", "ocr")).toBeCloseTo(TEST_PAGE_CREDITS.ocr - TEST_PAGE_CREDITS.fast);
    expect(pageUpgradeCredits("ocr", "rich")).toBeCloseTo(TEST_PAGE_CREDITS.rich - TEST_PAGE_CREDITS.ocr);
    expect(pageUpgradeCredits("fast", "rich", 3)).toBeCloseTo(3 * (TEST_PAGE_CREDITS.rich - TEST_PAGE_CREDITS.fast));
    expect(pageUpgradeCredits("rich", "ocr")).toBe(0);
    expect(pageUpgradeCredits("ocr", "ocr")).toBe(0);
  });

  it("refuses a provider whose page prices are out of order or invalid", () => {
    const order = (credits: Record<string, number>) => ({ ...OPEN_PRICING, id: "test", pageCredits: (mode: string, pages: number) => credits[mode]! * pages });
    expect(() => installPricingProvider(order({ fast: 0.01, ocr: 0.005, rich: 1 }) as PricingProvider)).toThrow(/prices ocr pages below fast/);
    expect(() => installPricingProvider(order({ fast: 0.01, ocr: 2, rich: 1 }) as PricingProvider)).toThrow(/prices rich pages below ocr/);
    expect(() => installPricingProvider(order({ fast: 0.01, ocr: Number.NaN, rich: 1 }) as PricingProvider)).toThrow(/invalid page price/);
    expect(() => installPricingProvider(order({ fast: 0.01, ocr: 0.01, rich: 0.01 }) as PricingProvider)).not.toThrow();
  });
});

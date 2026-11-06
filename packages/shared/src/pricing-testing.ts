import { costEstimateSchema } from "./jobs.js";
import { DEFAULT_PAGE_EQUIVALENT_ALLOWANCE } from "./page-equivalents.js";
import { estimateUploadMedia, uploadMediaKind } from "./media-upload-estimate.js";
import { assembleEstimateQuote } from "./estimate-assembly.js";
import { OPEN_PRICING, openStoredBytes } from "./pricing-open.js";
import { quoteFilePageRange } from "./upload-pages.js";
import { installPricingProvider, resetPricingProviderForTests, type PricingProvider } from "./pricing-provider.js";

/**
 * Tests only: a provider built from the open default with some methods replaced, installed for the caller. Lets core tests
 * check that a code path charges through the provider (e.g. that a Rich read is priced as `pageCredits("rich", n)`) with
 * arbitrary, recognisable numbers, without any deployment's real prices.
 */
export function installTestPricing(overrides: Partial<PricingProvider> = {}): PricingProvider {
  resetPricingProviderForTests();
  const provider: PricingProvider = { ...OPEN_PRICING, id: "test", version: "test-1", ...overrides };
  installPricingProvider(provider);
  return provider;
}

/**
 * Test prices. Per page, the published hosted list prices (Fast 5 and Rich 250 credits per 1,000 pages, on
 * docslurp.io/pricing); everything else is arbitrary and distinct, not any deployment's rule: one more Rich page per
 * started 800 output tokens past the first 800, a video minute two pages and an audio minute one, a feature 0.4 per started
 * 8 pages, storage 7 credits per GB-month, an LLM search three searches, speed boost 4x (the published opt-in rate), a reindex-only run half the page
 * charge, and remote sandboxes at 0.002 cents per core-second plus 0.0005 per GiB-second.
 */
export const DISTINCT_TEST_PRICING: Partial<PricingProvider> = {
  pageCredits: (mode, pages) => Math.max(0, Number.isFinite(pages) ? pages : 0) * (mode === "rich" ? 0.25 : 0.005),
  richPagesForOutputTokens: (tokens) => 1 + Math.max(0, Math.ceil((Math.max(0, tokens ?? 0) - 800) / 800)),
  mediaRichPages: (kind, seconds) => Math.ceil(Math.max(0, seconds) / 60) * (kind === "video" ? 2 : 1),
  storageCreditsPerMonth: (bytes) => (Math.max(0, bytes) / 1024 ** 3) * 7,
  searchUnits: ({ llmStrategies }) => (llmStrategies ? 3 : 1),
  searchCredits: (searches, { llmStrategies }) => Math.max(0, searches) * (llmStrategies ? 3 : 1) * 0.01,
  chatAnswerCredits: () => 2,
  featureCredits: (feature, pages) => (feature === "documentSummary" ? 0.3 : 0.4 * Math.max(1, Math.ceil(Math.max(0, pages) / 8))),
  speedBoostMultiplier: (speedBoost) => (speedBoost ? 4 : 1),
  pageChargeShare: (plan) => (plan.reusedStages.length === 0 ? 1 : 0.5),
  extractRetentionCredits: (bytes, months) => (Math.max(0, bytes) / 1024 ** 3) * Math.max(0, months) * 11,
  webSearchCredits: ({ deep, includeContent }) => (deep || includeContent ? 3 : 1),
  webPageCredits: (pages) => Math.max(0, pages) * 0.5,
  webMapCredits: (urls) => Math.max(1, Math.ceil(Math.max(0, urls) / 40)),
  qualityModePricing: (mode) => ({
    creditsPer1kPages: mode === "fast" ? { min: 5, max: 5 } : mode === "good" ? { min: 250, max: 250 } : { min: 5, max: 250 },
    priceNote: "Test price note.",
  }),
  pageEquivalentAllowance: DEFAULT_PAGE_EQUIVALENT_ALLOWANCE,
  plans: { creditPacksCents: [2_500, 5_000, 10_000], starterCredits: 250, workerSlots: { starter: 50, funded: 250 }, privateDedicatedMonthlyUsd: null },
  publicPrices: () => ({ rule: "test", summary: "Test summary: pay per page." }),
  // A simple test quote over the provider's own delegates: the fewest pages all Fast to the most pages all Rich, media by
  // duration, times the speed boost. Not any deployment's quote.
  quoteUpload: (args) => {
    const test = DISTINCT_TEST_PRICING;
    const paged = args.files.filter((file) => !uploadMediaKind(file));
    let low = 0, central = 0, high = 0, unmeasured = 0;
    for (const file of paged) {
      const range = quoteFilePageRange(file);
      const extra = Math.max(0, (file.pageEquivalents ?? range.central) - range.central);
      const extraHigh = Math.max(extra, (file.pageEquivalentsHigh ?? file.pageEquivalents ?? range.central) - range.central);
      low += range.low + extra; central += range.central + extra; high += range.high + extraHigh;
      if (!range.measured) unmeasured += 1;
    }
    const boost = test.speedBoostMultiplier!(args.speedBoost === true);
    const media = estimateUploadMedia(args.files, { videoFrames: args.profile.videoFrames });
    if (media) {
      media.credits = { low: media.credits.low * boost, high: media.credits.high * boost };
      if (media.lighter) { media.lighter.credits *= boost; media.lighter.savedCredits *= boost; }
    }
    const fast = args.profile.quality === "fast";
    const seconds = (pages: number) => OPEN_PRICING.estimateIngest({ pages, mix: { text: 1 }, documents: Math.max(1, paged.length) }).wallSeconds;
    const estimate = costEstimateSchema.parse({
      pages: central,
      documents: paged.length + (media ? media.audioFiles + media.videoFiles : 0),
      billing: args.profile.billing,
      credits: args.profile.billing === "disabled" ? null : {
        low: (test.pageCredits!(args.profile.quality === "good" ? "rich" : "fast", low)) * boost + (media?.credits.low ?? 0),
        high: (test.pageCredits!(fast ? "fast" : "rich", high)) * boost + (media?.credits.high ?? 0),
      },
      seconds: { low: seconds(low), high: seconds(high) },
      ...(unmeasured > 0 ? { pagesRange: { low, high }, unmeasuredFiles: unmeasured } : {}),
      basis: "test quote",
    });
    return { estimate, media };
  },
  quote: (args) => assembleEstimateQuote({
    ...args,
    ingest: DISTINCT_TEST_PRICING.quoteUpload!({ files: args.files, profile: args.profile, speedBoost: args.settings.speedBoost }),
    bytes: openStoredBytes,
    version: "test-1",
    validForMs: 15 * 60 * 1000,
  }),
  internalCost: {
    computeRates: () => null,
    listCredits: () => null,
    sandboxCostCents: ({ cores, memoryGib, seconds }) => (cores * 0.002 + memoryGib * 0.0005) * Math.max(0, seconds),
    sandboxRatesObservedAt: () => "2026-01-01",
    workerSlotUsdPerHour: () => 0.05,
  },
};

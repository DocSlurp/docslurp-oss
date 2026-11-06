import { OPEN_PRICING } from "./pricing-open.js";
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

/** Arbitrary, distinct test prices: a Fast page 1 credit, a Rich page 10, a Rich page per 500 output tokens past 500. */
export const DISTINCT_TEST_PRICING: Partial<PricingProvider> = {
  pageCredits: (mode, pages) => Math.max(0, Number.isFinite(pages) ? pages : 0) * (mode === "rich" ? 10 : 1),
  richPagesForOutputTokens: (tokens) => 1 + Math.max(0, Math.ceil((Math.max(0, tokens ?? 0) - 500) / 500)),
  mediaRichPages: (kind, seconds) => Math.ceil(Math.max(0, seconds) / 60) * (kind === "video" ? 2 : 1),
  storageCreditsPerMonth: (bytes) => (Math.max(0, bytes) / 1024 ** 3) * 7,
  searchUnits: ({ llmStrategies }) => (llmStrategies ? 3 : 1),
  searchCredits: (searches, { llmStrategies }) => Math.max(0, searches) * (llmStrategies ? 3 : 1) * 0.01,
  chatAnswerCredits: () => 2,
  featureCredits: (_feature, pages) => Math.max(1, Math.ceil(Math.max(0, pages) / 10)),
  speedBoostMultiplier: (speedBoost) => (speedBoost ? 3 : 1),
};

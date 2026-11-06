// Billing suites price through an installed provider with test prices (shared `DISTINCT_TEST_PRICING`: the published
// per-page prices, arbitrary values for every other rule), never a deployment's private rules. Suites that need other
// numbers install their own (`installTestPricing`).
import { DISTINCT_TEST_PRICING, installTestPricing } from "@docslurp/shared";

installTestPricing(DISTINCT_TEST_PRICING);

// Billing suites price through an installed provider with test prices (shared `DISTINCT_TEST_PRICING`: the published
// per-page prices, arbitrary values for every other rule), never a deployment's private rules. Suites that need other
// numbers install their own (`installTestPricing`).
import { assertDisposableTestDatabaseUrl, DISTINCT_TEST_PRICING, installTestPricing } from "@docslurp/shared";

// Gated database tests (#400) write and drop data: TEST_DATABASE_URL must name a disposable database on a loopback host
// (scripts/run-database-tests.mjs creates one per file). A wrong URL fails every test here instead of reaching it.
if (process.env.TEST_DATABASE_URL) assertDisposableTestDatabaseUrl(process.env.TEST_DATABASE_URL);

installTestPricing(DISTINCT_TEST_PRICING);

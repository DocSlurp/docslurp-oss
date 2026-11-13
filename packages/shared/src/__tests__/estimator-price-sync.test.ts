/*
 * Regression pins for estimates after the November 2026 price changes. Each block names the change it covers; the pending
 * ones name the branch or pull request that must turn them on when it lands.
 *
 * Prices themselves belong to the pricing provider (the open default here, or the test provider); these tests pin what
 * the estimator does with them, never a hosted price.
 */
import { afterEach, describe, expect, it } from "vitest";

import { assertNoAutomaticSelectionDenied, isAutomaticSelectionDenied } from "../automatic-model-selection.js";
import * as chatModels from "../project-chat-models.js";

import {
  compilePipelinePlan,
  creditsToDollars,
  defaultPipelineFeatures,
  estimatePipelineWork,
  DISTINCT_TEST_PRICING,
  installTestPricing,
  resetPricingProviderForTests,
  resolveChatCreditReserveConfig,
  runningJobCreditFloor,
  starterCredits,
} from "../index.js";

afterEach(() => resetPricingProviderForTests());

const BILLED = { STRIPE_SECRET_KEY: "sk_test", DOCSLURP_CHART_EXPORT: "on" };

describe("starter grant (core #345)", () => {
  it("is 100 credits, $1, in the open default and the test provider", () => {
    resetPricingProviderForTests();
    expect(starterCredits()).toBe(100);
    expect(creditsToDollars(starterCredits())).toBe(1);
    installTestPricing();
    expect(starterCredits()).toBe(100);
  });
});

describe("running-job overdraft (core #345)", () => {
  it("lets an admitted run finish up to 25 credits ($0.25) below zero by default, and never more than $10", () => {
    const config = resolveChatCreditReserveConfig({});
    expect(config.runOverdraftCredits).toBe(25);
    expect(runningJobCreditFloor(config)).toBe(-25);
    expect(creditsToDollars(-runningJobCreditFloor(config))).toBe(0.25);
    expect(runningJobCreditFloor(resolveChatCreditReserveConfig({ RUN_CREDIT_OVERDRAFT_CREDITS: "100000" }))).toBe(-1_000);
  });

  it("does not change what an estimate charges: the allowance is a balance floor, not a discount", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const work = (env: Record<string, string>) => estimatePipelineWork({
      features: defaultPipelineFeatures, stages: compilePipelinePlan(defaultPipelineFeatures).stageOrder, pages: 100, documents: 1, env,
    }).credits;
    expect(work(BILLED)!.high).toBeGreaterThan(0);
    expect(work({ ...BILLED, RUN_CREDIT_OVERDRAFT_CREDITS: "0" })).toEqual(work({ ...BILLED, RUN_CREDIT_OVERDRAFT_CREDITS: "1000" }));
  });
});

// Chart export model reads on main (`enabled: true`, priced per model read per generator call, deterministic sources
// free, nothing while DOCSLURP_CHART_EXPORT is off) are pinned in chart-export-pricing.test.ts. The measured cost of a
// read (tokens and repair rate) is private: the app's pricing plugin pins it.

// ---- Pending: changes still in flight. Turn each on (and adjust its fixture) when its branch lands. -------------------

describe("chart export tiers (core feat/chart-export-free-tier, not merged)", () => {
  it.todo("prices the `free` tier at 0 credits for any page count and visual stats");
  it.todo("prices the `models` tier per model read, like `enabled: true` above");
  it.todo("resolves an upload estimate with no tier to `off` for API, MCP, SDK and CLI callers (machine origin)");
  it.todo("resolves an upload estimate with no tier to `free` for the chat UI (app origin), still 0 credits");
  it.todo("adds the `models` tier to the upload estimate (`estimateUpload`), which on main omits chart export entirely");
});

describe("figure storage (core #357 on #355, not merged)", () => {
  it.todo("counts stored figure bytes in the upload estimate's hosting bytes and monthly storage credits");
  it.todo("bounds figure bytes by the page-scaled figure caps of the asset ledger (#355)");
});

describe("managed model tiers (core feat/managed-model-tiers-only, not merged)", () => {
  it.todo("quotes chat answers by category (chatTier) only; a request naming a backend model is refused, never priced");
});

// Council H1 (2026-11-13), owner decision: the Balanced tier is never DeepSeek V4.1 Flash. A tier-to-model default is chosen
// by the system, so the tier map (CHAT_TIER_MODELS, added by #362 feat/managed-model-tiers-only) must pass the
// never-automatic check. Skipped until the map exists; it runs, and must pass, from the commit that adds it.
const chatTierModels = (chatModels as Record<string, unknown>).CHAT_TIER_MODELS as Record<string, string> | undefined;
describe("chat tier map (#362)", () => {
  it.skipIf(!chatTierModels)("names no model that is never selected automatically (assertNoAutomaticSelectionDenied)", () => {
    expect(() => assertNoAutomaticSelectionDenied("CHAT_TIER_MODELS", Object.values(chatTierModels!))).not.toThrow();
    for (const [tier, model] of Object.entries(chatTierModels!)) expect(isAutomaticSelectionDenied(model), tier).toBe(false);
  });
});

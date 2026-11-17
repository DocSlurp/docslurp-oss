import { afterEach, describe, expect, it } from "vitest";

import { automaticCallMarginDecision } from "../automatic-call-margin.js";
import { OCR_ESCALATION_ROUTES, ocrEscalationAutomaticRoute, ocrEscalationRoutes } from "../ocr-escalation-routes.js";
import { pageUpgradeCredits } from "../billing.js";
import { DISTINCT_TEST_PRICING, installTestPricing } from "../pricing-testing.js";
import { resetPricingProviderForTests } from "../pricing-provider.js";

afterEach(() => resetPricingProviderForTests());

/** The escalation's billed value under test prices: the page's OCR-to-Rich upgrade, in USD (1 credit = 1 cent). */
function installUpgradeValue() {
  installTestPricing({
    ...DISTINCT_TEST_PRICING,
    automaticCallValueUsd: (call) => (call.role === "escalation" ? pageUpgradeCredits("ocr", "rich") / 100 : null),
  });
}

describe("OCR escalation readers", () => {
  it("tries GLM under its price ceiling on two US hosts first, then Qwen; a configured model keeps only its own routes", () => {
    expect(OCR_ESCALATION_ROUTES.map((route) => route.model)).toEqual(["llm://openrouter/z-ai/glm-5.3-flash", "llm://openrouter/z-ai/glm-5.3-flash", "llm://deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct"]);
    expect(ocrEscalationRoutes("llm://openrouter/z-ai/glm-5.3-flash").map((route) => route.optionId)).toEqual(["scan-ocr/hosted-escalation-glm", "scan-ocr/hosted-escalation-glm-morph"]);
    expect(ocrEscalationRoutes(null)).toBe(OCR_ESCALATION_ROUTES);
    expect(ocrEscalationRoutes("llm://deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct").map((route) => route.optionId)).toEqual(["scan-ocr/hosted-escalation"]);
    expect(ocrEscalationRoutes("llm://openrouter/some/model")).toEqual([{ optionId: "scan-ocr/hosted-escalation-configured", model: "llm://openrouter/some/model", priceCeiling: null }]);
    // The capped reader sends pages only to a host whose region is stated (US); two readers keep escalation available.
    expect(OCR_ESCALATION_ROUTES[0]!.priceCeiling!.hosts).toEqual(["wafer/us"]);
    expect(OCR_ESCALATION_ROUTES[1]!.priceCeiling!.hosts).toEqual(["morph/fp8"]);
    expect(OCR_ESCALATION_ROUTES).toHaveLength(3);
  });

  it("prices the GLM reader at its ceiling: the request's max_price, its hosts and no per-image fee", () => {
    const glm = OCR_ESCALATION_ROUTES[0]!;
    const route = ocrEscalationAutomaticRoute(glm);
    const ceiling = glm.priceCeiling!;
    expect(route.hosts).toEqual([...ceiling.hosts]);
    expect(route.capUsdPerMTok).toEqual({ inputUsdPerMTok: ceiling.inputUsdPerMTok, outputUsdPerMTok: ceiling.outputUsdPerMTok });
    expect(route.maxPriceSent).toEqual(route.capUsdPerMTok);
    expect(route.capImageUsd).toBe(0);
    // The uncapped reader keeps the vision route as sent (Qwen on DeepInfra's own API, at its list price).
    expect(ocrEscalationAutomaticRoute(OCR_ESCALATION_ROUTES[2]!)).toMatchObject({ billing: "direct" });
  });

  it("the gate checks the GLM reader at the ceiling and admits it at the test prices", () => {
    installUpgradeValue();
    const glm = OCR_ESCALATION_ROUTES[0]!;
    const decision = automaticCallMarginDecision("page-transcription", ocrEscalationAutomaticRoute(glm), { role: "escalation", env: {}, now: Date.parse("2026-11-16T12:00:00Z") });
    expect(decision).toMatchObject({ allowed: true, priceSource: "cap", price: { inputUsdPerMTok: glm.priceCeiling!.inputUsdPerMTok, outputUsdPerMTok: glm.priceCeiling!.outputUsdPerMTok } });
    // The worst case is the page's planning tokens (the model's image tokens plus the prompt) at the ceiling, no image fee.
    const expected = (decision.inputTokens * glm.priceCeiling!.inputUsdPerMTok + decision.outputTokens * glm.priceCeiling!.outputUsdPerMTok) / 1e6;
    expect(decision.worstCostUsd).toBeCloseTo(expected, 12);
    expect(decision.ratio).toBeCloseTo(pageUpgradeCredits("ocr", "rich") / 100 / expected, 9);
    // The same reader without its ceiling is priced at the catalog's dearest host and image fee: a higher worst case.
    const uncapped = automaticCallMarginDecision("page-transcription", { ...ocrEscalationAutomaticRoute(glm), capUsdPerMTok: { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.5 }, maxPriceSent: { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.5 }, capImageUsd: (8_002 * 0.15) / 1e6 }, { role: "escalation", env: {}, now: Date.parse("2026-11-16T12:00:00Z") });
    expect(uncapped.worstCostUsd!).toBeGreaterThan(decision.worstCostUsd! * 2);
  });

  it("refuses a reader whose value does not cover its worst case, each reader on its own", () => {
    installTestPricing({ ...DISTINCT_TEST_PRICING, automaticCallValueUsd: () => 0.0001 });
    for (const route of OCR_ESCALATION_ROUTES) {
      expect(automaticCallMarginDecision("page-transcription", ocrEscalationAutomaticRoute(route), { role: "escalation", env: {} }).allowed).toBe(false);
    }
  });
});

import { describe, expect, it } from "vitest";

import {
  DEPRECATED_HOSTED_OCR_IDS,
  EXTRACT_TIERS,
  FLAT_OCR_DEFAULT_ROUTES,
  isDeprecatedHostedOcrId,
  FLAT_TIER_MIN_MARGIN_AT_CAP,
  MEASURED_OCR_ROUTES,
  flatTierMargin,
  isMeasuredOcrRouteEligible,
  PRIVATE_DEDICATED_PRICING,
  filterFlatTierRoutes,
  flatTierRouteCostCapUsdPer1kPages,
  hostedRouteCostUsdPer1kPages,
  isRouteEligibleForFlatTier,
  priceFlatTierPages,
  privateDedicatedMonthlyUsd,
} from "../extract-pricing.js";

// Cents per 1K tokens = USD per million tokens / 10.
const perMTok = (input: number, output: number) => ({ costPer1kInputTokens: input / 10, costPer1kOutputTokens: output / 10 });

describe("flat tier route eligibility", () => {
  it("caps Extract OCR routes at $0.50 per 1,000 pages on every plan", () => {
    expect(flatTierRouteCostCapUsdPer1kPages("ocr")).toBe(0.5);
    for (const price of Object.values(EXTRACT_TIERS.ocr.usdPer1kPagesByPlan)) expect(price).toBeGreaterThan(0.5);
  });

  it("holds the margin floor at the cost cap on every tier and plan", () => {
    for (const tier of Object.values(EXTRACT_TIERS)) {
      for (const plan of ["free", "silver", "gold", "platinum"] as const) {
        expect(flatTierMargin(tier.id, plan)).toBeGreaterThanOrEqual(FLAT_TIER_MIN_MARGIN_AT_CAP);
      }
    }
    expect(EXTRACT_TIERS.ocr.usdPer1kPagesByPlan.free).toBeGreaterThanOrEqual(EXTRACT_TIERS.ocr.usdPer1kPagesByPlan.platinum);
  });

  it("admits only measured OCR routes under the cost cap and above the quality floor", () => {
    const eligible = MEASURED_OCR_ROUTES.filter((route) => isMeasuredOcrRouteEligible(route)).map((route) => route.id);
    expect(eligible).toContain("lightonocr-3-0.8b");
    expect(eligible).toContain("deepseek/deepseek-v4.1-flash (effort none)");
    expect(eligible).not.toContain("z-ai/glm-5.3-flash (minimal)");
    expect(isMeasuredOcrRouteEligible({ id: "x", licenseClass: "free", kind: "self-hosted", content: 0.8, tables: null, math: null, costUsdPer1kPagesLow: 0.1, costUsdPer1kPagesHigh: 0.1 })).toBe(false);
  });

  it("prefers Ling-3.0-flash-VL as the hosted fallback ahead of DeepSeek V4.1 Flash", () => {
    const ids = MEASURED_OCR_ROUTES.map((route) => route.id);
    expect(FLAT_OCR_DEFAULT_ROUTES.hostedFallback).toBe("inclusionai/ling-3.0-flash-vl (effort none)");
    expect(FLAT_OCR_DEFAULT_ROUTES.default).toBe("lightonocr-3-0.8b");
    const ling = MEASURED_OCR_ROUTES.find((route) => route.id === FLAT_OCR_DEFAULT_ROUTES.hostedFallback);
    expect(ling && isMeasuredOcrRouteEligible(ling)).toBe(true);
    expect(ids).toContain(FLAT_OCR_DEFAULT_ROUTES.hostedFallbackSecondary);
    const deepseek = MEASURED_OCR_ROUTES.find((route) => route.id === FLAT_OCR_DEFAULT_ROUTES.hostedFallbackSecondary);
    expect(ling!.content).toBeGreaterThan(deepseek!.content);
    expect(ling!.costUsdPer1kPagesHigh).toBeLessThan(deepseek!.costUsdPer1kPagesHigh);
  });

  it("never routes the deprecated DeepInfra OCR ids", () => {
    for (const id of DEPRECATED_HOSTED_OCR_IDS) expect(isDeprecatedHostedOcrId(id)).toBe(true);
    expect(isDeprecatedHostedOcrId("DeepInfra/PaddlePaddle/PaddleOCR-VL")).toBe(true);
    for (const route of MEASURED_OCR_ROUTES) expect(isDeprecatedHostedOcrId(route.id)).toBe(false);
  });

  it("prices a route from per-token list prices and the planning page size", () => {
    // 1,500 in + 800 out per page at $0.0261 / $0.90 per MTok.
    expect(hostedRouteCostUsdPer1kPages(perMTok(0.0261, 0.9))).toBeCloseTo(0.759, 3);
  });

  it("admits cheap hosted routes and own models, and refuses the ones that lose money", () => {
    // OpenRouter list prices, USD per MTok, checked 2026-10-13.
    const routes = {
      cheap: { kind: "hosted" as const, pricing: perMTok(0.05, 0.2) },
      glm: { kind: "hosted" as const, pricing: perMTok(0.0261, 0.9) },
      haiku: { kind: "hosted" as const, pricing: perMTok(0.1, 0.5) },
      flashLite31: { kind: "hosted" as const, pricing: perMTok(0.25, 1.5) },
      flashLite35: { kind: "hosted" as const, pricing: perMTok(0.3, 2.5) },
      sonnet: { kind: "hosted" as const, pricing: perMTok(2, 10) },
      flash35: { kind: "hosted" as const, pricing: perMTok(1.5, 9) },
    };
    expect(isRouteEligibleForFlatTier("ocr", routes.cheap)).toBe(true);
    expect(isRouteEligibleForFlatTier("ocr", routes.glm)).toBe(false);
    expect(isRouteEligibleForFlatTier("ocr", routes.haiku)).toBe(false);
    expect(isRouteEligibleForFlatTier("ocr", routes.flashLite31)).toBe(false);
    expect(isRouteEligibleForFlatTier("ocr", routes.flashLite35)).toBe(false);
    expect(isRouteEligibleForFlatTier("ocr", routes.sonnet)).toBe(false);
    expect(isRouteEligibleForFlatTier("ocr", routes.flash35)).toBe(false);
    expect(isRouteEligibleForFlatTier("ocr", { kind: "self-hosted" })).toBe(true);
    expect(isRouteEligibleForFlatTier("ocr", { kind: "native" })).toBe(true);
  });

  it("fails closed when a hosted route has no known price", () => {
    expect(isRouteEligibleForFlatTier("ocr", { kind: "hosted", pricing: null })).toBe(false);
    expect(isRouteEligibleForFlatTier("ocr", { kind: "hosted", pricing: perMTok(Number.NaN, 1) })).toBe(false);
  });

  it("is looser for higher-priced tiers", () => {
    const route = { kind: "hosted" as const, pricing: perMTok(0.25, 1.5) };
    expect(isRouteEligibleForFlatTier("structured", route)).toBe(true);
    expect(isRouteEligibleForFlatTier("ocr", route)).toBe(false);
    expect(isRouteEligibleForFlatTier("text", route)).toBe(false);
  });

  it("filters candidates", () => {
    const candidates = [
      { id: "own", route: { kind: "self-hosted" as const } },
      { id: "sonnet", route: { kind: "hosted" as const, pricing: perMTok(2, 10) } },
    ];
    expect(filterFlatTierRoutes("ocr", candidates).map((entry) => entry.id)).toEqual(["own"]);
  });
});

describe("flat tier billing", () => {
  it("charges the plan's flat price per page: $1.50 per 1,000 OCR pages on Free is 150 credits", () => {
    expect(priceFlatTierPages({ tier: "ocr", pages: 1_000 }).totalCredits).toBeCloseTo(150);
    expect(priceFlatTierPages({ tier: "ocr", plan: "gold", pages: 1_000 }).totalCredits).toBeCloseTo(110);
    expect(priceFlatTierPages({ tier: "ocr", pages: 0 }).totalCredits).toBe(0);
  });

  it("bills escalations to expensive models at metered rates on top", () => {
    const charge = priceFlatTierPages({ tier: "ocr", pages: 1_000, escalatedProviderCents: 50 });
    expect(charge.flatCredits).toBeCloseTo(150);
    expect(charge.escalationCredits).toBeCloseTo(60);
    expect(charge.totalCredits).toBeCloseTo(210);
  });
});

describe("private dedicated price", () => {
  it("floors at $4,400 and reproduces the managed PRO 6000 quote at $2.75/h", () => {
    expect(PRIVATE_DEDICATED_PRICING.floorUsdPerMonth).toBe(4_400);
    // 2.75 x 730 + 500 = 2,507.5 over 0.57 = 4,399.1 -> floor.
    expect(privateDedicatedMonthlyUsd({ gpuUsdPerHour: 2.75 })).toBe(4_400);
  });

  it("keeps a 40% margin after 3% fees on bigger boxes", () => {
    const price = privateDedicatedMonthlyUsd({ gpuUsdPerHour: 6, boxes: 2 });
    const cost = 2 * (6 * 730 + 500);
    expect((price * 0.97 - cost) / price).toBeGreaterThanOrEqual(0.4 - 1e-3);
    expect(price).toBeGreaterThan(2 * 4_400);
  });

  it("never prices below the floor and rejects bad rates", () => {
    expect(privateDedicatedMonthlyUsd({ gpuUsdPerHour: 0.46 })).toBe(4_400);
    expect(() => privateDedicatedMonthlyUsd({ gpuUsdPerHour: -1 })).toThrow();
  });
});

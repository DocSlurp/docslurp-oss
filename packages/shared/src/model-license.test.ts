import { describe, expect, it, vi } from "vitest";

import { buildDecisionModelCatalog, buildRoutingTargetCatalog } from "./routing-targets.js";
import { licenseClassOfModel, readDisableNonFreeSoftware, resetDisableNonFreeSoftwareWarnings } from "./model-license.js";
import {
  MEASURED_OCR_ROUTES,
  filterFlatTierRoutes,
  flatOcrDefaultRoutes,
  isMeasuredOcrRouteEligible,
  isRouteEligibleForFlatTier,
} from "./extract-pricing.js";

const prices = {
  asOf: "2026-10-13",
  models: Object.fromEntries(
    [
      "google/gemini-2.5-flash-lite",
      "google/gemini-3.1-flash-lite",
      "google/gemini-3.5-flash-lite",
      "z-ai/glm-5.3-flash",
      "google/gemini-3.5-flash",
      "openai/gpt-6-luna",
      "anthropic/claude-haiku-5.5",
      "inclusionai/ling-3.0-flash-vl",
      "anthropic/claude-sonnet-5.5",
    ].map((m) => [m, { input: 0.1, output: 0.4 }]),
  ),
};
const allEnv = {
  OPENROUTER_API_KEY: true,
  PERPLEXITYAI_API_KEY: true,
  LIQUID_API_KEY: true,
  LIGHTONOCR_3_ENDPOINT_URL: true,
  MINERU_2_5_ENDPOINT_URL: true,
  INFINITY_PARSER2_ENDPOINT_URL: true,
  DOTS_OCR_ENDPOINT_URL: true,
  OLMOCR_2_ENDPOINT_URL: true,
  NANONETS_OCR2_ENDPOINT_URL: true,
  DEEPSEEK_OCR_2_ENDPOINT_URL: true,
};

describe("DISABLE_NON_FREE_SOFTWARE flag parsing", () => {
  it("defaults false, accepts true/1, warns once on a typo", () => {
    resetDisableNonFreeSoftwareWarnings();
    const warn = vi.fn();
    expect(readDisableNonFreeSoftware({}, warn)).toBe(false);
    expect(readDisableNonFreeSoftware({ DISABLE_NON_FREE_SOFTWARE: "TRUE" }, warn)).toBe(true);
    expect(readDisableNonFreeSoftware({ DISABLE_NON_FREE_SOFTWARE: "1" }, warn)).toBe(true);
    expect(readDisableNonFreeSoftware({ DISABLE_NON_FREE_SOFTWARE: "no" }, warn)).toBe(false);
    expect(readDisableNonFreeSoftware({ DISABLE_NON_FREE_SOFTWARE: "no" }, warn)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("licence classes in the routing target catalog", () => {
  const allowed = buildRoutingTargetCatalog({ prices, env: allEnv });
  const blocked = buildRoutingTargetCatalog({ prices, env: allEnv, disableNonFree: true });
  const cls = (id: string) => allowed.targets.find((t) => t.id === id)?.licenseClass;

  it("classifies every admitted target", () => {
    expect(allowed.targets.every((t) => t.licenseClass && t.license)).toBe(true);
    expect(cls("vlm:private/dots-ocr")).toBe("non-free");
    expect(cls("vlm:private/nanonets-ocr2")).toBe("non-free");
    expect(cls("vlm:private/lightonocr-3")).toBe("free");
    expect(cls("vlm:private/olmocr-2")).toBe("free");
    expect(cls("vlm:private/mineru2.5")).toBe("free");
    expect(cls("vlm:openrouter/inclusionai/ling-3.0-flash-vl")).toBe("free");
    expect(cls("vlm:openrouter/google/gemini-3.5-flash")).toBe("proprietary-hosted");
    expect(cls("vlm:openrouter/anthropic/claude-sonnet-5.5")).toBe("proprietary-hosted");
    expect(cls("native:pdf-markdown")).toBe("free");
  });

  it("keeps non-free targets when the flag is off", () => {
    const ids = allowed.targets.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(["vlm:private/dots-ocr", "vlm:private/nanonets-ocr2"]));
    expect(allowed.rejected.some((r) => r.reason === "non-free-disabled")).toBe(false);
  });

  it("rejects non-free targets as non-free-disabled and keeps free and proprietary-hosted ones", () => {
    const ids = blocked.targets.map((t) => t.id);
    expect(ids).not.toContain("vlm:private/dots-ocr");
    expect(ids).not.toContain("vlm:private/nanonets-ocr2");
    expect(blocked.rejected.filter((r) => r.reason === "non-free-disabled").map((r) => r.targetId).sort()).toEqual([
      "vlm:private/dots-ocr",
      "vlm:private/nanonets-ocr2",
    ]);
    expect(ids).toEqual(
      expect.arrayContaining(["vlm:private/lightonocr-3", "vlm:private/olmocr-2", "vlm:openrouter/google/gemini-3.5-flash", "native:pymupdf"]),
    );
    expect(blocked.targets.some((t) => t.licenseClass === "non-free")).toBe(false);
  });

  it("fails closed: an unlisted private or local-labeler target is non-free", () => {
    const base = allowed.targets.find((t) => t.id === "vlm:private/lightonocr-3")!;
    const unknown = { ...base, id: "vlm:private/mystery", ref: { modelUri: "llm://private/mystery" }, licenseClass: undefined, license: undefined };
    const out = buildRoutingTargetCatalog({
      prices,
      env: { ...allEnv, MYSTERY: true },
      extraTargets: [{ ...unknown, availability: { requiresEnv: ["MYSTERY"], privacyClass: "private" } }],
      disableNonFree: true,
    });
    expect(out.rejected.find((r) => r.targetId === "vlm:private/mystery")?.reason).toBe("non-free-disabled");
  });
});

describe("licence classes in the decision model catalog", () => {
  it("classifies hosted APIs (including OpenRouter liquid/d1) as proprietary-hosted and Liquid d1 weights as non-free", () => {
    const { models } = buildDecisionModelCatalog({ env: allEnv });
    const cls = (id: string) => models.find((m) => m.id === id)?.licenseClass;
    expect(cls("cloudflare/clef-flash")).toBe("proprietary-hosted");
    expect(cls("typesafe/jev-1.13")).toBe("proprietary-hosted");
    expect(cls("perplexity/pplx-decider-v1.1-27b")).toBe("proprietary-hosted");
    expect(cls("openai/gpt-6-luna-decisions")).toBe("proprietary-hosted");
    expect(cls("liquid/d1")).toBe("proprietary-hosted");
    expect(cls("local/LiquidAI/d1-omni-600M")).toBe("non-free");
  });

  it("drops the non-free Liquid d1 routes only when the flag is on", () => {
    const on = buildDecisionModelCatalog({ env: allEnv, disableNonFree: true });
    expect(on.models.map((m) => m.id)).toContain("liquid/d1");
    expect(on.models.map((m) => m.id)).not.toContain("local/LiquidAI/d1-omni-600M");
    expect(on.models.map((m) => m.id)).toContain("cloudflare/clef-flash");
    expect(on.rejected.filter((r) => r.reason === "non-free-disabled")).toHaveLength(2);
    const off = buildDecisionModelCatalog({ env: allEnv });
    expect(off.models.map((m) => m.id)).toContain("liquid/d1");
  });
});

describe("flat tier route policy", () => {
  it("excludes non-free routes only when the flag is on", () => {
    const dots = MEASURED_OCR_ROUTES.find((r) => r.id === "dots.ocr")!;
    expect(isMeasuredOcrRouteEligible(dots)).toBe(true);
    expect(isMeasuredOcrRouteEligible(dots, { disableNonFree: true })).toBe(false);
    expect(isRouteEligibleForFlatTier("ocr", { kind: "self-hosted", licenseClass: "non-free" })).toBe(true);
    expect(isRouteEligibleForFlatTier("ocr", { kind: "self-hosted", licenseClass: "non-free" }, { disableNonFree: true })).toBe(false);
    expect(isRouteEligibleForFlatTier("ocr", { kind: "self-hosted", licenseClass: "free" }, { disableNonFree: true })).toBe(true);
    const kept = filterFlatTierRoutes(
      "ocr",
      [{ route: { kind: "self-hosted", licenseClass: "non-free" } as const }, { route: { kind: "native" } as const }],
      { disableNonFree: true },
    );
    expect(kept).toHaveLength(1);
  });

  it("drops dots.ocr from the math-page defaults when the flag is on", () => {
    expect(flatOcrDefaultRoutes().mathPages).toEqual(["dots.ocr", "olmocr-2"]);
    expect(flatOcrDefaultRoutes({ disableNonFree: true }).mathPages).toEqual(["olmocr-2"]);
  });

  it("classifies research-only and non-commercial models by id or uri", () => {
    expect(licenseClassOfModel("llm://vllm/Qwen/Qwen2.5-VL-3B-Instruct")).toBe("non-free");
    expect(licenseClassOfModel("Qwen/Qwen3-VL-8B-Instruct")).toBe("free");
    expect(licenseClassOfModel("jinaai/jina-embeddings-v5-omni-small")).toBe("non-free");
    expect(licenseClassOfModel("llm://openai/gpt-4.1-mini")).toBe("proprietary-hosted");
  });
});

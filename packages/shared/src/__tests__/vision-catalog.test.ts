import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPENROUTER_VISION_MODEL,
  NEMOTRON_SUPER_VL_VISION_MODEL,
  OPENROUTER_BASE_URL,
  defaultVisionConfig,
  normalizePipelineFeatures,
  openRouterReasoningParams,
  resolveVisionRoute,
  visionConfigSchema,
  visionListPriceCents,
  visionModelCatalog,
  visionModelTokenPricing,
} from "../index.js";

const NEMOTRON_URI = `llm://openrouter/${NEMOTRON_SUPER_VL_VISION_MODEL}`;

describe("hosted vision catalog", () => {
  it("keeps Gemini 3.1 Flash Lite as the default and Nemotron opt-in", () => {
    expect(defaultVisionConfig.profile).toBe("good-fast-hosted");
    expect(defaultVisionConfig.modelUri).toBe(`llm://openrouter/${DEFAULT_OPENROUTER_VISION_MODEL}`);
    expect(visionConfigSchema.parse({}).modelUri).toBe(`llm://openrouter/${DEFAULT_OPENROUTER_VISION_MODEL}`);
  });

  it("resolves the opt-in profile and an explicit model URI to the OpenRouter route", () => {
    for (const config of [
      visionConfigSchema.parse({ profile: "open-weights-hosted" }),
      visionConfigSchema.parse({ modelUri: NEMOTRON_URI }),
    ]) {
      expect(config).toMatchObject({ modelUri: NEMOTRON_URI, target: "hosted" });
      expect(resolveVisionRoute(config)).toMatchObject({
        provider: "openrouter",
        runtime: "openai-compatible",
        model: NEMOTRON_SUPER_VL_VISION_MODEL,
        baseUrl: OPENROUTER_BASE_URL,
      });
    }
  });

  it("accepts a per-run pipeline override and stored catalog model ids", () => {
    expect(normalizePipelineFeatures({ vision: { modelUri: NEMOTRON_URI } }).vision.modelUri).toBe(NEMOTRON_URI);
    expect(normalizePipelineFeatures({ vision: { profile: "open-weights-hosted" } }).vision.modelUri).toBe(NEMOTRON_URI);
    const stored = { vision: { model: NEMOTRON_SUPER_VL_VISION_MODEL, runtime: "openai-compatible", baseUrl: OPENROUTER_BASE_URL } };
    expect(normalizePipelineFeatures(stored as unknown as Parameters<typeof normalizePipelineFeatures>[0]).vision.modelUri).toBe(NEMOTRON_URI);
  });

  it("carries list token prices for every hosted entry and none for local ones", () => {
    for (const entry of visionModelCatalog) {
      if (entry.target === "hosted") expect(entry.tokenPricing, entry.id).not.toBeNull();
      else expect(entry.tokenPricing, entry.id).toBeNull();
    }
    expect(visionModelTokenPricing(NEMOTRON_URI)).toMatchObject({ inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.5 });
    expect(visionModelTokenPricing(NEMOTRON_SUPER_VL_VISION_MODEL)).toMatchObject({ inputUsdPerMillion: 0.15 });
    // 2,000 input + 1,000 output tokens: $0.0003 + $0.0005 = 0.08 cents.
    expect(visionListPriceCents(NEMOTRON_SUPER_VL_VISION_MODEL, { inputTokens: 2_000, outputTokens: 1_000 })).toBeCloseTo(0.08, 12);
    expect(visionListPriceCents("Qwen/Qwen2-VL-2B-Instruct", { inputTokens: 1, outputTokens: 1 })).toBeNull();
    expect(visionListPriceCents("vendor/unknown", { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });

  it("switches Nemotron reasoning off for page transcription", () => {
    expect(openRouterReasoningParams(NEMOTRON_SUPER_VL_VISION_MODEL)).toEqual({ reasoning: { enabled: false } });
    expect(openRouterReasoningParams(DEFAULT_OPENROUTER_VISION_MODEL)).toEqual({});
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_OPENROUTER_VISION_MODEL,
  DEFAULT_VISION_PROFILE,
  NEMOTRON_SUPER_VL_VISION_MODEL,
  OPENROUTER_BASE_URL,
  applyDefaultVisionOverride,
  defaultVisionConfig,
  normalizePipelineFeatures,
  readVisionModelUriOverride,
  resetVisionModelUriOverrideReports,
  visionModelCatalogById,
  visionProfileCatalog,
  openRouterReasoningParams,
  resolveVisionRoute,
  visionConfigSchema,
  visionListPriceCents,
  visionModelCatalog,
  visionModelTokenPricing,
} from "../index.js";

const NEMOTRON_URI = `llm://openrouter/${NEMOTRON_SUPER_VL_VISION_MODEL}`;

describe("hosted vision catalog", () => {
  const defaultUri = `llm://openrouter/${DEFAULT_OPENROUTER_VISION_MODEL}`;

  it("derives the default config, profile text and catalog entry from DEFAULT_OPENROUTER_VISION_MODEL", () => {
    const entry = visionModelCatalogById[DEFAULT_OPENROUTER_VISION_MODEL];
    expect(entry).toMatchObject({ target: "hosted", uri: defaultUri });
    expect(entry.tokenPricing).not.toBeNull();
    expect(defaultVisionConfig.profile).toBe(DEFAULT_VISION_PROFILE);
    expect(defaultVisionConfig.modelUri).toBe(defaultUri);
    expect(visionConfigSchema.parse({}).modelUri).toBe(defaultUri);
    expect(visionProfileCatalog[DEFAULT_VISION_PROFILE].config.modelUri).toBe(defaultUri);
    expect(visionProfileCatalog[DEFAULT_VISION_PROFILE].description).toContain(entry.label);
    expect(new Set(visionModelCatalog.map((model) => model.id)).size).toBe(visionModelCatalog.length);
  });

  it("catalogs the tuned opt-in models with list prices and never a Pro/Ultra or :free variant", () => {
    const tuned = {
      "deepseek/deepseek-v4.1-flash-1017": { input: 0.15, output: 0.6, perPage: 0.103 },
      "xiaomi/mimo-v2.6-flash": { input: 0.14, output: 0.28, perPage: 0.056 },
      "openai/gpt-6-luna": { input: 0.1, output: 0.5, perPage: 0.061 },
      "z-ai/glm-5.3-flash": { input: 0.15, output: 0.5, perPage: 0.073 },
    };
    for (const [id, expected] of Object.entries(tuned)) {
      const uri = `llm://openrouter/${id}`;
      expect(visionModelCatalogById[id as keyof typeof visionModelCatalogById], id).toMatchObject({
        uri,
        target: "hosted",
        estimatedCostPerPageCents: expected.perPage,
      });
      expect(visionModelTokenPricing(uri), id).toEqual({
        inputUsdPerMillion: expected.input,
        outputUsdPerMillion: expected.output,
        checked: "2026-10-25",
      });
      expect(visionConfigSchema.parse({ modelUri: uri }).modelUri).toBe(uri);
    }
    // GLM: ~3,000 input + 560 output tokens at list price, rounded up.
    expect(visionListPriceCents("z-ai/glm-5.3-flash", { inputTokens: 3_000, outputTokens: 560 })).toBeCloseTo(0.073, 4);
    for (const entry of visionModelCatalog) expect(entry.id, entry.id).not.toMatch(/-pro|-ultra|:free/i);
  });

  describe("DOCSLURP_VISION_MODEL_URI", () => {
    const luna = "llm://openrouter/openai/gpt-6-luna";
    const pipeline = (vision = defaultVisionConfig, privacyMode = "standard") => ({ vision, privacyMode });

    it("replaces only the built-in default vision model", () => {
      const env = { DOCSLURP_VISION_MODEL_URI: luna };
      const out = applyDefaultVisionOverride(pipeline(), env);
      expect(out.vision).toMatchObject({ modelUri: luna, target: "hosted", profile: DEFAULT_VISION_PROFILE });
      expect(resolveVisionRoute(out.vision)).toMatchObject({ provider: "openrouter", model: "openai/gpt-6-luna" });
      // Unset env and an override equal to the default change nothing.
      const base = pipeline();
      expect(applyDefaultVisionOverride(base, {})).toBe(base);
      expect(applyDefaultVisionOverride(base, { DOCSLURP_VISION_MODEL_URI: defaultUri })).toBe(base);
    });

    it("lets an explicit workspace model, profile or privacy mode win", () => {
      const env = { DOCSLURP_VISION_MODEL_URI: luna };
      const explicitModel = pipeline(visionConfigSchema.parse({ modelUri: NEMOTRON_URI }));
      const explicitProfile = pipeline(visionConfigSchema.parse({ profile: "cheapest-hosted" }));
      const local = pipeline(visionConfigSchema.parse({ profile: "cheapest-local" }));
      for (const input of [explicitModel, explicitProfile, local]) expect(applyDefaultVisionOverride(input, env)).toBe(input);
      for (const mode of ["local-only", "strict-privacy"]) {
        const strict = pipeline(defaultVisionConfig, mode);
        expect(applyDefaultVisionOverride(strict, env)).toBe(strict);
      }
    });

    it("ignores invalid values with one error each", () => {
      resetVisionModelUriOverrideReports();
      const onError = vi.fn();
      for (const value of [
        "not a uri",
        "llm://openrouter/vendor/uncataloged-model",
        "llm://local-cli/microsoft/Florence-2-base-ft",
        "openai/gpt-6-luna",
      ]) {
        expect(readVisionModelUriOverride({ DOCSLURP_VISION_MODEL_URI: value }, onError), value).toBeNull();
        readVisionModelUriOverride({ DOCSLURP_VISION_MODEL_URI: value }, onError);
      }
      expect(onError).toHaveBeenCalledTimes(4);
      expect(onError.mock.calls[0]![0]).toContain("DOCSLURP_VISION_MODEL_URI");
      expect(readVisionModelUriOverride({ DOCSLURP_VISION_MODEL_URI: "  " }, onError)).toBeNull();
      expect(onError).toHaveBeenCalledTimes(4);
      expect(readVisionModelUriOverride({ DOCSLURP_VISION_MODEL_URI: ` ${luna} ` }, onError)).toBe(luna);
    });
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

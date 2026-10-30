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
  visionModelImageTokenBound,
  visionModelUriProblem,
  visionModelRefusal,
  isProhibitedPremiumModelId,
  VISION_MAX_OUTPUT_USD_PER_MILLION,
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
      // Priced at the pinned US route (Together, Fireworks, Parasail), not DeepSeek's own list price.
      "deepseek/deepseek-v4.1-flash-1017": { input: 0.3, output: 1.2, perPage: 0.103, checked: "2026-10-26", route: ["together", "fireworks", "parasail"] },
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
      const route = "route" in expected ? expected.route : undefined;
      expect(visionModelTokenPricing(uri), id).toEqual({
        inputUsdPerMillion: expected.input,
        outputUsdPerMillion: expected.output,
        checked: "checked" in expected ? expected.checked : "2026-10-25",
        ...(route ? { basis: "pinned-route", providers: route } : {}),
      });
      // MiMo stays cataloged (price, profile) but is refused until its image-token bound has serving evidence.
      if (visionModelRefusal(id)) expect(visionConfigSchema.safeParse({ modelUri: uri }).success, id).toBe(false);
      else expect(visionConfigSchema.parse({ modelUri: uri }).modelUri).toBe(uri);
    }
    expect(visionModelRefusal("xiaomi/mimo-v2.6-flash")).not.toBeNull();
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
      const explicitModel = pipeline(visionConfigSchema.parse({ modelUri: "llm://openrouter/z-ai/glm-5.3-flash" }));
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

  it("resolves the open-weights profile to the admitted open-weights default, and refuses Nemotron", () => {
    const defaultUri = `llm://openrouter/${DEFAULT_OPENROUTER_VISION_MODEL}`;
    const config = visionConfigSchema.parse({ profile: "open-weights-hosted" });
    expect(config).toMatchObject({ modelUri: defaultUri, target: "hosted" });
    expect(resolveVisionRoute(config)).toMatchObject({
      provider: "openrouter",
      runtime: "openai-compatible",
      model: DEFAULT_OPENROUTER_VISION_MODEL,
      baseUrl: OPENROUTER_BASE_URL,
    });
    const refused = visionConfigSchema.safeParse({ modelUri: NEMOTRON_URI });
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.error?.issues)).toContain("is not admitted");
    expect(visionModelUriProblem(NEMOTRON_URI)).toMatch(/not proven at the serving level/);
  });

  it("accepts a per-run pipeline override and stored catalog model ids; a stored refused model fails loudly", () => {
    const glm = "llm://openrouter/z-ai/glm-5.3-flash";
    expect(normalizePipelineFeatures({ vision: { modelUri: glm } }).vision.modelUri).toBe(glm);
    expect(normalizePipelineFeatures({ vision: { profile: "open-weights-hosted" } }).vision.modelUri).toBe(`llm://openrouter/${DEFAULT_OPENROUTER_VISION_MODEL}`);
    const stored = { vision: { model: "z-ai/glm-5.3-flash", runtime: "openai-compatible", baseUrl: OPENROUTER_BASE_URL } };
    expect(normalizePipelineFeatures(stored as unknown as Parameters<typeof normalizePipelineFeatures>[0]).vision.modelUri).toBe(glm);
    const storedNemotron = { vision: { model: NEMOTRON_SUPER_VL_VISION_MODEL, runtime: "openai-compatible", baseUrl: OPENROUTER_BASE_URL } };
    expect(() => normalizePipelineFeatures(storedNemotron as unknown as Parameters<typeof normalizePipelineFeatures>[0])).toThrow(/is not admitted/);
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

describe("hosted vision catalog limits", () => {
  it("gives every priced model an image-token bound, an output price under the limit and a non-premium id", () => {
    for (const spec of visionModelCatalog) {
      expect(isProhibitedPremiumModelId(spec.id), spec.id).toBe(false);
      if (!spec.tokenPricing) continue;
      if (visionModelRefusal(spec.id)) {
        expect(visionModelImageTokenBound(spec.id), spec.id).toBeNull();
        expect(visionModelUriProblem(spec.uri), spec.uri).toMatch(/is not admitted/);
        continue;
      }
      expect(visionModelImageTokenBound(spec.id), spec.id).not.toBeNull();
      expect(spec.tokenPricing.outputUsdPerMillion, spec.id).toBeLessThan(VISION_MAX_OUTPUT_USD_PER_MILLION);
      expect(visionModelUriProblem(spec.uri), spec.uri).toBeNull();
    }
  });

  it("refuses unknown hosted providers, uncataloged hosted models and Pro/Ultra ids on every provider", () => {
    expect(visionModelUriProblem("llm://acme/o3-pro")).toMatch(/Pro\/Ultra/);
    expect(visionModelUriProblem("llm://acme/plain-vl")).toMatch(/not supported/);
    expect(visionModelUriProblem("llm://anthropic/claude-haiku-5.5")).toMatch(/not supported/);
    expect(visionModelUriProblem("llm://huggingface/Qwen/Qwen2.5-VL-7B-Instruct")).toMatch(/not supported/);
    expect(visionModelUriProblem("llm://openrouter/anthropic/claude-haiku-5.5")).toMatch(/priced vision catalog/);
    expect(visionModelUriProblem("llm://openai/gpt-x")).toMatch(/priced vision catalog/);
    for (const uri of ["llm://openrouter/openai/o3-pro", "llm://openai/gpt-5-pro", "llm://vllm/x/model-ultra", "llm://private/gpu1/acme/vl-pro-2025"]) {
      expect(visionModelUriProblem(uri), uri).toMatch(/Pro\/Ultra/);
    }
    // Not premium tiers: "pro" inside a word, or "-pro" not followed by a separator.
    expect(isProhibitedPremiumModelId("acme/prompt-vl")).toBe(false);
    expect(isProhibitedPremiumModelId("acme/vl-professional")).toBe(false);
    expect(visionModelUriProblem("llm://vllm/acme/plain-vl")).toBeNull();
    expect(visionModelUriProblem("llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8")).toBeNull();
  });
});

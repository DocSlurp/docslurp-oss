import { describe, expect, it } from "vitest";

import {
  customerPipelineView,
  managedPipelineModelPaths,
  publicPipelineFeatureOverridesSchema,
  resolveManagedPipeline,
  storedManagedPipeline,
} from "../managed-pipeline-models.js";
import { automaticModelCallProblem, policyModelId } from "../model-call-policy.js";
import { isProhibitedRoutingModelId } from "../routing-targets.js";
import { customerSearchSettingsView, publicUpdateProjectSearchSettingsSchema } from "../project.js";
import { defaultPipelineFeatures, normalizePipelineFeatures } from "../pipeline.js";
import { CHAT_TIER_MODELS, chatTierForModel, isProjectChatModelId } from "../project-chat-models.js";
import { CHAT_MODEL_PRICES_USD_PER_MTOK } from "../chat-model-prices.js";
import { isAutomaticSelectionDenied } from "../automatic-model-selection.js";

const BACKEND_ID = /llm:\/\/|openrouter|perplexity|gemini|deepseek|qwen|z-ai|openai\/|anthropic\/|cloudflare\/|typesafe\/|google\/|xenova|jinaai/i;

describe("managed pipeline model fields", () => {
  it("finds every backend model, provider and route a raw request sets", () => {
    expect(managedPipelineModelPaths({
      textGeneration: { model: "qwen/qwen3.5-flash-02-23", models: { "document-summary": "x/y" } },
      structuredExtraction: { model: "llm://openrouter/x/y" },
      embedding: { profile: "good-fast-local", modelUri: "llm://openrouter/perplexity/pplx-embed-v1-0.6b", target: "hosted" },
      vision: { modelUri: "llm://openrouter/x/y", target: "local", remoteFallbackModelUri: "llm://openrouter/x/z" },
      visualPages: { route: "gemini" },
      pageRouter: { router: "decision-model", decisionModel: ["openai/gpt-6-luna-decisions"] },
      chartExport: { enabled: true, generatorModel: "llm://openrouter/z-ai/glm-5.3-flash" },
    })).toEqual([
      "pipeline.textGeneration.model", "pipeline.textGeneration.models", "pipeline.structuredExtraction.model",
      "pipeline.embedding.modelUri", "pipeline.embedding.target", "pipeline.vision.modelUri", "pipeline.vision.target",
      "pipeline.vision.remoteFallbackModelUri", "pipeline.visualPages.route", "pipeline.pageRouter.decisionModel",
      "pipeline.chartExport.generatorModel",
    ]);
  });

  it("lets categories, nulls, empty maps and the auto route through", () => {
    expect(managedPipelineModelPaths({
      quality: "good", inferenceLane: "backfill", embedding: { profile: "good-fast-local" }, vision: { profile: "cheapest-hosted", remoteFallbackModelUri: null },
      textGeneration: { model: null, models: {} }, structuredExtraction: { model: null }, visualPages: { route: "auto", coarseFallback: true },
    })).toEqual([]);
    // A normalized pipeline read back and saved carries each profile's own URI and target: not a model choice.
    expect(managedPipelineModelPaths(normalizePipelineFeatures(defaultPipelineFeatures))).toEqual([]);
    expect(managedPipelineModelPaths({ embedding: { profile: "fastest-local", modelUri: "llm://transformers.js/Xenova/gte-small", target: "local" } })).toEqual([]);
    expect(managedPipelineModelPaths(undefined)).toEqual([]);
    expect(managedPipelineModelPaths("nope")).toEqual([]);
  });

  it("refuses managed fields in public overrides with the categories to use, never echoing the value", () => {
    const result = publicPipelineFeatureOverridesSchema.safeParse({ vision: { modelUri: "llm://openrouter/acme/secret-model" } });
    expect(result.success).toBe(false);
    const message = result.error!.issues[0]!.message;
    expect(message).toContain("pipeline.vision.modelUri");
    expect(message).toContain("pipeline.quality");
    expect(message).not.toContain("secret-model");
    expect(publicPipelineFeatureOverridesSchema.safeParse({ quality: "good", embedding: { profile: "good-fast-local" } }).success).toBe(true);
  });

  it("drops every stored model value that is not an explicit override, so current defaults apply", () => {
    const legacy = {
      ...defaultPipelineFeatures,
      vision: { profile: "good-fast-hosted", modelUri: "llm://openrouter/deepseek/deepseek-v4.1-flash-1017", remoteFallbackModelUri: "llm://openrouter/google/gemini-2.5-flash-lite" },
      textGeneration: { model: "qwen/qwen3.5-flash-02-23", models: { "document-summary": "z-ai/glm-5.3-flash" } },
      structuredExtraction: { model: "z-ai/glm-5.3-flash" },
      visualPages: { route: "gemini", coarseFallback: false },
    };
    const { pipeline, applied, dropped } = resolveManagedPipeline(legacy, null, "test");
    const current = normalizePipelineFeatures(defaultPipelineFeatures);
    expect(pipeline.vision.modelUri).toBe(current.vision.modelUri);
    expect(pipeline.vision.modelUri).not.toMatch(/deepseek/);
    expect(pipeline.vision.remoteFallbackModelUri).toBeNull();
    expect(pipeline.textGeneration).toMatchObject({ model: null, models: {} });
    expect(pipeline.structuredExtraction.model).toBeNull();
    expect(pipeline.visualPages.route).toBe("auto");
    expect([applied, dropped]).toEqual([[], []]);
  });

  it("applies explicit admin overrides, and stores them so direct readers see them", () => {
    const overrides = { textGeneration: { model: "llm://private/gpu1/acme/text" }, vision: { modelUri: "llm://openrouter/google/gemini-2.5-flash-lite" } };
    const resolved = resolveManagedPipeline({ ...defaultPipelineFeatures, textGeneration: { model: "z-ai/glm-5.3-flash", models: {} } }, overrides, "test");
    expect(resolved.pipeline.textGeneration.model).toBe("llm://private/gpu1/acme/text");
    expect(resolved.pipeline.vision.modelUri).toBe("llm://openrouter/google/gemini-2.5-flash-lite");
    const stored = storedManagedPipeline(resolved.pipeline, overrides, resolved.applied) as { vision: Record<string, unknown>; embedding: Record<string, unknown> };
    expect(stored.vision.modelUri).toBe("llm://openrouter/google/gemini-2.5-flash-lite");
    // A default the schema filled in is not stored, so a later default change applies.
    expect(stored.embedding).not.toHaveProperty("modelUri");
  });

  it("drops an override that conflicts with the customer's privacy mode instead of storing an invalid pipeline", () => {
    const overrides = { vision: { remoteFallbackModelUri: "llm://openrouter/google/gemini-2.5-flash-lite" } };
    const strict = { ...defaultPipelineFeatures, privacyMode: "local-only", vision: { profile: "cheapest-local" }, embedding: { profile: "cheapest-local" } };
    const resolved = resolveManagedPipeline(strict, overrides, "test");
    expect(resolved.dropped).toEqual(["vision.remoteFallbackModelUri"]);
    expect(resolved.pipeline.vision.remoteFallbackModelUri).toBeNull();
  });

  it("customer views of the FULL default pipeline carry no backend model ids", () => {
    const view = customerPipelineView(normalizePipelineFeatures(defaultPipelineFeatures));
    expect(JSON.stringify(view)).not.toMatch(BACKEND_ID);
    // A default pipeline read back and saved is not a model choice.
    expect(managedPipelineModelPaths(normalizePipelineFeatures(defaultPipelineFeatures))).toEqual([]);
  });
});

describe("call-time model policy", () => {
  it("refuses denied, Pro/Ultra and over-cap models whatever their spelling", () => {
    expect(automaticModelCallProblem("llm://openrouter/deepseek/deepseek-v4.1-flash-1017?_provider=fireworks")).toBe("never selected automatically");
    expect(automaticModelCallProblem("openai/gpt-6-sol-pro?reasoning=high")).toBe("prohibited model");
    expect(automaticModelCallProblem("openai%2Fgpt-6-sol-pro")).toBe("prohibited model");
    expect(isProhibitedRoutingModelId("openai/gpt-6-sol-pro?reasoning=high")).toBe(true);
    expect(isProhibitedRoutingModelId("openai/gpt-6-sol-pro#x")).toBe(true);
    expect(automaticModelCallProblem("anthropic/claude-haiku-5.5")).toBeNull();
    expect(automaticModelCallProblem("llm://private/gpu1/acme/model")).toBeNull();
    expect(policyModelId("LLM://OpenRouter/openai/gpt-6-luna:nitro?x=1")).toBe("openai/gpt-6-luna");
  });
});

describe("reranker category", () => {
  it("maps keyword and model onto the managed reranker and refuses provider names", () => {
    expect(publicUpdateProjectSearchSettingsSchema.parse({ retrievalDefaults: { reranker: "model", useRerank: true } }).retrievalDefaults)
      .toEqual({ useRerank: true, rerankProvider: "deepinfra", rerankModel: "Qwen/Qwen3-Reranker-0.6B" });
    expect(publicUpdateProjectSearchSettingsSchema.parse({ retrievalDefaults: { reranker: "keyword" } }).retrievalDefaults).toEqual({ rerankProvider: "bm25" });
    expect(publicUpdateProjectSearchSettingsSchema.safeParse({ retrievalDefaults: { rerankProvider: "deepinfra" } }).success).toBe(false);
    expect(publicUpdateProjectSearchSettingsSchema.safeParse({ retrievalDefaults: { rerankModel: "Qwen/Qwen3-Reranker-0.6B" } }).success).toBe(false);
  });

  it("reads back as a category", () => {
    const view = customerSearchSettingsView({ retrievalDefaults: { rerankProvider: "deepinfra", rerankModel: "Qwen/Qwen3-Reranker-0.6B", useRerank: true } });
    expect(view.retrievalDefaults).toEqual({ useRerank: true, reranker: "model" });
  });
});

describe("chat tiers", () => {
  it("map to reviewed catalog models priced under the output cap, never an automatic-selection-denied model", () => {
    for (const model of Object.values(CHAT_TIER_MODELS)) expect(isAutomaticSelectionDenied(model), model).toBe(false);
    for (const [tier, model] of Object.entries(CHAT_TIER_MODELS)) {
      expect(isProjectChatModelId(model), tier).toBe(true);
      expect(CHAT_MODEL_PRICES_USD_PER_MTOK[model]!.output, tier).toBeLessThan(50);
      expect(model, tier).not.toMatch(/-pro\b|ultra/i);
    }
  });

  it("map fastest, balanced and smart to Haiku 5.5, GPT-6 Luna and GPT-6.1 Sol (owner, 2026-11-13)", () => {
    expect(CHAT_TIER_MODELS).toEqual({ fastest: "anthropic/claude-haiku-5.5", balanced: "openai/gpt-6-luna", smart: "openai/gpt-6.1-sol" });
  });

  it("name the tier a served model answers for", () => {
    expect(chatTierForModel("anthropic/claude-haiku-5.5")).toBe("fastest");
    expect(chatTierForModel("openai/gpt-6-luna:nitro")).toBe("balanced");
    expect(chatTierForModel("z-ai/glm-5.3-flash")).toBeNull();
    expect(chatTierForModel("deepseek/deepseek-v4.1-flash-1017")).toBeNull();
    expect(chatTierForModel("llm://openrouter/openai/gpt-6.1-sol")).toBe("smart");
    expect(chatTierForModel("z-ai/glm-5.3-flash", { fastest: "z-ai/glm-5.3-flash" })).toBe("fastest");
    expect(chatTierForModel("acme/unknown")).toBeNull();
  });
});

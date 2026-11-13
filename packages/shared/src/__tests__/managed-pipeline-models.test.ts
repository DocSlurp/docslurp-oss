import { describe, expect, it } from "vitest";

import {
  carryManagedPipelineFields,
  customerPipelineView,
  managedPipelineModelPaths,
  publicPipelineFeatureOverridesSchema,
} from "../managed-pipeline-models.js";
import { customerSearchSettingsView, publicUpdateProjectSearchSettingsSchema } from "../project.js";
import { defaultPipelineFeatures, normalizePipelineFeatures } from "../pipeline.js";
import { CHAT_TIER_MODELS, chatTierForModel, isProjectChatModelId } from "../project-chat-models.js";
import { CHAT_MODEL_PRICES_USD_PER_MTOK } from "../chat-model-prices.js";

const BACKEND_ID = /llm:\/\/|openrouter|perplexity|gemini|deepseek|qwen|z-ai|openai/i;

describe("managed pipeline model fields", () => {
  it("finds every backend model, provider and route a raw request sets", () => {
    expect(managedPipelineModelPaths({
      textGeneration: { model: "qwen/qwen3.5-flash-02-23", models: { "document-summary": "x/y" } },
      structuredExtraction: { model: "llm://openrouter/x/y" },
      embedding: { profile: "cheapest-hosted", modelUri: "llm://openrouter/perplexity/pplx-embed-v1-0.6b", target: "hosted" },
      vision: { modelUri: "llm://openrouter/x/y", target: "hosted", remoteFallbackModelUri: "llm://openrouter/x/z" },
      visualPages: { route: "gemini" },
    })).toEqual([
      "pipeline.textGeneration.model", "pipeline.textGeneration.models", "pipeline.structuredExtraction.model",
      "pipeline.embedding.modelUri", "pipeline.embedding.target", "pipeline.vision.modelUri", "pipeline.vision.target",
      "pipeline.vision.remoteFallbackModelUri", "pipeline.visualPages.route",
    ]);
  });

  it("lets categories, nulls, empty maps and the auto route through", () => {
    expect(managedPipelineModelPaths({
      quality: "good", inferenceLane: "backfill", embedding: { profile: "good-fast-local" }, vision: { profile: "cheapest-hosted", remoteFallbackModelUri: null },
      textGeneration: { model: null, models: {} }, structuredExtraction: { model: null }, visualPages: { route: "auto", coarseFallback: true },
    })).toEqual([]);
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

  it("keeps an admin's stored overrides across a customer save, but lets a profile change take its default", () => {
    const stored = normalizePipelineFeatures({
      ...defaultPipelineFeatures,
      textGeneration: { model: "qwen/qwen3.5-flash-02-23", models: { "document-summary": "z-ai/glm-5.3-flash" } },
      vision: { profile: "good-fast-hosted", modelUri: "llm://openrouter/google/gemini-2.5-flash-lite" },
      visualPages: { route: "gemini", coarseFallback: false },
    });
    // The customer read the redacted view and saved it back with one toggle changed.
    const saved = normalizePipelineFeatures({ ...customerPipelineView(stored), summarize: true });
    const next = carryManagedPipelineFields(saved, stored as never);
    expect(next.textGeneration).toMatchObject({ model: "qwen/qwen3.5-flash-02-23", models: { "document-summary": "z-ai/glm-5.3-flash" } });
    expect(next.vision.modelUri).toBe("llm://openrouter/google/gemini-2.5-flash-lite");
    expect(next.visualPages.route).toBe("gemini");
    expect(next.summarize).toBe(true);

    const reprofiled = normalizePipelineFeatures({ ...customerPipelineView(stored), vision: { profile: "cheapest-local" } });
    expect(carryManagedPipelineFields(reprofiled, stored as never).vision.modelUri).not.toBe("llm://openrouter/google/gemini-2.5-flash-lite");
  });

  it("customer views carry no backend model ids", () => {
    const view = customerPipelineView(normalizePipelineFeatures(defaultPipelineFeatures));
    expect(JSON.stringify({ embedding: view.embedding, vision: view.vision, textGeneration: view.textGeneration, visualPages: view.visualPages, structuredExtraction: view.structuredExtraction })).not.toMatch(BACKEND_ID);
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
  it("map to reviewed catalog models priced under the output cap", () => {
    for (const [tier, model] of Object.entries(CHAT_TIER_MODELS)) {
      expect(isProjectChatModelId(model), tier).toBe(true);
      expect(CHAT_MODEL_PRICES_USD_PER_MTOK[model]!.output, tier).toBeLessThan(50);
      expect(model, tier).not.toMatch(/-pro\b|ultra/i);
    }
  });

  it("name the tier a served model answers for, including Speed boost swaps", () => {
    expect(chatTierForModel("z-ai/glm-5.3-flash")).toBe("fastest");
    expect(chatTierForModel("z-ai/glm-5.3-flash:nitro")).toBe("fastest");
    expect(chatTierForModel("deepseek/deepseek-v4.1-flash-1017")).toBe("balanced");
    expect(chatTierForModel("llm://openrouter/openai/gpt-6.1-sol")).toBe("smart");
    expect(chatTierForModel("anthropic/claude-haiku-5.5", { fastest: "anthropic/claude-haiku-5.5" })).toBe("fastest");
    expect(chatTierForModel("acme/unknown")).toBeNull();
  });
});

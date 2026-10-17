import { describe, expect, it } from "vitest";
import { defaultEmbeddingConfig, embeddingConfigSchema, openRouterEmbeddingRoute, resolveEmbeddingRoute, validateHostedEmbeddingVector } from "../embedding.js";
import { estimateAiUsageCostCents } from "../usage.js";

describe("registered hosted embedding spaces", () => {
  it.each([["0.6b", 1024, 0.4], ["4b", 2560, 3]])("resolves and prices Perplexity %s with the Perplexity 0.6B default", (size, dimensions, costCents) => {
    const model = `perplexity/pplx-embed-v1-${size}`;
    const route = resolveEmbeddingRoute(embeddingConfigSchema.parse({ profile: "cheapest-hosted", target: "hosted", modelUri: `llm://openrouter/${model}` }));
    expect(route).toMatchObject({ provider: "openrouter", runtime: "remote", model, dimensions, baseUrl: "https://openrouter.ai/api/v1", supportsCustomDimensions: false });
    expect(estimateAiUsageCostCents({ provider: "openrouter", model, inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(costCents);
    expect(defaultEmbeddingConfig.modelUri).toBe("llm://openrouter/perplexity/pplx-embed-v1-0.6b");
  });
  it("rejects alternate endpoints, dimension changes and unregistered models", () => {
    const modelUri = "llm://openrouter/perplexity/pplx-embed-v1-0.6b";
    expect(embeddingConfigSchema.safeParse({ modelUri, dimensions: 512 }).success).toBe(false);
    expect(embeddingConfigSchema.safeParse({ modelUri: `${modelUri}?baseUrl=https://example.invalid` }).success).toBe(false);
    expect(() => openRouterEmbeddingRoute("unknown/model")).toThrow("Unregistered");
  });
  it("normalizes exact vectors and rejects truncation, padding, zero and nonfinite values", () => {
    expect(validateHostedEmbeddingVector([3, 4], 2)).toEqual([0.6, 0.8]);
    for (const vector of [[1], [1, 2, 3], [0, 0], [NaN, 1], [Infinity, 1]]) expect(() => validateHostedEmbeddingVector(vector, 2)).toThrow();
  });
});

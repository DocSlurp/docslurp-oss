import { describe, expect, it } from "vitest";
import { embeddingConfigSchema, resolveEmbeddingRoute, validateDeepInfraEmbedding } from "../embedding.js";
import { buildPricedAiUsageLedgerEvent } from "../usage.js";

describe("DeepInfra BGE-M3 contract", () => {
  it("resolves an explicit fixed-size provider route and refuses arbitrary resizing", () => {
    const config = embeddingConfigSchema.parse({ modelUri: "llm://deepinfra/BAAI/bge-m3" });
    expect(resolveEmbeddingRoute(config)).toMatchObject({ provider: "deepinfra", model: "BAAI/bge-m3", dimensions: 1024, supportsCustomDimensions: false, baseUrl: "https://api.deepinfra.com/v1/openai" });
    expect(embeddingConfigSchema.safeParse({ modelUri: "llm://deepinfra/BAAI/bge-m3", dimensions: 512 }).success).toBe(false);
  });
  it("normalizes full vectors and rejects wrong sizes, nonfinite values and zero vectors", () => {
    const full = Array(1024).fill(1);
    expect(Math.hypot(...validateDeepInfraEmbedding(full))).toBeCloseTo(1, 12);
    expect(validateDeepInfraEmbedding(full, 1024, false)).toBe(full);
    for (const vector of [Array(512).fill(1), Array(1536).fill(1), Array(1024).fill(0), Array(1024).fill(NaN)]) expect(() => validateDeepInfraEmbedding(vector)).toThrow();
  });
  it("prices actual token usage from the verified route instead of fallback", () => {
    const event = buildPricedAiUsageLedgerEvent({ provider: "deepinfra", model: "BAAI/bge-m3", metric: "embed-query", inputTokens: 1_000_000 });
    expect(event.costCents).toBe(1);
  });
});

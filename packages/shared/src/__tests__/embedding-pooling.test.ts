import { describe, expect, it } from "vitest";

import { embeddingConfigSchema, embeddingModelBaseUri, embeddingPoolingProblem, localEmbeddingPooling, resolveEmbeddingRoute } from "../embedding.js";

describe("embedding pooling routes", () => {
  it("reads ?pooling= on local routes and keeps mean (the vectors existing indexes hold) when absent", () => {
    expect(localEmbeddingPooling("llm://transformers.js/Xenova/bge-m3")).toBe("mean");
    expect(localEmbeddingPooling("llm://transformers.js/Xenova/bge-m3?pooling=cls")).toBe("cls");
    expect(localEmbeddingPooling("llm://transformers.js/Xenova/bge-m3?pooling=mean")).toBe("mean");
    expect(embeddingModelBaseUri("llm://transformers.js/Xenova/bge-m3?pooling=cls")).toBe("llm://transformers.js/Xenova/bge-m3");
  });

  it("defaults the good-fast-local profile to CLS while stored plain routes keep mean", () => {
    expect(resolveEmbeddingRoute(embeddingConfigSchema.parse({ profile: "good-fast-local" })).modelUri).toBe("llm://transformers.js/Xenova/bge-m3?pooling=cls");
    const stored = embeddingConfigSchema.parse({ profile: "good-fast-local", modelUri: "llm://transformers.js/Xenova/bge-m3" });
    expect(localEmbeddingPooling(resolveEmbeddingRoute(stored).modelUri)).toBe("mean");
  });

  it("accepts only the pooling a hosted provider returns", () => {
    expect(embeddingPoolingProblem("llm://deepinfra/BAAI/bge-m3")).toBeNull();
    expect(embeddingPoolingProblem("llm://deepinfra/BAAI/bge-m3?pooling=cls")).toBeNull();
    expect(embeddingPoolingProblem("llm://deepinfra/BAAI/bge-m3?pooling=mean")).toContain("cls-pooled by the provider");
    expect(embeddingPoolingProblem("llm://openai/text-embedding-3-small?pooling=cls")).toContain("remove ?pooling=");
    expect(embeddingPoolingProblem("llm://transformers.js/Xenova/bge-m3?pooling=max")).toContain("use mean or cls");
  });

  it("validates workspace config and keeps catalog facts for parameterized routes", () => {
    const local = embeddingConfigSchema.parse({ profile: "good-fast-local", modelUri: "llm://transformers.js/Xenova/bge-m3?pooling=cls" });
    expect(resolveEmbeddingRoute(local)).toMatchObject({ dimensions: 1024, model: "Xenova/bge-m3", modelUri: "llm://transformers.js/Xenova/bge-m3?pooling=cls" });
    expect(embeddingConfigSchema.safeParse({ profile: "cheapest-hosted", modelUri: "llm://deepinfra/BAAI/bge-m3?pooling=mean" }).success).toBe(false);
  });
});

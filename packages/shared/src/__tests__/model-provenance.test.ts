import { describe, expect, it } from "vitest";

import { modelClassLabel, modelRecordUri, withModelProvenance } from "../model-provenance.js";

describe("modelRecordUri", () => {
  it("names a call as one llm:// URI with its settings sorted", () => {
    expect(modelRecordUri({ provider: "openrouter", model: "z-ai/glm-5.3-flash" })).toBe("llm://openrouter/z-ai/glm-5.3-flash");
    expect(modelRecordUri({ provider: "openrouter", model: "qwen/qwen3.5-flash-02-23:nitro", config: { reasoningEffort: "low", maxOutputTokens: 2048 } }))
      .toBe("llm://openrouter/qwen/qwen3.5-flash-02-23:nitro?maxOutputTokens=2048&reasoningEffort=low");
  });

  it("keeps the provider of a model that is already a URI, and makes record labels readable hosts", () => {
    expect(modelRecordUri({ provider: "ignored", model: "llm://deepinfra/Qwen/Qwen3-VL-30B" })).toBe("llm://deepinfra/Qwen/Qwen3-VL-30B");
    expect(modelRecordUri({ provider: "private", model: "gpu1/acme/text" })).toBe("llm://private/gpu1/acme/text");
    expect(modelRecordUri({ provider: "page-reader:ec2 us", model: "reader-v2" })).toBe("llm://page-reader-ec2-us/reader-v2");
    expect(modelRecordUri({ provider: "ocr-vm:ppocr", model: "ppocr-v6-small" })).toBe("llm://ocr-vm-ppocr/ppocr-v6-small");
  });

  it("never records an address or a credential, and drops what is not a small value", () => {
    const uri = modelRecordUri({ provider: "vllm", model: "Qwen/Qwen2-VL-2B-Instruct", config: {
      baseUrl: "http://10.0.0.5:8000/v1", apiKey: "sk-secret", endpoint: "https://x.example", temperature: 0, topP: undefined, role: "fallback",
      nested: { a: 1 } as never, list: [1] as never, nan: Number.NaN,
    } });
    expect(uri).toBe("llm://vllm/Qwen/Qwen2-VL-2B-Instruct?role=fallback&temperature=0");
  });

  it("is null without a model or a provider, and bounded in length", () => {
    expect(modelRecordUri({ provider: "openrouter", model: "" })).toBeNull();
    expect(modelRecordUri({ provider: null, model: "bare-model" })).toBeNull();
    const long = modelRecordUri({ provider: "openrouter", model: "a/b", config: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key${i}`, "x".repeat(200)])) })!;
    expect(long.length).toBeLessThanOrEqual(400);
    expect(long.startsWith("llm://openrouter/a/b")).toBe(true);
  });
});

describe("modelClassLabel", () => {
  it("is a sorted name=value list, or null", () => {
    expect(modelClassLabel({ quality: "auto", visionProfile: "good-fast-hosted", empty: "" })).toBe("quality=auto;visionProfile=good-fast-hosted");
    expect(modelClassLabel({})).toBeNull();
    expect(modelClassLabel(null)).toBeNull();
  });
});

describe("withModelProvenance", () => {
  it("stamps the URI with the call's settings and the level that selected the model", () => {
    const event = withModelProvenance(
      { provider: "openrouter", model: "z-ai/glm-5.3-flash", metadata: { runtime: "openai-compatible", modelConfig: { temperature: 0, maxTokens: 4096 }, modelClass: { role: "escalation" } } },
      { modelClass: { quality: "good", visionProfile: "good-fast-hosted" } },
    );
    expect(event.metadata).toMatchObject({
      runtime: "openai-compatible",
      modelUri: "llm://openrouter/z-ai/glm-5.3-flash?maxTokens=4096&temperature=0",
      modelClass: { quality: "good", visionProfile: "good-fast-hosted", role: "escalation" },
    });
  });

  it("is idempotent, keeps a URI the caller already set, and leaves charges and fees alone", () => {
    const once = withModelProvenance({ provider: "deepinfra", model: "Qwen/Qwen3-Reranker-0.6B", metadata: {} });
    expect(withModelProvenance(once)).toEqual(once);
    expect(withModelProvenance({ provider: "x", model: "y", metadata: { modelUri: "llm://private/alias/model" } }).metadata?.modelUri).toBe("llm://private/alias/model");
    const charge = { provider: "docslurp", model: "price-card", metadata: { readBy: "vision" } };
    expect(withModelProvenance(charge, { modelClass: { quality: "auto" } })).toBe(charge);
    expect(withModelProvenance({ provider: "", model: "m", metadata: null })).toEqual({ provider: "", model: "m", metadata: null });
  });
});

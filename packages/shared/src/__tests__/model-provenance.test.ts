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
    expect(modelRecordUri({ provider: "page-reader:gpu-a", model: "reader-v2" })).toBe("llm://page-reader-gpu-a/reader-v2");
    expect(modelRecordUri({ provider: "ocr-vm:ppocr", model: "ppocr-v6-small" })).toBe("llm://ocr-vm-ppocr/ppocr-v6-small");
  });

  it("never records an address, a credential or free text", () => {
    const uri = modelRecordUri({ provider: "vllm", model: "Qwen/Qwen2-VL-2B-Instruct", config: {
      baseUrl: "http://10.0.0.5:8000/v1", apiKey: "sk-secret", endpoint: "https://x.example", apiBase: "x", openRouterApiKey: "k", accessToken: "t",
      bearer: "b", visionBaseUrl: "u", "x-api-key": "k", route: "https://user:pw@h.internal/v1", note: "free text, with punctuation!",
      temperature: 0, topP: undefined, role: "fallback", nested: { a: 1 } as never, list: [1] as never, nan: Number.NaN,
    } });
    expect(uri).toBe("llm://vllm/Qwen/Qwen2-VL-2B-Instruct?role=fallback&temperature=0");
    // A provider or model that is an address, has userinfo or is not a plain id names nothing.
    for (const [provider, model] of [
      ["https://user:pw@gpu.internal:8443/v1", "m"], ["openrouter", "http://10.0.0.5:8000/v1/models/q"], ["x", "llm://user:sk-secret@host.internal/m"],
      ["openrouter", "a model with spaces"], ["openrouter", "a/\ud800b"], ["openrouter", "m?baseUrl=http%3A%2F%2Fh"],
    ]) expect(modelRecordUri({ provider, model }), `${provider} ${model}`).toBeNull();
    // A URI that carries a query keeps only its provider and model.
    expect(modelRecordUri({ provider: "x", model: "llm://vllm/Qwen/Q2?baseUrl=http%3A%2F%2F10.0.0.5" })).toBe("llm://vllm/Qwen/Q2");
  });

  it("is null without a model or a provider, never throws, and is bounded in length", () => {
    expect(modelRecordUri({ provider: "openrouter", model: "" })).toBeNull();
    expect(modelRecordUri({ provider: null, model: "bare-model" })).toBeNull();
    expect(modelRecordUri({ provider: 5 as never, model: {} as never })).toBeNull();
    const long = modelRecordUri({ provider: "openrouter", model: "a/b", config: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`opt${i}`, "x".repeat(200)])) })!;
    expect(long.length).toBeLessThanOrEqual(400);
    expect(long.startsWith("llm://openrouter/a/b?opt0=")).toBe(true);
    expect(modelRecordUri({ provider: "openrouter", model: `a/${"b".repeat(500)}` })).toBeNull();
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

  it("is idempotent, derives the URI from the row, and reduces the stored settings to what may be recorded", () => {
    const once = withModelProvenance({ provider: "deepinfra", model: "Qwen/Qwen3-Reranker-0.6B", metadata: {} });
    expect(withModelProvenance(once)).toEqual(once);
    const preset = withModelProvenance({ provider: "openrouter", model: "a/b", metadata: {
      modelUri: "llm://private/alias/model?baseUrl=http%3A%2F%2Fh&apiKey=k", modelConfig: { baseUrl: "http://h", apiKey: "k", nested: { a: 1 }, temperature: 0 },
      modelClass: { tier: "smart", note: "user\ud83d text" },
    } });
    expect(preset.metadata).toEqual({ modelUri: "llm://openrouter/a/b?temperature=0", modelConfig: { temperature: 0 }, modelClass: { tier: "smart" } });
    expect(JSON.stringify(preset)).not.toContain("http");
  });

  it("leaves rows that are not model calls alone, and never throws", () => {
    for (const row of [
      { provider: "docslurp", model: "price-card", metadata: { readBy: "vision" } },
      { provider: "docslurp", model: "document-map", metadata: {} },
      { provider: "local-compute", model: "performance-4x", metadata: {} },
      { provider: "modal", model: "sandbox", metadata: {} },
      { provider: "heuristic", model: "bm25", metadata: {} },
      { provider: "reused", model: "document-context", metadata: {} },
      { provider: "ec2", model: "gpu-capacity", metadata: {} },
      { provider: "openrouter", model: "a/b", metadata: { unitCharge: true } },
      { provider: "", model: "m", metadata: null },
    ]) expect(withModelProvenance(row, { modelClass: { quality: "auto" } }), JSON.stringify(row)).toBe(row);
    const hostile = { provider: "openrouter", model: "a/\ud800b", metadata: { modelConfig: { v: "\ud83d" }, modelClass: { tier: "x\u0000y" } } };
    const stamped = withModelProvenance(hostile);
    expect(stamped.metadata).toEqual({});
    expect(() => JSON.stringify(stamped)).not.toThrow();
  });
});

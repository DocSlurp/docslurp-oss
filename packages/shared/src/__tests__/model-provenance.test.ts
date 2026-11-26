import { describe, expect, it } from "vitest";

import { embeddingSpaceMatches, embeddingSpaceUri, modelClassLabel, modelRecordUri, withModelProvenance } from "../model-provenance.js";
import { embeddingRequestConfig, embeddingRouteSpaceUri } from "../embedding.js";

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

describe("embedding spaces", () => {
  it("names provider, model and the settings that change the space; mean pooling is the default", () => {
    expect(embeddingSpaceUri({ provider: "openrouter", model: "vendor/embed-1", dimensions: 1024 })).toBe("llm://openrouter/vendor/embed-1?dimensions=1024");
    expect(embeddingSpaceUri({ provider: "openrouter", model: "vendor/embed-1", dimensions: 1024, pooling: "mean" })).toBe("llm://openrouter/vendor/embed-1?dimensions=1024");
    expect(embeddingSpaceUri({ provider: "local", model: "bge-small", dimensions: 384, pooling: "cls" })).toBe("llm://local/bge-small?dimensions=384&pooling=cls");
    expect(embeddingSpaceUri({ provider: "private", model: "llm://private/page-embed", dimensions: 768 })).toBe("llm://private/page-embed?dimensions=768");
    expect(embeddingSpaceUri({ provider: "", model: "x" })).toBeNull();
    expect(embeddingSpaceUri({ provider: "a", model: "https://host/x" })).toBeNull();
  });

  it("tells same-id spaces apart and lets a missing URI fall back to the bare id", () => {
    const a = embeddingSpaceUri({ provider: "host-a", model: "m", dimensions: 8 });
    const b = embeddingSpaceUri({ provider: "host-b", model: "m", dimensions: 8 });
    expect(a).not.toBe(b);
    expect(embeddingSpaceMatches(a, a)).toBe(true);
    expect(embeddingSpaceMatches(a, b)).toBe(false);
    expect(embeddingSpaceMatches(null, b)).toBe(true);
    expect(embeddingSpaceMatches(a, null)).toBe(true);
  });

  it("derives a route's space from its own pooling and the vectors' real dimensions", () => {
    const route = { provider: "transformersjs", model: "Xenova/bge", dimensions: 384, modelUri: "llm://transformersjs/Xenova/bge?pooling=cls" };
    expect(embeddingRouteSpaceUri(route)).toBe("llm://transformersjs/Xenova/bge?dimensions=384&pooling=cls");
    expect(embeddingRouteSpaceUri(route, 256)).toBe("llm://transformersjs/Xenova/bge?dimensions=256&pooling=cls");
  });

  it("records an embedding call's request settings, without addresses", () => {
    const config = embeddingRequestConfig({ task: "document", normalize: true, dimensions: 1024, requestedDimensions: 512, batchSize: 64,
      lateChunking: false, modelUri: "llm://ollama/nomic?baseUrl=http://127.0.0.1:11434/v1&pooling=cls", runtime: "local" }, { inputTokenLimit: 8192 });
    expect(config).toEqual({ task: "document", inputType: undefined, normalize: true, pooling: "cls", dimensions: 1024, requestedDimensions: 512,
      batchSize: 64, lateChunking: false, truncateAtTokens: 8192 });
    const stamped = withModelProvenance({ provider: "ollama", model: "nomic", metadata: { modelConfig: config } as Record<string, unknown> });
    expect(stamped.metadata?.modelUri).toBe("llm://ollama/nomic?batchSize=64&dimensions=1024&lateChunking=false&normalize=true&pooling=cls&requestedDimensions=512&task=document&truncateAtTokens=8192");
    expect(JSON.stringify(stamped)).not.toContain("127.0.0.1");
  });
});

describe("recorded setting names", () => {
  it("none of the names the call paths record is withheld by the sanitizer", () => {
    // Every modelConfig / modelClass key written by a call path (worker and server). A name the sanitizer withholds
    // (it contains url, host, key, token, ...) would silently vanish from the persisted record.
    const names = [
      "operation", "maxOutputTokens", "reasoningEffort", "reasoning", "profile", "providerPinning", "temperature",
      "task", "inputType", "normalize", "pooling", "dimensions", "requestedDimensions", "batchSize", "lateChunking", "truncateAtTokens",
      "renderDpi", "windows", "windowChars", "paragraphBatchChars", "format", "sampleRateHz", "wordTimestamps", "chunkSeconds",
      "purpose", "input", "route", "role", "questions", "images", "pages", "candidates", "batchCandidates", "maxCandidates",
      "timeoutMs", "concurrency", "queryPrefix", "maxSteps", "maxToolCalls", "responseFormat",
      "embeddingProfile", "visualPagesRoute", "chartExportTier", "moderator", "rerank", "tier", "answer",
    ];
    const record = Object.fromEntries(names.map((name) => [name, 1]));
    const stamped = withModelProvenance({ provider: "openrouter", model: "vendor/m", metadata: { modelConfig: record, modelClass: record } });
    expect(Object.keys(stamped.metadata?.modelConfig as object).sort()).toEqual([...names].sort());
    expect(Object.keys(stamped.metadata?.modelClass as object).sort()).toEqual([...names].sort());
  });
});

describe("chatTierLabel", () => {
  it("keeps only the tier vocabulary", async () => {
    const { chatTierLabel } = await import("../project-chat-models.js");
    expect(chatTierLabel("smart")).toBe("smart");
    expect(chatTierLabel("balanced")).toBe("balanced");
    expect(chatTierLabel("vendor/some-model")).toBeUndefined();
    expect(chatTierLabel("smart; drop table")).toBeUndefined();
    expect(chatTierLabel(null)).toBeUndefined();
  });
});

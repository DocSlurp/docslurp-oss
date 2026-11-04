import { describe, expect, it } from "vitest";
import { normalizeHostedModelRef, openRouterModelIdFromUri, textGenerationConfigSchema, toModelUri } from "../index.js";

describe("llm:// model references", () => {
  it("reads the OpenRouter id from llm://openrouter/<id>, keeping variant suffixes", () => {
    expect(openRouterModelIdFromUri("llm://openrouter/qwen/qwen3.5-flash-02-23")).toBe("qwen/qwen3.5-flash-02-23");
    expect(openRouterModelIdFromUri(" LLM://OpenRouter/z-ai/glm-5.3-flash:nitro ")).toBe("z-ai/glm-5.3-flash:nitro");
    for (const value of ["qwen/qwen3.5-flash-02-23", "llm://openrouter/", "llm://openrouter//x", "llm://openrouter/a/b?x=1",
      "llm://openrouter/a/b#c", "llm://openrouter/a b", "llm://private/gpu1/m", "llm://perplexity/pplx-embed-v1-0.6b", null, undefined]) {
      expect(openRouterModelIdFromUri(value), String(value)).toBeNull();
    }
  });

  it("normalizes hosted refs to the bare id and leaves other values for the caller to validate", () => {
    expect(normalizeHostedModelRef("llm://openrouter/a/b")).toBe("a/b");
    expect(normalizeHostedModelRef(" a/b ")).toBe("a/b");
    expect(normalizeHostedModelRef("llm://private/gpu1/m")).toBe("llm://private/gpu1/m");
    expect(normalizeHostedModelRef("llm://openrouter/a/b?x=1")).toBe("llm://openrouter/a/b?x=1");
  });

  it("formats the canonical URI", () => {
    expect(toModelUri("a/b")).toBe("llm://openrouter/a/b");
    expect(toModelUri("llm://private/gpu1/m")).toBe("llm://private/gpu1/m");
  });

  it("accepts llm://openrouter/<id> for text generation and stores the bare id", () => {
    const parsed = textGenerationConfigSchema.parse({
      model: "llm://openrouter/qwen/qwen3.5-flash-02-23",
      models: { "document-summary": "llm://openrouter/z-ai/glm-5.3-flash", "graph-extraction": "deepseek/deepseek-v4.1-flash" },
    });
    expect(parsed.model).toBe("qwen/qwen3.5-flash-02-23");
    expect(parsed.models).toEqual({ "document-summary": "z-ai/glm-5.3-flash", "graph-extraction": "deepseek/deepseek-v4.1-flash" });
    expect(textGenerationConfigSchema.parse({ model: "llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8" }).model).toBe("llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8");
  });

  it("rejects text model URIs for providers that do not serve text stages", () => {
    for (const model of ["llm://perplexity/pplx-embed-v1-0.6b", "llm://openrouter/", "llm://openrouter/a/b?x=1", "llm://private/", "llm://private/gpu1"]) {
      expect(textGenerationConfigSchema.safeParse({ model }).success, model).toBe(false);
    }
  });
});

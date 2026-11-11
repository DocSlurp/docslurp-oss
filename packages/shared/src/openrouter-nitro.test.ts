import { describe, expect, it } from "vitest";
import { chatModelTier } from "./billing.js";
import { isProjectChatModelId, nitroBaseModel, normalizeChatModelRef, parseChatModelOptions, withChatReasoning } from "./project-chat-models.js";
import { SPEED_BOOST_PERFORMANCE, speedBoostMaxPrice, withOpenRouterProviderPreferences } from "./openrouter-routing.js";
import { lowestOpenRouterReasoning, resolveOpenRouterUsage } from "./openrouter-usage.js";

describe("reviewed Nitro variants", () => {
  for (const base of ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4.1-flash-1017", "openai/gpt-6-luna"]) {
    it(`keeps ${base} attribution and enforces endpoint ceilings`, () => {
      const model = `${base}:nitro`;
      expect(isProjectChatModelId(model)).toBe(true);
      expect(nitroBaseModel(model)).toBe(base);
      expect(chatModelTier(model)).toBe(chatModelTier(base));
      expect(lowestOpenRouterReasoning(model)).toEqual(lowestOpenRouterReasoning(base));
      const body = withOpenRouterProviderPreferences({ model, provider: { max_price: { prompt: 500, completion: 500 }, sort: "throughput" } });
      expect(body.model).toBe(base);
      expect(body.provider).toMatchObject({ sort: "price", max_price: speedBoostMaxPrice(base), ...SPEED_BOOST_PERFORMANCE });
    });
  }
  it("rejects arbitrary and prohibited variants", () => {
    for (const model of ["openai/gpt-6-pro:nitro", "openai/gpt-6-ultra:nitro", "unknown/model:nitro", "z-ai/glm-5.3-flash:nitro:nitro"]) {
      expect(isProjectChatModelId(model)).toBe(false);
      expect(nitroBaseModel(model)).toBeUndefined();
      expect(() => withOpenRouterProviderPreferences({ model })).toThrow("Unsupported");
    }
  });
  it("retains stricter prices and regional restrictions", () => {
    const body = withOpenRouterProviderPreferences({ model: "z-ai/glm-5.3-flash:nitro", provider: { max_price: { prompt: 0.1, completion: 0.3 } } }, { allowChinaProviders: false });
    expect(body.provider).toMatchObject({ max_price: { prompt: 0.1, completion: 0.3 } });
    expect(body.provider?.only).toBeDefined();
    expect(() => withOpenRouterProviderPreferences({ model: "z-ai/glm-5.3-flash:nitro", provider: { only: ["z-ai"] } }, { allowChinaProviders: false })).toThrow();
  });
  it("never widens caller quantizations", () => {
    const model = "z-ai/glm-5.3-flash:nitro";
    expect(withOpenRouterProviderPreferences({ model, provider: { quantizations: ["fp16"] } }).provider?.quantizations).toEqual(["fp16"]);
    expect(() => withOpenRouterProviderPreferences({ model, provider: { quantizations: ["fp4"] } })).toThrow("quantization");
    expect(() => withOpenRouterProviderPreferences({ model, provider: { quantizations: [] } })).toThrow("quantization");
  });
  it("uses actual provider charges rather than base catalog prices", async () => {
    const actual = await resolveOpenRouterUsage({ apiKey: "unused", model: "z-ai/glm-5.3-flash:nitro", providerName: "host", usage: { inputTokens: 100, outputTokens: 20, raw: { cost: 0.123 } } });
    expect(actual.costCents).toBeCloseTo(12.3);
    expect(actual.metadata).toMatchObject({ costSource: "provider", providerName: "host" });
  });
  it("preserves usage with a marked ceiling estimate when receipts are missing", async () => {
    const actual = await resolveOpenRouterUsage({ apiKey: "unused", model: "z-ai/glm-5.3-flash:nitro", usage: { inputTokens: 100, outputTokens: 20 } });
    // GLM 5.3 Flash ceiling: $0.15 / $0.50 per 1M tokens.
    expect(actual).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(actual.costCents).toBeCloseTo(0.0025);
    expect(actual.metadata).toMatchObject({ costSource: "estimate", reconciliationRequired: true, pricingSource: "nitro-endpoint-ceiling-estimate" });
  });
  it("caps every Speed boost model at its first-party list price, below the old $1 / $5 ceiling", () => {
    expect(speedBoostMaxPrice("deepseek/deepseek-v4.1-flash-1017")).toEqual({ prompt: 0.3, completion: 1.2 });
    expect(speedBoostMaxPrice("z-ai/glm-5.3-flash")).toEqual({ prompt: 0.15, completion: 0.5 });
    expect(speedBoostMaxPrice("openai/gpt-6-luna")).toEqual({ prompt: 0.1, completion: 0.5 });
  });
});

describe("chat model reasoning options", () => {
  it("reads ?reasoning= and the native reasoning_effort / effort keys", () => {
    expect(parseChatModelOptions("llm://openrouter/z-ai/glm-5.3-flash?reasoning=high")).toEqual({ model: "llm://openrouter/z-ai/glm-5.3-flash", reasoning: "high" });
    expect(parseChatModelOptions("openai/gpt-6-luna?reasoning_effort=low")).toEqual({ model: "openai/gpt-6-luna", reasoning: "low" });
    expect(parseChatModelOptions("openai/gpt-6-luna?effort=MINIMAL")).toEqual({ model: "openai/gpt-6-luna", reasoning: "minimal" });
    expect(parseChatModelOptions("openai/gpt-6-luna?reasoning=off")).toEqual({ model: "openai/gpt-6-luna", reasoning: "none" });
    expect(parseChatModelOptions("openai/gpt-6-luna")).toEqual({ model: "openai/gpt-6-luna" });
  });
  it("refuses unknown options, unknown or conflicting levels and fragments", () => {
    for (const ref of ["a/b?reasoning=max", "a/b?temperature=1", "a/b?reasoning=low&effort=high", "a/b#x", "a/b?reasoning="]) {
      expect(parseChatModelOptions(ref), ref).toBeNull();
    }
    expect(parseChatModelOptions("a/b?reasoning=low&effort=low")).toEqual({ model: "a/b", reasoning: "low" });
  });
  it("keeps the model identity without its options", () => {
    expect(normalizeChatModelRef("llm://openrouter/deepseek/deepseek-v4.1-flash?reasoning=high")).toBe("deepseek/deepseek-v4.1-flash-1017");
    expect(withChatReasoning("z-ai/glm-5.3-flash?reasoning=low", "high")).toBe("z-ai/glm-5.3-flash?reasoning=high");
    expect(withChatReasoning("z-ai/glm-5.3-flash?reasoning=low", "none")).toBe("z-ai/glm-5.3-flash");
  });
});

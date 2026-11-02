import { describe, expect, it } from "vitest";
import { chatModelTier } from "./billing.js";
import { isWorkspaceChatModelId, nitroBaseModel } from "./workspace-chat-models.js";
import { withOpenRouterProviderPreferences } from "./openrouter-routing.js";
import { lowestOpenRouterReasoning, resolveOpenRouterUsage } from "./openrouter-usage.js";

describe("reviewed Nitro variants", () => {
  for (const base of ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4.1-flash", "openai/gpt-6-luna"]) {
    it(`keeps ${base} attribution and enforces endpoint ceilings`, () => {
      const model = `${base}:nitro`;
      expect(isWorkspaceChatModelId(model)).toBe(true);
      expect(nitroBaseModel(model)).toBe(base);
      expect(chatModelTier(model)).toBe(chatModelTier(base));
      expect(lowestOpenRouterReasoning(model)).toEqual(lowestOpenRouterReasoning(base));
      const body = withOpenRouterProviderPreferences({ model, provider: { max_price: { prompt: 500, completion: 500 }, sort: "price" } });
      expect(body.provider).toMatchObject({ sort: "throughput", max_price: { prompt: 1, completion: 5 } });
    });
  }
  it("rejects arbitrary and prohibited variants", () => {
    for (const model of ["openai/gpt-6-pro:nitro", "openai/gpt-6-ultra:nitro", "unknown/model:nitro", "z-ai/glm-5.3-flash:nitro:nitro"]) {
      expect(isWorkspaceChatModelId(model)).toBe(false);
      expect(nitroBaseModel(model)).toBeUndefined();
      expect(() => withOpenRouterProviderPreferences({ model })).toThrow("Unsupported");
    }
  });
  it("retains stricter prices and regional restrictions", () => {
    const body = withOpenRouterProviderPreferences({ model: "z-ai/glm-5.3-flash:nitro", provider: { max_price: { prompt: 0.2, completion: 0.7 } } }, { allowChinaProviders: false });
    expect(body.provider).toMatchObject({ max_price: { prompt: 0.2, completion: 0.7 } });
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
    expect(actual).toMatchObject({ inputTokens: 100, outputTokens: 20, costCents: 0.02 });
    expect(actual.metadata).toMatchObject({ costSource: "estimate", reconciliationRequired: true, pricingSource: "nitro-endpoint-ceiling-estimate" });
  });
});

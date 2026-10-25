import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHINA_PROVIDER_SLUGS, createOpenRouterRoutingFetch, openRouterProviderPreferences,
  setOpenRouterProviderPolicyResolver, withOpenRouterProviderPreferences,
} from "../openrouter-routing.js";

afterEach(() => setOpenRouterProviderPolicyResolver(undefined));

describe("OpenRouter provider routing", () => {
  it("sends GLM and DeepSeek to their cheapest FP8-or-better host and leaves other models alone", () => {
    for (const model of ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4.1-flash-1017"]) {
      expect(openRouterProviderPreferences(model)).toEqual({ sort: "price", quantizations: ["fp8", "fp16", "bf16", "fp32"], allow_fallbacks: true });
    }
    expect(openRouterProviderPreferences("anthropic/claude-haiku-5.5")).toBeUndefined();
    expect(openRouterProviderPreferences("anthropic/claude-haiku-5.5", { allowChinaProviders: true })).toBeUndefined();
  });

  it("ignores every China-based provider for any model when the org turned them off", () => {
    expect(openRouterProviderPreferences("openai/gpt-6-luna", { allowChinaProviders: false })).toEqual({ ignore: [...CHINA_PROVIDER_SLUGS] });
    expect(openRouterProviderPreferences("z-ai/glm-5.3-flash", { allowChinaProviders: false })).toMatchObject({ sort: "price", ignore: expect.arrayContaining(["z-ai", "deepseek", "streamlake", "baidu"]) });
  });

  it("keeps the caller's own routing and adds the China restriction to its ignore list", () => {
    const body = { model: "deepseek/deepseek-v4.1-flash", provider: { order: ["deepinfra"], allow_fallbacks: false, ignore: ["relace"] } };
    expect(withOpenRouterProviderPreferences(body, { allowChinaProviders: false }).provider).toEqual({
      sort: "price", quantizations: ["fp8", "fp16", "bf16", "fp32"], order: ["deepinfra"], allow_fallbacks: false,
      ignore: ["relace", ...CHINA_PROVIDER_SLUGS],
    });
    const plain = { model: "anthropic/claude-haiku-5.5" };
    expect(withOpenRouterProviderPreferences(plain)).toBe(plain);
  });

  it("applies the registered org policy to each JSON request", async () => {
    const base = vi.fn<typeof fetch>(async () => new Response("{}"));
    setOpenRouterProviderPolicyResolver(async () => ({ allowChinaProviders: false }));
    const routed = createOpenRouterRoutingFetch(base);
    await routed("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "openai/gpt-6-luna", messages: [] }) });
    expect(JSON.parse(base.mock.calls[0]![1]!.body as string).provider).toEqual({ ignore: [...CHINA_PROVIDER_SLUGS] });
    setOpenRouterProviderPolicyResolver(() => undefined);
    const init = { method: "POST", body: JSON.stringify({ model: "openai/gpt-6-luna" }) };
    await routed("https://openrouter.ai/api/v1/chat/completions", init);
    expect(base.mock.calls[1]![1]).toBe(init);
    await routed("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: "not json" });
    expect(base.mock.calls[2]![1]!.body).toBe("not json");
  });
});

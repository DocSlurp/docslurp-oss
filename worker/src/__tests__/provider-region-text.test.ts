import { afterEach, describe, expect, it, vi } from "vitest";

import { CHINA_PROVIDER_SLUGS, DEFAULT_PIPELINE_TEXT_MODEL, NON_CHINA_PROVIDER_SLUGS, providerRegion } from "@docslurp/shared";

import { generateOpenRouterText } from "../lib/ai.js";
import { runWithProviderRateScope } from "../lib/provider-rate-limit.js";

afterEach(() => vi.unstubAllGlobals());

/** The OpenRouter request bodies one pipeline text call (summaries, document map, titles...) sends. */
async function textBodies(model: string, scope: { allowChinaProviders?: boolean } | null) {
  const bodies: Record<string, any>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "g", object: "chat.completion", created: 0, model, provider: "Together",
      choices: [{ index: 0, message: { role: "assistant", content: "Summary." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.000001 } }), { headers: { "content-type": "application/json" } });
  }));
  const call = () => generateOpenRouterText({ apiKey: "k", model, operation: "document-summary", prompt: "Summarize.", maxOutputTokens: 16, privacyMode: "standard" })
    .catch(() => undefined);
  if (scope) await runWithProviderRateScope({ orgId: "org", ...scope }, call);
  else await call();
  return bodies.filter((body) => body.model === model);
}

describe("pipeline text calls and the China-provider policy", () => {
  it("an opted-out run never sends summaries to a China-based or unknown-region provider", async () => {
    for (const model of [DEFAULT_PIPELINE_TEXT_MODEL, "z-ai/glm-5.3-flash"]) {
      const [body] = await textBodies(model, { allowChinaProviders: false });
      expect(body!.provider.only).toEqual([...NON_CHINA_PROVIDER_SLUGS]);
      expect(body!.provider.ignore).toEqual(expect.arrayContaining([...CHINA_PROVIDER_SLUGS]));
      for (const slug of body!.provider.only) expect(providerRegion(slug), slug).toBe("other");
    }
  });

  it("a call outside any run scope is restricted (unknown scope fails closed)", async () => {
    const [body] = await textBodies("z-ai/glm-5.3-flash", null);
    expect(body!.provider.only).toEqual([...NON_CHINA_PROVIDER_SLUGS]);
  });

  it("a default run sends price-routed models to their cheapest host, China-based ones included", async () => {
    const [body] = await textBodies("z-ai/glm-5.3-flash", { allowChinaProviders: true });
    expect(body!.provider).toEqual({ sort: "price", quantizations: ["fp8", "fp16", "bf16", "fp32"], allow_fallbacks: true });
    const [qwen] = await textBodies(DEFAULT_PIPELINE_TEXT_MODEL, { allowChinaProviders: true });
    expect(qwen!.provider).toBeUndefined();
  });
});

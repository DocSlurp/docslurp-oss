import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOpenRouterRoutingFetch, currentOpenRouterProviderPolicy, openRouterProviderPreferences, ProviderRegionRefusedError,
  restrictToNonChinaProviders, setOpenRouterProviderPolicyResolver, withOpenRouterProviderPreferences,
} from "../openrouter-routing.js";
import { CHINA_PROVIDER_SLUGS, NON_CHINA_PROVIDER_SLUGS, providerRegion } from "../provider-regions.js";

afterEach(() => setOpenRouterProviderPolicyResolver(undefined));

const RESTRICTED = { allowChinaProviders: false };
const PRICE = { sort: "price", quantizations: ["fp8", "fp16", "bf16", "fp32"], allow_fallbacks: true };

/** Every slug a restricted request could reach: its allowlist minus its ignore list. */
function reachable(provider: Record<string, unknown>): string[] {
  const ignore = new Set(provider.ignore as string[]);
  return (provider.only as string[]).filter((slug) => !ignore.has(slug.split("/")[0]!));
}

describe("OpenRouter provider routing", () => {
  it("sends GLM and DeepSeek to their cheapest FP8-or-better host and leaves other models alone", () => {
    for (const model of ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4.1-flash-1017"]) {
      expect(openRouterProviderPreferences(model)).toEqual(PRICE);
    }
    expect(openRouterProviderPreferences("anthropic/claude-haiku-5.5")).toBeUndefined();
  });

  it("allows China-based hosts by default: a price-routed request is not restricted", () => {
    const body = { model: "deepseek/deepseek-v4.1-flash-1017" };
    expect(withOpenRouterProviderPreferences(body, { allowChinaProviders: true }).provider).toEqual(PRICE);
    const plain = { model: "anthropic/claude-haiku-5.5" };
    expect(withOpenRouterProviderPreferences(plain, { allowChinaProviders: true })).toBe(plain);
  });

  it("restricts an opted-out request to providers with a known non-China headquarters, for any model", () => {
    const provider = withOpenRouterProviderPreferences({ model: "openai/gpt-6-luna" }, RESTRICTED).provider as Record<string, unknown>;
    expect(provider.only).toEqual([...NON_CHINA_PROVIDER_SLUGS]);
    expect(provider.ignore).toEqual([...CHINA_PROVIDER_SLUGS]);
    for (const slug of reachable(provider)) expect(providerRegion(slug), slug).toBe("other");
    // Price routing still applies inside the allowlist.
    expect(withOpenRouterProviderPreferences({ model: "z-ai/glm-5.3-flash" }, RESTRICTED).provider).toMatchObject({ sort: "price", only: [...NON_CHINA_PROVIDER_SLUGS] });
  });

  it("never reaches a China-based or unknown-region provider when opted out, whatever the caller asked for", () => {
    for (const slug of ["deepseek", "streamlake", "z-ai/fp8", "alibaba", "seed", "siliconflow/fp8"]) expect(providerRegion(slug), slug).toBe("cn");
    for (const slug of ["relace", "typesafe", "makora", "liquid", "brand-new-host"]) expect(providerRegion(slug), slug).toBe("unknown");
    const caller = { only: ["streamlake", "relace", "together", "amazon-bedrock/us-east-1"], order: ["deepseek", "relace", "together"], ignore: ["fireworks"], allow_fallbacks: false };
    const provider = restrictToNonChinaProviders(caller);
    expect(provider).toEqual({ only: ["together", "amazon-bedrock/us-east-1"], order: ["together"], ignore: ["fireworks", ...CHINA_PROVIDER_SLUGS], allow_fallbacks: false });
    expect(NON_CHINA_PROVIDER_SLUGS).not.toContain("relace");
    expect(NON_CHINA_PROVIDER_SLUGS.some((slug) => providerRegion(slug) !== "other")).toBe(false);
  });

  it("refuses rather than sends when nothing the caller allowed is in a known non-China region", () => {
    expect(() => restrictToNonChinaProviders({ only: ["deepseek", "relace"] })).toThrow(ProviderRegionRefusedError);
    // An order with no allowed entry falls back to the full allowlist, never to an empty `only`.
    expect(restrictToNonChinaProviders({ order: ["streamlake"], allow_fallbacks: false })).toEqual({ only: [...NON_CHINA_PROVIDER_SLUGS], ignore: [...CHINA_PROVIDER_SLUGS], allow_fallbacks: false });
  });

  it("applies the registered policy to each JSON request and fails closed when it cannot place the call", async () => {
    const base = vi.fn<typeof fetch>(async () => new Response("{}"));
    const routed = createOpenRouterRoutingFetch(base);
    const url = "https://openrouter.ai/api/v1/chat/completions";
    setOpenRouterProviderPolicyResolver(async () => RESTRICTED);
    await routed(url, { method: "POST", body: JSON.stringify({ model: "openai/gpt-6-luna", messages: [] }) });
    expect(JSON.parse(base.mock.calls[0]![1]!.body as string).provider).toEqual({ only: [...NON_CHINA_PROVIDER_SLUGS], ignore: [...CHINA_PROVIDER_SLUGS] });
    // A restricted body that cannot carry the restriction is never sent.
    await expect(routed(url, { method: "POST", body: "not json" })).rejects.toThrow(ProviderRegionRefusedError);
    expect(base).toHaveBeenCalledTimes(1);
    // A resolver that cannot place the call in a scope restricts it.
    setOpenRouterProviderPolicyResolver(() => undefined);
    expect(await currentOpenRouterProviderPolicy()).toEqual(RESTRICTED);
    await routed(url, { method: "POST", body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash" }) });
    expect(JSON.parse(base.mock.calls[1]![1]!.body as string).provider).toMatchObject({ only: [...NON_CHINA_PROVIDER_SLUGS] });
    // Allowed: untouched.
    setOpenRouterProviderPolicyResolver(() => ({ allowChinaProviders: true }));
    const init = { method: "POST", body: JSON.stringify({ model: "openai/gpt-6-luna" }) };
    await routed(url, init);
    expect(base.mock.calls[2]![1]).toBe(init);
    await routed(url, { method: "POST", body: "not json" });
    expect(base.mock.calls[3]![1]!.body).toBe("not json");
    // No resolver at all (scripts, benchmarks): allowed.
    setOpenRouterProviderPolicyResolver(undefined);
    expect(await currentOpenRouterProviderPolicy()).toBeUndefined();
  });
  it("enforces the policy on Request bodies and refuses restricted audio before sending", async () => {
    const base = vi.fn<typeof fetch>(async () => new Response("{}"));
    const routed = createOpenRouterRoutingFetch(base);
    setOpenRouterProviderPolicyResolver(() => RESTRICTED);
    await routed(new Request("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ model: "qwen/qwen3.5-flash-02-23" }),
    }));
    expect(JSON.parse(base.mock.calls[0]![1]!.body as string).provider.only).toEqual([...NON_CHINA_PROVIDER_SLUGS]);
    await expect(routed(new Request("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", body: "malformed",
    }))).rejects.toThrow(ProviderRegionRefusedError);
    await expect(routed("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST", body: JSON.stringify({ model: "voice", input_audio: "customer audio" }),
    })).rejects.toThrow(ProviderRegionRefusedError);
    expect(base).toHaveBeenCalledTimes(1);
  });

});

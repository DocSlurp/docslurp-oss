import { describe, expect, it, vi } from "vitest";

import { WebRouter, type WebRouterOptions } from "./router.js";
import { WebProviderError, WebToolError, type WebInput, type WebProviderAdapter, type WebProviderId } from "./types.js";

const search: WebInput<"search"> = { query: "q", limit: 5, depth: "fast", includeContent: false, maxCharacters: 1000 };

function adapter(id: WebProviderId, usd: number, run: () => Promise<unknown> = async () => ({ data: { results: [{ url: `https://${id}.test/` }] }, costUsd: usd, costSource: "reported" }),
  accepts?: (input: WebInput<"search">) => boolean): WebProviderAdapter & { calls: ReturnType<typeof vi.fn> } {
  const calls = vi.fn(run);
  return { id, keyEnv: "", calls, capabilities: { search: { estimateUsd: () => usd, accepts, run: calls as never } } };
}

function router(adapters: WebProviderAdapter[], options: Partial<WebRouterOptions> = {}) {
  let now = 1_000_000;
  const instance = new WebRouter({
    adapters, keys: Object.fromEntries(adapters.map((a) => [a.id, "key"])), strategy: "cheapest",
    order: ["jina", "firecrawl", "exa", "tavily"], maxAttempts: 3, now: () => now, ...options,
  });
  const run = () => instance.run("search", search, { signal: new AbortController().signal, deadlineAt: now + 30_000 });
  return { instance, run, advance: (ms: number) => { now += ms; } };
}

describe("WebRouter", () => {
  it("tries the cheapest provider first and skips providers that cannot honour the input", async () => {
    const exa = adapter("exa", 0.004);
    const jina = adapter("jina", 0.0005, undefined, () => false);
    const firecrawl = adapter("firecrawl", 0.002);
    const routed = await router([exa, jina, firecrawl]).run();
    expect(routed.provider).toBe("firecrawl");
    expect(jina.calls).not.toHaveBeenCalled();
  });

  it("fails over on rate limits and benches the limited provider until its cooldown ends", async () => {
    const jina = adapter("jina", 0.001, async () => { throw new WebProviderError("rate_limited", "jina responded 429", 429, 5_000); });
    const exa = adapter("exa", 0.004);
    const r = router([jina, exa]);
    expect((await r.run()).attempts.map((a) => [a.provider, a.outcome])).toEqual([["jina", "rate_limited"], ["exa", "ok"]]);
    await r.run();
    expect(jina.calls).toHaveBeenCalledOnce();
    r.advance(6_000);
    await r.run();
    expect(jina.calls).toHaveBeenCalledTimes(2);
  });

  it("does not pay a second provider for a request the first rejected as invalid", async () => {
    const jina = adapter("jina", 0.001, async () => { throw new WebProviderError("invalid_request", "jina responded 422", 422); });
    const exa = adapter("exa", 0.004);
    await expect(router([jina, exa]).run()).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    expect(exa.calls).not.toHaveBeenCalled();
  });

  it("keeps the spend of a provider job that started and then failed", async () => {
    const firecrawl = adapter("firecrawl", 0.002, async () => {
      throw Object.assign(new WebProviderError("unavailable", "firecrawl crawl failed"), { costUsd: 0.003 });
    });
    const error = await router([firecrawl]).run().catch((caught: unknown) => caught) as { paid?: Array<{ costUsd: number }> };
    expect(error.paid?.map((p) => p.costUsd)).toEqual([0.003]);
  });

  it("returns a generic error that never names a provider", async () => {
    const tavily = adapter("tavily", 0.008, async () => { throw new WebProviderError("quota_exhausted", "tavily responded 432: plan limit", 432); });
    const error = await router([tavily]).run().catch((caught: unknown) => caught) as WebToolError;
    expect(error).toBeInstanceOf(WebToolError);
    expect(JSON.stringify({ message: error.message, code: error.code })).not.toMatch(/tavily|jina|exa|firecrawl/i);
  });

  it("rotates the first provider under round-robin and honours per-capability restrictions", async () => {
    const jina = adapter("jina", 0.001);
    const exa = adapter("exa", 0.004);
    const tavily = adapter("tavily", 0.008);
    const r = router([jina, exa, tavily], { strategy: "round-robin", perCapability: { search: ["exa", "tavily"] } });
    expect([(await r.run()).provider, (await r.run()).provider, (await r.run()).provider]).toEqual(["exa", "tavily", "exa"]);
    expect(jina.calls).not.toHaveBeenCalled();
  });

  it("passes over an empty map to the next provider, keeping every paid attempt", async () => {
    const map = (id: WebProviderId, usd: number, urls: string[]): WebProviderAdapter => ({ id, keyEnv: "",
      capabilities: { map: { estimateUsd: () => usd, run: async () => ({ data: { urls }, costUsd: usd, costSource: "estimated" }) } } });
    const r = new WebRouter({ adapters: [map("firecrawl", 0.001, []), map("tavily", 0.008, ["https://a.test/1"])],
      keys: { firecrawl: "k", tavily: "k" }, strategy: "cheapest", order: ["firecrawl", "tavily"], maxAttempts: 3 });
    const routed = await r.run("map", { url: "https://a.test/", limit: 10, includeSubdomains: false }, { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 });
    expect(routed.provider).toBe("tavily");
    expect(routed.attempts.map((a) => a.outcome)).toEqual(["empty", "ok"]);
    expect(routed.paid.map((p) => p.costUsd)).toEqual([0.001, 0.008]);

    // A site every provider finds empty costs at most two attempts, never the whole provider list.
    const third = map("exa", 0.02, ["https://a.test/never"]);
    const stubborn = new WebRouter({ adapters: [map("firecrawl", 0.001, []), map("tavily", 0.008, []), third],
      keys: { firecrawl: "k", tavily: "k", exa: "k" }, strategy: "cheapest", order: ["firecrawl", "tavily", "exa"], maxAttempts: 3 });
    const gaveUp = await stubborn.run("map", { url: "https://a.test/", limit: 10, includeSubdomains: false }, { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 });
    expect(gaveUp.attempts.map((a) => a.outcome)).toEqual(["empty", "empty"]);
    expect(gaveUp.result.data).toEqual({ urls: [] });
  });

  it("reports unavailability with a retry hint when every provider is cooling down", async () => {
    const jina = adapter("jina", 0.001, async () => { throw new WebProviderError("auth", "jina responded 401", 401); });
    const r = router([jina]);
    await expect(r.run()).rejects.toMatchObject({ status: 502 });
    await expect(r.run()).rejects.toMatchObject({ status: 503, code: "unavailable", retryAfterSeconds: 600 });
  });
});

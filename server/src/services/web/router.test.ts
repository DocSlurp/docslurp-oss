import { describe, expect, it, vi } from "vitest";

import { thinPage, WebRouter, type WebRouterOptions } from "./router.js";
import { WebProviderError, WebToolError, type WebInput, type WebOutput, type WebProviderAdapter, type WebProviderId } from "./types.js";

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

describe("WebRouter render ladder (fetch)", () => {
  type FetchRun = (input: WebInput<"fetch">) => Promise<{ data: WebOutput<"fetch">; costUsd: number; costSource: "reported" | "estimated" }>;
  const opt = (id: string, tier: 0 | 1 | 2, usd: number, run: FetchRun) => ({ id, tier, estimateUsd: () => usd, run: vi.fn(run) });
  const read = (urls: string[], markdown = "# Real page\n\nEnough readable text to count as a real page for the reader.") =>
    ({ data: { pages: urls.map((url) => ({ url, markdown })), failed: [] }, costUsd: 0.001, costSource: "reported" as const });
  const fetchInput = (urls: string[]): WebInput<"fetch"> => ({ urls, depth: "fast", maxCharacters: 5_000 });
  function ladder(adapters: WebProviderAdapter[], options: Partial<WebRouterOptions> = {}) {
    return new WebRouter({ adapters, keys: Object.fromEntries(adapters.map((a) => [a.id, "k"])), strategy: "cheapest",
      order: ["jina", "firecrawl", "exa", "tavily"], maxAttempts: 4, retryDelayMs: () => 0, ...options });
  }
  const run = (router: WebRouter, urls: string[]) => router.run("fetch", fetchInput(urls), { signal: new AbortController().signal, deadlineAt: Date.now() + 60_000 });

  it("reads with the cheapest plain fetch first and escalates only blocked or thin pages to a rendering tier", async () => {
    const direct = opt("direct", 0, 0.00025, async (input) => ({ data: {
      pages: input.urls.filter((url) => url.endsWith("/ok")).map((url) => ({ url, markdown: "# Docs\n\nPlenty of real, server-rendered documentation text lives on this page." }))
        .concat(input.urls.filter((url) => url.endsWith("/spa")).map((url) => ({ url, markdown: "Please enable JavaScript to run this app." }))),
      failed: input.urls.filter((url) => url.endsWith("/blocked")).map((url) => ({ url, reason: "blocked" })) }, costUsd: 0.0005, costSource: "reported" }));
    const browser = opt("browser", 1, 0.00025, async (input) => read(input.urls));
    const jina: WebProviderAdapter = { id: "jina", keyEnv: "", capabilities: { fetch: { tier: 0, estimateUsd: direct.estimateUsd, run: direct.run, variants: [browser] } } };
    const routed = await run(ladder([jina]), ["https://a.test/ok", "https://a.test/spa", "https://a.test/blocked"]);
    expect(routed.result.data.pages.map((page) => page.url)).toEqual(["https://a.test/ok", "https://a.test/spa", "https://a.test/blocked"]);
    expect(browser.run).toHaveBeenCalledWith(expect.objectContaining({ urls: ["https://a.test/spa", "https://a.test/blocked"] }), expect.anything());
    expect(routed.paid.map((item) => `${item.provider}.${item.option}:${item.tier}`)).toEqual(["jina.standard:0", "jina.browser:1"]);
    expect(routed.attempts.map((item) => item.outcome)).toEqual(["partial", "ok"]);
  });

  it("blocks options priced at 15x or more of the cheapest, and reports what it blocked", async () => {
    const cheap = opt("standard", 0, 0.001, async (input) => ({ data: { pages: [], failed: input.urls.map((url) => ({ url, reason: "blocked" })) }, costUsd: 0.001, costSource: "reported" }));
    const pricey = opt("llm-render", 2, 0.015, async (input) => read(input.urls));
    const affordable = opt("browser", 1, 0.0149, async (input) => read(input.urls));
    const firecrawl: WebProviderAdapter = { id: "firecrawl", keyEnv: "", capabilities: { fetch: { estimateUsd: cheap.estimateUsd, run: cheap.run, variants: [affordable, pricey] } } };
    const routed = await run(ladder([firecrawl]), ["https://b.test/"]);
    expect(routed.priceBlocked).toEqual(["firecrawl.llm-render"]);
    expect(pricey.run).not.toHaveBeenCalled();
    expect(routed.option).toBe("browser");
  });

  it("retries a transient outage once on the same option, then fails over within the tier", async () => {
    let calls = 0;
    const flaky = opt("standard", 0, 0.0002, async (input) => { calls++; if (calls < 2) throw new WebProviderError("unavailable", "jina responded 502", 502); return read(input.urls); });
    const jina: WebProviderAdapter = { id: "jina", keyEnv: "", capabilities: { fetch: { estimateUsd: flaky.estimateUsd, run: flaky.run } } };
    const routed = await run(ladder([jina]), ["https://c.test/"]);
    expect(calls).toBe(2);
    expect(routed.attempts.map((item) => item.outcome)).toEqual(["unavailable", "ok"]);

    const down = opt("standard", 0, 0.0002, async () => { throw new WebProviderError("unavailable", "jina responded 503", 503); });
    const backup = opt("standard", 0, 0.001, async (input) => read(input.urls));
    const routedOver = await run(ladder([
      { id: "jina", keyEnv: "", capabilities: { fetch: { estimateUsd: down.estimateUsd, run: down.run } } },
      { id: "exa", keyEnv: "", capabilities: { fetch: { estimateUsd: backup.estimateUsd, run: backup.run } } },
    ]), ["https://d.test/"]);
    expect(down.run).toHaveBeenCalledTimes(2);
    expect(routedOver.provider).toBe("exa");
  });

  it("skips disabled options and starts deep reads at the rendering tier", async () => {
    const plain = opt("standard", 0, 0.0002, async (input) => read(input.urls));
    const live = opt("live", 2, 0.001, async (input) => read(input.urls));
    const exa: WebProviderAdapter = { id: "exa", keyEnv: "", capabilities: { fetch: { estimateUsd: plain.estimateUsd, run: plain.run, variants: [live] } } };
    await expect(run(ladder([exa], { disabledOptions: ["exa.standard", "exa.live"] }), ["https://e.test/"])).rejects.toMatchObject({ status: 503 });
    const routed = await ladder([exa]).run("fetch", { urls: ["https://e.test/"], depth: "deep", maxCharacters: 5_000 }, { signal: new AbortController().signal, deadlineAt: Date.now() + 60_000 });
    expect(routed.option).toBe("live");
    expect(plain.run).not.toHaveBeenCalled();
  });

  it("learns from reported costs: an option that bills above its estimate drops behind a cheaper one", async () => {
    const underestimated = opt("standard", 0, 0.0002, async (input) => ({ ...read(input.urls), costUsd: 0.002 }));
    const honest = opt("standard", 0, 0.001, async (input) => read(input.urls));
    const router = ladder([
      { id: "jina", keyEnv: "", capabilities: { fetch: { estimateUsd: underestimated.estimateUsd, run: underestimated.run } } },
      { id: "exa", keyEnv: "", capabilities: { fetch: { estimateUsd: honest.estimateUsd, run: honest.run } } },
    ]);
    for (let i = 0; i < 3; i++) expect((await run(router, [`https://f.test/${i}`])).provider).toBe("jina");
    expect((await run(router, ["https://f.test/next"])).provider).toBe("exa");
    expect(router.costProfile()["fetch:jina.standard"]).toMatchObject({ samples: 3 });
  });
});

describe("thinPage", () => {
  it("treats JavaScript shells and anti-bot walls as thin, but not short real pages", () => {
    expect(thinPage({ url: "https://x.test", markdown: "Just a moment... Checking your browser before accessing x.test." })).toBe(true);
    expect(thinPage({ url: "https://x.test", markdown: "" })).toBe(true);
    expect(thinPage({ url: "https://example.com", markdown: "This domain is for use in documentation examples without needing permission. Avoid use in operations." })).toBe(false);
  });
});

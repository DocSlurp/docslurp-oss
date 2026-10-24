import { describe, expect, it, vi } from "vitest";

import { WebProviderError, type ProviderCallContext } from "../types.js";
import { createExaAdapter } from "./exa.js";
import { createFirecrawlAdapter } from "./firecrawl.js";
import { createJinaAdapter } from "./jina.js";
import { createTavilyAdapter } from "./tavily.js";

function context(responses: Array<Response | ((url: string, init?: RequestInit) => Response)>, deadlineMs = 30_000) {
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${String(url)}`);
    return typeof next === "function" ? next(String(url), init) : next;
  });
  const ctx: ProviderCallContext = { apiKey: "test-key", signal: new AbortController().signal, fetch: fetch as unknown as typeof globalThis.fetch, deadlineMs };
  return { ctx, fetch, body: (index: number) => JSON.parse(fetch.mock.calls[index]![1]!.body as string) };
}

const search = { query: "grid storage", limit: 3, depth: "fast" as const, includeContent: false, maxCharacters: 1000 };

describe("web provider adapters", () => {
  it("Tavily search: maps results and prices reported credits", async () => {
    const t = context([Response.json({ results: [{ url: "https://a.test/x", title: "A", content: "snippet", score: 0.9, favicon: "f" }], usage: { credits: 1 }, request_id: "r" })]);
    const result = await createTavilyAdapter({ usdPerCredit: 0.008 }).capabilities.search!.run(search, t.ctx);
    expect(result).toEqual({ data: { results: [{ url: "https://a.test/x", title: "A", snippet: "snippet", score: 0.9 }] }, costUsd: 0.008, costSource: "reported", units: { amount: 1, unit: "credits" } });
    expect(t.body(0)).toMatchObject({ search_depth: "basic", max_results: 3, include_usage: true, include_raw_content: false });
  });

  it("Tavily extract: falls back to the price sheet (per started block of 5 URLs) when usage reads zero", async () => {
    const t = context([Response.json({ results: [{ url: "https://a.test/", raw_content: "# Page" }], failed_results: [{ url: "https://b.test/", error: "x" }], usage: { credits: 0 } })]);
    const result = await createTavilyAdapter({ usdPerCredit: 0.008 }).capabilities.fetch!.run({ urls: ["https://a.test/", "https://b.test/"], depth: "fast", maxCharacters: 1000 }, t.ctx);
    expect(result.data).toEqual({ pages: [{ url: "https://a.test/", markdown: "# Page" }], failed: [{ url: "https://b.test/", reason: "unreadable" }] });
    expect(result).toMatchObject({ costSource: "estimated", costUsd: 0.008 }); // one started block of 5 URLs
  });

  it("Exa search: uses reported costDollars and requests text only when content is wanted", async () => {
    const t = context([Response.json({ results: [{ url: "https://e.test/", title: "E", publishedDate: "2026-10-01", text: "Body text" }], costDollars: { total: 0.007 } })]);
    const result = await createExaAdapter().capabilities.search!.run({ ...search, includeContent: true, depth: "deep" }, t.ctx);
    expect(result.data.results[0]).toEqual({ url: "https://e.test/", title: "E", publishedAt: "2026-10-01", snippet: "Body text", markdown: "Body text" });
    expect(result).toMatchObject({ costUsd: 0.007, costSource: "reported" });
    expect(t.body(0)).toMatchObject({ type: "auto", contents: { text: { maxCharacters: 1000 } } });
  });

  it("Jina search: asks for no page content on snippet searches and prices tokens", async () => {
    const t = context([Response.json({ code: 200, data: [{ title: "J", url: "https://j.test/", description: "d" }], meta: { usage: { tokens: 10_000 } } })]);
    const result = await createJinaAdapter({ usdPerMillionTokens: 0.05 }).capabilities.search!.run({ ...search, includeDomains: ["j.test"] }, t.ctx);
    expect(result).toMatchObject({ data: { results: [{ url: "https://j.test/", title: "J", snippet: "d" }] }, costUsd: 0.0005, costSource: "reported" });
    expect(String(t.fetch.mock.calls[0]![0])).toBe("https://s.jina.ai/?q=grid+storage&site=j.test");
    expect((t.fetch.mock.calls[0]![1]!.headers as Record<string, string>)["X-Respond-With"]).toBe("no-content");
  });

  it("Jina search declines inputs it cannot honour so the router picks another provider", () => {
    const jina = createJinaAdapter({ usdPerMillionTokens: 0.05 }).capabilities.search!;
    expect(jina.accepts!({ ...search, recency: "week" })).toBe(false);
    expect(jina.accepts!({ ...search, includeContent: true })).toBe(false);
    expect(jina.accepts!(search)).toBe(true);
  });

  it("Firecrawl crawl: polls the job and cancels it when the deadline passes", async () => {
    vi.useFakeTimers();
    try {
      const t = context([
        Response.json({ success: true, id: "job-1" }),
        Response.json({ status: "scraping", data: [{ markdown: "# One", metadata: { sourceURL: "https://f.test/1", title: "One" } }], creditsUsed: 1 }),
        Response.json({ status: "scraping", data: [{ markdown: "# One", metadata: { sourceURL: "https://f.test/1", title: "One" } }], creditsUsed: 1 }),
        new Response(null, { status: 200 }),
      ], 5_000);
      const pending = createFirecrawlAdapter({ usdPerCredit: 0.001 }).capabilities.crawl!.run(
        { url: "https://f.test/", limit: 5, maxDepth: 2, maxCharacters: 1000 }, t.ctx);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result.data.pages).toEqual([{ url: "https://f.test/1", title: "One", markdown: "# One" }]);
      expect(result).toMatchObject({ costUsd: 0.001, costSource: "reported" });
      expect(t.fetch.mock.calls.at(-1)![1]).toMatchObject({ method: "DELETE" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("Jina page reads: direct fetch first, browser variants render JavaScript", async () => {
    const jina = createJinaAdapter({ usdPerMillionTokens: 0.05 }).capabilities.fetch!;
    const ok = () => Response.json({ data: { url: "https://j.test/", title: "J", content: "# J\n\nbody", usage: { tokens: 400 } } });
    for (const [option, expected] of [["standard", { "X-Engine": "direct" }], ["browser", {}], ["browser-wait", { "X-Engine": "browser", "X-With-Shadow-Dom": "true", "X-No-Cache": "true" }]] as const) {
      const t = context([ok()]);
      const run = option === "standard" ? jina.run : jina.variants!.find((item) => item.id === option)!.run;
      await run({ urls: ["https://j.test/"], depth: "fast", maxCharacters: 1000 }, t.ctx);
      const headers = t.fetch.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(headers).toMatchObject(expected);
      if (option === "browser") expect(headers["X-Engine"]).toBeUndefined();
    }
    expect(jina.tier).toBe(0);
    expect(jina.variants!.map((item) => [item.id, item.tier])).toEqual([["browser", 1], ["browser-wait", 2]]);
  });

  it("Firecrawl page reads: a target-site 403 is a blocked page that was still billed", async () => {
    const t = context([Response.json({ success: true, data: { markdown: "Access denied", metadata: { sourceURL: "https://f.test/", statusCode: 403 } } })]);
    const result = await createFirecrawlAdapter({ usdPerCredit: 0.001 }).capabilities.fetch!.run({ urls: ["https://f.test/"], depth: "fast", maxCharacters: 1000 }, t.ctx);
    expect(result.data).toEqual({ pages: [], failed: [{ url: "https://f.test/", reason: "blocked" }] });
    expect(result.costUsd).toBe(0.001);
    expect(t.body(0)).toMatchObject({ proxy: "auto" });
    const wait = context([Response.json({ success: true, data: { markdown: "# Loaded\n\nlazy content", metadata: { sourceURL: "https://f.test/", statusCode: 200 } } })]);
    await createFirecrawlAdapter({ usdPerCredit: 0.001 }).capabilities.fetch!.variants![0]!.run({ urls: ["https://f.test/"], depth: "fast", maxCharacters: 1000 }, wait.ctx);
    expect(wait.body(0)).toMatchObject({ maxAge: 0, waitFor: 2_500, actions: [{ type: "scroll" }, { type: "wait" }] });
  });

  it("Exa page reads: live crawl on demand, and error tags become escalation reasons", async () => {
    const exa = createExaAdapter().capabilities.fetch!;
    const t = context([Response.json({ results: [], statuses: [
      { id: "https://e.test/a", status: "error", error: { tag: "CRAWL_HTTP_403" } },
      { id: "https://e.test/b", status: "error", error: { tag: "CRAWL_LIVECRAWL_TIMEOUT" } },
      { id: "https://e.test/c", status: "error", error: { tag: "SOMETHING_NEW" } },
    ], costDollars: { total: 0 } })]);
    const result = await exa.variants![0]!.run({ urls: ["https://e.test/a", "https://e.test/b", "https://e.test/c"], depth: "fast", maxCharacters: 1000 }, t.ctx);
    expect(result.data.failed.map((item) => item.reason)).toEqual(["blocked", "timeout", "unreadable"]);
    expect(t.body(0)).toMatchObject({ maxAgeHours: 0, livecrawlTimeout: 30_000 });
  });

  it("Tavily page reads: advanced extraction costs double and renders JavaScript", async () => {
    const tavily = createTavilyAdapter({ usdPerCredit: 0.008 }).capabilities.fetch!;
    const advanced = tavily.variants![0]!;
    expect(advanced.estimateUsd({ urls: ["https://t.test/"], depth: "fast", maxCharacters: 1000 })).toBeCloseTo(2 * tavily.estimateUsd({ urls: ["https://t.test/"], depth: "fast", maxCharacters: 1000 }));
    const t = context([Response.json({ results: [{ url: "https://t.test/", raw_content: "# T\n\nbody" }], failed_results: [], usage: { credits: 0 } })]);
    await advanced.run({ urls: ["https://t.test/"], depth: "fast", maxCharacters: 1000 }, t.ctx);
    expect(t.body(0)).toMatchObject({ extract_depth: "advanced", timeout: 30 });
  });

  it("maps provider statuses to failover kinds", async () => {
    for (const [status, kind] of [[402, "quota_exhausted"], [432, "quota_exhausted"], [429, "rate_limited"], [401, "auth"], [503, "unavailable"], [422, "invalid_request"]] as const) {
      const t = context([new Response("nope", { status, headers: { "retry-after": "7" } })]);
      const error = await createExaAdapter().capabilities.search!.run(search, t.ctx).catch((caught: unknown) => caught) as WebProviderError;
      expect(error).toBeInstanceOf(WebProviderError);
      expect(error.kind).toBe(kind);
      if (kind === "rate_limited") expect(error.retryAfterMs).toBe(7_000);
    }
  });
});

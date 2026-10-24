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

  it("Tavily extract: falls back to the price sheet when amortized usage reads zero", async () => {
    const t = context([Response.json({ results: [{ url: "https://a.test/", raw_content: "# Page" }], failed_results: [{ url: "https://b.test/", error: "x" }], usage: { credits: 0 } })]);
    const result = await createTavilyAdapter({ usdPerCredit: 0.008 }).capabilities.fetch!.run({ urls: ["https://a.test/", "https://b.test/"], depth: "fast", maxCharacters: 1000 }, t.ctx);
    expect(result.data).toEqual({ pages: [{ url: "https://a.test/", markdown: "# Page" }], failed: [{ url: "https://b.test/", reason: "unreadable" }] });
    expect(result).toMatchObject({ costSource: "estimated", costUsd: 0.2 * 0.008 });
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

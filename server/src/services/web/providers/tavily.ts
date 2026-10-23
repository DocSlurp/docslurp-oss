import type { ProviderResult, WebProviderAdapter } from "../types.js";
import { clip, num, page, providerJson, str } from "./http.js";

const BASE = "https://api.tavily.com";

type TavilyUsage = { usage?: { credits?: unknown } };

/**
 * Tavily: search, extract (fetch), map and crawl. Credits are reported when
 * `include_usage` is set, but extract/map/crawl billing is amortized (a small
 * call can report 0), so a zero report falls back to the price-sheet estimate.
 */
export function createTavilyAdapter(options: { usdPerCredit: number }): WebProviderAdapter {
  const cost = <T>(data: T, reported: TavilyUsage, estimatedCredits: number): ProviderResult<T> => {
    const credits = num(reported.usage?.credits);
    return credits && credits > 0
      ? { data, costUsd: credits * options.usdPerCredit, costSource: "reported", units: { amount: credits, unit: "credits" } }
      : { data, costUsd: estimatedCredits * options.usdPerCredit, costSource: "estimated", units: { amount: estimatedCredits, unit: "credits" } };
  };
  const auth = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}` });
  const searchCredits = (depth: string) => depth === "deep" ? 2 : 1;
  const extractCredits = (urls: number, depth: string) => urls * 0.2 * (depth === "deep" ? 2 : 1);

  return {
    id: "tavily",
    keyEnv: "TAVILY_API_KEY",
    capabilities: {
      search: {
        estimateUsd: (input) => searchCredits(input.depth) * options.usdPerCredit,
        run: async (input, ctx) => {
          const body = await providerJson<TavilyUsage & { results?: Array<Record<string, unknown>> }>("tavily", ctx, `${BASE}/search`, {
            headers: auth(ctx.apiKey),
            body: {
              query: input.query.slice(0, 400), search_depth: input.depth === "deep" ? "advanced" : "basic",
              max_results: Math.min(input.limit, 20), include_raw_content: input.includeContent ? "markdown" : false,
              ...(input.includeDomains?.length ? { include_domains: input.includeDomains } : {}),
              ...(input.excludeDomains?.length ? { exclude_domains: input.excludeDomains } : {}),
              ...(input.recency ? { time_range: input.recency } : {}),
              include_usage: true,
            },
          });
          const results = (body.results ?? []).flatMap((item) => {
            const url = str(item.url);
            return url ? [page({ url, title: str(item.title), snippet: clip(item.content, 1_000), score: num(item.score),
              publishedAt: str(item.published_date), markdown: input.includeContent ? clip(item.raw_content, input.maxCharacters) : undefined })] : [];
          });
          return cost({ results }, body, searchCredits(input.depth));
        },
      },
      fetch: {
        estimateUsd: (input) => extractCredits(input.urls.length, input.depth) * options.usdPerCredit,
        run: async (input, ctx) => {
          const body = await providerJson<TavilyUsage & { results?: Array<Record<string, unknown>>; failed_results?: Array<Record<string, unknown>> }>(
            "tavily", ctx, `${BASE}/extract`, {
              headers: auth(ctx.apiKey),
              body: { urls: input.urls, extract_depth: input.depth === "deep" ? "advanced" : "basic", format: "markdown", include_usage: true },
            });
          const pages = (body.results ?? []).flatMap((item) => {
            const url = str(item.url);
            return url ? [page({ url, title: str(item.title), markdown: clip(item.raw_content, input.maxCharacters) })] : [];
          });
          const failed = (body.failed_results ?? []).flatMap((item) => str(item.url) ? [{ url: str(item.url)!, reason: "unreadable" }] : []);
          return cost({ pages, failed }, body, extractCredits(pages.length, input.depth));
        },
      },
      map: {
        estimateUsd: (input) => Math.ceil(input.limit / 10) * options.usdPerCredit,
        // Tavily ranks map results only with an LLM `instructions` step (double cost), and bills per 10 URLs,
        // above the per-map price for large maps; it only serves small, unsearched maps.
        accepts: (input) => !input.search && input.limit <= 20,
        run: async (input, ctx) => {
          const body = await providerJson<TavilyUsage & { results?: unknown[] }>("tavily", ctx, `${BASE}/map`, {
            headers: auth(ctx.apiKey),
            body: { url: input.url, limit: input.limit, max_depth: 2, allow_external: false, include_usage: true },
          });
          const urls = (body.results ?? []).flatMap((item) => str(item) ? [str(item)!] : []).slice(0, input.limit);
          return cost({ urls }, body, Math.ceil(Math.max(1, urls.length) / 10));
        },
      },
      crawl: {
        estimateUsd: (input) => input.limit * 0.3 * options.usdPerCredit,
        run: async (input, ctx) => {
          const body = await providerJson<TavilyUsage & { results?: Array<Record<string, unknown>> }>("tavily", ctx, `${BASE}/crawl`, {
            headers: auth(ctx.apiKey),
            body: {
              url: input.url, limit: input.limit, max_depth: input.maxDepth, extract_depth: "basic", format: "markdown",
              allow_external: false, include_usage: true,
              ...(input.includePaths?.length ? { select_paths: input.includePaths } : {}),
              ...(input.excludePaths?.length ? { exclude_paths: input.excludePaths } : {}),
              timeout: Math.max(10, Math.min(150, Math.floor(ctx.deadlineMs / 1000))),
            },
          });
          const pages = (body.results ?? []).flatMap((item) => {
            const url = str(item.url);
            return url ? [page({ url, title: str(item.title), markdown: clip(item.raw_content, input.maxCharacters) })] : [];
          }).slice(0, input.limit);
          return cost({ pages }, body, Math.max(1, pages.length) * 0.3);
        },
      },
    },
  };
}

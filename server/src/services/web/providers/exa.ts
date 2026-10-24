import type { ProviderResult, WebProviderAdapter, WebRecency } from "../types.js";
import { clip, num, page, providerJson, str } from "./http.js";

const BASE = "https://api.exa.ai";
// Price sheet (USD), used for routing and when costDollars is missing.
const SEARCH_LITE = 0.004;
const SEARCH_AUTO = 0.007;
const CONTENT_PER_PAGE = 0.001;

type ExaCost = { costDollars?: { total?: unknown } };

function since(recency: WebRecency): string {
  const days = { day: 1, week: 7, month: 31, year: 366 }[recency];
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Exa: neural search and contents (fetch). No map or crawl. Every response reports `costDollars`. */
export function createExaAdapter(): WebProviderAdapter {
  const cost = <T>(data: T, body: ExaCost, estimateUsd: number): ProviderResult<T> => {
    const total = num(body.costDollars?.total);
    return total !== undefined
      ? { data, costUsd: total, costSource: "reported", units: { amount: total, unit: "usd" } }
      : { data, costUsd: estimateUsd, costSource: "estimated" };
  };
  const headers = (apiKey: string) => ({ "x-api-key": apiKey });
  // Snippet searches request highlights, which measured at no extra cost (2026-10-23); text adds per page.
  const searchEstimate = (deep: boolean, includeContent: boolean, limit: number) =>
    (deep ? SEARCH_AUTO : SEARCH_LITE) + (includeContent ? limit * CONTENT_PER_PAGE : 0);

  return {
    id: "exa",
    keyEnv: "EXA_API_KEY",
    capabilities: {
      search: {
        estimateUsd: (input) => searchEstimate(input.depth === "deep", input.includeContent, input.limit),
        run: async (input, ctx) => {
          const body = await providerJson<ExaCost & { results?: Array<Record<string, unknown>> }>("exa", ctx, `${BASE}/search`, {
            headers: headers(ctx.apiKey),
            body: {
              query: input.query.slice(0, 2_000), type: input.depth === "deep" ? "auto" : "lite", numResults: Math.min(input.limit, 10),
              ...(input.includeDomains?.length ? { includeDomains: input.includeDomains } : {}),
              ...(input.excludeDomains?.length ? { excludeDomains: input.excludeDomains } : {}),
              ...(input.recency ? { startPublishedDate: since(input.recency) } : {}),
              contents: input.includeContent
                ? { text: { maxCharacters: input.maxCharacters } }
                : { highlights: { numSentences: 2, highlightsPerUrl: 1 } },
            },
          });
          const results = (body.results ?? []).flatMap((item) => {
            const url = str(item.url);
            const text = typeof item.text === "string" ? item.text : undefined;
            return url ? [page({ url, title: str(item.title), publishedAt: str(item.publishedDate),
              snippet: clip(Array.isArray(item.highlights) ? item.highlights[0] : text, 1_000),
              markdown: input.includeContent ? clip(text, input.maxCharacters) : undefined })] : [];
          });
          return cost({ results }, body, searchEstimate(input.depth === "deep", input.includeContent, input.limit));
        },
      },
      fetch: {
        estimateUsd: (input) => input.urls.length * CONTENT_PER_PAGE,
        run: async (input, ctx) => {
          const body = await providerJson<ExaCost & { results?: Array<Record<string, unknown>>; statuses?: Array<Record<string, unknown>> }>(
            "exa", ctx, `${BASE}/contents`, {
              headers: headers(ctx.apiKey),
              body: { urls: input.urls, text: { maxCharacters: input.maxCharacters }, ...(input.depth === "deep" ? { maxAgeHours: 0 } : {}) },
            });
          const pages = (body.results ?? []).flatMap((item) => {
            const url = str(item.url);
            const markdown = clip(item.text, input.maxCharacters);
            return url && markdown ? [page({ url, title: str(item.title), publishedAt: str(item.publishedDate), markdown })] : [];
          });
          const failed = (body.statuses ?? []).flatMap((status) => status.status === "error" && str(status.id)
            ? [{ url: str(status.id)!, reason: "unreadable" }] : []);
          return cost({ pages, failed }, body, pages.length * CONTENT_PER_PAGE);
        },
      },
    },
  };
}

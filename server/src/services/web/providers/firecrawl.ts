import { WebProviderError, type ProviderCallContext, type ProviderResult, type WebPage, type WebProviderAdapter, type WebRecency } from "../types.js";
import { clip, num, page, providerJson, sleep, str } from "./http.js";

const BASE = "https://api.firecrawl.dev/v2";
const TBS: Record<WebRecency, string> = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };
const POLL_MS = 2_000;

type Credits = { creditsUsed?: unknown };

function scrapedPage(item: Record<string, unknown>, maxCharacters: number): WebPage | null {
  const metadata = (item.metadata && typeof item.metadata === "object" ? item.metadata : {}) as Record<string, unknown>;
  const url = str(metadata.sourceURL) ?? str(metadata.url) ?? str(item.url);
  const markdown = clip(item.markdown, maxCharacters);
  return url && markdown ? page({ url, title: str(metadata.title) ?? str(item.title), markdown }) : null;
}

/**
 * Firecrawl: search, scrape (fetch), map and crawl (an async job, polled until
 * done or the deadline, then cancelled so it stops spending). Search and crawl
 * report `creditsUsed`; scrape and map are priced from the credit sheet.
 */
export function createFirecrawlAdapter(options: { usdPerCredit: number }): WebProviderAdapter {
  const usd = (credits: number) => credits * options.usdPerCredit;
  const cost = <T>(data: T, reported: unknown, estimatedCredits: number): ProviderResult<T> => {
    const credits = num(reported);
    return credits !== undefined && credits > 0
      ? { data, costUsd: usd(credits), costSource: "reported", units: { amount: credits, unit: "credits" } }
      : { data, costUsd: usd(estimatedCredits), costSource: "estimated", units: { amount: estimatedCredits, unit: "credits" } };
  };
  const auth = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}` });
  const scrapeOptions = { formats: ["markdown"], onlyMainContent: true, removeBase64Images: true, blockAds: true };
  const searchCredits = (limit: number, includeContent: boolean) => Math.ceil(limit / 10) * 2 + (includeContent ? limit : 0);

  async function scrape(url: string, input: { depth: string; maxCharacters: number }, ctx: ProviderCallContext) {
    const body = await providerJson<Credits & { data?: Record<string, unknown> }>("firecrawl", ctx, `${BASE}/scrape`, {
      headers: auth(ctx.apiKey),
      body: { url, ...scrapeOptions, ...(input.depth === "deep" ? { maxAge: 0, waitFor: 1_000 } : {}) },
    });
    return body.data ? scrapedPage(body.data, input.maxCharacters) : null;
  }

  return {
    id: "firecrawl",
    keyEnv: "FIRECRAWL_API_KEY",
    capabilities: {
      search: {
        estimateUsd: (input) => usd(searchCredits(input.limit, input.includeContent)),
        run: async (input, ctx) => {
          const sites = [
            ...(input.includeDomains ?? []).length ? [`(${input.includeDomains!.map((domain) => `site:${domain}`).join(" OR ")})`] : [],
            ...(input.excludeDomains ?? []).map((domain) => `-site:${domain}`),
          ];
          const body = await providerJson<Credits & { data?: { web?: Array<Record<string, unknown>> } }>("firecrawl", ctx, `${BASE}/search`, {
            headers: auth(ctx.apiKey),
            body: {
              query: [input.query, ...sites].join(" ").slice(0, 500), limit: input.limit, sources: ["web"],
              ...(input.recency ? { tbs: TBS[input.recency] } : {}),
              ...(input.includeContent ? { scrapeOptions } : {}),
            },
          });
          const results = (body.data?.web ?? []).flatMap((item) => {
            const url = str(item.url);
            return url ? [page({ url, title: str(item.title), snippet: clip(item.description, 1_000),
              markdown: input.includeContent ? clip(item.markdown, input.maxCharacters) : undefined })] : [];
          });
          return cost({ results }, body.creditsUsed, searchCredits(input.limit, input.includeContent));
        },
      },
      fetch: {
        estimateUsd: (input) => usd(input.urls.length),
        run: async (input, ctx) => {
          const settled = await Promise.allSettled(input.urls.map((url) => scrape(url, input, ctx)));
          const pages: WebPage[] = [];
          const failed: Array<{ url: string; reason: string }> = [];
          settled.forEach((result, index) => {
            if (result.status === "fulfilled" && result.value) pages.push(result.value);
            else failed.push({ url: input.urls[index]!, reason: "unreadable" });
          });
          // Every URL failing on a provider-level error (quota, auth) is a provider failure, not unreadable pages.
          const providerFailure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected"
            && result.reason instanceof WebProviderError && result.reason.kind !== "invalid_request");
          if (!pages.length && providerFailure) throw providerFailure.reason;
          return cost({ pages, failed }, undefined, pages.length);
        },
      },
      map: {
        estimateUsd: () => usd(1),
        run: async (input, ctx) => {
          const body = await providerJson<{ links?: unknown[] }>("firecrawl", ctx, `${BASE}/map`, {
            headers: auth(ctx.apiKey),
            body: { url: input.url, limit: input.limit, includeSubdomains: input.includeSubdomains, sitemap: "include",
              ...(input.search ? { search: input.search.slice(0, 200) } : {}) },
          });
          const urls = (body.links ?? []).flatMap((link) => {
            const url = typeof link === "string" ? link : str((link as { url?: unknown } | null)?.url);
            return url ? [url] : [];
          }).slice(0, input.limit);
          return cost({ urls }, undefined, 1);
        },
      },
      crawl: {
        estimateUsd: (input) => usd(input.limit),
        run: async (input, ctx) => {
          const started = Date.now();
          const job = await providerJson<{ id?: unknown }>("firecrawl", ctx, `${BASE}/crawl`, {
            headers: auth(ctx.apiKey),
            body: {
              url: input.url, limit: input.limit, maxDiscoveryDepth: input.maxDepth, sitemap: "include", allowExternalLinks: false,
              ...(input.includePaths?.length ? { includePaths: input.includePaths } : {}),
              ...(input.excludePaths?.length ? { excludePaths: input.excludePaths } : {}),
              scrapeOptions,
            },
          });
          const id = str(job.id);
          if (!id) throw new WebProviderError("unavailable", "firecrawl crawl returned no job id");
          type Status = Credits & { status?: unknown; data?: Array<Record<string, unknown>>; next?: unknown };
          let status: Status = {};
          let finished = false;
          // A started crawl has spent credits even if we fail to collect it; report them on the error.
          const spent = () => usd(num(status.creditsUsed) ?? (status.data?.length ?? 1));
          try {
            while (Date.now() - started < ctx.deadlineMs - POLL_MS) {
              await sleep(POLL_MS, ctx.signal);
              status = await providerJson<Status>("firecrawl", ctx, `${BASE}/crawl/${encodeURIComponent(id)}`, { method: "GET", headers: auth(ctx.apiKey) });
              if (status.status === "failed" || status.status === "cancelled") throw new WebProviderError("unavailable", `firecrawl crawl ${String(status.status)}`);
              if (status.status === "completed") { finished = true; break; }
            }
          } catch (error) {
            if (error && typeof error === "object") Object.assign(error, { costUsd: spent() });
            throw error;
          } finally {
            // Stop a crawl we no longer wait for, so it stops spending credits.
            if (!finished) await ctx.fetch(`${BASE}/crawl/${encodeURIComponent(id)}`, { method: "DELETE", headers: auth(ctx.apiKey) }).catch(() => undefined);
          }
          const items = [...(status.data ?? [])];
          // Large results are paginated (`next`, ~10 MB per page). Follow while under the limit and the
          // soft deadline; a failed or late page keeps what was collected instead of losing the crawl.
          let next = str(status.next);
          while (next && items.length < input.limit && next.startsWith(`${BASE}/`) && Date.now() - started < ctx.deadlineMs - POLL_MS) {
            try {
              const more = await providerJson<Status>("firecrawl", ctx, next, { method: "GET", headers: auth(ctx.apiKey) });
              items.push(...(more.data ?? []));
              next = str(more.next);
            } catch (error) {
              if (ctx.signal.aborted && !items.length) throw Object.assign(error as object, { costUsd: spent() });
              break;
            }
          }
          const pages = items.flatMap((item) => scrapedPage(item, input.maxCharacters) ?? []).slice(0, input.limit);
          return cost({ pages }, status.creditsUsed, Math.max(1, pages.length));
        },
      },
    },
  };
}

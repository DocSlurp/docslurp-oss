import { WebProviderError, type ProviderCallContext, type ProviderResult, type WebPage, type WebProviderAdapter, type WebRecency } from "../types.js";
import { clip, num, page, pageFailureReason, providerJson, sleep, str, targetStatusReason } from "./http.js";

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

  /**
   * `standard` renders JavaScript with the auto proxy (basic, retried once on
   * enhanced when the site answers 401/403/429, at no surcharge). `rendered-wait`
   * also waits, scrolls to trigger lazy content and skips the cache; actions
   * add no credits. A returned document costs 1 credit even when the site
   * answered with an error, so those count toward cost and fail the page.
   */
  async function scrape(url: string, mode: "standard" | "rendered-wait", maxCharacters: number, ctx: ProviderCallContext) {
    const body = await providerJson<Credits & { data?: Record<string, unknown> }>("firecrawl", ctx, `${BASE}/scrape`, {
      headers: auth(ctx.apiKey),
      body: { url, ...scrapeOptions, proxy: "auto",
        ...(mode === "rendered-wait" ? { maxAge: 0, waitFor: 2_500, timeout: 40_000,
          actions: [{ type: "scroll", direction: "down" }, { type: "wait", milliseconds: 1_500 }] } : {}) },
    });
    if (!body.data) return { page: null, charged: false, reason: "unreadable" };
    const metadata = (body.data.metadata && typeof body.data.metadata === "object" ? body.data.metadata : {}) as Record<string, unknown>;
    const reason = targetStatusReason(num(metadata.statusCode));
    if (reason) return { page: null, charged: true, reason };
    const scraped = scrapedPage(body.data, maxCharacters);
    return { page: scraped, charged: true, reason: scraped ? null : "unreadable" };
  }

  async function scrapeAll(input: { urls: string[]; maxCharacters: number }, ctx: ProviderCallContext, mode: "standard" | "rendered-wait") {
    const settled = await Promise.allSettled(input.urls.map((url) => scrape(url, mode, input.maxCharacters, ctx)));
    const pages: WebPage[] = [];
    const failed: Array<{ url: string; reason: string }> = [];
    let charged = 0;
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        if (result.value.charged) charged++;
        if (result.value.page) pages.push(result.value.page);
        else failed.push({ url: input.urls[index]!, reason: result.value.reason ?? "unreadable" });
      } else {
        failed.push({ url: input.urls[index]!, reason: pageFailureReason(result.reason) });
      }
    });
    // Every URL failing on a provider-level error (quota, rate limit, outage) is a provider failure, not unreadable pages.
    const providerFailure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected"
      && result.reason instanceof WebProviderError && ["quota_exhausted", "rate_limited", "unavailable", "auth"].includes(result.reason.kind));
    if (!charged && providerFailure && settled.every((result) => result.status === "rejected")) throw providerFailure.reason;
    return cost({ pages, failed }, undefined, charged);
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
        tier: 1,
        estimateUsd: (input) => usd(input.urls.length),
        run: (input, ctx) => scrapeAll(input, ctx, "standard"),
        variants: [
          { id: "rendered-wait", tier: 2, estimateUsd: (input) => usd(input.urls.length), run: (input, ctx) => scrapeAll(input, ctx, "rendered-wait") },
        ],
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

import { WebProviderError, type ProviderCallContext, type ProviderResult, type WebPage, type WebProviderAdapter } from "../types.js";
import { clip, num, page, providerJson, str } from "./http.js";

/** Search is billed at a fixed minimum of 10k tokens per request. */
const SEARCH_MIN_TOKENS = 10_000;
/** Typical article: ~5k output tokens. */
const PAGE_TOKENS_ESTIMATE = 5_000;

type JinaItem = { title?: unknown; url?: unknown; description?: unknown; content?: unknown; usage?: { tokens?: unknown } };
type JinaBody<T> = { data?: T; meta?: { usage?: { tokens?: unknown } } };

/**
 * Jina Reader (fetch) and Search, billed in tokens. JSON mode reports
 * `usage.tokens`. Search returns a handful of results and supports only
 * domain inclusion, so inputs with other filters route elsewhere.
 */
export function createJinaAdapter(options: { usdPerMillionTokens: number }): WebProviderAdapter {
  const usd = (tokens: number) => (tokens * options.usdPerMillionTokens) / 1_000_000;
  const cost = <T>(data: T, tokens: number | undefined, estimateTokens: number): ProviderResult<T> => tokens && tokens > 0
    ? { data, costUsd: usd(tokens), costSource: "reported", units: { amount: tokens, unit: "tokens" } }
    : { data, costUsd: usd(estimateTokens), costSource: "estimated", units: { amount: estimateTokens, unit: "tokens" } };
  const headers = (apiKey: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${apiKey}`, "X-Retain-Images": "none", ...extra });

  async function read(url: string, deep: boolean, maxCharacters: number, ctx: ProviderCallContext): Promise<{ page: WebPage | null; tokens: number }> {
    const body = await providerJson<JinaBody<JinaItem>>("jina", ctx, `https://r.jina.ai/${url}`, {
      method: "GET", headers: headers(ctx.apiKey, { "X-Respond-With": "markdown", ...(deep ? { "X-Engine": "browser" } : {}) }),
    });
    const markdown = clip(body.data?.content, maxCharacters);
    const tokens = num(body.data?.usage?.tokens) ?? num(body.meta?.usage?.tokens) ?? 0;
    return { page: markdown ? page({ url: str(body.data?.url) ?? url, title: str(body.data?.title), markdown }) : null, tokens };
  }

  return {
    id: "jina",
    keyEnv: "JINA_API_KEY",
    capabilities: {
      search: {
        estimateUsd: (input) => usd(SEARCH_MIN_TOKENS + (input.includeContent ? input.limit * PAGE_TOKENS_ESTIMATE : 0)),
        accepts: (input) => !input.recency && !input.excludeDomains?.length && input.limit <= 10,
        run: async (input, ctx) => {
          const params = new URLSearchParams({ q: input.query.slice(0, 500) });
          for (const domain of input.includeDomains ?? []) params.append("site", domain);
          const body = await providerJson<JinaBody<JinaItem[]>>("jina", ctx, `https://s.jina.ai/?${params}`, {
            method: "GET", headers: headers(ctx.apiKey, input.includeContent ? {} : { "X-Respond-With": "no-content" }),
          });
          const items = Array.isArray(body.data) ? body.data : [];
          const results = items.flatMap((item) => {
            const url = str(item.url);
            return url ? [page({ url, title: str(item.title), snippet: clip(item.description, 1_000),
              markdown: input.includeContent ? clip(item.content, input.maxCharacters) : undefined })] : [];
          }).slice(0, input.limit);
          const itemTokens = items.reduce((sum, item) => sum + (num(item.usage?.tokens) ?? 0), 0);
          return cost({ results }, num(body.meta?.usage?.tokens) ?? itemTokens, SEARCH_MIN_TOKENS);
        },
      },
      fetch: {
        estimateUsd: (input) => usd(input.urls.length * PAGE_TOKENS_ESTIMATE),
        run: async (input, ctx) => {
          const settled = await Promise.allSettled(input.urls.map((url) => read(url, input.depth === "deep", input.maxCharacters, ctx)));
          const pages: WebPage[] = [];
          const failed: Array<{ url: string; reason: string }> = [];
          let tokens = 0;
          settled.forEach((result, index) => {
            if (result.status === "fulfilled") tokens += result.value.tokens;
            if (result.status === "fulfilled" && result.value.page) pages.push(result.value.page);
            else failed.push({ url: input.urls[index]!, reason: "unreadable" });
          });
          const providerFailure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected"
            && result.reason instanceof WebProviderError && result.reason.kind !== "invalid_request");
          if (!pages.length && providerFailure) throw providerFailure.reason;
          return cost({ pages, failed }, tokens, pages.length * PAGE_TOKENS_ESTIMATE);
        },
      },
    },
  };
}

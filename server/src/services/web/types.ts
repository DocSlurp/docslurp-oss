/**
 * Web Capability contracts. Every provider adapter maps its own API onto these
 * generic capabilities; callers (REST, MCP, chat, website ingestion) only ever
 * see the generic shapes. Provider identity never leaves the server: it is
 * recorded in internal telemetry and internal cost events only.
 */

export const WEB_CAPABILITIES = ["search", "fetch", "map", "crawl"] as const;
export type WebCapability = (typeof WEB_CAPABILITIES)[number];

export const WEB_PROVIDER_IDS = ["jina", "tavily", "exa", "firecrawl"] as const;
export type WebProviderId = (typeof WEB_PROVIDER_IDS)[number];

/** `fast` picks the provider's cheapest mode; `deep` its higher-quality, costlier one. */
export type WebDepth = "fast" | "deep";
export type WebRecency = "day" | "week" | "month" | "year";

export interface WebPage {
  url: string;
  title?: string;
  snippet?: string;
  markdown?: string;
  publishedAt?: string;
  score?: number;
}

export interface WebSearchInput {
  query: string;
  limit: number;
  depth: WebDepth;
  /** Return each result's page Markdown (costs more on most providers). */
  includeContent: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
  recency?: WebRecency;
  maxCharacters: number;
}
export interface WebSearchOutput { results: WebPage[] }

export interface WebFetchInput {
  urls: string[];
  depth: WebDepth;
  maxCharacters: number;
}
export interface WebFetchOutput { pages: WebPage[]; failed: Array<{ url: string; reason: string }> }

export interface WebMapInput {
  url: string;
  limit: number;
  /** Rank or filter discovered URLs by this text. */
  search?: string;
  includeSubdomains: boolean;
}
export interface WebMapOutput { urls: string[] }

export interface WebCrawlInput {
  url: string;
  limit: number;
  maxDepth: number;
  includePaths?: string[];
  excludePaths?: string[];
  maxCharacters: number;
}
export interface WebCrawlOutput { pages: WebPage[] }

export interface WebCapabilityIO {
  search: { input: WebSearchInput; output: WebSearchOutput };
  fetch: { input: WebFetchInput; output: WebFetchOutput };
  map: { input: WebMapInput; output: WebMapOutput };
  crawl: { input: WebCrawlInput; output: WebCrawlOutput };
}
export type WebInput<C extends WebCapability> = WebCapabilityIO[C]["input"];
export type WebOutput<C extends WebCapability> = WebCapabilityIO[C]["output"];

/** What one provider call returned and cost. */
export interface ProviderResult<T> {
  data: T;
  /** Provider cost in USD. `reported` when the response stated it, else our price-sheet estimate. */
  costUsd: number;
  costSource: "reported" | "estimated";
  /** Raw provider units (credits, tokens, requests), for internal cost audits only. */
  units?: { amount: number; unit: string };
}

export interface ProviderCallContext {
  apiKey: string;
  signal: AbortSignal;
  fetch: typeof fetch;
  /** Wall-clock budget for async jobs (crawl polling), ms. */
  deadlineMs: number;
}

export type ProviderHandler<C extends WebCapability> = (input: WebInput<C>, ctx: ProviderCallContext) => Promise<ProviderResult<WebOutput<C>>>;

export interface ProviderCapability<C extends WebCapability> {
  estimateUsd(input: WebInput<C>): number;
  /** False when the provider cannot honour an option in this input (the router skips it). */
  accepts?(input: WebInput<C>): boolean;
  run: ProviderHandler<C>;
}

/**
 * One provider. `capabilities` lists only what the provider does natively, with
 * a USD estimate used for cheapest-first routing (before the call) and as the
 * cost when the response does not report one.
 */
export interface WebProviderAdapter {
  readonly id: WebProviderId;
  /** Environment variable holding the API key. */
  readonly keyEnv: string;
  readonly capabilities: { [C in WebCapability]?: ProviderCapability<C> };
}

export type WebProviderErrorKind = "rate_limited" | "quota_exhausted" | "auth" | "invalid_request" | "unavailable" | "timeout";

/**
 * Internal provider failure. `message` is for logs and traces only; it may
 * name the provider and is never returned to callers.
 */
export class WebProviderError extends Error {
  constructor(
    readonly kind: WebProviderErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "WebProviderError";
  }

  /** Another provider may succeed where this one failed. */
  get failover(): boolean {
    return this.kind !== "invalid_request";
  }
}

/** Caller-facing failure: generic message and code, safe to return verbatim. */
export class WebToolError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 429 | 502 | 503,
    readonly code: "web_disabled" | "invalid_request" | "url_blocked" | "privacy_mode_blocked" | "rate_limited" | "unavailable",
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "WebToolError";
  }
}

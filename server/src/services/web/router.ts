import { startTelemetrySpan, type TelemetrySpan } from "@docslurp/shared/observability";

import {
  capabilityOptions, WebProviderError, WebToolError,
  type ProviderCapability, type ProviderOption, type ProviderResult, type WebCapability, type WebInput, type WebOutput, type WebPage,
  type WebProviderAdapter, type WebProviderErrorKind, type WebProviderId, type WebRenderTier,
} from "./types.js";

/**
 * `cheapest`: within each render tier, lowest estimated cost first (default).
 * `round-robin`: within each tier, rotate the starting provider to spread load and rate limits.
 * `ordered`: within each tier, the configured provider order.
 * Tiers always run low to high: a plain fetch is tried before a browser render.
 */
export type WebRoutingStrategy = "cheapest" | "round-robin" | "ordered";

export interface WebRouterOptions {
  adapters: WebProviderAdapter[];
  /** API keys by provider; a provider without a key is never used. */
  keys: Partial<Record<WebProviderId, string>>;
  strategy: WebRoutingStrategy;
  /** Preference order: tie-break for `cheapest`, sequence for `ordered`, ring for `round-robin`. */
  order: WebProviderId[];
  /** Restrict a capability to these providers (in this order of preference). */
  perCapability?: Partial<Record<WebCapability, WebProviderId[]>>;
  /** Provider calls per web call, including the first (failover and escalation steps). */
  maxAttempts: number;
  /**
   * Price guard: an option whose (observed) cost estimate is at least this many times
   * the cheapest eligible option for the same request is never tried. Default 15.
   */
  maxCostRatio?: number;
  /** Same-option retries after a transient failure (5xx, network) before moving on. Default 1. */
  transientRetries?: number;
  /** Options switched off, as "provider.option" (e.g. "exa.live"). */
  disabledOptions?: string[];
  fetch?: typeof fetch;
  now?: () => number;
  /** Backoff before a transient retry; tests pass 0. */
  retryDelayMs?: () => number;
}

export interface WebAttempt {
  provider: WebProviderId;
  option: string;
  tier: WebRenderTier;
  outcome: "ok" | "empty" | "partial" | WebProviderErrorKind | "error";
  runtimeMs: number;
  httpStatus?: number;
}

export interface WebPaidAttempt {
  provider: WebProviderId;
  option: string;
  tier: WebRenderTier;
  costUsd: number;
  costSource: ProviderResult<unknown>["costSource"];
  units?: ProviderResult<unknown>["units"];
}

export interface WebRouteResult<C extends WebCapability> {
  result: ProviderResult<WebOutput<C>>;
  provider: WebProviderId;
  option: string;
  attempts: WebAttempt[];
  /** Every provider call that cost money, including passed-over empty traversals and escalated page reads. */
  paid: WebPaidAttempt[];
  /** Options skipped by the price guard for this call. */
  priceBlocked: string[];
}

interface Candidate<C extends WebCapability> {
  adapter: WebProviderAdapter;
  option: ProviderOption<C>;
  usd: number;
  key: string;
}

/**
 * An empty map or crawl can be a provider quirk (one maps only base domains),
 * so the router asks one more provider, never more. Search and fetch results
 * are taken as returned (fetch escalates per page instead).
 */
function emptyTraversal(capability: WebCapability, data: unknown): boolean {
  if (capability === "map") return !(data as WebOutput<"map">).urls.length;
  if (capability === "crawl") return !(data as WebOutput<"crawl">).pages.length;
  return false;
}

/**
 * A page a plain fetch "read" but that is really a JavaScript shell, an
 * anti-bot interstitial or a consent wall. A short real page (example.com) is
 * not thin: only near-empty text or a known interstitial counts.
 */
const INTERSTITIAL = /\b(enable javascript|javascript is (required|disabled)|just a moment|checking your browser|verify you are (a )?human|are you a robot|access denied|attention required|captcha|cf-browser-verification|please wait while we|ddos protection)\b/i;
export function thinPage(page: WebPage): boolean {
  const text = (page.markdown ?? "").trim();
  if (text.length < 64) return true;
  return text.length < 2_000 && INTERSTITIAL.test(text);
}

/** Margin between a crawl's soft deadline (stop polling, return pages) and its hard abort. */
const CRAWL_DEADLINE_MARGIN_MS = 8_000;

/** Per-attempt time limits; crawl uses the caller's remaining deadline. */
const ATTEMPT_TIMEOUT_MS: Record<WebCapability, number> = { search: 20_000, fetch: 45_000, map: 45_000, crawl: Number.POSITIVE_INFINITY };

function cooldownMs(error: WebProviderError): number {
  if (error.kind === "auth" || error.kind === "quota_exhausted") return 10 * 60_000;
  if (error.kind === "rate_limited") return error.retryAfterMs ?? 30_000;
  return 15_000;
}

/** Provider-wide failures (auth, quota) bench the provider for every capability; others only for the failing capability. */
function cooldownKey(provider: WebProviderId, capability: WebCapability, error: WebProviderError): string {
  return error.kind === "auth" || error.kind === "quota_exhausted" ? provider : `${provider}:${capability}`;
}

function normalize(url: string): string {
  return url.replace(/#.*$/, "").replace(/\/+$/, "");
}

export class WebRouter {
  private readonly cooldowns = new Map<string, number>();
  private readonly rotation = new Map<WebCapability, number>();
  /** Observed cost / estimate per provider option (EWMA), so ordering and the price guard follow real bills. */
  private readonly costRatios = new Map<string, { ratio: number; samples: number }>();
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxCostRatio: number;
  private readonly transientRetries: number;
  private readonly disabled: Set<string>;

  constructor(private readonly options: WebRouterOptions) {
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetch ?? fetch;
    this.maxCostRatio = options.maxCostRatio ?? 15;
    this.transientRetries = Math.max(0, options.transientRetries ?? 1);
    this.disabled = new Set(options.disabledOptions ?? []);
  }

  /** Configured providers that support the capability, regardless of cooldown. */
  configured(capability: WebCapability): WebProviderAdapter[] {
    const allowed = this.options.perCapability?.[capability];
    return this.options.adapters.filter((adapter) => this.options.keys[adapter.id] && adapter.capabilities[capability]
      && (!allowed || allowed.includes(adapter.id)));
  }

  private cooling(provider: WebProviderId, capability: WebCapability): number {
    const now = this.now();
    return Math.max(this.cooldowns.get(provider) ?? 0, this.cooldowns.get(`${provider}:${capability}`) ?? 0) - now;
  }

  /** Observed-vs-estimated cost per option, for internal cost reports. */
  costProfile(): Record<string, { ratio: number; samples: number }> {
    return Object.fromEntries(this.costRatios);
  }

  private observe(key: string, estimateUsd: number, result: ProviderResult<unknown>): void {
    if (result.costSource !== "reported" || estimateUsd <= 0 || !Number.isFinite(result.costUsd)) return;
    const sample = Math.min(20, Math.max(0.05, result.costUsd / estimateUsd));
    const current = this.costRatios.get(key);
    this.costRatios.set(key, current
      ? { ratio: current.ratio * 0.8 + sample * 0.2, samples: current.samples + 1 }
      : { ratio: sample, samples: 1 });
  }

  /** Estimate corrected by what this option has actually cost (after 3 reported samples). */
  private estimate<C extends WebCapability>(key: string, option: ProviderOption<C>, input: WebInput<C>): number {
    const base = option.estimateUsd(input);
    const seen = this.costRatios.get(key);
    return seen && seen.samples >= 3 ? base * seen.ratio : base;
  }

  /**
   * Provider options to try for this input: by tier, then strategy order within
   * the tier. Options at `maxCostRatio`x or more of the cheapest are dropped.
   */
  plan<C extends WebCapability>(capability: C, input: WebInput<C>, minTier = 0): { candidates: Array<Candidate<C>>; priceBlocked: string[] } {
    const preference = this.options.perCapability?.[capability] ?? this.options.order;
    const rank = (id: WebProviderId) => { const index = preference.indexOf(id); return index < 0 ? preference.length : index; };
    const all: Array<Candidate<C>> = [];
    for (const adapter of this.configured(capability)) {
      if (this.cooling(adapter.id, capability) > 0) continue;
      for (const option of capabilityOptions(adapter.capabilities[capability] as ProviderCapability<C>)) {
        const key = `${adapter.id}.${option.id}`;
        if (option.tier < minTier || this.disabled.has(key) || !(option.accepts?.(input) ?? true)) continue;
        all.push({ adapter, option, key, usd: this.estimate(`${capability}:${key}`, option, input) });
      }
    }
    if (!all.length) return { candidates: [], priceBlocked: [] };
    const cheapest = Math.min(...all.map((candidate) => candidate.usd));
    const limit = cheapest > 0 ? cheapest * this.maxCostRatio : Number.POSITIVE_INFINITY;
    const allowed = all.filter((candidate) => candidate.usd < limit);
    const priceBlocked = all.filter((candidate) => candidate.usd >= limit).map((candidate) => candidate.key);
    const tiers = [...new Set(allowed.map((candidate) => candidate.option.tier))].sort((a, b) => a - b);
    const turn = this.rotation.get(capability) ?? 0;
    if (this.options.strategy === "round-robin") this.rotation.set(capability, turn + 1);
    const ordered = tiers.flatMap((tier) => {
      const inTier = allowed.filter((candidate) => candidate.option.tier === tier);
      if (this.options.strategy === "cheapest") return inTier.sort((a, b) => a.usd - b.usd || rank(a.adapter.id) - rank(b.adapter.id));
      const byRank = inTier.sort((a, b) => rank(a.adapter.id) - rank(b.adapter.id) || a.usd - b.usd);
      if (this.options.strategy !== "round-robin" || byRank.length < 2) return byRank;
      const start = turn % byRank.length;
      return [...byRank.slice(start), ...byRank.slice(0, start)];
    });
    return { candidates: ordered, priceBlocked };
  }

  private unavailable(capability: WebCapability): WebToolError {
    const configured = this.configured(capability);
    if (!configured.length) return new WebToolError(400, "invalid_request", `Web ${capability} is not available on this server.`);
    const waits = configured.map((adapter) => this.cooling(adapter.id, capability)).filter((ms) => ms > 0);
    return new WebToolError(503, "unavailable", `Web ${capability} is temporarily unavailable. Try again shortly.`,
      waits.length ? Math.ceil(Math.min(...waits) / 1000) : undefined);
  }

  /**
   * One provider option call with its span, transient retry, cooldowns and
   * cost bookkeeping. Returns the result, or the classified failure.
   */
  private async attempt<C extends WebCapability>(capability: C, candidate: Candidate<C>, input: WebInput<C>, state: {
    signal: AbortSignal; deadlineAt: number; parent?: TelemetrySpan; attempts: WebAttempt[]; paid: WebPaidAttempt[];
  }): Promise<{ ok: true; result: ProviderResult<WebOutput<C>> } | { ok: false; failure: WebProviderError } | { ok: false; skipped: true }> {
    const { adapter, option } = candidate;
    for (let retry = 0; ; retry++) {
      state.signal.throwIfAborted();
      const remaining = state.deadlineAt - this.now();
      if (remaining <= 1_000) return { ok: false, skipped: true };
      const timeoutMs = Math.min(remaining, ATTEMPT_TIMEOUT_MS[capability]);
      const span = startTelemetrySpan("docslurp.web", `web.provider ${capability}`, {
        "docslurp.web.capability": capability, "docslurp.web.provider": adapter.id, "docslurp.web.option": option.id,
        "docslurp.web.tier": option.tier, "docslurp.web.estimate_usd": candidate.usd,
        "docslurp.web.attempt": state.attempts.length + 1, "docslurp.web.retry": retry,
        "docslurp.web.strategy": this.options.strategy, "docslurp.web.timeout_ms": timeoutMs,
      }, { parent: state.parent, kind: "client" });
      const started = this.now();
      const signal = AbortSignal.any([state.signal, AbortSignal.timeout(timeoutMs)]);
      try {
        // Async jobs (crawl) get a soft deadline well before the hard abort, so they can stop and return what they have.
        const softDeadlineMs = capability === "crawl" ? Math.max(Math.min(5_000, timeoutMs / 2), timeoutMs - CRAWL_DEADLINE_MARGIN_MS) : timeoutMs;
        const result = await span.run(() => option.run(input, { apiKey: this.options.keys[adapter.id]!, signal, fetch: this.fetchImpl, deadlineMs: softDeadlineMs }));
        const runtimeMs = this.now() - started;
        state.paid.push({ provider: adapter.id, option: option.id, tier: option.tier, costUsd: result.costUsd, costSource: result.costSource, units: result.units });
        this.observe(`${capability}:${candidate.key}`, option.estimateUsd(input), result);
        state.attempts.push({ provider: adapter.id, option: option.id, tier: option.tier, outcome: "ok", runtimeMs });
        span.set({ "docslurp.web.outcome": "ok", "docslurp.web.runtime_ms": runtimeMs, "docslurp.web.cost_usd": result.costUsd,
          "docslurp.web.cost_source": result.costSource });
        span.end();
        return { ok: true, result };
      } catch (error) {
        const runtimeMs = this.now() - started;
        // A provider job that started before failing reports what it spent (`costUsd` on the error).
        const spentUsd = (error as { costUsd?: unknown } | null)?.costUsd;
        if (typeof spentUsd === "number" && spentUsd > 0) state.paid.push({ provider: adapter.id, option: option.id, tier: option.tier, costUsd: spentUsd, costSource: "estimated" });
        if (state.signal.aborted) {
          state.attempts.push({ provider: adapter.id, option: option.id, tier: option.tier, outcome: "error", runtimeMs });
          span.end(error);
          throw error;
        }
        const failure = error instanceof WebProviderError ? error
          : signal.aborted ? new WebProviderError("timeout", `${adapter.id} timed out after ${timeoutMs} ms`)
          : new WebProviderError("unavailable", `${adapter.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        state.attempts.push({ provider: adapter.id, option: option.id, tier: option.tier, outcome: failure.kind, runtimeMs, ...(failure.status ? { httpStatus: failure.status } : {}) });
        span.set({ "docslurp.web.outcome": failure.kind, "docslurp.web.runtime_ms": runtimeMs, ...(failure.status ? { "http.response.status_code": failure.status } : {}) });
        span.end(failure);
        // Internal log only: may name the provider and quote its error.
        console.warn(`[web] provider_failure capability=${capability} provider=${adapter.id} option=${option.id} kind=${failure.kind} status=${failure.status ?? "-"} retry=${retry} ms=${runtimeMs} detail=${JSON.stringify(failure.message.slice(0, 300))}`);
        // A transient outage (5xx, dropped connection) gets a quick same-option retry; nothing else does.
        // A job that already spent (a started crawl) is not retried: that would pay twice.
        const spent = typeof spentUsd === "number" && spentUsd > 0;
        if (failure.kind === "unavailable" && !spent && retry < this.transientRetries && state.deadlineAt - this.now() > 3_000) {
          const delay = this.options.retryDelayMs?.() ?? 300 + Math.floor(Math.random() * 500);
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        if (failure.kind !== "invalid_request" && failure.kind !== "timeout") {
          this.cooldowns.set(cooldownKey(adapter.id, capability, failure), this.now() + cooldownMs(failure));
        }
        return { ok: false, failure };
      }
    }
  }

  async run<C extends WebCapability>(capability: C, input: WebInput<C>, args: {
    signal: AbortSignal;
    /** Absolute wall-clock deadline (epoch ms) for the whole call, failovers included. */
    deadlineAt: number;
    parent?: TelemetrySpan;
  }): Promise<WebRouteResult<C>> {
    if (capability === "fetch") return await this.runFetch(input as WebInput<"fetch">, args) as unknown as WebRouteResult<C>;
    const { candidates, priceBlocked } = this.plan(capability, input);
    if (!candidates.length) throw this.unavailable(capability);
    const attempts: WebAttempt[] = [];
    const paid: WebPaidAttempt[] = [];
    let empty: WebRouteResult<C> | undefined;
    let lastFailure: WebProviderError | undefined;
    const tried = new Set<WebProviderId>();
    try {
      for (const candidate of candidates) {
        if (attempts.length >= this.options.maxAttempts) break;
        // Search/map/crawl options are alternatives, not render levels: one try per provider.
        if (tried.has(candidate.adapter.id) || this.cooling(candidate.adapter.id, capability) > 0) continue;
        tried.add(candidate.adapter.id);
        const outcome = await this.attempt(capability, candidate, input, { ...args, attempts, paid });
        if ("skipped" in outcome) break;
        if (!outcome.ok) {
          lastFailure = outcome.failure;
          if (!outcome.failure.failover) break;
          continue;
        }
        const routed: WebRouteResult<C> = { result: outcome.result, provider: candidate.adapter.id, option: candidate.option.id, attempts, paid, priceBlocked };
        if (!emptyTraversal(capability, outcome.result.data)) return routed;
        attempts[attempts.length - 1]!.outcome = "empty";
        // One second opinion at most: two empty traversals mean the site, not the provider. Stop paying.
        if (empty) return empty;
        empty = routed;
      }
    } catch (error) {
      if (error && typeof error === "object") Object.assign(error, { attempts, paid });
      throw error;
    }
    if (empty) return empty;
    if (lastFailure?.kind === "invalid_request") {
      throw Object.assign(new WebToolError(400, "invalid_request", `The web ${capability} request was rejected. Check the query or URLs and try again.`), { attempts, paid });
    }
    throw Object.assign(new WebToolError(502, "unavailable", `Web ${capability} failed. Try again shortly.`), { attempts, paid });
  }

  /**
   * Page reads escalate per page: read every URL with the cheapest option of
   * the lowest tier; URLs that came back unreadable, blocked or thin are
   * retried with the next tier (cheapest first), up to `maxAttempts` calls.
   * A provider error fails over within the same tier. Pages read so far are
   * always kept, and a thin page is returned if nothing better was found.
   */
  private async runFetch(input: WebInput<"fetch">, args: { signal: AbortSignal; deadlineAt: number; parent?: TelemetrySpan }): Promise<WebRouteResult<"fetch">> {
    const minTier: WebRenderTier = input.depth === "deep" ? 1 : 0;
    const { candidates, priceBlocked } = this.plan("fetch", input, minTier);
    if (!candidates.length) throw this.unavailable("fetch");
    const attempts: WebAttempt[] = [];
    const paid: WebPaidAttempt[] = [];
    const read = new Map<string, WebPage>();
    const thin = new Map<string, WebPage>();
    const reasons = new Map<string, string>(input.urls.map((url) => [normalize(url), "unreadable"]));
    let remaining = [...input.urls];
    let floor: WebRenderTier = minTier;
    let lastFailure: WebProviderError | undefined;
    let lastOk: Candidate<"fetch"> | undefined;
    const used = new Set<string>();
    try {
      while (remaining.length && attempts.length < this.options.maxAttempts) {
        const candidate = candidates.find((item) => item.option.tier >= floor && !used.has(item.key) && this.cooling(item.adapter.id, "fetch") <= 0);
        if (!candidate) break;
        used.add(candidate.key);
        const outcome = await this.attempt("fetch", candidate, { ...input, urls: remaining }, { ...args, attempts, paid });
        if ("skipped" in outcome) break;
        if (!outcome.ok) {
          lastFailure = outcome.failure;
          if (!outcome.failure.failover) break;
          continue; // same tier, next provider
        }
        lastOk = candidate;
        for (const page of outcome.result.data.pages) {
          const key = normalize(page.url);
          if (thinPage(page) && candidate.option.tier < 2) {
            thin.set(key, page);
            reasons.set(key, "thin");
          } else {
            read.set(key, page);
          }
        }
        for (const failed of outcome.result.data.failed) reasons.set(normalize(failed.url), failed.reason);
        remaining = remaining.filter((url) => !read.has(normalize(url)));
        if (remaining.length) {
          attempts[attempts.length - 1]!.outcome = "partial";
          floor = Math.min(2, candidate.option.tier + 1) as WebRenderTier; // escalate the unread pages
          if (candidate.option.tier === 2) break; // nothing higher to try
        }
      }
    } catch (error) {
      if (error && typeof error === "object") Object.assign(error, { attempts, paid });
      throw error;
    }
    for (const url of remaining) {
      const fallback = thin.get(normalize(url));
      if (fallback) read.set(normalize(url), fallback);
    }
    const pages = input.urls.flatMap((url) => read.get(normalize(url)) ?? []);
    if (!pages.length && lastFailure && !paid.length) {
      throw Object.assign(lastFailure.kind === "invalid_request"
        ? new WebToolError(400, "invalid_request", "The web fetch request was rejected. Check the URLs and try again.")
        : new WebToolError(502, "unavailable", "Web fetch failed. Try again shortly."), { attempts, paid });
    }
    const failed = input.urls.filter((url) => !read.has(normalize(url))).map((url) => ({ url, reason: reasons.get(normalize(url)) ?? "unreadable" }));
    const costUsd = paid.reduce((sum, item) => sum + item.costUsd, 0);
    const served = lastOk ?? candidates[0]!;
    return {
      result: { data: { pages, failed }, costUsd, costSource: paid.every((item) => item.costSource === "reported") ? "reported" : "estimated" },
      provider: served.adapter.id, option: served.option.id, attempts, paid, priceBlocked,
    };
  }
}

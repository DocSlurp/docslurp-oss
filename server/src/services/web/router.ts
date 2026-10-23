import { startTelemetrySpan, type TelemetrySpan } from "@docslurp/shared/observability";

import {
  WebProviderError, WebToolError,
  type ProviderCapability, type ProviderResult, type WebCapability, type WebInput, type WebOutput, type WebProviderAdapter, type WebProviderErrorKind, type WebProviderId,
} from "./types.js";

/**
 * `cheapest`: lowest estimated cost for this input first (default).
 * `round-robin`: rotate the starting provider per capability, spreading load and rate limits.
 * `ordered`: the configured order, so one provider is primary and the rest are fallbacks.
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
  /** Providers tried per call, including the first (failover depth). */
  maxAttempts: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface WebAttempt {
  provider: WebProviderId;
  outcome: "ok" | "empty" | WebProviderErrorKind | "error";
  runtimeMs: number;
  httpStatus?: number;
}

export interface WebRouteResult<C extends WebCapability> {
  result: ProviderResult<WebOutput<C>>;
  provider: WebProviderId;
  attempts: WebAttempt[];
  /** Every attempt that returned (and so cost money), including empty map/crawl results that were passed over. */
  paid: Array<{ provider: WebProviderId; costUsd: number; costSource: ProviderResult<unknown>["costSource"]; units?: ProviderResult<unknown>["units"] }>;
}

/**
 * An empty map or crawl can be a provider quirk (one maps only base domains),
 * so the router asks one more provider, never more. Search and fetch results
 * are taken as returned.
 */
function emptyTraversal(capability: WebCapability, data: unknown): boolean {
  if (capability === "map") return !(data as WebOutput<"map">).urls.length;
  if (capability === "crawl") return !(data as WebOutput<"crawl">).pages.length;
  return false;
}

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

export class WebRouter {
  private readonly cooldowns = new Map<string, number>();
  private readonly rotation = new Map<WebCapability, number>();
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: WebRouterOptions) {
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetch ?? fetch;
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

  /** Providers to try for this input, in strategy order. */
  plan<C extends WebCapability>(capability: C, input: WebInput<C>): WebProviderAdapter[] {
    const preference = this.options.perCapability?.[capability] ?? this.options.order;
    const rank = (id: WebProviderId) => { const index = preference.indexOf(id); return index < 0 ? preference.length : index; };
    const eligible = this.configured(capability).filter((adapter) => {
      const handler = adapter.capabilities[capability] as ProviderCapability<C>;
      return (handler.accepts?.(input) ?? true) && this.cooling(adapter.id, capability) <= 0;
    }).sort((a, b) => rank(a.id) - rank(b.id));
    if (this.options.strategy === "cheapest") {
      const estimate = (adapter: WebProviderAdapter) => (adapter.capabilities[capability] as ProviderCapability<C>).estimateUsd(input);
      return eligible.map((adapter) => ({ adapter, usd: estimate(adapter) }))
        .sort((a, b) => a.usd - b.usd || rank(a.adapter.id) - rank(b.adapter.id)).map(({ adapter }) => adapter);
    }
    if (this.options.strategy === "round-robin" && eligible.length > 1) {
      const turn = this.rotation.get(capability) ?? 0;
      this.rotation.set(capability, turn + 1);
      const start = turn % eligible.length;
      return [...eligible.slice(start), ...eligible.slice(0, start)];
    }
    return eligible;
  }

  async run<C extends WebCapability>(capability: C, input: WebInput<C>, args: {
    signal: AbortSignal;
    /** Absolute wall-clock deadline (epoch ms) for the whole call, failovers included. */
    deadlineAt: number;
    parent?: TelemetrySpan;
  }): Promise<WebRouteResult<C>> {
    const candidates = this.plan(capability, input).slice(0, Math.max(1, this.options.maxAttempts));
    if (!candidates.length) {
      const configured = this.configured(capability);
      if (!configured.length) throw new WebToolError(400, "invalid_request", `Web ${capability} is not available on this server.`);
      const waits = configured.map((adapter) => this.cooling(adapter.id, capability)).filter((ms) => ms > 0);
      throw new WebToolError(503, "unavailable", `Web ${capability} is temporarily unavailable. Try again shortly.`,
        waits.length ? Math.ceil(Math.min(...waits) / 1000) : undefined);
    }
    const attempts: WebAttempt[] = [];
    const paid: WebRouteResult<C>["paid"] = [];
    let empty: WebRouteResult<C> | undefined;
    let lastError: unknown;
    for (const [index, adapter] of candidates.entries()) {
      args.signal.throwIfAborted();
      const remaining = args.deadlineAt - this.now();
      if (remaining <= 1_000) break;
      const timeoutMs = Math.min(remaining, ATTEMPT_TIMEOUT_MS[capability]);
      const handler = adapter.capabilities[capability] as ProviderCapability<C>;
      const span = startTelemetrySpan("docslurp.web", `web.provider ${capability}`, {
        "docslurp.web.capability": capability, "docslurp.web.provider": adapter.id, "docslurp.web.attempt": index + 1,
        "docslurp.web.strategy": this.options.strategy, "docslurp.web.timeout_ms": timeoutMs,
      }, { parent: args.parent, kind: "client" });
      const started = this.now();
      const signal = AbortSignal.any([args.signal, AbortSignal.timeout(timeoutMs)]);
      try {
        const result = await span.run(() => handler.run(input, { apiKey: this.options.keys[adapter.id]!, signal, fetch: this.fetchImpl, deadlineMs: timeoutMs }));
        const runtimeMs = this.now() - started;
        const isEmpty = emptyTraversal(capability, result.data);
        attempts.push({ provider: adapter.id, outcome: isEmpty ? "empty" : "ok", runtimeMs });
        paid.push({ provider: adapter.id, costUsd: result.costUsd, costSource: result.costSource, units: result.units });
        span.set({ "docslurp.web.outcome": isEmpty ? "empty" : "ok", "docslurp.web.runtime_ms": runtimeMs, "docslurp.web.cost_usd": result.costUsd,
          "docslurp.web.cost_source": result.costSource });
        span.end();
        if (!isEmpty) return { result, provider: adapter.id, attempts, paid };
        // One second opinion at most: two empty traversals mean the site, not the provider. Stop paying.
        if (empty) return empty;
        empty = { result, provider: adapter.id, attempts, paid };
        continue;
      } catch (error) {
        const runtimeMs = this.now() - started;
        if (args.signal.aborted) {
          attempts.push({ provider: adapter.id, outcome: "error", runtimeMs });
          span.end(error);
          throw error;
        }
        const failure = error instanceof WebProviderError ? error
          : signal.aborted ? new WebProviderError("timeout", `${adapter.id} timed out after ${timeoutMs} ms`)
          : new WebProviderError("unavailable", `${adapter.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        attempts.push({ provider: adapter.id, outcome: failure.kind, runtimeMs, ...(failure.status ? { httpStatus: failure.status } : {}) });
        span.set({ "docslurp.web.outcome": failure.kind, "docslurp.web.runtime_ms": runtimeMs, ...(failure.status ? { "http.response.status_code": failure.status } : {}) });
        span.end(failure);
        // Internal log only: may name the provider and quote its error.
        console.warn(`[web] provider_failure capability=${capability} provider=${adapter.id} kind=${failure.kind} status=${failure.status ?? "-"} ms=${runtimeMs} detail=${JSON.stringify(failure.message.slice(0, 300))}`);
        lastError = failure;
        if (failure.kind !== "invalid_request" && failure.kind !== "timeout") {
          this.cooldowns.set(cooldownKey(adapter.id, capability, failure), this.now() + cooldownMs(failure));
        }
        if (!failure.failover) break;
      }
    }
    if (empty) return empty;
    const failure = lastError instanceof WebProviderError ? lastError : undefined;
    if (failure?.kind === "invalid_request") {
      throw Object.assign(new WebToolError(400, "invalid_request", `The web ${capability} request was rejected. Check the query or URLs and try again.`), { attempts });
    }
    throw Object.assign(new WebToolError(502, "unavailable", `Web ${capability} failed. Try again shortly.`), { attempts });
  }
}

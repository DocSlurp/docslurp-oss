/**
 * OpenRouter host routing: which upstream providers may serve a request, and
 * in what order. Applied to request bodies by `createOpenRouterRoutingFetch`
 * (and by the worker's vision runtime right before each send).
 *
 * - Open-weight models served by many hosts (GLM, DeepSeek) are sorted by
 *   price, so OpenRouter tries the cheapest host first and keeps using it for
 *   later steps (the same host is also what makes prompt-cache reads hit).
 *   Hosts must serve at least FP8 weights: the cheapest listings are often
 *   FP4/NVFP4 or undisclosed quantizations.
 * - China-based providers are allowed by default. An organization, or a
 *   workspace inside an allowing organization, can turn them off
 *   (`allowChinaProviders`). A restricted request then carries an allowlist,
 *   `provider.only`, of providers with a known headquarters outside China
 *   (provider-regions.ts), plus every China-based provider on `ignore`; any
 *   caller `only`/`order` entry outside the allowlist is dropped, and a request
 *   with nothing left is refused before it is sent. Providers with no known
 *   region are never on the allowlist.
 */

import { CHINA_PROVIDER_SLUGS, NON_CHINA_PROVIDER_SLUGS, isProviderAllowedByRegion } from "./provider-regions.js";

/** Models routed to their cheapest host (by model id prefix). */
const PRICE_ROUTED_MODEL_PREFIXES = ["z-ai/glm-", "deepseek/deepseek-"] as const;

/** Weight precisions a price-routed host may serve; excludes FP4 variants and undisclosed quantizations. */
const PRICE_ROUTED_QUANTIZATIONS = ["fp8", "fp16", "bf16", "fp32"] as const;

export interface OpenRouterProviderPolicy {
  /** False when the organization or workspace turned off China-based providers. */
  allowChinaProviders: boolean;
}

/** A restricted request that no allowed provider could serve; it is never sent. */
export class ProviderRegionRefusedError extends Error {
  readonly code = "PROVIDER_REGION_REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "ProviderRegionRefusedError";
  }
}

/** Whether `model` is sent to its cheapest qualifying host first. */
export function isPriceRoutedModel(model: string): boolean {
  return PRICE_ROUTED_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

/** The price-routing `provider` preferences for `model`, or undefined to leave routing to OpenRouter. */
export function openRouterProviderPreferences(model: string): Record<string, unknown> | undefined {
  return isPriceRoutedModel(model)
    ? { sort: "price", quantizations: [...PRICE_ROUTED_QUANTIZATIONS], allow_fallbacks: true }
    : undefined;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

/**
 * `provider` preferences restricted to providers with a known non-China headquarters. Caller `only` and
 * `order` entries are filtered to that allowlist (endpoint slugs such as `amazon-bedrock/us-east-1` resolve to
 * their provider); `ignore` gains every China-based provider. Throws when a caller allowlist has no allowed
 * entry left, since sending an empty `only` would not restrict anything.
 */
export function restrictToNonChinaProviders(provider: Record<string, unknown> | undefined): Record<string, unknown> {
  const own = provider ?? {};
  const callerOnly = stringList(own.only);
  const only = callerOnly ? callerOnly.filter((slug) => isProviderAllowedByRegion(slug, false)) : [...NON_CHINA_PROVIDER_SLUGS];
  if (only.length === 0) {
    throw new ProviderRegionRefusedError("China-based providers are turned off and none of the request's allowed providers has a known region outside China");
  }
  const ignore = [...new Set([...(stringList(own.ignore) ?? []), ...CHINA_PROVIDER_SLUGS])];
  const callerOrder = stringList(own.order);
  const order = callerOrder?.filter((slug) => isProviderAllowedByRegion(slug, false));
  const { order: _order, ...rest } = own;
  return { ...rest, ...(order?.length ? { order } : {}), only, ignore };
}

/** `provider` preferences with `policy` applied (unchanged when China-based providers are allowed). */
export function applyOpenRouterProviderPolicy(provider: Record<string, unknown> | undefined, policy: OpenRouterProviderPolicy): Record<string, unknown> | undefined {
  return policy.allowChinaProviders ? provider : restrictToNonChinaProviders(provider);
}

/**
 * A request body with routing preferences merged in. Price-routing preferences the caller set itself win; the
 * China restriction (when `policy` turns it on) then applies to the merged preferences, so a caller can narrow
 * it but never widen it.
 */
export function withOpenRouterProviderPreferences<T extends Record<string, unknown>>(body: T, policy?: OpenRouterProviderPolicy): T & { provider?: Record<string, unknown> } {
  const model = typeof body.model === "string" ? body.model : "";
  const preferences = openRouterProviderPreferences(model);
  const own = body.provider && typeof body.provider === "object" && !Array.isArray(body.provider) ? body.provider as Record<string, unknown> : undefined;
  const merged = preferences || own ? { ...preferences, ...own } : undefined;
  const routed = policy ? applyOpenRouterProviderPolicy(merged, policy) : merged;
  if (!routed || (routed === own && !preferences)) return body;
  return { ...body, provider: routed };
}

type PolicyResolver = () => OpenRouterProviderPolicy | undefined | Promise<OpenRouterProviderPolicy | undefined>;
let policyResolver: PolicyResolver | undefined;

/**
 * Registers how the current organization's policy is found (the server reads
 * its request context, the worker its job scope). Without a resolver (scripts,
 * benchmarks) China-based providers stay allowed; with one, a call it cannot
 * place in a scope is restricted.
 */
export function setOpenRouterProviderPolicyResolver(resolver: PolicyResolver | undefined): void {
  policyResolver = resolver;
}

/** The current provider policy: the resolver's answer, restricted when it has none; undefined without a resolver. */
export async function currentOpenRouterProviderPolicy(): Promise<OpenRouterProviderPolicy | undefined> {
  if (!policyResolver) return undefined;
  return (await policyResolver()) ?? { allowChinaProviders: false };
}

/**
 * Wraps an OpenRouter fetch so each JSON request carries the routing preferences for its model and
 * organization. A restricted request whose body is not a JSON object cannot carry the restriction, so it is
 * refused rather than sent.
 */
export function createOpenRouterRoutingFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const policy = await currentOpenRouterProviderPolicy();
    const restricted = policy !== undefined && !policy.allowChinaProviders;
    if (init?.body === undefined || init.body === null) return baseFetch(input, init);
    let body: Record<string, unknown> | undefined;
    if (typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        body = undefined;
      }
    }
    if (!body) {
      if (restricted) throw new ProviderRegionRefusedError("China-based providers are turned off and this request body cannot carry a provider restriction");
      return baseFetch(input, init);
    }
    const routed = withOpenRouterProviderPreferences(body, policy);
    return routed === body ? baseFetch(input, init) : baseFetch(input, { ...init, body: JSON.stringify(routed) });
  };
}

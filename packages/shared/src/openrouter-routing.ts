import { lowestOpenRouterReasoning } from "./openrouter-usage.js";
import { nitroBaseModel } from "./workspace-chat-models.js";
export { nitroBaseModel } from "./workspace-chat-models.js";
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
  /** Explicit per-request or immutable run opt-in; unsupported models remain unchanged. */
  speedBoost?: boolean;
}

/** Only reviewed routing variants can be selected by the Speed boost option. */
export function isSpeedBoostEligible(model: string): boolean {
  return nitroBaseModel(model) !== undefined || nitroBaseModel(`${model}:nitro`) !== undefined;
}

/** Unsupported models retain their existing route; admission may require eligibility explicitly. */
export function speedBoostModel(model: string, enabled: boolean | undefined): string {
  if (enabled === false && model.endsWith(":nitro")) throw new Error("Explicit Nitro models require speedBoost: true");
  return enabled === true && !nitroBaseModel(model) && isSpeedBoostEligible(model) ? `${model}:nitro` : model;
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
  if (model.endsWith(":nitro")) {
    const base = nitroBaseModel(model);
    if (!base) throw new Error("Unsupported OpenRouter Nitro model");
    return { sort: "throughput", ...(isPriceRoutedModel(base) ? { quantizations: [...PRICE_ROUTED_QUANTIZATIONS] } : {}),
      max_price: { prompt: 1, completion: 5 }, allow_fallbacks: true };
  }
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
  if (nitroBaseModel(model) && merged) {
    // Request preferences may narrow, but cannot remove or raise the endpoint ceiling.
    const price = own?.max_price as Record<string, unknown> | undefined;
    const cap = (value: unknown, ceiling: number) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, ceiling) : ceiling;
    merged.max_price = { prompt: cap(price?.prompt, 1), completion: cap(price?.completion, 5) };
    merged.sort = "throughput";
    if (isPriceRoutedModel(nitroBaseModel(model)!)) {
      const requested = stringList(own?.quantizations);
      const allowed = [...PRICE_ROUTED_QUANTIZATIONS].filter((value) => !requested || requested.includes(value));
      if (!allowed.length) throw new Error("No supported Nitro quantization remains");
      merged.quantizations = allowed;
    }
  }
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
 * The open-weight text model a request falls back to when China-based providers
 * are turned off and its model has no other host (OpenRouter answers 404 "No
 * allowed providers"). OPENROUTER_RESTRICTED_FALLBACK_MODEL overrides it; "" or
 * "none" turns the fallback off. Checked 2026-11-06: openai/gpt-oss-120b
 * (Apache-2.0) has 21 non-China endpoints and is cheaper than the default.
 */
export const DEFAULT_RESTRICTED_FALLBACK_MODEL = "openai/gpt-oss-120b";

export function restrictedFallbackModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.OPENROUTER_RESTRICTED_FALLBACK_MODEL?.trim();
  if (configured === undefined) return DEFAULT_RESTRICTED_FALLBACK_MODEL;
  return configured && configured.toLowerCase() !== "none" ? configured : undefined;
}

/** Models a restricted request found unservable, until this time; such requests go straight to the fallback. */
const regionBlockedModels = new Map<string, number>();
const REGION_BLOCK_TTL_MS = 60 * 60_000;

function regionBlocked(model: string, now = Date.now()): boolean {
  const until = regionBlockedModels.get(model);
  if (until === undefined) return false;
  if (until > now) return true;
  regionBlockedModels.delete(model);
  return false;
}

/** For tests: forget remembered region blocks. */
export function resetRegionBlockedModels(): void {
  regionBlockedModels.clear();
}

const NON_TEXT_PART_TYPES = new Set(["image_url", "input_image", "image", "file", "input_file", "input_audio", "audio", "video_url"]);

/** True when no message part is an image, file, audio or video: the fallback model reads text only. */
export function isTextOnlyRequest(body: Record<string, unknown>): boolean {
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 8 || value === null || typeof value !== "object") return true;
    if (Array.isArray(value)) return value.every((item) => visit(item, depth + 1));
    const record = value as Record<string, unknown>;
    if (typeof record.type === "string" && NON_TEXT_PART_TYPES.has(record.type)) return false;
    return Object.values(record).every((item) => visit(item, depth + 1));
  };
  return visit(body.messages, 0) && visit(body.input, 0);
}

/** OpenRouter's 404 for a model the request's provider restriction leaves without a host. */
async function isNoAllowedProviderResponse(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  const text = await response.clone().text().catch(() => "");
  return /no allowed providers|no endpoints found/i.test(text);
}

/** The request re-targeted at the fallback model, with that model's reasoning floor where the caller disabled reasoning. */
function withFallbackModel(body: Record<string, unknown>, fallback: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body, model: fallback };
  const floor = lowestOpenRouterReasoning(fallback);
  const reasoning = body.reasoning as Record<string, unknown> | undefined;
  const disabled = reasoning?.enabled === false || reasoning?.effort === "none" || body.reasoning_effort === "none";
  if (floor && disabled) {
    delete next.reasoning_effort;
    next.reasoning = floor;
  }
  return next;
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
    // Request objects carry their body separately from init. Clone it so policy
    // enforcement cannot be bypassed by the standard fetch(Request) form.
    const request = input instanceof Request ? input : undefined;
    const rawBody = init?.body ?? (request?.body ? await request.clone().text() : undefined);
    if (rawBody === undefined || rawBody === null) return baseFetch(input, init);
    const url = new URL(request?.url ?? String(input));
    // These endpoints document provider routing. Audio transcription does not:
    // refuse restricted uploads rather than assume an ignored field protects them.
    if (restricted && !["/api/v1/chat/completions", "/api/v1/completions", "/api/v1/embeddings", "/api/v1/responses"].includes(url.pathname)) {
      throw new ProviderRegionRefusedError("Provider-region restrictions are not verified for this endpoint; use a supported text endpoint or a private transcription service");
    }
    let body: Record<string, unknown> | undefined;
    if (typeof rawBody === "string") {
      try {
        const parsed = JSON.parse(rawBody) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        body = undefined;
      }
    }
    if (!body) {
      if (restricted) throw new ProviderRegionRefusedError("China-based providers are turned off and this request body cannot carry a provider restriction");
      return baseFetch(input, init);
    }
    const original = body;
    // Never rewrite embedding, audio or other non-generation model identities.
    const generation = ["/api/v1/chat/completions", "/api/v1/completions", "/api/v1/responses"].includes(url.pathname);
    if (generation && typeof body.model === "string") {
      const model = speedBoostModel(body.model, policy?.speedBoost);
      if (model !== body.model) body = { ...body, model };
    }
    // A restricted text request whose model has no non-China host goes to the open fallback model,
    // still under the same restriction. Image, file and audio requests are never re-targeted.
    const regionFallback = restricted && generation && isTextOnlyRequest(body) ? restrictedFallbackModel() : undefined;
    const requested = typeof body.model === "string" ? body.model : undefined;
    const canFallBack = regionFallback !== undefined && requested !== undefined && requested !== regionFallback;
    if (canFallBack && regionBlocked(requested)) {
      console.warn(`[openrouter] region_fallback model=${requested} fallback=${regionFallback} reason=remembered`);
      return baseFetch(input, { ...init, body: JSON.stringify(withOpenRouterProviderPreferences(withFallbackModel(body, regionFallback), { ...policy!, speedBoost: false })) });
    }
    const routed = withOpenRouterProviderPreferences(body, policy);
    const response = routed === original ? await baseFetch(input, init) : await baseFetch(input, { ...init, body: JSON.stringify(routed) });
    if (canFallBack && await isNoAllowedProviderResponse(response)) {
      regionBlockedModels.set(requested, Date.now() + REGION_BLOCK_TTL_MS);
      console.warn(`[openrouter] region_fallback model=${requested} fallback=${regionFallback} status=404`);
      await response.body?.cancel().catch(() => undefined);
      return baseFetch(input, { ...init, body: JSON.stringify(withOpenRouterProviderPreferences(withFallbackModel(body, regionFallback), { ...policy!, speedBoost: false })) });
    }
    const base = typeof routed.model === "string" ? nitroBaseModel(routed.model) : undefined;
    if (response.status !== 404 || !base) return response;
    // Nitro routing (throughput sort, price ceiling, quantization filter) can leave
    // no endpoint, which OpenRouter answers with 404. Retry once on the base
    // model's normal route instead of failing the call.
    console.warn(`[openrouter] nitro_fallback model=${routed.model} base=${base} status=404`);
    await response.body?.cancel().catch(() => undefined);
    const fallback = withOpenRouterProviderPreferences({ ...original, model: base }, policy && { ...policy, speedBoost: false });
    return baseFetch(input, { ...init, body: JSON.stringify(fallback) });
  };
}

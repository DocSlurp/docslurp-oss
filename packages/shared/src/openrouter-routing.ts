/**
 * OpenRouter host routing: which upstream providers may serve a request, and
 * in what order. Applied to request bodies by `createOpenRouterRoutingFetch`.
 *
 * - Open-weight models served by many hosts (GLM, DeepSeek) are sorted by
 *   price, so OpenRouter tries the cheapest host first and keeps using it for
 *   later steps (the same host is also what makes prompt-cache reads hit).
 *   Hosts must serve at least FP8 weights: the cheapest listings are often
 *   FP4/NVFP4 or undisclosed quantizations.
 * - An organization can turn off China-based providers (`allowChinaProviders`).
 *   Those hosts are then on the request's `ignore` list for every model.
 */

/**
 * OpenRouter provider slugs for China-based companies: headquartered in China
 * per OpenRouter's provider list (Baidu, DeepSeek, Nex AGI, StreamLake,
 * Tencent, Xiaomi), or Chinese-owned and listed under an international entity
 * (Alibaba, MiniMax, Moonshot AI, SiliconFlow, StepFun, Z.AI). Checked
 * 2026-10-25 against https://openrouter.ai/api/v1/providers.
 */
export const CHINA_PROVIDER_SLUGS = [
  "alibaba", "baidu", "deepseek", "minimax", "moonshotai", "nex-agi",
  "siliconflow", "stepfun", "streamlake", "tencent", "xiaomi", "z-ai",
] as const;

/** Models routed to their cheapest host (by model id prefix). */
const PRICE_ROUTED_MODEL_PREFIXES = ["z-ai/glm-", "deepseek/deepseek-"] as const;

/** Weight precisions a price-routed host may serve; excludes FP4 variants and undisclosed quantizations. */
const PRICE_ROUTED_QUANTIZATIONS = ["fp8", "fp16", "bf16", "fp32"] as const;

export interface OpenRouterProviderPolicy {
  /** False when the organization turned off China-based providers. */
  allowChinaProviders: boolean;
}

/** Whether `model` is sent to its cheapest qualifying host first. */
export function isPriceRoutedModel(model: string): boolean {
  return PRICE_ROUTED_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

/** The `provider` preferences for one OpenRouter request, or undefined to leave routing to OpenRouter. */
export function openRouterProviderPreferences(model: string, policy?: OpenRouterProviderPolicy): Record<string, unknown> | undefined {
  const preferences: Record<string, unknown> = {};
  if (isPriceRoutedModel(model)) Object.assign(preferences, { sort: "price", quantizations: [...PRICE_ROUTED_QUANTIZATIONS], allow_fallbacks: true });
  if (policy && !policy.allowChinaProviders) preferences.ignore = [...CHINA_PROVIDER_SLUGS];
  return Object.keys(preferences).length ? preferences : undefined;
}

/**
 * A request body with routing preferences merged in. Preferences the caller
 * set itself win, except that the China restriction is always added to any
 * `ignore` list the caller supplied.
 */
export function withOpenRouterProviderPreferences<T extends Record<string, unknown>>(body: T, policy?: OpenRouterProviderPolicy): T {
  const model = typeof body.model === "string" ? body.model : "";
  const preferences = openRouterProviderPreferences(model, policy);
  if (!preferences) return body;
  const own = body.provider && typeof body.provider === "object" ? body.provider as Record<string, unknown> : {};
  const ignore = [...new Set([...(Array.isArray(own.ignore) ? own.ignore as string[] : []), ...((preferences.ignore as string[] | undefined) ?? [])])];
  return { ...body, provider: { ...preferences, ...own, ...(ignore.length ? { ignore } : {}) } };
}

type PolicyResolver = () => OpenRouterProviderPolicy | undefined | Promise<OpenRouterProviderPolicy | undefined>;
let policyResolver: PolicyResolver | undefined;

/**
 * Registers how the current organization's policy is found (the server reads
 * its request context, the worker its job scope). Without one, or outside any
 * organization, China-based providers stay allowed.
 */
export function setOpenRouterProviderPolicyResolver(resolver: PolicyResolver | undefined): void {
  policyResolver = resolver;
}

/** The current organization's provider policy, if a resolver knows it. */
export async function currentOpenRouterProviderPolicy(): Promise<OpenRouterProviderPolicy | undefined> {
  return policyResolver ? await policyResolver() : undefined;
}

/** Wraps an OpenRouter fetch so each JSON request carries the routing preferences for its model and organization. */
export function createOpenRouterRoutingFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body !== "string") return baseFetch(input, init);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return baseFetch(input, init);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return baseFetch(input, init);
    const routed = withOpenRouterProviderPreferences(body, await currentOpenRouterProviderPolicy());
    return routed === body ? baseFetch(input, init) : baseFetch(input, { ...init, body: JSON.stringify(routed) });
  };
}

import { chatModelPricePerToken } from "./chat-model-prices.js";

/** Provider charges are USD; the application ledger uses fractional USD cents. */
export interface ProviderTextUsage {
  inputTokens: number;
  outputTokens: number;
  costCents?: number;
  metadata?: Record<string, unknown>;
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function readProviderCharge(usage: unknown): Pick<ProviderTextUsage, "costCents" | "metadata"> {
  if (!usage || typeof usage !== "object") return {};
  const raw = usage as Record<string, unknown>;
  if (!finiteNonnegative(raw.cost)) return {};
  const details = raw.cost_details as Record<string, unknown> | undefined;
  const upstream = details?.upstream_inference_cost;
  // BYOK inference is billed separately from router credits, which can be zero.
  // For ordinary routing the upstream amount is already included in cost.
  if (raw.is_byok === true && !finiteNonnegative(upstream)) return {};
  const total = raw.cost + (raw.is_byok === true && finiteNonnegative(upstream) ? upstream : 0);
  return { costCents: total * 100, metadata: { costSource: "provider", providerCostUsd: total,
    routerCreditCostUsd: raw.cost, upstreamInferenceCostUsd: upstream, isByok: raw.is_byok === true, providerUsage: raw } };
}

/** The OpenAI adapter strips router-specific usage fields. Recover charges by generation ID. */
export async function resolveOpenRouterUsage(args: {
  apiKey: string;
  model: string;
  providerName?: string;
  generationId?: string;
  usage: { inputTokens?: number; outputTokens?: number; raw?: unknown };
}): Promise<ProviderTextUsage> {
  const base = { inputTokens: args.usage.inputTokens ?? 0, outputTokens: args.usage.outputTokens ?? 0 };
  const direct = readProviderCharge(args.usage.raw);
  if (direct.costCents !== undefined) return { ...base, ...direct, metadata: { ...direct.metadata, generationId: args.generationId ?? null, ...(args.providerName ? { providerName: args.providerName } : {}) } };
  if (args.generationId) {
    try {
      const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(args.generationId)}`, {
        headers: { Authorization: `Bearer ${args.apiKey}` }, signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const { data } = await response.json() as { data?: Record<string, unknown> };
        if (data && finiteNonnegative(data.total_cost)) {
          const charge = readProviderCharge({ cost: data.total_cost, is_byok: data.is_byok,
            cost_details: { upstream_inference_cost: data.upstream_inference_cost } });
          if (charge.costCents === undefined) throw new Error("Incomplete BYOK accounting");
          return {
            inputTokens: finiteNonnegative(data.native_tokens_prompt) ? data.native_tokens_prompt : base.inputTokens,
            outputTokens: finiteNonnegative(data.native_tokens_completion) ? data.native_tokens_completion : base.outputTokens,
            costCents: charge.costCents,
            metadata: { ...charge.metadata, generationId: args.generationId,
              providerName: data.provider_name, cachedTokens: data.native_tokens_cached, reasoningTokens: data.native_tokens_reasoning,
              upstreamInferenceCostUsd: data.upstream_inference_cost, isByok: data.is_byok },
          };
        }
      }
    } catch { /* Record explicit fallback provenance; accounting must not discard the answer. */ }
  }
  // No receipt: estimate from the verified price table, then the live listing.
  const verified = chatModelPricePerToken(args.model);
  const pricing = verified ?? await getModelPricing(args.model);
  return { ...base,
    ...(pricing ? { costCents: (base.inputTokens * pricing.input + base.outputTokens * pricing.output) * 100 } : {}),
    metadata: { costSource: "estimate", generationId: args.generationId ?? null,
      pricingSource: verified ? "model-prices" : pricing ? "openrouter-models" : "configured-fallback", ...(pricing ? { pricingUsdPerToken: pricing } : {}) },
  };
}

let catalog: { expiresAt: number; prices: Map<string, { input: number; output: number }> } | undefined;
let catalogRequest: Promise<void> | undefined;
async function getModelPricing(model: string) {
  if (!catalog || catalog.expiresAt < Date.now()) {
    catalogRequest ??= (async () => {
      try {
        const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(5000) });
        if (!response.ok) return;
        const payload = await response.json() as { data: Array<{ id: string; pricing: { prompt: string; completion: string } }> };
        const prices = new Map<string, { input: number; output: number }>();
        for (const model of payload.data) {
          const input = Number(model.pricing.prompt), output = Number(model.pricing.completion);
          if (finiteNonnegative(input) && finiteNonnegative(output)) prices.set(model.id, { input, output });
        }
        catalog = { expiresAt: Date.now() + 3600_000, prices };
      } catch { /* Leave unavailable pricing explicitly marked as a configured estimate. */ }
    })().finally(() => { catalogRequest = undefined; });
    await catalogRequest;
  }
  return catalog?.prices.get(model);
}

/** OpenRouter `reasoning` object: either thinking switched off or an explicit effort level. */
export type OpenRouterReasoning = { enabled: false } | { effort: "none" | "minimal" | "low" };

/**
 * Lowest reasoning each model accepts, verified live against OpenRouter on 2026-10-12 (one probe call per
 * variant; receipts in the E2 effort-probe run dir). Models absent here have no verified floor, so no
 * `reasoning` field is added for them. Never send `{ enabled: false }` or effort `none` to a model whose
 * floor is `minimal`: those endpoints reject it with HTTP 400 ("Reasoning is mandatory").
 */
export const OPENROUTER_LOWEST_REASONING: Readonly<Record<string, OpenRouterReasoning>> = {
  "deepseek/deepseek-v4.1-flash": { effort: "none" },
  // 2026-10-21: effort `none` returns zero reasoning tokens; `low` cost 6.4x per page and lowered math.
  "deepseek/deepseek-v4.1-flash-1017": { effort: "none" },
  "z-ai/glm-5.3-flash": { effort: "minimal" },
  "inclusionai/ling-3.0-flash-vl": { effort: "none" }, // EV1: HTTP 200 with zero reasoning tokens on 95+28 pages (2026-10-13)
  "anthropic/claude-haiku-5.5": { enabled: false },
  "anthropic/claude-sonnet-5.5": { effort: "minimal" },
  // 2026-10-20 probes: both `{ enabled: false }` and effort `none` return HTTP 200 with zero reasoning tokens.
  "nvidia/nemotron-3.5-super-vl": { enabled: false },
  // 2026-10-21 probes: reasons by default; `{ effort: "none" }` and `{ enabled: false }` both return 0 reasoning tokens.
  "xiaomi/mimo-v2.6-flash": { effort: "none" },
};

export function lowestOpenRouterReasoning(model: string | undefined): OpenRouterReasoning | undefined {
  return model ? OPENROUTER_LOWEST_REASONING[model] : undefined;
}

/** Request-body fragment for page-transcription calls: the model's verified lowest reasoning, or nothing. */
export function openRouterReasoningParams(model: string | undefined): { reasoning?: OpenRouterReasoning } {
  const reasoning = lowestOpenRouterReasoning(model);
  return reasoning ? { reasoning } : {};
}

/**
 * Reasoning policy for OpenRouter chat requests.
 * - `effort === "none"`: force each model's verified lowest setting (Claude/Qwen do not expose an effort named `none`;
 *   models with a verified higher floor get that floor instead).
 * - `effort` unset: apply the verified lowest setting only to models listed in OPENROUTER_LOWEST_REASONING whose request
 *   carries no explicit `reasoning` / `reasoning_effort`; every other model and every explicit choice is untouched.
 * - any other effort: pass through.
 */
export function createOpenRouterReasoningFetch(baseFetch: typeof fetch, effort?: string): typeof fetch {
  if (effort !== "none" && effort !== undefined) return baseFetch;
  const floorWhenUnset = effort === undefined;
  return async (input, init) => {
    if (typeof init?.body !== "string") return baseFetch(input, init);
    let body: Record<string, any>;
    try {
      body = JSON.parse(init.body);
    } catch {
      return baseFetch(input, init);
    }
    if (floorWhenUnset) {
      const floor = lowestOpenRouterReasoning(typeof body.model === "string" ? body.model : undefined);
      if (!floor || body.reasoning !== undefined || body.reasoning_effort !== undefined) return baseFetch(input, init);
      return baseFetch(input, { ...init, body: JSON.stringify({ ...body, reasoning: floor }) });
    }
    const floor = lowestOpenRouterReasoning(typeof body.model === "string" ? body.model : undefined);
    body.reasoning = { ...body.reasoning };
    delete body.reasoning.effort;
    delete body.reasoning.enabled;
    delete body.reasoning_effort;
    if (floor && "effort" in floor) body.reasoning.effort = floor.effort;
    else body.reasoning.enabled = false;
    return baseFetch(input, { ...init, body: JSON.stringify(body) });
  };
}

/** Observe the original response before SDK validation discards router cost fields. */
export function createOpenRouterUsageCapture(baseFetch: typeof fetch = fetch) {
  let captured: unknown;
  let providerName: string | undefined;
  let responseModel: string | undefined;
  const capture = (text: string) => {
    try {
      const value = JSON.parse(text) as { provider?: string; model?: string; usage?: unknown; response?: { provider?: string; model?: string; usage?: unknown } };
      const provider = value.response?.provider ?? value.provider;
      if (typeof provider === "string" && provider) providerName = provider;
      // The routed build (e.g. a dated id behind an alias), not the requested slug.
      const model = value.response?.model ?? value.model;
      if (typeof model === "string" && model) responseModel = model;
      const usage = value.response?.usage ?? value.usage;
      if (usage && typeof usage === "object") captured = usage;
    } catch { /* SSE comments, [DONE], and partial frames contain no usage. */ }
  };
  const trackedFetch: typeof fetch = async (input, init) => {
    captured = undefined;
    providerName = undefined;
    responseModel = undefined;
    const response = await baseFetch(input, init);
    if (!response.ok || !response.body) return response;
    const streaming = response.headers.get("content-type")?.includes("text/event-stream");
    const decoder = new TextDecoder();
    let buffer = "";
    const observe = (text: string) => {
      buffer += text;
      if (streaming) {
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (line.startsWith("data:")) capture(line.slice(5).trim());
        }
      }
      // Accounting must never retain unbounded generated content.
      if (buffer.length > 1_048_576) buffer = "";
    };
    return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { observe(decoder.decode(chunk, { stream: true })); controller.enqueue(chunk); },
      flush() { observe(decoder.decode()); if (streaming && buffer.startsWith("data:")) capture(buffer.slice(5).trim()); else if (!streaming) capture(buffer); },
    })), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return { fetch: trackedFetch, usage: () => captured, providerName: () => providerName, responseModel: () => responseModel };
}

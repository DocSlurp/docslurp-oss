import { nitroBaseModel, speedBoostMaxPrice } from "./project-chat-models.js";
import { withServedProviderRegion } from "./provider-regions.js";
import { chatModelPricePerToken } from "./chat-model-prices.js";
import { liveModelPrice, refreshStaleLiveModelPrices } from "./live-model-prices.js";

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
export async function resolveOpenRouterUsage(args: Parameters<typeof resolveOpenRouterUsageInner>[0]): Promise<ProviderTextUsage> {
  const usage = await resolveOpenRouterUsageInner(args);
  return { ...usage, metadata: withServedProviderRegion(usage.metadata, usage.metadata?.providerName ?? args.providerName) };
}

async function resolveOpenRouterUsageInner(args: {
  apiKey: string;
  model: string;
  providerName?: string;
  generationId?: string;
  usage: { inputTokens?: number; outputTokens?: number; raw?: unknown };
  /** Delays before each generation-receipt lookup (default [0], one lookup). */
  receiptRetryDelaysMs?: readonly number[];
}): Promise<ProviderTextUsage> {
  const base = { inputTokens: args.usage.inputTokens ?? 0, outputTokens: args.usage.outputTokens ?? 0 };
  const direct = readProviderCharge(args.usage.raw);
  if (direct.costCents !== undefined) return { ...base, ...direct, metadata: { ...direct.metadata, generationId: args.generationId ?? null, ...(args.providerName ? { providerName: args.providerName } : {}) } };
  if (args.generationId) {
    // A receipt is often not queryable for a moment after the response ends. Background callers
    // pass a retry delay (e.g. [0, 1_500]); user-facing paths look once.
    for (const delayMs of args.receiptRetryDelaysMs ?? [0]) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const receipt = await fetchGenerationReceipt(args.apiKey, args.generationId, base).catch(() => null);
      if (receipt === "incomplete") continue;
      if (receipt) {
        return { ...receipt, metadata: { ...receipt.metadata, ...(delayMs > 0 ? { receiptRetried: true } : {}) } };
      }
    }
  }
  // Speed boost picks any host under its price ceiling, so a base-model listing cannot price this call.
  // Preserve tokens at the ceiling, marked as an estimate. This is NOT a held budget reserve:
  // operators must reconcile missing receipts manually; no automatic reconciliation exists.
  const nitroBase = nitroBaseModel(args.model);
  if (nitroBase) {
    const ceiling = speedBoostMaxPrice(nitroBase);
    return { ...base,
      costCents: (base.inputTokens * ceiling.prompt + base.outputTokens * ceiling.completion) / 10_000,
      metadata: { costSource: "estimate", accountingStatus: "receipt-missing", reconciliationRequired: true,
        pricingSource: "nitro-endpoint-ceiling-estimate", generationId: args.generationId ?? null,
        ...(args.providerName ? { providerName: args.providerName } : {}) },
    };
  }
  // No receipt: estimate from the live list price, then the hardcoded verified
  // table. A missing or stale snapshot is refreshed in the background, never
  // awaited on this (often user-facing) path.
  refreshStaleLiveModelPrices();
  const reference = chatModelPricePerToken(args.model);
  const live = liveModelPrice(args.model, { promptTokens: base.inputTokens, reference });
  const verified = live ? undefined : reference;
  const pricing = live ? { input: live.input, output: live.output } : verified;
  return { ...base,
    ...(pricing ? { costCents: (base.inputTokens * pricing.input + base.outputTokens * pricing.output) * 100 } : {}),
    metadata: { costSource: pricing ? "estimate" : "unknown", reconciliationRequired: true, accountingStatus: "receipt-missing", generationId: args.generationId ?? null,
      pricingSource: live ? "openrouter-live" : verified ? "model-prices" : "configured-fallback",
      ...(live?.override ? { pricingOverride: live.override } : {}), ...(pricing ? { pricingUsdPerToken: pricing } : {}) },
  };
}

/** The generation receipt, null when not (yet) available, "incomplete" when BYOK accounting lacks the upstream cost. */
async function fetchGenerationReceipt(apiKey: string, generationId: string, base: { inputTokens: number; outputTokens: number }): Promise<ProviderTextUsage | "incomplete" | null> {
  const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;
  const { data } = await response.json() as { data?: Record<string, unknown> };
  if (!data || !finiteNonnegative(data.total_cost)) return null;
  const charge = readProviderCharge({ cost: data.total_cost, is_byok: data.is_byok,
    cost_details: { upstream_inference_cost: data.upstream_inference_cost } });
  if (charge.costCents === undefined) return "incomplete";
  return {
    inputTokens: finiteNonnegative(data.native_tokens_prompt) ? data.native_tokens_prompt : base.inputTokens,
    outputTokens: finiteNonnegative(data.native_tokens_completion) ? data.native_tokens_completion : base.outputTokens,
    costCents: charge.costCents,
    metadata: { ...charge.metadata, generationId,
      providerName: data.provider_name, cachedTokens: data.native_tokens_cached, reasoningTokens: data.native_tokens_reasoning,
      upstreamInferenceCostUsd: data.upstream_inference_cost, isByok: data.is_byok },
  };
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
  // 2026-11-10 chat probes (one-sentence answer): effort `none` returns HTTP 200 with zero reasoning tokens; the
  // provider default spent 47 reasoning tokens and took 0.41 s against 0.53 s cold, 1.18 s against 0.56 s p50 over
  // 8 RAG calls. Vision profiles set their own reasoning and are unaffected.
  "deepseek/deepseek-v4.1-flash-1017": { effort: "none" },
  "openai/gpt-6-luna": { effort: "none" },
  "xiaomi/mimo-v2.6-flash": { effort: "none" },
  // 2026-11-10: `{ enabled: false }` and effort `none` return HTTP 400 "Reasoning is mandatory"; `minimal` returns
  // HTTP 200 with zero reasoning tokens on a short answer.
  "openai/gpt-6.1-sol": { effort: "minimal" },
  "z-ai/glm-5.3-flash": { effort: "minimal" },
  "inclusionai/ling-3.0-flash-vl": { effort: "none" }, // EV1: HTTP 200 with zero reasoning tokens on 95+28 pages (2026-10-13)
  "anthropic/claude-haiku-5.5": { enabled: false },
  "anthropic/claude-sonnet-5.5": { effort: "minimal" },
  // 2026-10-20 probes: both `{ enabled: false }` and effort `none` return HTTP 200 with zero reasoning tokens.
  "nvidia/nemotron-3.5-super-vl": { enabled: false },
  // 2026-11-02 probes: `{ enabled: false }` returns HTTP 200 with zero reasoning tokens. Unset, the default
  // pipeline model spends a 1,600-token graph-extraction budget on reasoning and returns no answer.
  "qwen/qwen3.5-flash-02-23": { enabled: false },
  "qwen/qwen3.6-flash": { enabled: false },
  // 2026-11-06 probes on non-China hosts: `{ enabled: false }` and effort `none` return HTTP 400 "Reasoning is
  // mandatory"; `minimal` returns HTTP 200 with ~145 reasoning tokens (unset: ~750). The restricted fallback model.
  "openai/gpt-oss-120b": { effort: "minimal" },
};

export function lowestOpenRouterReasoning(model: string | undefined): OpenRouterReasoning | undefined {
  return model ? OPENROUTER_LOWEST_REASONING[nitroBaseModel(model) ?? model] : undefined;
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
    const original = init.body;
    body.reasoning = { ...body.reasoning };
    delete body.reasoning.effort;
    delete body.reasoning.enabled;
    delete body.reasoning_effort;
    if (floor && "effort" in floor) body.reasoning.effort = floor.effort;
    else body.reasoning.enabled = false;
    const response = await baseFetch(input, { ...init, body: JSON.stringify(body) });
    if (floor || response.status !== 400) return response;
    // A model without a verified floor may require reasoning; send the request as the caller built it.
    const detail = await response.clone().text().catch(() => "");
    if (!/reasoning is mandatory/i.test(detail)) return response;
    console.warn(`[openrouter] reasoning_floor_rejected model=${String(body.model)}; retrying with the provider default`);
    await response.body?.cancel().catch(() => undefined);
    return baseFetch(input, { ...init, body: original });
  };
}

/**
 * The model to price and record a text call as: the model actually sent when a
 * restricted fallback re-targeted it, else the requested one. A speed-boost
 * (`:nitro`) variant of the requested model is not a different model here, so
 * its pricing is unchanged. Read `sentModel()` from a capture inside the routing fetch.
 */
export function servedTextModel(requested: string, sent: string | undefined): { model: string; regionFallback: boolean } {
  if (!sent) return { model: requested, regionFallback: false };
  const base = (model: string) => nitroBaseModel(model) ?? model;
  return base(sent) === base(requested) ? { model: requested, regionFallback: false } : { model: sent, regionFallback: true };
}

/** Usage metadata marking a call the restricted fallback re-targeted: the model that ran and the one requested. */
export function regionFallbackUsageMetadata(requested: string, served: { model: string; regionFallback: boolean }): Record<string, unknown> {
  return served.regionFallback ? { routedModel: served.model, regionFallback: true, requestedModel: requested } : {};
}

/**
 * A usage input for a call the restricted fallback re-targeted (metadata
 * `regionFallback` with `routedModel`), relabelled as the model that ran; the
 * caller's model stays in metadata as `requestedModel`. Other inputs pass through.
 */
export function withServedUsageModel<T extends { model: string; metadata?: Record<string, unknown> | null }>(input: T): T {
  const metadata = input.metadata ?? undefined;
  if (metadata?.regionFallback !== true || typeof metadata.routedModel !== "string" || metadata.routedModel === input.model) return input;
  return { ...input, model: metadata.routedModel, metadata: { ...metadata, requestedModel: metadata.requestedModel ?? input.model } };
}

/** Observe the original response before SDK validation discards router cost fields. */
export function createOpenRouterUsageCapture(baseFetch: typeof fetch = fetch) {
  let captured: unknown;
  let providerName: string | undefined;
  let responseModel: string | undefined;
  let sentModel: string | undefined;
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
    sentModel = undefined;
    // The model this request actually asked for, after routing (a restricted fallback re-targets it).
    if (typeof init?.body === "string") {
      try { const model = (JSON.parse(init.body) as { model?: unknown }).model; if (typeof model === "string") sentModel = model; } catch { /* not JSON */ }
    }
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
  return { fetch: trackedFetch, usage: () => captured, providerName: () => providerName, responseModel: () => responseModel, sentModel: () => sentModel };
}

/**
 * The provider charge summed over every response sent through `fetch`, for
 * calls that may issue several requests (AI SDK `embedMany`). Read `charge()`
 * after the call resolves. Returns `{}` (no receipt, so callers estimate) when
 * no request was sent or any response lacked a charge, never a partial sum.
 */
export function createOpenRouterChargeTotal(baseFetch: typeof fetch = fetch) {
  const captures: Array<ReturnType<typeof createOpenRouterUsageCapture>> = [];
  const trackedFetch: typeof fetch = (input, init) => {
    const capture = createOpenRouterUsageCapture(baseFetch);
    captures.push(capture);
    return capture.fetch(input, init);
  };
  const charge = (): Pick<ProviderTextUsage, "costCents" | "metadata"> => {
    if (captures.length === 0) return {};
    let costCents = 0;
    for (const capture of captures) {
      const one = readProviderCharge(capture.usage());
      if (one.costCents === undefined) return {};
      costCents += one.costCents;
    }
    return { costCents, metadata: { costSource: "provider", providerCostUsd: costCents / 100, providerResponses: captures.length } };
  };
  return { fetch: trackedFetch, charge };
}

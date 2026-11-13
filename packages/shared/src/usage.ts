import { liveModelPrice } from "./live-model-prices.js";
import { z } from "zod";
import { ANTHROPIC_MODELS } from "./anthropic-models.js";
import { DEFAULT_PIPELINE_TEXT_MODEL } from "./pipeline.js";

export const usageEventSchema = z.object({
  provider: z.string(),
  model: z.string(),
  metric: z.string(),
  amount: z.number().default(0),
  unit: z.string().default("token"),
  costCents: z.number().default(0),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UsageEvent = z.infer<typeof usageEventSchema>;

export interface AiUsageLedgerInput {
  provider: string;
  model: string;
  metric: string;
  /** Every prompt token, cached or not (OpenAI/OpenRouter `prompt_tokens`; for Anthropic's native API add its cache reads and writes). */
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Of `inputTokens`, those served from the provider's prompt cache. Defaults to `metadata.cachedInputTokens`. */
  cachedInputTokens?: number | null;
  /** Of `inputTokens`, those written to the provider's prompt cache. Defaults to `metadata.cacheWriteInputTokens`. */
  cacheWriteInputTokens?: number | null;
  amount?: number;
  unit?: string;
  costCents?: number;
  metadata?: Record<string, unknown> | null;
}

export interface AiUsageLedgerEvent {
  provider: string;
  model: string;
  metric: string;
  amount: number;
  unit: string;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  metadata: Record<string, unknown>;
}

export interface AiUsagePricing {
  costPer1kInputTokens: number;
  costPer1kOutputTokens: number;
  /** Rate for prompt tokens served from the prompt cache. Unset: cached tokens are priced as ordinary input. */
  costPer1kCacheReadInputTokens?: number;
  /** Rate for prompt tokens written to the prompt cache. Unset: priced as ordinary input. */
  costPer1kCacheWriteInputTokens?: number;
  /** Rates for requests whose prompt exceeds the threshold (e.g. Claude Haiku 5.5 above 100K). */
  longContext?: {
    thresholdInputTokens: number;
    costPer1kInputTokens: number;
    costPer1kOutputTokens: number;
    costPer1kCacheReadInputTokens?: number;
    costPer1kCacheWriteInputTokens?: number;
  };
}

export interface AiUsagePricingCatalogEntry extends AiUsagePricing {
  provider?: string;
  model: string;
}

export interface AiUsagePricingOptions {
  fallback?: AiUsagePricing;
  catalog?: AiUsagePricingCatalogEntry[];
}

// Qwen 3.5 Flash 02-23 via OpenRouter: $0.065/$0.26 per MTok, verified 2026-10-25.
export const defaultAiUsagePricing: AiUsagePricing = {
  costPer1kInputTokens: 0.0065,
  costPer1kOutputTokens: 0.026,
};

export const defaultAiUsagePricingCatalog: AiUsagePricingCatalogEntry[] = [
  {
    provider: "deepinfra", model: "BAAI/bge-m3",
    // DeepInfra official route: $0.010/M input tokens, checked 2026-10-25.
    costPer1kInputTokens: 0.001, costPer1kOutputTokens: 0,
  },
  {
    provider: "openrouter",
    model: DEFAULT_PIPELINE_TEXT_MODEL,
    ...defaultAiUsagePricing,
  },
  // Supported Claude models, native and OpenRouter ids (cents per 1K = USD per MTok / 10).
  ...ANTHROPIC_MODELS.flatMap((model) => {
    const pricing: AiUsagePricing = {
      costPer1kInputTokens: model.inputUsdPerMTok / 10,
      costPer1kOutputTokens: model.outputUsdPerMTok / 10,
      costPer1kCacheReadInputTokens: model.cacheReadUsdPerMTok / 10,
      costPer1kCacheWriteInputTokens: model.cacheWriteUsdPerMTok / 10,
      ...(model.longContext
        ? {
            longContext: {
              thresholdInputTokens: model.longContext.thresholdInputTokens,
              costPer1kInputTokens: model.longContext.inputUsdPerMTok / 10,
              costPer1kOutputTokens: model.longContext.outputUsdPerMTok / 10,
              costPer1kCacheReadInputTokens: model.longContext.cacheReadUsdPerMTok / 10,
              costPer1kCacheWriteInputTokens: model.longContext.cacheWriteUsdPerMTok / 10,
            },
          }
        : {}),
    };
    return [
      { provider: "anthropic", model: model.id, ...pricing },
      { provider: "openrouter", model: model.openRouterId, ...pricing },
    ];
  }),
  // Official OpenRouter embedding catalog, verified 2026-10-25: $0.004/$0.03 per million input tokens.
  { provider: "openrouter", model: "perplexity/pplx-embed-v1-0.6b", costPer1kInputTokens: 0.0004, costPer1kOutputTokens: 0 },
  { provider: "perplexity", model: "pplx-embed-v1-0.6b", costPer1kInputTokens: 0.0004, costPer1kOutputTokens: 0 },
  { provider: "perplexity", model: "pplx-embed-v1-4b", costPer1kInputTokens: 0.003, costPer1kOutputTokens: 0 },
  { provider: "openrouter", model: "perplexity/pplx-embed-v1-4b", costPer1kInputTokens: 0.003, costPer1kOutputTokens: 0 },
  // Deprecated models: kept only to reprice historical usage events.
  {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    // $1 / $5 per million tokens (verified 2026-10-09, platform.claude.com pricing).
    costPer1kInputTokens: 0.1,
    costPer1kOutputTokens: 0.5,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    // $3 / $15 per million tokens (verified 2026-10-09; retired on the first-party API).
    costPer1kInputTokens: 0.3,
    costPer1kOutputTokens: 1.5,
  },
  {
    provider: "openai",
    model: "text-embedding-3-small",
    // $0.02 / million input tokens = 0.002 cents / thousand (verified 2026-09-30).
    costPer1kInputTokens: 0.002,
    costPer1kOutputTokens: 0,
  },
];

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * Prompt-cache token counts of an event: `cachedInputTokens` (served from the cache) and `cacheWriteInputTokens`
 * (written to it), both included in `inputTokens`. Read from `metadata`, where the ledger stores them; zero when absent.
 */
export function aiUsageCacheTokens(event: { inputTokens?: number | null; metadata?: Record<string, unknown> | null }): { cachedInputTokens: number; cacheWriteInputTokens: number } {
  const input = Math.max(0, event.inputTokens ?? 0);
  const cached = Math.min(input, tokenCount(event.metadata?.cachedInputTokens) ?? 0);
  const written = Math.min(input - cached, tokenCount(event.metadata?.cacheWriteInputTokens) ?? 0);
  return { cachedInputTokens: cached, cacheWriteInputTokens: written };
}

export function buildAiUsageLedgerEvent(
  input: AiUsageLedgerInput,
): AiUsageLedgerEvent {
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  const metadata = { ...(input.metadata ?? {}) };
  const cached = tokenCount(input.cachedInputTokens ?? metadata.cachedInputTokens);
  const written = tokenCount(input.cacheWriteInputTokens ?? metadata.cacheWriteInputTokens);
  delete metadata.cachedInputTokens;
  delete metadata.cacheWriteInputTokens;
  // Persisted in metadata (usage_events has no cache columns), clamped so they never exceed the prompt.
  const cache = aiUsageCacheTokens({ inputTokens, metadata: { cachedInputTokens: cached, cacheWriteInputTokens: written } });
  if (cache.cachedInputTokens > 0) metadata.cachedInputTokens = cache.cachedInputTokens;
  if (cache.cacheWriteInputTokens > 0) metadata.cacheWriteInputTokens = cache.cacheWriteInputTokens;

  return {
    provider: input.provider,
    model: input.model,
    metric: input.metric,
    amount: input.amount ?? inputTokens + outputTokens,
    unit: input.unit ?? "token",
    costCents: input.costCents ?? 0,
    inputTokens,
    outputTokens,
    metadata,
  };
}

export function buildPricedAiUsageLedgerEvent(
  input: AiUsageLedgerInput,
  options: AiUsagePricingOptions = {},
): AiUsageLedgerEvent {
  const event = buildAiUsageLedgerEvent(input);
  if (input.costCents !== undefined) {
    return event;
  }

  const { pricing, pricingSource } = resolveAiUsagePricingWithSource(event, options);
  return {
    ...event,
    costCents: calculateAiUsageCostCents({ inputTokens: event.inputTokens, outputTokens: event.outputTokens, ...aiUsageCacheTokens(event), ...pricing }),
    metadata: { ...event.metadata, costSource: "estimate", pricingSource, pricing },
  };
}

/**
 * Whether an event is worth persisting: tokens, a customer charge, or provider
 * cost (AI events bill 0 credits but keep `metadata.providerCostCents`, e.g.
 * duration-priced transcription with no token counts).
 */
export function hasAiUsageLedgerTokens(event: AiUsageLedgerEvent): boolean {
  return event.inputTokens !== 0 || event.outputTokens !== 0 || event.costCents > 0
    || Number(event.metadata?.providerCostCents ?? 0) > 0;
}

/**
 * Cost in cents. `inputTokens` counts every prompt token; `cachedInputTokens` and `cacheWriteInputTokens` are the
 * parts of it read from and written to the prompt cache, priced at the cache rates when the pricing lists them.
 * Unknown rates err high: a read at the input rate (providers charge less), a write at 1.25x the input rate (the
 * 5-minute write premium Anthropic and OpenAI list).
 */
/** Write premium assumed when a model's cache-write rate is unknown (5-minute TTL; the 1-hour TTL is never used). */
export const CACHE_WRITE_FALLBACK_MULTIPLIER = 1.25;

export function calculateAiUsageCostCents(
  input: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedInputTokens?: number | null;
    cacheWriteInputTokens?: number | null;
  } & AiUsagePricing,
): number {
  const inputTokens = Math.max(0, input.inputTokens ?? 0);
  const outputTokens = Math.max(0, input.outputTokens ?? 0);
  const cachedTokens = Math.min(inputTokens, Math.max(0, input.cachedInputTokens ?? 0));
  const writeTokens = Math.min(inputTokens - cachedTokens, Math.max(0, input.cacheWriteInputTokens ?? 0));
  const rates =
    input.longContext && inputTokens > input.longContext.thresholdInputTokens
      ? input.longContext
      : input;
  const finiteRate = (value: number | undefined, fallback: number) => value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback;
  const inputRate = finiteRate(rates.costPer1kInputTokens, 0);
  const outputRate = finiteRate(rates.costPer1kOutputTokens, 0);
  const cacheReadRate = finiteRate(rates.costPer1kCacheReadInputTokens, inputRate);
  const cacheWriteRate = finiteRate(rates.costPer1kCacheWriteInputTokens, inputRate * CACHE_WRITE_FALLBACK_MULTIPLIER);
  const rawCost =
    ((inputTokens - cachedTokens - writeTokens) / 1000) * inputRate +
    (cachedTokens / 1000) * cacheReadRate +
    (writeTokens / 1000) * cacheWriteRate +
    (outputTokens / 1000) * outputRate;

  return rawCost > 0 ? rawCost : 0;
}

export function estimateAiUsageCostCents(
  input: {
    provider?: string | null;
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedInputTokens?: number | null;
    cacheWriteInputTokens?: number | null;
  },
  options: AiUsagePricingOptions = {},
): number {
  return calculateAiUsageCostCents({
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cachedInputTokens: input.cachedInputTokens,
    cacheWriteInputTokens: input.cacheWriteInputTokens,
    ...resolveAiUsagePricingWithSource(input, options).pricing,
  });
}

/** Where an estimated price came from: the live OpenRouter listing, a hardcoded catalog entry, or the configured fallback rate. */
export type AiUsagePricingSource = "openrouter-live" | "catalog" | "configured-fallback";

/**
 * Price for an event without a provider receipt. OpenRouter models use the
 * live list price when one is loaded (live-model-prices.ts), applying its
 * long-prompt or time-of-day override; otherwise, and for every other
 * provider, the hardcoded catalog, then the fallback rate. An explicit
 * `options.catalog` (tests, operator overrides) skips the live listing.
 */
export function resolveAiUsagePricingWithSource(
  input: { provider?: string | null; model?: string | null; inputTokens?: number | null },
  options: AiUsagePricingOptions = {},
): { pricing: AiUsagePricing; pricingSource: AiUsagePricingSource } {
  const matched = findAiUsageCatalogEntry(input, options.catalog ?? defaultAiUsagePricingCatalog);
  if (!options.catalog && normalizeAiUsageCatalogKey(input.provider) === "openrouter") {
    // A verified catalog rate (cents per 1K) bounds the live listing, in USD per token.
    const reference = matched ? {
      input: matched.costPer1kInputTokens / 100_000,
      output: matched.costPer1kOutputTokens / 100_000,
      ...(matched.costPer1kCacheReadInputTokens !== undefined ? { cacheRead: matched.costPer1kCacheReadInputTokens / 100_000 } : {}),
      ...(matched.costPer1kCacheWriteInputTokens !== undefined ? { cacheWrite: matched.costPer1kCacheWriteInputTokens / 100_000 } : {}),
    } : undefined;
    const live = liveModelPrice(input.model, { promptTokens: input.inputTokens ?? undefined, reference });
    if (live) {
      // USD per token to cents per 1K tokens.
      return { pricing: { costPer1kInputTokens: live.input * 100_000, costPer1kOutputTokens: live.output * 100_000,
        ...(live.cacheRead !== undefined ? { costPer1kCacheReadInputTokens: live.cacheRead * 100_000 } : {}),
        ...(live.cacheWrite !== undefined ? { costPer1kCacheWriteInputTokens: live.cacheWrite * 100_000 } : {}) }, pricingSource: "openrouter-live" };
    }
  }
  return { pricing: resolveAiUsagePricing(input, options), pricingSource: matched ? "catalog" : "configured-fallback" };
}

function findAiUsageCatalogEntry(
  input: { provider?: string | null; model?: string | null },
  catalog: AiUsagePricingCatalogEntry[],
): AiUsagePricingCatalogEntry | undefined {
  const provider = normalizeAiUsageCatalogKey(input.provider);
  const model = normalizeAiUsageCatalogKey(input.model);
  return catalog.find((entry) => normalizeAiUsageCatalogKey(entry.model) === model
      && (!entry.provider || !provider || normalizeAiUsageCatalogKey(entry.provider) === provider))
    ?? catalog.find((entry) => normalizeAiUsageCatalogKey(entry.model) === model);
}

export function resolveAiUsagePricing(
  input: {
    provider?: string | null;
    model?: string | null;
  },
  options: AiUsagePricingOptions = {},
): AiUsagePricing {
  const match = findAiUsageCatalogEntry(input, options.catalog ?? defaultAiUsagePricingCatalog);

  const pricing = match ?? options.fallback ?? defaultAiUsagePricing;
  return {
    costPer1kInputTokens: pricing.costPer1kInputTokens,
    costPer1kOutputTokens: pricing.costPer1kOutputTokens,
    ...(pricing.costPer1kCacheReadInputTokens !== undefined ? { costPer1kCacheReadInputTokens: pricing.costPer1kCacheReadInputTokens } : {}),
    ...(pricing.costPer1kCacheWriteInputTokens !== undefined ? { costPer1kCacheWriteInputTokens: pricing.costPer1kCacheWriteInputTokens } : {}),
    ...(pricing.longContext ? { longContext: pricing.longContext } : {}),
  };
}

function normalizeAiUsageCatalogKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function formatAiUsageConsoleLog(
  event: AiUsageLedgerEvent,
  options: { includeOutputTokens?: boolean } = {},
): string {
  const output =
    options.includeOutputTokens === false
      ? ""
      : ` output_tokens=${event.outputTokens}`;
  // Cache fields only when the provider reported them, so existing parsers of the line keep working.
  const cache = aiUsageCacheTokens(event);
  const cached = cache.cachedInputTokens > 0 ? ` cached_input_tokens=${cache.cachedInputTokens}` : "";
  const written = cache.cacheWriteInputTokens > 0 ? ` cache_write_input_tokens=${cache.cacheWriteInputTokens}` : "";
  return `[ai-usage] ${event.metric} model=${event.model} input_tokens=${event.inputTokens}${output}${cached}${written}`;
}

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
  inputTokens?: number | null;
  outputTokens?: number | null;
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
  /** Rates for requests whose prompt exceeds the threshold (e.g. Claude Haiku 5.5 above 100K). */
  longContext?: {
    thresholdInputTokens: number;
    costPer1kInputTokens: number;
    costPer1kOutputTokens: number;
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

export const defaultAiUsagePricing: AiUsagePricing = {
  costPer1kInputTokens: 0.01,
  costPer1kOutputTokens: 0.03,
};

export const defaultAiUsagePricingCatalog: AiUsagePricingCatalogEntry[] = [
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
      ...(model.longContext
        ? {
            longContext: {
              thresholdInputTokens: model.longContext.thresholdInputTokens,
              costPer1kInputTokens: model.longContext.inputUsdPerMTok / 10,
              costPer1kOutputTokens: model.longContext.outputUsdPerMTok / 10,
            },
          }
        : {}),
    };
    return [
      { provider: "anthropic", model: model.id, ...pricing },
      { provider: "openrouter", model: model.openRouterId, ...pricing },
    ];
  }),
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

export function buildAiUsageLedgerEvent(
  input: AiUsageLedgerInput,
): AiUsageLedgerEvent {
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;

  return {
    provider: input.provider,
    model: input.model,
    metric: input.metric,
    amount: input.amount ?? inputTokens + outputTokens,
    unit: input.unit ?? "token",
    costCents: input.costCents ?? 0,
    inputTokens,
    outputTokens,
    metadata: input.metadata ?? {},
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

  return {
    ...event,
    costCents: estimateAiUsageCostCents(event, options),
    metadata: { ...event.metadata, costSource: "estimate", pricing: resolveAiUsagePricing(event, options) },
  };
}

export function hasAiUsageLedgerTokens(event: AiUsageLedgerEvent): boolean {
  return event.inputTokens !== 0 || event.outputTokens !== 0 || event.costCents > 0;
}

export function calculateAiUsageCostCents(
  input: {
    inputTokens?: number | null;
    outputTokens?: number | null;
  } & AiUsagePricing,
): number {
  const inputTokens = Math.max(0, input.inputTokens ?? 0);
  const outputTokens = Math.max(0, input.outputTokens ?? 0);
  const rates =
    input.longContext && inputTokens > input.longContext.thresholdInputTokens
      ? input.longContext
      : input;
  const inputRate = Number.isFinite(rates.costPer1kInputTokens)
    ? Math.max(0, rates.costPer1kInputTokens)
    : 0;
  const outputRate = Number.isFinite(rates.costPer1kOutputTokens)
    ? Math.max(0, rates.costPer1kOutputTokens)
    : 0;
  const rawCost =
    (inputTokens / 1000) * inputRate +
    (outputTokens / 1000) * outputRate;

  return rawCost > 0 ? rawCost : 0;
}

export function estimateAiUsageCostCents(
  input: {
    provider?: string | null;
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
  },
  options: AiUsagePricingOptions = {},
): number {
  return calculateAiUsageCostCents({
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    ...resolveAiUsagePricing(input, options),
  });
}

export function resolveAiUsagePricing(
  input: {
    provider?: string | null;
    model?: string | null;
  },
  options: AiUsagePricingOptions = {},
): AiUsagePricing {
  const provider = normalizeAiUsageCatalogKey(input.provider);
  const model = normalizeAiUsageCatalogKey(input.model);
  const catalog = options.catalog ?? defaultAiUsagePricingCatalog;
  const match =
    catalog.find(
      (entry) =>
        normalizeAiUsageCatalogKey(entry.model) === model &&
        (!entry.provider ||
          !provider ||
          normalizeAiUsageCatalogKey(entry.provider) === provider),
    ) ??
    catalog.find(
      (entry) => normalizeAiUsageCatalogKey(entry.model) === model,
    );

  const pricing = match ?? options.fallback ?? defaultAiUsagePricing;
  return {
    costPer1kInputTokens: pricing.costPer1kInputTokens,
    costPer1kOutputTokens: pricing.costPer1kOutputTokens,
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
  return `[ai-usage] ${event.metric} model=${event.model} input_tokens=${event.inputTokens}${output}`;
}

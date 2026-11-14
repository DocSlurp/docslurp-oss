import { afterEach, describe, expect, it } from "vitest";
import { liveModelPrice, parseOpenRouterCatalog, setLiveModelPricesForTests } from "../live-model-prices.js";
import { readPromptCacheTokens, resolveOpenRouterUsage } from "../openrouter-usage.js";
import {
  aiUsageCacheTokens,
  buildAiUsageLedgerEvent,
  buildPricedAiUsageLedgerEvent,
  calculateAiUsageCostCents,
  estimateAiUsageCostCents,
  formatAiUsageConsoleLog,
} from "../usage.js";

afterEach(() => setLiveModelPricesForTests(null));

// Listed 2026-11-13 for anthropic/claude-haiku-5.5 and openai/gpt-6-luna alike.
const LISTING = { data: [{ id: "vendor/cached", pricing: {
  prompt: "0.0000001", completion: "0.0000005", input_cache_read: "0.00000001", input_cache_write: "0.000000125",
  overrides: [{ min_prompt_tokens: 100000, prompt: "0.0000005", completion: "0.0000025", input_cache_read: "0.00000005" }],
} }] };

describe("prompt-cache token accounting", () => {
  it("reads cache counts from every usage shape OpenRouter and Anthropic return", () => {
    expect(readPromptCacheTokens({ prompt_tokens: 3000, prompt_tokens_details: { cached_tokens: 2048, cache_write_tokens: 0 } }))
      .toEqual({ cachedInputTokens: 2048 });
    expect(readPromptCacheTokens({ prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1900 } })).toEqual({ cacheWriteInputTokens: 1900 });
    expect(readPromptCacheTokens({ input_tokens_details: { cached_tokens: 1024 } })).toEqual({ cachedInputTokens: 1024 });
    expect(readPromptCacheTokens({ cache_read_input_tokens: 500, cache_creation_input_tokens: 700 })).toEqual({ cachedInputTokens: 500, cacheWriteInputTokens: 700 });
    expect(readPromptCacheTokens({ prompt_tokens_details: { cached_tokens: -5 } })).toEqual({});
    expect(readPromptCacheTokens(null)).toEqual({});
  });

  it("stores cache counts in metadata, clamped to the prompt", () => {
    const event = buildAiUsageLedgerEvent({ provider: "openrouter", model: "m", metric: "chat", inputTokens: 1000, outputTokens: 10,
      cachedInputTokens: 900, cacheWriteInputTokens: 500 });
    expect(event.metadata).toEqual({ cachedInputTokens: 900, cacheWriteInputTokens: 100 });
    expect(aiUsageCacheTokens(event)).toEqual({ cachedInputTokens: 900, cacheWriteInputTokens: 100 });
    // Metadata from a provider receipt is honoured the same way, and garbage is dropped.
    expect(buildAiUsageLedgerEvent({ provider: "p", model: "m", metric: "x", inputTokens: 10, metadata: { cachedInputTokens: 4, cacheWriteInputTokens: "x" } }).metadata)
      .toEqual({ cachedInputTokens: 4 });
  });

  it("prices cached reads and writes at their own rates, and at the input rate when unknown", () => {
    const rates = { costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.05, costPer1kCacheReadInputTokens: 0.001, costPer1kCacheWriteInputTokens: 0.0125 };
    // 1,000 uncached + 2,000 read + 1,000 written + 100 output.
    expect(calculateAiUsageCostCents({ inputTokens: 4000, cachedInputTokens: 2000, cacheWriteInputTokens: 1000, outputTokens: 100, ...rates }))
      .toBeCloseTo(0.01 + 0.002 + 0.0125 + 0.005);
    expect(calculateAiUsageCostCents({ inputTokens: 4000, cachedInputTokens: 2000, outputTokens: 0, costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.05 }))
      .toBeCloseTo(0.04);
    // An unknown write rate errs high: 1.25x input, never the input rate.
    expect(calculateAiUsageCostCents({ inputTokens: 1000, cacheWriteInputTokens: 1000, outputTokens: 0, costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0 }))
      .toBeCloseTo(0.0125);
    // Without cache counts the cost is unchanged from before.
    expect(calculateAiUsageCostCents({ inputTokens: 4000, outputTokens: 100, ...rates })).toBeCloseTo(0.045);
  });

  it("prices Claude Haiku 5.5 cache reads at a tenth of input", () => {
    const full = estimateAiUsageCostCents({ provider: "anthropic", model: "claude-haiku-5-5", inputTokens: 10_000, outputTokens: 0 });
    const cached = estimateAiUsageCostCents({ provider: "anthropic", model: "claude-haiku-5-5", inputTokens: 10_000, cachedInputTokens: 10_000, outputTokens: 0 });
    expect(full).toBeCloseTo(0.1);
    expect(cached).toBeCloseTo(0.01);
    const priced = buildPricedAiUsageLedgerEvent({ provider: "openrouter", model: "anthropic/claude-haiku-5.5", metric: "chat",
      inputTokens: 10_000, outputTokens: 0, metadata: { cachedInputTokens: 9_000 } });
    expect(priced.costCents).toBeCloseTo(0.01 + 0.009);
  });

  it("uses the live listing's cache rates, following the matched long-prompt tier", () => {
    setLiveModelPricesForTests({ models: Object.fromEntries(parseOpenRouterCatalog(LISTING)) });
    expect(liveModelPrice("vendor/cached")).toMatchObject({ cacheRead: 0.00000001, cacheWrite: 0.000000125 });
    const long = liveModelPrice("vendor/cached", { promptTokens: 200_000 });
    expect(long).toMatchObject({ input: 0.0000005, cacheRead: 0.00000005 });
    expect(long?.cacheWrite).toBeUndefined();
    const event = buildPricedAiUsageLedgerEvent({ provider: "openrouter", model: "vendor/cached", metric: "chat",
      inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 0 });
    expect(event.costCents).toBeCloseTo((2_000 * 0.0000001 + 8_000 * 0.00000001) * 100);
  });

  it("drops implausible live cache rates instead of pricing with them", () => {
    setLiveModelPricesForTests({ models: Object.fromEntries(parseOpenRouterCatalog({ data: [
      { id: "vendor/zero-read", pricing: { prompt: "0.0000001", completion: "0.0000005", input_cache_read: "0", input_cache_write: "0.000000125" } },
      { id: "vendor/typo-write", pricing: { prompt: "0.0000001", completion: "0.0000005", input_cache_read: "0.00000001", input_cache_write: "0.0000125" } },
      { id: "vendor/cheap-write", pricing: { prompt: "0.0000001", completion: "0.0000005", input_cache_write: "0.00000005" } },
    ] })) });
    expect(liveModelPrice("vendor/zero-read")?.cacheRead).toBeUndefined();
    expect(liveModelPrice("vendor/zero-read")?.cacheWrite).toBe(0.000000125);
    expect(liveModelPrice("vendor/typo-write")?.cacheWrite).toBeUndefined();
    expect(liveModelPrice("vendor/cheap-write")?.cacheWrite).toBeUndefined();
    // Against a verified cache rate, a drifted listing is dropped.
    setLiveModelPricesForTests({ models: Object.fromEntries(parseOpenRouterCatalog(LISTING)) });
    expect(liveModelPrice("vendor/cached", { reference: { input: 0.0000001, output: 0.0000005, cacheRead: 0.0000001 } })?.cacheRead).toBeUndefined();
  });

  it("logs cache fields only when present", () => {
    const plain = buildAiUsageLedgerEvent({ provider: "p", model: "m", metric: "chat", inputTokens: 10, outputTokens: 2 });
    expect(formatAiUsageConsoleLog(plain)).toBe("[ai-usage] chat model=m input_tokens=10 output_tokens=2");
    const cached = buildAiUsageLedgerEvent({ provider: "p", model: "claude-haiku-5-5", metric: "chat", inputTokens: 3000, outputTokens: 2,
      cachedInputTokens: 2048, cacheWriteInputTokens: 900 });
    expect(formatAiUsageConsoleLog(cached)).toBe("[ai-usage] chat model=claude-haiku-5-5 input_tokens=3000 output_tokens=2 cached_input_tokens=2048 cache_write_input_tokens=900");
  });

  it("carries cache counts from a receipt and discounts an estimate without one", async () => {
    const withReceipt = await resolveOpenRouterUsage({ apiKey: "k", model: "openai/gpt-6-luna",
      usage: { inputTokens: 3000, outputTokens: 50, raw: { cost: 0.0001, prompt_tokens_details: { cached_tokens: 2048 } } } });
    expect(withReceipt.metadata).toMatchObject({ costSource: "provider", cachedInputTokens: 2048 });
    expect(withReceipt.costCents).toBeCloseTo(0.01);

    setLiveModelPricesForTests({ models: Object.fromEntries(parseOpenRouterCatalog(LISTING)) });
    const estimated = await resolveOpenRouterUsage({ apiKey: "k", model: "vendor/cached",
      usage: { inputTokens: 3000, outputTokens: 0, raw: { prompt_tokens_details: { cached_tokens: 2000 } } } });
    expect(estimated.metadata).toMatchObject({ costSource: "estimate", cachedInputTokens: 2000 });
    expect(estimated.costCents).toBeCloseTo((1000 * 0.0000001 + 2000 * 0.00000001) * 100);
  });
});

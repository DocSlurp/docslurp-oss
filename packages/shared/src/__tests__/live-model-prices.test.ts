import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_MODEL_PRICES_MAX_AGE_MS, liveModelPrice, liveModelPriceStatus, parseOpenRouterCatalog, refreshLiveModelPrices, setLiveModelPricesForTests,
} from "../live-model-prices.js";
import { buildPricedAiUsageLedgerEvent, resolveAiUsagePricingWithSource } from "../usage.js";

afterEach(() => { setLiveModelPricesForTests(null); vi.restoreAllMocks(); });

const catalog = { data: [
  { id: "vendor/flat", pricing: { prompt: "0.0000001", completion: "0.0000004" } },
  { id: "vendor/tiered", pricing: { prompt: "0.0000001", completion: "0.0000005", overrides: [{ min_prompt_tokens: 100000, prompt: "0.0000005", completion: "0.0000025" }] } },
  { id: "vendor/peak", pricing: { prompt: "0.00000015", completion: "0.0000006", overrides: [
    { utc_days: ["monday", "tuesday", "wednesday", "thursday", "friday"], utc_start: 100, utc_end: 400, prompt: "0.0000003", completion: "0.0000012" },
  ] } },
  { id: "vendor/embed", pricing: { prompt: "0.000000004", completion: "0" } },
  { id: "vendor/bad", pricing: { prompt: "-1", completion: "x" } },
  { id: "vendor/unconditioned", pricing: { prompt: "0.0000001", completion: "0.0000001", overrides: [{ prompt: "1", completion: "1" }] } },
] };

describe("live model prices", () => {
  it("parses listings, skips invalid prices and ignores overrides without a condition", () => {
    const models = parseOpenRouterCatalog(catalog);
    expect(models.has("vendor/bad")).toBe(false);
    expect(models.get("vendor/unconditioned")?.overrides).toEqual([]);
    expect(models.get("vendor/embed")).toMatchObject({ input: 0.000000004, output: 0 });
    expect(parseOpenRouterCatalog(null).size).toBe(0);
  });

  it("applies long-prompt and UTC-window overrides only when the call matches them", () => {
    setLiveModelPricesForTests({ models: Object.fromEntries(parseOpenRouterCatalog(catalog)) });
    expect(liveModelPrice("vendor/tiered", { promptTokens: 100_000 })).toMatchObject({ input: 0.0000001 });
    expect(liveModelPrice("vendor/tiered", { promptTokens: 100_001 })).toMatchObject({ input: 0.0000005, override: "min-prompt-tokens" });
    const wednesday0200 = new Date("2026-11-04T02:00:00Z"), wednesday0400 = new Date("2026-11-04T04:00:00Z"), sunday0200 = new Date("2026-11-08T02:00:00Z");
    expect(liveModelPrice("vendor/peak", { at: wednesday0200 })).toMatchObject({ input: 0.0000003, override: "utc-window" });
    expect(liveModelPrice("vendor/peak", { at: wednesday0400 })?.input).toBe(0.00000015);
    expect(liveModelPrice("vendor/peak", { at: sunday0200 })?.input).toBe(0.00000015);
    expect(liveModelPrice("vendor/flat:nitro")).toBeUndefined();
  });

  it("drops listings at or above the prohibited-price ceiling and ignores live prices far from a verified one", () => {
    expect(parseOpenRouterCatalog({ data: [{ id: "vendor/huge", pricing: { prompt: "1e307", completion: "0.0000001" } }] }).size).toBe(0);
    expect(parseOpenRouterCatalog({ data: [{ id: "vendor/pricey", pricing: { prompt: "0.0000001", completion: "0.00005" } }] }).size).toBe(0);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setLiveModelPricesForTests({ models: { "vendor/flat": { input: 0.0000001, output: 0.0000004 }, "vendor/zero": { input: 0, output: 0 } } });
    expect(liveModelPrice("vendor/flat", { reference: { input: 0.00000015, output: 0.0000005 } })?.input).toBe(0.0000001);
    expect(liveModelPrice("vendor/flat", { reference: { input: 0.000001, output: 0.0000004 } })).toBeUndefined();
    // A $0 listing cannot silence the estimate for a model with a verified price.
    expect(liveModelPrice("vendor/zero", { reference: { input: 0.0000001, output: 0.0000004 } })).toBeUndefined();
  });

  it("handles UTC windows that wrap midnight and windows with only an end", () => {
    setLiveModelPricesForTests({ models: Object.fromEntries(parseOpenRouterCatalog({ data: [
      { id: "vendor/night", pricing: { prompt: "0.0000001", completion: "0.0000001", overrides: [{ utc_start: 2200, utc_end: 600, prompt: "0.0000002", completion: "0.0000002" }] } },
      { id: "vendor/morning", pricing: { prompt: "0.0000001", completion: "0.0000001", overrides: [{ utc_end: 900, prompt: "0.0000003", completion: "0.0000003" }] } },
    ] })) });
    expect(liveModelPrice("vendor/night", { at: new Date("2026-11-04T23:00:00Z") })?.input).toBe(0.0000002);
    expect(liveModelPrice("vendor/night", { at: new Date("2026-11-04T05:59:00Z") })?.input).toBe(0.0000002);
    expect(liveModelPrice("vendor/night", { at: new Date("2026-11-04T12:00:00Z") })?.input).toBe(0.0000001);
    expect(liveModelPrice("vendor/morning", { at: new Date("2026-11-04T08:00:00Z") })?.input).toBe(0.0000003);
    expect(liveModelPrice("vendor/morning", { at: new Date("2026-11-04T10:00:00Z") })?.input).toBe(0.0000001);
  });

  it("ignores a snapshot past its maximum age", () => {
    setLiveModelPricesForTests({ fetchedAt: Date.now() - LIVE_MODEL_PRICES_MAX_AGE_MS - 1, models: { "vendor/flat": { input: 1, output: 1 } } });
    expect(liveModelPrice("vendor/flat")).toBeUndefined();
  });

  it("merges both catalogs, keeps the previous snapshot when a refresh fails, and shares one in-flight fetch", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ok = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [catalog.data[0]] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [catalog.data[3]] })));
    const [a, b] = await Promise.all([refreshLiveModelPrices({ fetch: ok, force: true }), refreshLiveModelPrices({ fetch: ok, force: true })]);
    expect(a && b).toBe(true);
    expect(ok).toHaveBeenCalledTimes(2);
    expect(liveModelPriceStatus()).toMatchObject({ loaded: true, models: 2, lastError: null });
    const down = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    expect(await refreshLiveModelPrices({ fetch: down, force: true })).toBe(false);
    expect(liveModelPrice("vendor/flat")?.input).toBe(0.0000001);
    expect(liveModelPriceStatus().lastError).toContain("offline");
  });

  it("prices receipt-less OpenRouter usage events from the live listing before the hardcoded catalog", () => {
    expect(resolveAiUsagePricingWithSource({ provider: "openrouter", model: "perplexity/pplx-embed-v1-0.6b" }).pricingSource).toBe("catalog");
    setLiveModelPricesForTests({ models: { "perplexity/pplx-embed-v1-0.6b": { input: 0.00000001, output: 0 } } });
    const event = buildPricedAiUsageLedgerEvent({ provider: "openrouter", model: "perplexity/pplx-embed-v1-0.6b", metric: "embedding", inputTokens: 1_000_000 });
    expect(event.costCents).toBeCloseTo(1, 10);
    expect(event.metadata).toMatchObject({ costSource: "estimate", pricingSource: "openrouter-live" });
    // Other providers and explicit catalogs never read the live listing.
    expect(resolveAiUsagePricingWithSource({ provider: "perplexity", model: "pplx-embed-v1-0.6b" }).pricingSource).toBe("catalog");
    expect(resolveAiUsagePricingWithSource({ provider: "openrouter", model: "perplexity/pplx-embed-v1-0.6b" }, { catalog: [] }).pricingSource).toBe("configured-fallback");
    // A provider receipt is never repriced.
    expect(buildPricedAiUsageLedgerEvent({ provider: "openrouter", model: "perplexity/pplx-embed-v1-0.6b", metric: "embedding", inputTokens: 5, costCents: 0.3 }).costCents).toBe(0.3);
  });
});

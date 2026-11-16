import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTOMATIC_CALL_PLANNING_TOKENS,
  AutomaticCallRefusedError,
  DEFAULT_AUTOMATIC_MIN_MARGIN,
  MODEL_PRICE_SCHEDULES,
  OPEN_PRICING,
  assertAutomaticModelCallAllowed,
  automaticCallMarginDecision,
  automaticMinMargin,
  automaticPriceMaxAgeMs,
  defineTierOptions,
  ensureEndpointPrices,
  installTestPricing,
  parseEndpointPrices,
  reportAutomaticCallOutcome,
  resetPricingProviderForTests,
  schedulePriceAt,
  selectTierRoute,
  setEndpointPricesForTests,
  visionAutomaticRoute,
  type AutomaticCallKind,
  type EndpointObservation,
} from "../index.js";

// Arbitrary test values, not any deployment's prices: a page read bills $0.0025, a chart read $0.0025, a chat answer $0.01.
const VALUES: Record<AutomaticCallKind, number> = { "page-transcription": 0.0025, "chart-read": 0.0025, "chat-answer": 0.01 };
const MODEL = "deepseek/deepseek-v4.1-flash-1017";
// Monday 2026-11-16: 02:00 UTC is DeepSeek peak, 12:00 UTC off-peak; Saturday 2026-11-14 02:00 UTC is off-peak.
const PEAK = new Date("2026-11-16T02:00:00Z");
const OFF_PEAK = new Date("2026-11-16T12:00:00Z");
const WEEKEND = new Date("2026-11-14T02:00:00Z");
const NOW = PEAK.getTime();

const SCHEDULE_OVERRIDES = [
  { utc_days: ["monday", "tuesday", "wednesday", "thursday", "friday"], utc_start: 100, utc_end: 400, prompt: "0.0000003", completion: "0.0000012" },
  { utc_days: ["monday", "tuesday", "wednesday", "thursday", "friday"], utc_start: 600, utc_end: 1000, prompt: "0.0000003", completion: "0.0000012" },
];

function listing(endpoints: Array<{ endpoint: string; input: number; output: number; overrides?: unknown[] }>, fetchedAt = NOW) {
  const parsed = parseEndpointPrices({ data: { endpoints: endpoints.map((entry) => ({
    tag: entry.endpoint,
    pricing: { prompt: String(entry.input / 1e6), completion: String(entry.output / 1e6), ...(entry.overrides ? { overrides: entry.overrides } : {}) },
  })) } });
  setEndpointPricesForTests({ [MODEL]: { fetchedAt, endpoints: parsed } });
}

const decide = (kind: AutomaticCallKind, route: Parameters<typeof automaticCallMarginDecision>[1], at: Date, env: Record<string, string> = {}) =>
  automaticCallMarginDecision(kind, route, { at, now: NOW, env });

describe("automatic call margin gate", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    installTestPricing({ automaticCallValueUsd: ({ kind }) => VALUES[kind] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setEndpointPricesForTests(null);
    resetPricingProviderForTests();
    vi.unstubAllEnvs();
  });

  it("records DeepSeek's verified peak schedule (official pricing page, UTC weekdays) and evaluates it by UTC time", () => {
    const schedule = MODEL_PRICE_SCHEDULES.find((entry) => entry.family === "deepseek-v4.1-flash")!;
    expect(schedule).toMatchObject({ host: "deepseek", source: "https://api-docs.deepseek.com/quick_start/pricing" });
    expect(schedulePriceAt(schedule, PEAK)).toEqual({ inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 });
    expect(schedulePriceAt(schedule, new Date("2026-11-16T08:30:00Z"))).toEqual({ inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 });
    expect(schedulePriceAt(schedule, new Date("2026-11-16T04:00:00Z"))).toEqual({ ...schedule.base });
    expect(schedulePriceAt(schedule, OFF_PEAK)).toEqual(schedule.base);
    expect(schedulePriceAt(schedule, WEEKEND)).toEqual(schedule.base);
  });

  it("refuses a chart read on DeepSeek's own endpoint at peak and allows it off-peak and at the weekend", () => {
    listing([{ endpoint: "deepseek", input: 0.15, output: 0.6, overrides: SCHEDULE_OVERRIDES }]);
    const route = { model: MODEL, hosts: ["deepseek"] };
    const peak = decide("chart-read", route, PEAK);
    // 3,300 x $0.30 + 1,400 x $1.20 per M = $0.00267 against $0.0025: ratio 0.94.
    expect(peak).toMatchObject({ allowed: false, reason: "below the minimum margin", price: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 }, priceSource: "listing" });
    expect(peak.worstCostUsd).toBeCloseTo(0.00267, 8);
    expect(decide("chart-read", route, OFF_PEAK)).toMatchObject({ allowed: true, reason: "margin" });
    expect(decide("chart-read", route, WEEKEND)).toMatchObject({ allowed: true, reason: "margin" });
    // A page read clears 1.3x at peak too (1,500 x 0.30 + 800 x 1.20 = $0.00141; ratio 1.77).
    expect(decide("page-transcription", route, PEAK)).toMatchObject({ allowed: true });
  });

  it("applies the verified schedule as a floor when a listing drops the host's time-of-day overrides", () => {
    listing([{ endpoint: "deepseek", input: 0.15, output: 0.6 }]);
    expect(decide("chart-read", { model: MODEL, hosts: ["deepseek"] }, PEAK)).toMatchObject({ allowed: false, price: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 } });
  });

  it("prices a multi-host route at the highest price of the hosts it allows, each component separately", () => {
    listing([
      { endpoint: "deepseek", input: 0.15, output: 0.6, overrides: SCHEDULE_OVERRIDES },
      { endpoint: "fireworks", input: 0.3, output: 1.2 },
      { endpoint: "cheap-host", input: 0.4, output: 0.1 },
      { endpoint: "venice/ultrafast", input: 3, output: 12 },
    ]);
    // Off-peak DeepSeek is cheap, but the route may also reach Fireworks: the worst case is Fireworks.
    expect(decide("chart-read", { model: MODEL, hosts: ["deepseek", "fireworks"] }, OFF_PEAK)).toMatchObject({ allowed: false, price: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 } });
    // Input from one host, output from another: never under-prices either.
    expect(decide("page-transcription", { model: MODEL, hosts: ["fireworks", "cheap-host"] }, OFF_PEAK).price).toEqual({ inputUsdPerMTok: 0.4, outputUsdPerMTok: 1.2 });
    // Unrestricted: every listed host can be reached, the most expensive included.
    expect(decide("chat-answer", { model: MODEL }, OFF_PEAK)).toMatchObject({ allowed: false, price: { inputUsdPerMTok: 3, outputUsdPerMTok: 12 } });
    // A max_price cap excludes hosts above it: OpenRouter never routes there.
    expect(decide("page-transcription", { model: MODEL, capUsdPerMTok: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 } }, OFF_PEAK))
      .toMatchObject({ allowed: true, price: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 } });
  });

  it("fails closed when the price is unknown or stale, unless the request's enforced cap bounds it", () => {
    const route = { model: MODEL, hosts: ["deepseek"] };
    setEndpointPricesForTests(null);
    expect(decide("page-transcription", route, OFF_PEAK)).toMatchObject({ allowed: false, reason: "price unknown: no fresh price listing" });
    listing([{ endpoint: "deepseek", input: 0.15, output: 0.6 }], NOW - 2 * 3_600_000);
    expect(decide("page-transcription", route, OFF_PEAK)).toMatchObject({ allowed: false, reason: "price unknown: no fresh price listing" });
    // A fresher maximum age reads it; a stale listing is never used.
    expect(decide("page-transcription", route, OFF_PEAK, { DOCSLURP_AUTOMATIC_PRICE_MAX_AGE_MINUTES: "180" })).toMatchObject({ allowed: true });
    // An enforced max_price is a valid worst case without a listing.
    const capped = decide("page-transcription", { ...route, capUsdPerMTok: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 } }, OFF_PEAK);
    expect(capped).toMatchObject({ allowed: true, priceSource: "cap" });
    // A host the listing does not show, or an unreadable price, is unknown.
    listing([{ endpoint: "fireworks", input: 0.3, output: 1.2 }]);
    expect(decide("page-transcription", route, OFF_PEAK)).toMatchObject({ allowed: false, reason: "price unknown: no listed endpoint the route allows" });
    setEndpointPricesForTests({ [MODEL]: { fetchedAt: NOW, endpoints: parseEndpointPrices({ data: { endpoints: [
      { tag: "deepseek", pricing: { prompt: "0.00000015", completion: "0.0000006", overrides: [{ utc_start: 100, utc_end: 400, prompt: "bogus", completion: "1" }] } },
    ] } }) } });
    expect(decide("page-transcription", route, OFF_PEAK)).toMatchObject({ allowed: false, reason: "price unknown: an allowed endpoint has an unreadable price" });
  });

  it("keeps an expensive endpoint in the listing instead of dropping it", () => {
    const parsed = parseEndpointPrices({ data: { endpoints: [{ tag: "pricey", pricing: { prompt: "0.0001", completion: "0.0002" } }] } });
    expect(parsed[0]).toMatchObject({ endpoint: "pricey", priced: true, inputUsdPerMTok: 100, outputUsdPerMTok: 200 });
  });

  it("reads the minimum margin from DOCSLURP_AUTOMATIC_MIN_MARGIN (default 1.3); an invalid value keeps the default", () => {
    expect(DEFAULT_AUTOMATIC_MIN_MARGIN).toBe(1.3);
    expect(automaticMinMargin({})).toBe(1.3);
    expect(automaticMinMargin({ DOCSLURP_AUTOMATIC_MIN_MARGIN: "2" })).toBe(2);
    for (const bad of ["0.5", "-1", "abc", "Infinity", "1000"]) expect(automaticMinMargin({ DOCSLURP_AUTOMATIC_MIN_MARGIN: bad }), bad).toBe(1.3);
    expect(automaticPriceMaxAgeMs({})).toBe(60 * 60_000);
    expect(automaticPriceMaxAgeMs({ DOCSLURP_AUTOMATIC_PRICE_MAX_AGE_MINUTES: "0" })).toBe(60 * 60_000);
    listing([{ endpoint: "deepseek", input: 0.15, output: 0.6, overrides: SCHEDULE_OVERRIDES }]);
    // Page at peak: ratio 1.77. Allowed at 1.3, refused at 2.
    expect(decide("page-transcription", { model: MODEL, hosts: ["deepseek"] }, PEAK, { DOCSLURP_AUTOMATIC_MIN_MARGIN: "2" })).toMatchObject({ allowed: false, minMargin: 2 });
  });

  it("asks the pricing provider for the billed value at the planning shape; the open default bills nothing and checks nothing", () => {
    const seen: unknown[] = [];
    installTestPricing({ automaticCallValueUsd: (call) => { seen.push(call); return VALUES[call.kind]; } });
    listing([{ endpoint: "deepseek", input: 0.15, output: 0.6 }]);
    decide("chart-read", { model: `llm://openrouter/${MODEL}:nitro?reasoning=none`, hosts: ["deepseek"] }, OFF_PEAK);
    expect(seen).toEqual([{ kind: "chart-read", model: MODEL, ...AUTOMATIC_CALL_PLANNING_TOKENS["chart-read"] }]);
    resetPricingProviderForTests();
    expect(OPEN_PRICING.automaticCallValueUsd?.({ kind: "chat-answer", model: MODEL, inputTokens: 1, outputTokens: 1 })).toBeNull();
    setEndpointPricesForTests(null);
    // No value stated: no check, even with no price at all.
    expect(decide("chat-answer", { model: MODEL }, PEAK)).toMatchObject({ allowed: true, reason: "not-billed" });
  });

  it("fails closed where pricing is required and the provider states no value or an invalid one", () => {
    listing([{ endpoint: "deepseek", input: 0.15, output: 0.6 }]);
    const route = { model: MODEL, hosts: ["deepseek"] };
    vi.stubEnv("DOCSLURP_PRICING_REQUIRED", "1");
    const { automaticCallValueUsd: _omit, id: _id, version: _version, ...withoutHook } = OPEN_PRICING;
    installTestPricing({ ...withoutHook, automaticCallValueUsd: undefined });
    expect(decide("page-transcription", route, OFF_PEAK)).toMatchObject({ allowed: false, reason: "the pricing provider states no automatic call value" });
    resetPricingProviderForTests();
    expect(decide("page-transcription", route, OFF_PEAK).allowed).toBe(false);
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, "1" as unknown as number]) {
      installTestPricing({ automaticCallValueUsd: () => bad });
      expect(decide("page-transcription", route, OFF_PEAK), String(bad)).toMatchObject({ allowed: false, reason: "the pricing provider returned an invalid automatic call value" });
    }
    installTestPricing({ automaticCallValueUsd: () => { throw new Error("boom"); } });
    expect(decide("page-transcription", route, OFF_PEAK).allowed).toBe(false);
  });

  it("does not check operator private routes; prices direct routes at their list price", () => {
    setEndpointPricesForTests(null);
    expect(decide("page-transcription", { model: "llm://private/gpu1/acme/model" }, PEAK)).toMatchObject({ allowed: true, reason: "private-route" });
    expect(decide("page-transcription", { model: "llm://deepinfra/Acme/Model" }, PEAK)).toMatchObject({ allowed: false, reason: "price unknown: no verified list price for a direct route" });
    expect(decide("page-transcription", { model: "llm://deepinfra/Acme/Model", capUsdPerMTok: { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.4 } }, PEAK))
      .toMatchObject({ allowed: true, priceSource: "list-price" });
  });

  it("builds vision routes from the catalog: the max_price cap and pinned hosts the runtime sends", () => {
    const route = visionAutomaticRoute(`llm://openrouter/${MODEL}`);
    expect(route.billing).toBe("openrouter");
    expect(route.capUsdPerMTok?.outputUsdPerMTok).toBeGreaterThan(0);
    expect(visionAutomaticRoute("llm://private/gpu1/acme/model").billing).toBe("private");
    expect(visionAutomaticRoute("llm://deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct").billing).toBe("direct");
  });

  it("assertAutomaticModelCallAllowed applies the gate only when the caller names an automatic call kind", () => {
    listing([{ endpoint: "deepseek", input: 0.15, output: 0.6, overrides: SCHEDULE_OVERRIDES }]);
    vi.useFakeTimers();
    vi.setSystemTime(PEAK);
    try {
      expect(assertAutomaticModelCallAllowed(MODEL, "explicit")).toBeNull();
      expect(() => assertAutomaticModelCallAllowed(MODEL, "chart", { kind: "chart-read", route: { model: MODEL, hosts: ["deepseek"] } })).toThrow(AutomaticCallRefusedError);
      expect(assertAutomaticModelCallAllowed(MODEL, "chart", { kind: "chart-read", route: { model: MODEL, hosts: ["deepseek"] }, at: OFF_PEAK })).toMatchObject({ allowed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs a loss (actual cost above the billed value) at error and an over-estimate at warn", () => {
    listing([{ endpoint: "deepseek", input: 0.15, output: 0.6 }]);
    const decision = decide("page-transcription", { model: MODEL, hosts: ["deepseek"] }, OFF_PEAK);
    reportAutomaticCallOutcome(decision, { costUsd: 0.0001 }, "t");
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    reportAutomaticCallOutcome(decision, { costUsd: decision.worstCostUsd! * 1.5 }, "t");
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/\[automatic-margin\] overrun .*loss=false/));
    reportAutomaticCallOutcome(decision, { costUsd: 0.003, inputTokens: 9_000, outputTokens: 1_000 }, "t");
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/\[automatic-margin\] overrun .*loss=true/));
  });

  it("never fetches outside a process that started the refresher", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await ensureEndpointPrices([MODEL], 60_000);
      decide("page-transcription", { model: MODEL }, PEAK);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("route tiers under the margin gate", () => {
  const [option] = defineTierOptions([
    { id: "ocr-ds", capability: "page-ocr", pool: [`llm://openrouter/${MODEL}?_provider=deepseek`], tiers: ["balanced"], evalScore: null, evalRef: null },
  ]);
  const observation = (at: Date): EndpointObservation => ({ model: MODEL, endpoint: "deepseek", observedAt: new Date(at.getTime() - 60_000),
    inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6, uptime30m: 100, status: 0, latencyP50Ms: null });
  const CHART_UNIT = AUTOMATIC_CALL_PLANNING_TOKENS["chart-read"];
  afterEach(() => resetPricingProviderForTests());

  it("prices an observed host at its verified schedule at the request time and skips it under the minimum margin", () => {
    const input = { capability: "page-ocr" as const, tier: "balanced" as const, options: [option!], unitRevenueUsd: 0.0025, unit: CHART_UNIT };
    expect(selectTierRoute({ ...input, observations: [observation(PEAK)], now: PEAK }).basis).toBe("none");
    expect(selectTierRoute({ ...input, observations: [observation(OFF_PEAK)], now: OFF_PEAK }).basis).toBe("live");
    expect(selectTierRoute({ ...input, observations: [observation(OFF_PEAK)], now: OFF_PEAK, minMarginRatio: 2 }).basis).toBe("none");
  });

  it("takes the billed value from the pricing provider, and never picks on reviewed order alone when a value must be kept", () => {
    installTestPricing({ automaticCallValueUsd: ({ kind }) => VALUES[kind] });
    const input = { capability: "page-ocr" as const, tier: "balanced" as const, options: [option!], unitRevenueUsd: null, unit: AUTOMATIC_CALL_PLANNING_TOKENS["page-transcription"] };
    expect(selectTierRoute({ ...input, observations: [observation(PEAK)], now: PEAK }).basis).toBe("live");
    expect(selectTierRoute({ ...input, observations: [], now: PEAK })).toMatchObject({ basis: "none" });
    resetPricingProviderForTests();
    // Nothing billed (open default): the reviewed first host is still the static pick.
    expect(selectTierRoute({ ...input, observations: [], now: PEAK }).basis).toBe("static");
  });
});

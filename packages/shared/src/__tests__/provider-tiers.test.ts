import { describe, expect, it } from "vitest";
import { hostMatchesEndpoint, parsePoolDuration, parseProviderPool, providerPool, providerPoolPreferences } from "../provider-pools.js";
import { assertTierOptions, defineTierOptions, selectTierRoute, servedMargin, type EndpointObservation, type TierOption, type TierSelectionInput } from "../provider-tiers.js";

const NOW = new Date("2026-11-12T18:00:00Z");
const PAGE = { inputTokens: 1_500, outputTokens: 800 };
const obs = (model: string, endpoint: string, input: number, output: number, extra: Partial<EndpointObservation> = {}): EndpointObservation => ({
  model, endpoint, observedAt: new Date(NOW.getTime() - 10 * 60_000), inputUsdPerMTok: input, outputUsdPerMTok: output,
  uptime30m: 100, status: 0, latencyP50Ms: null, ...extra,
});

const entries = (model: string, hosts: string[], options = "") => hosts.map((host, index) => `llm://openrouter/${model}?_provider=${host}${index === 0 ? options : ""}`);
const [ocrA, ocrB, chat] = defineTierOptions([
  { id: "ocr-a", capability: "page-ocr", pool: entries("acme/ocr-a", ["fireworks", "parasail", "together"], "&_sort=latency"), tiers: ["cheapest", "fastest", "best"], evalScore: 0.91, evalRef: "run-a" },
  { id: "ocr-b", capability: "page-ocr", pool: entries("acme/ocr-b", ["wafer/nvfp4", "friendli"]), tiers: ["cheapest", "fastest", "best"], evalScore: 0.95, evalRef: "run-b" },
  { id: "chat-a", capability: "chat", pool: entries("acme/chat", ["deepinfra/fp8"]), tiers: ["cheapest"], evalScore: null, evalRef: null },
]) as [TierOption, TierOption, TierOption];
const options = [ocrA, ocrB, chat];
const problems = (uris: string[]) => parseProviderPool(uris).problems;
const base = (over: Partial<TierSelectionInput>): TierSelectionInput => ({ capability: "page-ocr", tier: "cheapest", options, observations: [], unitRevenueUsd: null, unit: PAGE, now: NOW, ...over });

describe("provider pools", () => {
  it("parses llm:// entries: model from the path, model options from the query, pool options from _ params or the fragment", () => {
    const pool = providerPool([
      "llm://openrouter/acme/m?reasoning=low&_provider=fireworks&_sort=latency&_timeout=45s",
      "llm://openrouter/acme/m?reasoning=low&_provider=parasail/fp8#minUptime=95&_maxAge=30m&preferredMargin=0.25",
    ]);
    expect(pool).toMatchObject({ model: "acme/m", modelOptions: { reasoning: "low" }, hosts: ["fireworks", "parasail/fp8"], sort: "latency",
      fallbackBeyondPool: false, timeoutMs: 45_000, minUptime: 95, maxAgeMs: 1_800_000, preferredMargin: 0.25 });
    expect(providerPool(["llm://openrouter/acme/m?_provider=a"])).toMatchObject({ sort: "price", timeoutMs: null, minUptime: null, maxAgeMs: null, preferredMargin: null });
  });

  it("has no size cap: many distinct providers are one pool", () => {
    const hosts = Array.from({ length: 12 }, (_, index) => `host${index}`);
    expect(providerPool(entries("acme/m", hosts)).hosts).toEqual(hosts);
  });

  it("refuses malformed pools, naming every problem", () => {
    expect(problems([])).not.toEqual([]);
    expect(problems(["acme/m?_provider=a"])[0]).toContain("llm://openrouter/");
    expect(problems(["llm://private/gpu1/m?_provider=a"])[0]).toContain("llm://openrouter/");
    expect(problems(["llm://openrouter/acme/m"])[0]).toContain("_provider is required");
    expect(problems(entries("acme/m", ["deepinfra/fp8", "deepinfra/fp8/flex"]))[0]).toContain("distinct providers");
    expect(problems(["llm://openrouter/acme/m?_provider=Fireworks"])[0]).toContain("lowercase");
    expect(problems(["llm://openrouter/acme/m?_provider=a", "llm://openrouter/acme/n?_provider=b"])[0]).toContain("same model");
    expect(problems(["llm://openrouter/acme/m?reasoning=low&_provider=a", "llm://openrouter/acme/m?_provider=b"])[0]).toContain("model options");
    expect(problems(["llm://openrouter/acme/m?_provider=a&_bogus=1"])[0]).toContain("unknown pool option _bogus");
    expect(problems(["llm://openrouter/acme/m?_provider=a#bogus=1"])[0]).toContain("unknown pool option #bogus");
    expect(problems(["llm://openrouter/acme/m?_provider=a&_sort=price#sort=latency"])[0]).toContain("given twice");
    expect(problems(["llm://openrouter/acme/m?_provider=a&_sort=price", "llm://openrouter/acme/m?_provider=b&_sort=latency"])[0]).toContain("conflicts");
    expect(problems(["llm://openrouter/acme/m?_provider=a&_sort=fastest"])[0]).toContain("_sort");
    expect(problems(["llm://openrouter/acme/m?_provider=a&_fallbacks=true"])[0]).toContain("order pool");
    expect(problems(["llm://openrouter/acme/m?_provider=a&_timeout=soon"])[0]).toContain("_timeout");
    expect(problems(["llm://openrouter/acme/m?_provider=a&_minUptime=101"])[0]).toContain("_minUptime");
    expect(problems(["llm://openrouter/acme/m?_provider=a&_preferredMargin=1"])[0]).toContain("_preferredMargin");
    expect(problems(["llm://openrouter/acme/m?_provider=a&_maxHosts=3"])[0]).toContain("unknown pool option _maxHosts");
    expect(() => providerPool(["llm://openrouter/acme/m"], "pool x")).toThrow(/^pool x: /);
  });

  it("accepts the same pool-wide value repeated on several entries", () => {
    expect(problems(["llm://openrouter/acme/m?_provider=a&_sort=latency", "llm://openrouter/acme/m?_provider=b#sort=latency"])).toEqual([]);
  });

  it("parses durations", () => {
    expect([parsePoolDuration("500ms"), parsePoolDuration("30s"), parsePoolDuration("2m"), parsePoolDuration("1h"), parsePoolDuration("750")]).toEqual([500, 30_000, 120_000, 3_600_000, 750]);
    expect([parsePoolDuration("0s"), parsePoolDuration("-1s"), parsePoolDuration("1d"), parsePoolDuration("")]).toEqual([null, null, null, null]);
  });

  it("matches a provider slug to its variants and a tag only to itself", () => {
    expect(hostMatchesEndpoint("fireworks", "fireworks/us")).toBe(true);
    expect(hostMatchesEndpoint("fireworks", "fireworks")).toBe(true);
    expect(hostMatchesEndpoint("wafer/nvfp4", "wafer/mxfp4")).toBe(false);
    expect(hostMatchesEndpoint("fire", "fireworks")).toBe(false);
  });

  it("sends only pool hosts: fallbacks stay inside an only pool; order pools fall back only when allowed", () => {
    expect(providerPoolPreferences(providerPool(entries("m/x", ["fireworks", "parasail"], "&_sort=latency")))).toEqual({ only: ["fireworks", "parasail"], sort: "latency", allow_fallbacks: true });
    expect(providerPoolPreferences(providerPool(entries("m/x", ["relace", "deepinfra"], "#sort=order&fallbacks=true")))).toEqual({ order: ["relace", "deepinfra"], allow_fallbacks: true });
    const single = providerPool(entries("m/x", ["fireworks"]));
    expect(providerPoolPreferences(single, ["fireworks", "evil-host"])).toEqual({ only: ["fireworks"], sort: "price", allow_fallbacks: true });
    expect(() => providerPoolPreferences(single, ["evil-host"])).toThrow(/no host/);
  });
});

describe("tier selection", () => {
  it("validates options", () => {
    expect(() => assertTierOptions(options)).not.toThrow();
    expect(() => assertTierOptions([ocrA, ocrA])).toThrow(/duplicate/);
    expect(() => assertTierOptions([{ ...ocrA, evalScore: 1.5 }])).toThrow(/0-1/);
    expect(() => assertTierOptions([{ ...ocrA, evalRef: null }])).toThrow(/together/);
    expect(() => assertTierOptions([{ ...ocrA, model: "acme/other" }])).toThrow(/pool's model/);
    expect(() => defineTierOptions([{ id: "bad", capability: "chat", pool: ["llm://openrouter/acme/m?_provider=a&_nope=1"], tiers: ["cheapest"], evalScore: null, evalRef: null }])).toThrow(/^tier option bad: .*unknown pool option _nope/);
  });

  it("never routes to an observed endpoint outside the option's pool, however cheap", () => {
    const selection = selectTierRoute(base({ observations: [obs("acme/ocr-a", "cheap-unvetted", 0.001, 0.001), obs("acme/ocr-a", "parasail/fp8", 0.3, 1.2)], options: [ocrA] }));
    expect(selection.basis).toBe("live");
    if (selection.basis !== "live") return;
    expect(selection.provider.order).toEqual(["parasail"]);
    expect(selection.provider.allow_fallbacks).toBe(false);
  });

  // PAGE at 0.30/1.20 per MTok costs $0.00141; at 0.25/1.00, $0.001175; at 0.065/0.24, $0.0002895.
  it("sends one host: the fastest that keeps the 20% preferred margin, not the cheapest; the rest are retry alternatives", () => {
    const observations = [
      obs("acme/ocr-a", "fireworks", 0.3, 1.2, { latencyP50Ms: 500 }),
      obs("acme/ocr-a", "parasail/fp8", 0.25, 1.0, { latencyP50Ms: 900 }),
      obs("acme/ocr-a", "together", 0.2, 0.9, { latencyP50Ms: 1_200 }),
      obs("acme/ocr-b", "wafer/nvfp4", 0.065, 0.24, { latencyP50Ms: 1_500 }),
    ];
    // Earns $0.0015 a page: fireworks (fastest) keeps only 6%, parasail 21.7%, together 32%, wafer 80.7%.
    const selection = selectTierRoute(base({ observations, unitRevenueUsd: 0.0015 }));
    if (selection.basis !== "live") throw new Error(selection.basis);
    expect(selection.option.id).toBe("ocr-a");
    expect(selection.host).toMatchObject({ host: "parasail", endpoint: "parasail/fp8" });
    expect(selection).toMatchObject({ policy: "speed", marginWarning: null });
    expect(selection.provider).toEqual({ order: ["parasail"], allow_fallbacks: false, max_price: { prompt: 0.25, completion: 1.0 } });
    // Within the band by speed, then the rest by margin.
    expect(selection.alternatives.map((host) => host.host)).toEqual(["together", "fireworks"]);
    // Earning more makes the fastest host affordable.
    const richer = selectTierRoute(base({ observations, unitRevenueUsd: 0.002 }));
    if (richer.basis !== "live") throw new Error(richer.basis);
    expect(richer.provider.order).toEqual(["fireworks"]);
  });

  it("when no host keeps the preferred margin, takes the best margin without a loss, and warns under the global threshold", () => {
    const observations = [obs("acme/ocr-a", "fireworks", 0.3, 1.2, { latencyP50Ms: 400 }), obs("acme/ocr-a", "parasail", 0.25, 1.0, { latencyP50Ms: 2_000 })];
    // Fireworks costs $0.00141 and parasail $0.001175. At $0.00125 revenue: fireworks loses money, parasail keeps 6%.
    const thin = selectTierRoute(base({ options: [ocrA], observations, unitRevenueUsd: 0.00125 }));
    if (thin.basis !== "live") throw new Error(thin.basis);
    expect(thin).toMatchObject({ policy: "margin", provider: { order: ["parasail"] } });
    expect(thin.alternatives).toEqual([]);
    expect(thin.marginWarning?.threshold).toBe(0.1);
    expect(thin.marginWarning?.margin).toBeCloseTo(0.06, 5);
    // At $0.0016 parasail keeps 26.6% (in the band) and fireworks 11.9% (out): speed among the band picks parasail.
    const band = selectTierRoute(base({ options: [ocrA], observations, unitRevenueUsd: 0.0016 }));
    expect(band).toMatchObject({ basis: "live", policy: "speed", provider: { order: ["parasail"] }, marginWarning: null });
    // At $0.0014: parasail 16%, fireworks loses. Best margin, no warning (16% is over the 10% threshold).
    expect(selectTierRoute(base({ options: [ocrA], observations, unitRevenueUsd: 0.0014 }))).toMatchObject({ policy: "margin", provider: { order: ["parasail"] }, marginWarning: null });
  });

  it("the preferred margin and threshold come from the caller; a pool's _preferredMargin overrides the band for its hosts", () => {
    const observations = [obs("acme/ocr-a", "fireworks", 0.3, 1.2, { latencyP50Ms: 400 }), obs("acme/ocr-a", "parasail", 0.25, 1.0, { latencyP50Ms: 2_000 })];
    // $0.0016 revenue: fireworks keeps 11.9%, parasail 26.6%.
    expect(selectTierRoute(base({ options: [ocrA], observations, unitRevenueUsd: 0.0016 }))).toMatchObject({ provider: { order: ["parasail"] } });
    expect(selectTierRoute(base({ options: [ocrA], observations, unitRevenueUsd: 0.0016, preferredMargin: 0.1 }))).toMatchObject({ policy: "speed", provider: { order: ["fireworks"] }, marginWarning: null });
    expect(selectTierRoute(base({ options: [ocrA], observations, unitRevenueUsd: 0.0016, preferredMargin: 0.1, warnBelowMargin: 0.15 }))).toMatchObject({ provider: { order: ["fireworks"] }, marginWarning: { threshold: 0.15 } });
    const [loose] = defineTierOptions([{ id: "loose", capability: "page-ocr", pool: entries("acme/ocr-a", ["fireworks", "parasail"], "#preferredMargin=0.1"), tiers: ["cheapest"], evalScore: null, evalRef: null }]);
    expect(selectTierRoute(base({ options: [loose!], observations, unitRevenueUsd: 0.0016 }))).toMatchObject({ provider: { order: ["fireworks"] } });
  });

  it("checks a served request's actual margin against the threshold", () => {
    const fine = servedMargin({ usage: PAGE, inputUsdPerMTok: 0.25, outputUsdPerMTok: 1.0, unitRevenueUsd: 0.0016 });
    expect(fine.marginWarning).toBeNull();
    const long = servedMargin({ usage: { inputTokens: 1_500, outputTokens: 1_400 }, inputUsdPerMTok: 0.25, outputUsdPerMTok: 1.0, unitRevenueUsd: 0.0016 });
    expect(long.margin).toBeCloseTo(1 - 0.001775 / 0.0016, 6);
    expect(long.marginWarning).toEqual({ margin: long.margin, threshold: 0.1 });
  });

  it("without measured latency, follows the reviewed order (options as listed, hosts as pooled), not the lowest price", () => {
    const selection = selectTierRoute(base({ unitRevenueUsd: 0.01, observations: [
      obs("acme/ocr-b", "wafer/nvfp4", 0.065, 0.24), obs("acme/ocr-a", "parasail/fp8", 0.25, 1.0), obs("acme/ocr-a", "fireworks", 0.3, 1.2),
    ] }));
    if (selection.basis !== "live") throw new Error(selection.basis);
    expect(selection.provider.order).toEqual(["fireworks"]);
    expect(selection.alternatives.map((host) => host.host)).toEqual(["parasail"]);
  });

  it("takes each host's cheapest endpoint and drops endpoints that would lose money", () => {
    const revenue = (1_500 * 0.3 + 800 * 1.2) / 1e6 / 0.9;
    const selection = selectTierRoute(base({ options: [ocrA], unitRevenueUsd: revenue, observations: [obs("acme/ocr-a", "fireworks/us", 0.45, 1.8), obs("acme/ocr-a", "fireworks", 0.3, 1.2)] }));
    if (selection.basis !== "live") throw new Error(selection.basis);
    expect(selection.host).toMatchObject({ host: "fireworks", endpoint: "fireworks" });
    expect(selection.provider.max_price).toEqual({ prompt: 0.3, completion: 1.2 });
  });

  it("fails closed when every fresh host would lose money, is down or degraded", () => {
    const observations = [obs("acme/ocr-a", "fireworks", 0.3, 1.2), obs("acme/ocr-b", "wafer/nvfp4", 0.065, 0.24, { status: -2 }), obs("acme/ocr-b", "friendli", 0.15, 0.5, { uptime30m: 40 })];
    expect(selectTierRoute(base({ observations, unitRevenueUsd: 0.0001 })).basis).toBe("none");
  });

  it("uses the first host of the first option, alone, when every candidate's observations are stale", () => {
    const stale = obs("acme/ocr-a", "fireworks", 0.3, 1.2, { observedAt: new Date(NOW.getTime() - 3 * 3600_000) });
    expect(selectTierRoute(base({ observations: [stale] }))).toMatchObject({ basis: "static", option: { id: "ocr-a" }, provider: { order: ["fireworks"], allow_fallbacks: false } });
    expect(selectTierRoute(base({ tier: "best" }))).toMatchObject({ basis: "static", option: { id: "ocr-b" }, provider: { order: ["wafer/nvfp4"] } });
  });

  it("best takes the top eval score that has a host within the margin, then its fastest host; unmeasured options never best", () => {
    const observations = [
      obs("acme/ocr-a", "fireworks", 0.3, 1.2, { latencyP50Ms: 400 }),
      obs("acme/ocr-b", "wafer/nvfp4", 0.065, 0.24), obs("acme/ocr-b", "friendli", 0.15, 0.5, { latencyP50Ms: 1_500 }),
    ];
    const best = selectTierRoute(base({ tier: "best", observations, unitRevenueUsd: 0.01 }));
    expect(best).toMatchObject({ basis: "live", option: { id: "ocr-b" }, provider: { order: ["friendli"] } });
    // ocr-b's hosts down: best falls to the next score rather than failing.
    const down = observations.map((observation) => observation.model === "acme/ocr-b" ? { ...observation, status: -1 } : observation);
    expect(selectTierRoute(base({ tier: "best", observations: down, unitRevenueUsd: 0.01 }))).toMatchObject({ basis: "live", option: { id: "ocr-a" } });
    expect(selectTierRoute(base({ capability: "chat", tier: "best", observations: [obs("acme/chat", "deepinfra/fp8", 0.1, 0.3)] }))).toMatchObject({ basis: "none" });
  });

  it("a large pool still sends one host; the others are alternatives", () => {
    const hosts = Array.from({ length: 12 }, (_, index) => `h${index}`);
    const [wide] = defineTierOptions([{ id: "wide", capability: "page-ocr", pool: entries("acme/ocr-a", hosts), tiers: ["cheapest"], evalScore: null, evalRef: null }]);
    const observations = hosts.map((host, index) => obs("acme/ocr-a", host, 0.1, 0.5, { latencyP50Ms: 3_000 - index * 100 }));
    const selection = selectTierRoute(base({ options: [wide!], observations }));
    if (selection.basis !== "live") throw new Error(selection.basis);
    expect(selection.provider.order).toEqual(["h11"]);
    expect(selection.alternatives).toHaveLength(11);
  });

  it("applies a pool's _minUptime and _maxAge over the caller's defaults", () => {
    const [strict] = defineTierOptions([{ id: "strict", capability: "page-ocr", pool: entries("acme/ocr-a", ["fireworks", "parasail"], "&_minUptime=99&_maxAge=5m"), tiers: ["cheapest"], evalScore: null, evalRef: null }]);
    const observations = [obs("acme/ocr-a", "fireworks", 0.3, 1.2, { uptime30m: 97 }), obs("acme/ocr-a", "parasail", 0.3, 1.2)];
    const selection = selectTierRoute(base({ options: [strict!], observations: [...observations, obs("acme/ocr-a", "parasail", 0.3, 1.2, { observedAt: new Date(NOW.getTime() - 60_000) })] }));
    if (selection.basis !== "live") throw new Error(selection.basis);
    expect(selection.provider.order).toEqual(["parasail"]);
    // Ten-minute-old observations are stale under _maxAge=5m: the static pool is used.
    expect(selectTierRoute(base({ options: [strict!], observations }))).toMatchObject({ basis: "static" });
  });
});

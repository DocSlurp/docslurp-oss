import { describe, expect, it } from "vitest";
import { assertProviderPool, hostMatchesEndpoint, providerPoolPreferences, providerPoolProblems } from "../provider-pools.js";
import { assertTierOptions, selectTierRoute, type EndpointObservation, type TierOption, type TierSelectionInput } from "../provider-tiers.js";

const NOW = new Date("2026-11-12T18:00:00Z");
const PAGE = { inputTokens: 1_500, outputTokens: 800 };
const obs = (model: string, endpoint: string, input: number, output: number, extra: Partial<EndpointObservation> = {}): EndpointObservation => ({
  model, endpoint, observedAt: new Date(NOW.getTime() - 10 * 60_000), inputUsdPerMTok: input, outputUsdPerMTok: output,
  uptime30m: 100, status: 0, latencyP50Ms: null, ...extra,
});

const ocrA: TierOption = { id: "ocr-a", capability: "page-ocr", model: "acme/ocr-a", pool: { hosts: ["fireworks", "parasail", "together"], sort: "latency" }, tiers: ["cheapest", "fastest", "best"], evalScore: 0.91, evalRef: "run-a" };
const ocrB: TierOption = { id: "ocr-b", capability: "page-ocr", model: "acme/ocr-b", pool: { hosts: ["wafer/nvfp4", "friendli"], sort: "price" }, tiers: ["cheapest", "fastest", "best"], evalScore: 0.95, evalRef: "run-b" };
const chat: TierOption = { id: "chat-a", capability: "chat", model: "acme/chat", pool: { hosts: ["deepinfra/fp8"], sort: "price" }, tiers: ["cheapest"], evalScore: null, evalRef: null };
const options = [ocrA, ocrB, chat];
const base = (over: Partial<TierSelectionInput>): TierSelectionInput => ({ capability: "page-ocr", tier: "cheapest", options, observations: [], maxUnitCostUsd: null, unit: PAGE, now: NOW, ...over });

describe("provider pools", () => {
  it("accepts 1-5 distinct providers and refuses repeats, empty and oversized pools", () => {
    expect(providerPoolProblems({ hosts: ["fireworks", "parasail"], sort: "price" })).toEqual([]);
    expect(providerPoolProblems({ hosts: [], sort: "price" })).not.toEqual([]);
    expect(providerPoolProblems({ hosts: ["a", "b", "c", "d", "e", "f"], sort: "price" })).not.toEqual([]);
    expect(providerPoolProblems({ hosts: ["deepinfra/fp8", "deepinfra/fp8/flex"], sort: "price" })[0]).toContain("distinct providers");
    expect(providerPoolProblems({ hosts: ["a"], sort: "price", fallbackBeyondPool: true })).not.toEqual([]);
    expect(() => assertProviderPool({ hosts: ["Fireworks"], sort: "price" })).toThrow(/lowercase/);
  });

  it("matches a provider slug to its variants and a tag only to itself", () => {
    expect(hostMatchesEndpoint("fireworks", "fireworks/us")).toBe(true);
    expect(hostMatchesEndpoint("fireworks", "fireworks")).toBe(true);
    expect(hostMatchesEndpoint("wafer/nvfp4", "wafer/mxfp4")).toBe(false);
    expect(hostMatchesEndpoint("fire", "fireworks")).toBe(false);
  });

  it("sends only pool hosts: fallbacks stay inside an only pool; order pools fall back only when allowed", () => {
    expect(providerPoolPreferences({ hosts: ["fireworks", "parasail"], sort: "latency" })).toEqual({ only: ["fireworks", "parasail"], sort: "latency", allow_fallbacks: true });
    expect(providerPoolPreferences({ hosts: ["relace", "deepinfra"], sort: "order", fallbackBeyondPool: true })).toEqual({ order: ["relace", "deepinfra"], allow_fallbacks: true });
    expect(providerPoolPreferences({ hosts: ["fireworks"], sort: "price" }, ["fireworks", "evil-host"])).toEqual({ only: ["fireworks"], sort: "price", allow_fallbacks: true });
    expect(() => providerPoolPreferences({ hosts: ["fireworks"], sort: "price" }, ["evil-host"])).toThrow(/no host/);
  });
});

describe("tier selection", () => {
  it("validates options", () => {
    expect(() => assertTierOptions(options)).not.toThrow();
    expect(() => assertTierOptions([ocrA, ocrA])).toThrow(/duplicate/);
    expect(() => assertTierOptions([{ ...ocrA, evalScore: 1.5 }])).toThrow(/0-1/);
    expect(() => assertTierOptions([{ ...ocrA, evalRef: null }])).toThrow(/together/);
  });

  it("never routes to an observed endpoint outside the option's pool, however cheap", () => {
    const selection = selectTierRoute(base({ observations: [obs("acme/ocr-a", "cheap-unvetted", 0.001, 0.001), obs("acme/ocr-a", "parasail/fp8", 0.3, 1.2)], options: [ocrA] }));
    expect(selection.basis).toBe("live");
    if (selection.basis !== "live") return;
    expect(selection.provider.order).toEqual(["parasail"]);
    expect(selection.provider.allow_fallbacks).toBe(false);
  });

  it("picks the cheapest option and ranks its hosts by unit cost; max_price is the dearest chosen endpoint", () => {
    const selection = selectTierRoute(base({ observations: [
      obs("acme/ocr-a", "fireworks", 0.3, 1.2), obs("acme/ocr-a", "parasail/fp8", 0.3, 1.2),
      obs("acme/ocr-b", "wafer/nvfp4", 0.065, 0.24), obs("acme/ocr-b", "friendli", 0.15, 0.5),
    ] }));
    expect(selection.basis).toBe("live");
    if (selection.basis !== "live") return;
    expect(selection.option.id).toBe("ocr-b");
    expect(selection.provider.order).toEqual(["wafer/nvfp4", "friendli"]);
    expect(selection.provider.max_price).toEqual({ prompt: 0.15, completion: 0.5 });
  });

  it("takes each host's cheapest endpoint and skips dearer variants over the ceiling", () => {
    const ceiling = (1_500 * 0.3 + 800 * 1.2) / 1e6;
    const selection = selectTierRoute(base({ options: [ocrA], maxUnitCostUsd: ceiling, observations: [obs("acme/ocr-a", "fireworks/us", 0.45, 1.8), obs("acme/ocr-a", "fireworks", 0.3, 1.2)] }));
    if (selection.basis !== "live") throw new Error(selection.basis);
    expect(selection.hosts[0]).toMatchObject({ host: "fireworks", endpoint: "fireworks" });
    expect(selection.provider.max_price).toEqual({ prompt: 0.3, completion: 1.2 });
  });

  it("fails closed when fresh observations leave nothing under the ceiling, down or degraded", () => {
    const observations = [obs("acme/ocr-a", "fireworks", 0.3, 1.2), obs("acme/ocr-b", "wafer/nvfp4", 0.065, 0.24, { status: -2 }), obs("acme/ocr-b", "friendli", 0.15, 0.5, { uptime30m: 40 })];
    expect(selectTierRoute(base({ observations, maxUnitCostUsd: 0.0001 })).basis).toBe("none");
  });

  it("uses the static pool when every candidate's observations are stale", () => {
    const stale = obs("acme/ocr-a", "fireworks", 0.3, 1.2, { observedAt: new Date(NOW.getTime() - 3 * 3600_000) });
    const selection = selectTierRoute(base({ observations: [stale] }));
    expect(selection).toMatchObject({ basis: "static", option: { id: "ocr-a" }, provider: { only: ["fireworks", "parasail", "together"], sort: "latency" } });
    expect(selectTierRoute(base({ tier: "best" }))).toMatchObject({ basis: "static", option: { id: "ocr-b" } });
  });

  it("fastest ranks by measured latency, unmeasured last; best by eval score; unmeasured options never best", () => {
    const observations = [
      obs("acme/ocr-a", "fireworks", 0.3, 1.2, { latencyP50Ms: 900 }), obs("acme/ocr-a", "parasail/fp8", 0.3, 1.2, { latencyP50Ms: 2_000 }),
      obs("acme/ocr-b", "wafer/nvfp4", 0.065, 0.24), obs("acme/ocr-b", "friendli", 0.15, 0.5, { latencyP50Ms: 1_500 }),
    ];
    const fastest = selectTierRoute(base({ tier: "fastest", observations }));
    if (fastest.basis !== "live") throw new Error(fastest.basis);
    expect(fastest.option.id).toBe("ocr-a");
    expect(fastest.provider.order).toEqual(["fireworks", "parasail"]);
    const best = selectTierRoute(base({ tier: "best", observations }));
    expect(best).toMatchObject({ basis: "live", option: { id: "ocr-b" } });
    expect(selectTierRoute(base({ capability: "chat", tier: "best", observations: [obs("acme/chat", "deepinfra/fp8", 0.1, 0.3)] }))).toMatchObject({ basis: "none" });
  });

  it("caps a live route at five hosts", () => {
    const wide: TierOption = { ...ocrA, id: "wide", pool: { hosts: ["a1", "b1", "c1", "d1", "e1"], sort: "price" } };
    const observations = ["a1", "b1", "c1", "d1", "e1"].map((host, index) => obs("acme/ocr-a", host, 0.1 + index / 100, 0.5));
    const selection = selectTierRoute(base({ options: [wide], observations }));
    if (selection.basis !== "live") throw new Error(selection.basis);
    expect(selection.provider.order).toEqual(["a1", "b1", "c1", "d1", "e1"]);
  });
});

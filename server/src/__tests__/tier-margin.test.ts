import { describe, expect, it, vi } from "vitest";
import { defineTierOptions, selectTierRoute, type EndpointObservation } from "@docslurp/shared";
import { tierMarginPolicy, warnOnServedMargin, warnOnTierSelection } from "../services/tier-margin.js";

const NOW = new Date("2026-11-12T18:00:00Z");
const PAGE = { inputTokens: 1_500, outputTokens: 800 };
const obs = (endpoint: string, input: number, output: number): EndpointObservation => ({
  model: "acme/ocr", endpoint, observedAt: NOW, inputUsdPerMTok: input, outputUsdPerMTok: output, uptime30m: 100, status: 0, latencyP50Ms: null,
});
const options = defineTierOptions([{ id: "ocr", capability: "page-ocr", pool: ["llm://openrouter/acme/ocr?_provider=parasail"], tiers: ["cheapest"], evalScore: null, evalRef: null }]);
const select = (unitRevenueUsd: number) => selectTierRoute({ capability: "page-ocr", tier: "cheapest", options, observations: [obs("parasail", 0.25, 1.0)], unitRevenueUsd, unit: PAGE, now: NOW });
const context = { tier: "cheapest", capability: "page-ocr", requestId: "req-1" };

describe("tier margin warnings", () => {
  it("reads the policy from env with 20% / 10% defaults and refuses malformed values", () => {
    expect(tierMarginPolicy({})).toEqual({ preferredMargin: 0.2, warnBelowMargin: 0.1 });
    expect(tierMarginPolicy({ DOCSLURP_TIER_PREFERRED_MARGIN: "0.3", DOCSLURP_TIER_MARGIN_WARN_BELOW: "0.12" })).toEqual({ preferredMargin: 0.3, warnBelowMargin: 0.12 });
    expect(() => tierMarginPolicy({ DOCSLURP_TIER_MARGIN_WARN_BELOW: "10" })).toThrow(/DOCSLURP_TIER_MARGIN_WARN_BELOW/);
    expect(() => tierMarginPolicy({ DOCSLURP_TIER_PREFERRED_MARGIN: "lots" })).toThrow(/DOCSLURP_TIER_PREFERRED_MARGIN/);
  });

  it("logs a pick under the global threshold, and stays quiet above it", () => {
    const emit = vi.fn();
    // Parasail costs $0.001175 a page: 6% margin at $0.00125, 26.6% at $0.0016.
    expect(warnOnTierSelection(select(0.00125), context, emit)).toBe(true);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      severityText: "warn", eventName: "docslurp.route_tier.margin_low",
      attributes: expect.objectContaining({ stage: "selected", host: "parasail", policy: "margin", threshold: 0.1, requestId: "req-1" }),
    }));
    emit.mockClear();
    expect(warnOnTierSelection(select(0.0016), context, emit)).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("logs a served request whose actual usage drops it under the threshold", () => {
    const emit = vi.fn();
    const base = { context, optionId: "ocr", host: "parasail", inputUsdPerMTok: 0.25, outputUsdPerMTok: 1.0, unitRevenueUsd: 0.0016, policy: { preferredMargin: 0.2, warnBelowMargin: 0.1 } };
    expect(warnOnServedMargin({ ...base, usage: PAGE }, emit).warned).toBe(false);
    const long = warnOnServedMargin({ ...base, usage: { inputTokens: 1_500, outputTokens: 1_400 } }, emit);
    expect(long.warned).toBe(true);
    expect(long.margin).toBeLessThan(0);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ attributes: expect.objectContaining({ stage: "served", outputTokens: 1_400 }) }));
  });
});

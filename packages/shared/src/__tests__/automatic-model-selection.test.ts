import { describe, expect, it } from "vitest";

import {
  DEFAULT_RESTRICTED_FALLBACK_MODEL,
  NO_AUTOMATIC_SELECTION_MODEL_FAMILIES,
  TIER_OPTIONS,
  assertNoAutomaticSelectionDenied,
  assertTierOptions,
  buildRoutingTargetCatalog,
  defineTierOptions,
  isAutomaticSelectionDenied,
  restrictedFallbackModel,
  visionModelCatalog,
  withoutAutomaticSelectionDenied,
} from "../index.js";
import { SPEED_BOOST_MODEL_SWAPS } from "../project-chat-models.js";

describe("models never selected automatically", () => {
  it("lists DeepSeek V4.1 Flash, matched across builds, variants, providers and URIs", () => {
    expect(NO_AUTOMATIC_SELECTION_MODEL_FAMILIES).toContain("deepseek-v4.1-flash");
    for (const ref of [
      "deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4.1-flash-1017",
      "deepseek/deepseek-v4.1-flash-1017:nitro",
      "deepseek/deepseek-v4.1-flash:nitro",
      "deepseek-v4.1-flash",
      "llm://openrouter/deepseek/deepseek-v4.1-flash-1017",
      "llm://openrouter/deepseek/deepseek-v4.1-flash-1017?_provider=fireworks&_sort=latency",
      "llm://deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017",
      "vlm:openrouter/deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4.1-flash-20261017",
    ]) expect(isAutomaticSelectionDenied(ref), ref).toBe(true);
  });

  it("is not bypassed by percent-encoding, stacked variants, provider suffixes or the Fireworks spelling", () => {
    for (const ref of [
      // Council L1 probes (2026-11-13).
      "llm://openrouter/deepseek%2Fdeepseek-v4.1-flash-1017",
      "llm://openrouter/deepseek%252Fdeepseek-v4.1-flash-1017",
      "deepseek%2fdeepseek-v4.1-flash",
      "llm://openrouter/deepseek/deepseek%2Dv4%2E1-flash",
      "deepseek/deepseek-v4.1-flash:nitro:free",
      "deepseek/deepseek-v4.1-flash:extended:nitro",
      "deepseek/deepseek-v4.1-flash@fireworks",
      "deepseek/deepseek-v4.1-flash-1017@fireworks:nitro",
      "accounts/fireworks/models/deepseek-v4p1-flash",
      "llm://fireworks/accounts/fireworks/models/deepseek-v4p1-flash-1017",
      "llm://openrouter/deepseek%2Fdeepseek-v4.1-flash%ZZ",
      // A route label with its setting after the id.
      "deepseek/deepseek-v4.1-flash (effort none)",
    ]) expect(isAutomaticSelectionDenied(ref), ref).toBe(true);
    expect(isAutomaticSelectionDenied("z-ai/glm-5.3-flash (effort minimal)")).toBe(false);
  });

  it("does not catch neighbouring models", () => {
    for (const ref of ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4.1", "deepseek/deepseek-v4.1-pro", "deepseek/deepseek-v4p1", "deepseek/deepseek-v4.1-flashy", "z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash@wafer:nitro", "openai/gpt-6-luna", "", null, undefined]) {
      expect(isAutomaticSelectionDenied(ref), String(ref)).toBe(false);
    }
    expect(withoutAutomaticSelectionDenied(["openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash-1017", "z-ai/glm-5.3-flash"]))
      .toEqual(["openai/gpt-6-luna", "z-ai/glm-5.3-flash"]);
    expect(() => assertNoAutomaticSelectionDenied("list", ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4.1-flash:nitro"])).toThrow(/deepseek-v4\.1-flash:nitro/);
  });

  it("is in no route-tier pool, and defining one that names it fails", () => {
    assertTierOptions(TIER_OPTIONS);
    for (const option of TIER_OPTIONS) {
      expect(isAutomaticSelectionDenied(option.model), option.id).toBe(false);
      for (const host of option.pool.hosts) expect(isAutomaticSelectionDenied(String(host)), option.id).toBe(false);
    }
    expect(() => defineTierOptions([{
      id: "chat/denied", capability: "chat", pool: ["llm://openrouter/deepseek/deepseek-v4.1-flash-1017?_provider=fireworks"],
      tiers: ["cheapest"], evalScore: null, evalRef: null,
    }])).toThrow(/never selected automatically/);
  });

  it("is never a Speed boost swap target", () => {
    for (const [from, to] of Object.entries(SPEED_BOOST_MODEL_SWAPS) as [string, string][]) expect(isAutomaticSelectionDenied(to), `${from} -> ${to}`).toBe(false);
  });

  it("is never the restricted-region fallback, even when configured", () => {
    expect(isAutomaticSelectionDenied(DEFAULT_RESTRICTED_FALLBACK_MODEL)).toBe(false);
    expect(restrictedFallbackModel({ OPENROUTER_RESTRICTED_FALLBACK_MODEL: "deepseek/deepseek-v4.1-flash-1017" })).toBeUndefined();
  });

  it("is never an admitted page-router target, although the vision catalog still offers it explicitly", () => {
    const catalog = buildRoutingTargetCatalog({ visionCatalog: visionModelCatalog as never });
    expect(catalog.targets.some((target) => isAutomaticSelectionDenied(target.id) || isAutomaticSelectionDenied(target.ref.modelUri ?? ""))).toBe(false);
    expect(catalog.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "vlm:openrouter/deepseek/deepseek-v4.1-flash-1017", reason: "automatic-selection-denied" }),
    ]));
    // An explicit choice is unaffected: the catalog still lists it for projects that configure it.
    expect(visionModelCatalog.some((entry) => entry.id === "deepseek/deepseek-v4.1-flash-1017")).toBe(true);
  });
});

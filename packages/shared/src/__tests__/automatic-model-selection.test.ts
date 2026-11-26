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

/**
 * The denylist mechanism, exercised on a fixture list (the shipped list is empty since 2026-11-15: DeepSeek V4.1 Flash,
 * once listed, is admitted by the automatic-call margin gate instead). The matching rules are what a future entry gets.
 */
const FIXTURE = ["deepseek-v4.1-flash", "deepseek-v4p1-flash"];
const denied = (ref: string | null | undefined) => isAutomaticSelectionDenied(ref, FIXTURE);

describe("models never selected automatically", () => {
  it("lists no model today: DeepSeek V4.1 Flash is admitted by the margin gate, not refused by name", () => {
    expect(NO_AUTOMATIC_SELECTION_MODEL_FAMILIES).toEqual([]);
    for (const ref of ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash-1017:nitro", "llm://openrouter/deepseek/deepseek-v4.1-flash-1017?_provider=fireworks"]) {
      expect(isAutomaticSelectionDenied(ref), ref).toBe(false);
    }
  });

  it("matches a listed family across builds, variants, providers and URIs", () => {
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
    ]) expect(denied(ref), ref).toBe(true);
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
      // Council round 2, L3.
      "deepseek/deepseek-v4-1-flash",
      "deepseek/deepseek_v4_1_flash",
      "deepseek.deepseek-v4.1-flash-v1:0",
      "us.deepseek.deepseek-v4.1-flash-v1:0",
      "deepseek/deepseek-v4.1-flash.1017",
      "deepseek\\deepseek-v4.1-flash",
      "deepseek%5Cdeepseek-v4.1-flash",
    ]) expect(denied(ref), ref).toBe(true);
    // Provider aliases that do not name the family are not caught (documented).
    expect(denied("deepseek/deepseek-chat")).toBe(false);
    expect(denied("z-ai/glm-5.3-flash (effort minimal)")).toBe(false);
  });

  it("does not catch neighbouring models", () => {
    for (const ref of ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-1017", "deepseek/deepseek-v4.11-flash", "deepseek/deepseek-v4.1", "deepseek/deepseek-v4.1-pro", "deepseek/deepseek-v4p1", "deepseek/deepseek-v4.1-flashy", "z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash@wafer:nitro", "openai/gpt-6-luna", "", null, undefined]) {
      expect(denied(ref), String(ref)).toBe(false);
    }
    expect(withoutAutomaticSelectionDenied(["openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash-1017", "z-ai/glm-5.3-flash"], FIXTURE))
      .toEqual(["openai/gpt-6-luna", "z-ai/glm-5.3-flash"]);
    expect(() => assertNoAutomaticSelectionDenied("list", ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4.1-flash:nitro"], FIXTURE)).toThrow(/deepseek-v4\.1-flash:nitro/);
  });

  it("route-tier pools pass the list; a DeepSeek option is no longer refused by name (the margin gate prices it per request)", () => {
    assertTierOptions(TIER_OPTIONS);
    for (const option of TIER_OPTIONS) {
      expect(isAutomaticSelectionDenied(option.model), option.id).toBe(false);
      for (const host of option.pool.hosts) expect(isAutomaticSelectionDenied(String(host)), option.id).toBe(false);
    }
    expect(() => defineTierOptions([{
      id: "chat/deepseek", capability: "chat", pool: ["llm://openrouter/deepseek/deepseek-v4.1-flash-1017?_provider=fireworks"],
      tiers: ["balanced"], evalScore: null, evalRef: null,
    }])).not.toThrow();
    // The shipped options still name no DeepSeek model: adding one is a reviewed quality decision, not this change.
    expect(TIER_OPTIONS.some((option) => /deepseek/i.test(option.model))).toBe(false);
  });

  it("is never a Speed boost swap target", () => {
    for (const [from, to] of Object.entries(SPEED_BOOST_MODEL_SWAPS) as [string, string][]) expect(isAutomaticSelectionDenied(to), `${from} -> ${to}`).toBe(false);
  });

  it("the restricted-region fallback is not the denylist's: an operator may configure DeepSeek; the default is unchanged", () => {
    expect(isAutomaticSelectionDenied(DEFAULT_RESTRICTED_FALLBACK_MODEL)).toBe(false);
    expect(restrictedFallbackModel({ OPENROUTER_RESTRICTED_FALLBACK_MODEL: "deepseek/deepseek-v4.1-flash-1017" })).toBe("deepseek/deepseek-v4.1-flash-1017");
  });

  it("the page-router catalog admits no denylisted target; DeepSeek is no longer rejected by name (worker admission applies the margin gate)", () => {
    const catalog = buildRoutingTargetCatalog({ visionCatalog: visionModelCatalog as never });
    expect(catalog.targets.some((target) => isAutomaticSelectionDenied(target.id) || isAutomaticSelectionDenied(target.ref.modelUri ?? ""))).toBe(false);
    expect(catalog.rejected.some((rejection) => rejection.reason === "automatic-selection-denied")).toBe(false);
    expect(visionModelCatalog.some((entry) => entry.id === "deepseek/deepseek-v4.1-flash-1017")).toBe(true);
  });
});

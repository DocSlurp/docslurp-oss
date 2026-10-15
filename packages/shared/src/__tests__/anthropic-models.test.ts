import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_MODELS,
  isDeprecatedAnthropicModel,
  parseAnthropicModelId,
  resolveSupportedModelId,
} from "../anthropic-models.js";
import { estimateAiUsageCostCents } from "../usage.js";

describe("anthropic model policy", () => {
  it("supports exactly the 5.5 generation, including Haiku 5.5", () => {
    expect(ANTHROPIC_MODELS.map((model) => model.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    for (const model of ANTHROPIC_MODELS) {
      expect(isDeprecatedAnthropicModel(model.id)).toBe(false);
      expect(isDeprecatedAnthropicModel(model.openRouterId)).toBe(false);
    }
  });

  it("parses native, dated, legacy and OpenRouter ids", () => {
    expect(parseAnthropicModelId("claude-haiku-4-5-20251001")).toEqual({ family: "haiku", version: 4.5, openRouter: false });
    expect(parseAnthropicModelId("claude-sonnet-4-0")).toEqual({ family: "sonnet", version: 4, openRouter: false });
    expect(parseAnthropicModelId("claude-3-5-sonnet-20241022")).toEqual({ family: "sonnet", version: 3.5, openRouter: false });
    expect(parseAnthropicModelId("anthropic/claude-opus-4.8:batch")).toEqual({ family: "opus", version: 4.8, openRouter: true });
    expect(parseAnthropicModelId("openai/gpt-6.1-sol")).toBeNull();
  });

  it.each([
    ["claude-haiku-4-5-20251001", "claude-haiku-5-5"],
    ["claude-sonnet-4-20250514", "claude-sonnet-5-5"],
    ["claude-sonnet-5", "claude-sonnet-5-5"],
    ["claude-opus-5", "claude-opus-5-5"],
    ["claude-opus-4-8", "claude-opus-5-5"],
    ["claude-fable-5-1", "claude-opus-5-5"],
    ["claude-3-5-sonnet-20241022", "claude-sonnet-5-5"],
    ["anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-5.5"],
    ["anthropic/claude-fable-5.1", "anthropic/claude-opus-5.5"],
    ["anthropic/claude-haiku-4.5", "anthropic/claude-haiku-5.5"],
  ])("replaces deprecated %s with %s", (requested, replacement) => {
    expect(resolveSupportedModelId(requested)).toEqual({ model: replacement, requested, deprecated: true });
  });

  it("passes supported and non-Claude ids through", () => {
    expect(resolveSupportedModelId("claude-opus-5-5").deprecated).toBe(false);
    expect(resolveSupportedModelId("anthropic/claude-haiku-5.5").model).toBe("anthropic/claude-haiku-5.5");
    expect(resolveSupportedModelId("z-ai/glm-5.3-flash")).toEqual({ model: "z-ai/glm-5.3-flash", requested: "z-ai/glm-5.3-flash", deprecated: false });
  });

  it("prices Haiku 5.5 with its long-context tier", () => {
    // 50K input at $0.10/MTok => 0.5 cents.
    expect(estimateAiUsageCostCents({ provider: "anthropic", model: "claude-haiku-5-5", inputTokens: 50_000, outputTokens: 0 })).toBeCloseTo(0.5);
    // Above 100K input tokens the $0.50/$2.50 rates apply.
    expect(estimateAiUsageCostCents({ provider: "anthropic", model: "claude-haiku-5-5", inputTokens: 200_000, outputTokens: 10_000 })).toBeCloseTo(10 + 2.5);
    expect(estimateAiUsageCostCents({ provider: "openrouter", model: "anthropic/claude-sonnet-5.5", inputTokens: 1_000, outputTokens: 1_000 })).toBeCloseTo(0.2 + 1);
  });
});

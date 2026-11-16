import { afterEach, describe, expect, it, vi } from "vitest";

import { installTestPricing, resetPricingProviderForTests, setEndpointPricesForTests } from "@docslurp/shared";

import { admittedChatFailover, failoverCandidates } from "./chat-failover.js";

const MODELS = ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5", "z-ai/glm-5.3-flash"];

describe("chat failover under the automatic-call margin gate", () => {
  afterEach(() => {
    resetPricingProviderForTests();
    setEndpointPricesForTests(null);
    vi.restoreAllMocks();
  });

  it("orders candidates without the turn's own model (its Nitro variant included); none when failover is off", () => {
    expect(failoverCandidates(MODELS, "z-ai/glm-5.3-flash")).toEqual(["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"]);
    expect(failoverCandidates(MODELS, "openai/gpt-6-luna:nitro")).toEqual(["anthropic/claude-haiku-5.5", "z-ai/glm-5.3-flash"]);
    expect(failoverCandidates(MODELS, "openai/gpt-6-luna", false)).toEqual([]);
  });

  it("admits the first candidate that keeps the margin at its current price, skipping (logged) those that do not", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const candidates = failoverCandidates(MODELS, "z-ai/glm-5.3-flash");
    // Nothing billed (open pricing): the first candidate, no price needed.
    expect((await admittedChatFailover(candidates))?.model).toBe("openai/gpt-6-luna");
    // Synthetic values: Luna's answer bills too little to cover any price.
    const seen: unknown[] = [];
    installTestPricing({ automaticCallValueUsd: (call) => { seen.push(call); return call.model === "openai/gpt-6-luna" ? 1e-9 : 0.04; } });
    // No fresh listing and no cap: every candidate fails closed.
    expect(await admittedChatFailover(candidates)).toBeNull();
    setEndpointPricesForTests({
      "openai/gpt-6-luna": { endpoints: [{ endpoint: "openai", inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 }] },
      "anthropic/claude-haiku-5.5": { endpoints: [{ endpoint: "anthropic", inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 }] },
    });
    const admitted = await admittedChatFailover(candidates, { inputTokens: 40_000, outputTokens: 2_048 });
    expect(admitted?.model).toBe("anthropic/claude-haiku-5.5");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[automatic-margin\] skipped label=chat failover kind=chat-answer model=openai\/gpt-6-luna/));
    // Priced at the turn's own size and role.
    expect(seen.at(-1)).toMatchObject({ kind: "chat-answer", role: "failover", inputTokens: 40_000, outputTokens: 2_048 });
    expect(admitted?.decision.worstCostUsd).toBeCloseTo((40_000 * 0.1 + 2_048 * 0.5) / 1e6, 10);
  });
});

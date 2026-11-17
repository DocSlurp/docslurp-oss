import { expect, it } from "vitest";
import { currentProviderPolicy, runWithProviderRateScope } from "../lib/provider-rate-limit.js";
import { visionModelProfile, openRouterProviderParams } from "../tools/vision-model-profiles.js";
it("keeps concurrent org scopes and nested opt-ins independent", async () => {
  expect(currentProviderPolicy().speedBoost).toBe(false);
  await Promise.all([true, false].map(speedBoost => runWithProviderRateScope({ orgId: String(speedBoost), allowChinaProviders: false, speedBoost }, async () => {
    await Promise.resolve();
    expect(currentProviderPolicy()).toEqual({ allowChinaProviders: false, speedBoost });
    await runWithProviderRateScope({ orgId: "nested" }, async () => expect(currentProviderPolicy().speedBoost).toBe(false));
    expect(currentProviderPolicy().speedBoost).toBe(speedBoost);
  })));
  expect(currentProviderPolicy().speedBoost).toBe(false);
});
it("preserves vision reasoning and output limits, and keeps speed boost inside the evidenced host allowlist", () => {
  expect(visionModelProfile("z-ai/glm-5.3-flash:nitro")).toBe(visionModelProfile("z-ai/glm-5.3-flash"));
  // Nitro ranks by throughput but only among the profile's stated US/EU hosts.
  expect(openRouterProviderParams("z-ai/glm-5.3-flash:nitro")).toEqual({ provider: { only: ["wafer/us", "friendli", "inference-net/us"], allow_fallbacks: true } });
  expect(openRouterProviderParams("openai/gpt-6-luna:nitro")).toEqual({ provider: { only: ["amazon-bedrock/us-east-1", "azure/us"], allow_fallbacks: true } });
  expect(openRouterProviderParams("z-ai/glm-5.3-flash").provider).toBeDefined();
});

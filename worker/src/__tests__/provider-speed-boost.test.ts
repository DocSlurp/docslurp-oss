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
it("preserves vision reasoning and output limits without baseline provider ordering", () => {
  expect(visionModelProfile("z-ai/glm-5.3-flash:nitro")).toBe(visionModelProfile("z-ai/glm-5.3-flash"));
  expect(openRouterProviderParams("z-ai/glm-5.3-flash:nitro")).toEqual({});
  expect(openRouterProviderParams("z-ai/glm-5.3-flash").provider).toBeDefined();
});

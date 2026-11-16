import { afterEach, describe, expect, it, vi } from "vitest";

import { installTestPricing, resetPricingProviderForTests } from "@docslurp/shared";

import { buildRuntimeCatalog, vlmTargetMarginProblem } from "./runtime.js";

describe("page-router targets under the automatic-call margin gate", () => {
  afterEach(() => {
    resetPricingProviderForTests();
    vi.restoreAllMocks();
  });

  it("keeps every hosted target when nothing is billed (open pricing), and drops those whose page read misses the margin", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = { OPENROUTER_API_KEY: "test-key" } as NodeJS.ProcessEnv;
    const open = buildRuntimeCatalog({ env }).targets.filter((target) => target.kind === "hosted-vlm");
    expect(open.length).toBeGreaterThan(0);
    for (const target of open) expect(vlmTargetMarginProblem(target), target.id).toBeNull();
    installTestPricing({ automaticCallValueUsd: () => 1e-9 });
    expect(buildRuntimeCatalog({ env }).targets.filter((target) => target.kind === "hosted-vlm")).toEqual([]);
    expect(vlmTargetMarginProblem(open[0]!)).toMatch(/automatic-call margin: below the minimum margin/);
    installTestPricing({ automaticCallValueUsd: () => 1 });
    expect(buildRuntimeCatalog({ env }).targets.filter((target) => target.kind === "hosted-vlm").length).toBe(open.length);
  });
});

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultPipelineFeatures,
  DISTINCT_TEST_PRICING,
  estimatePipelineWork,
  compilePipelinePlan,
  installTestPricing,
  quoteEstimate,
  quoteSettingsForPipeline,
  QuoteSettingsError,
  resetPricingProviderForTests,
} from "../index.js";

/**
 * The public quote (POST /v1/estimate, estimateUpload().quote, SDK/CLI/MCP uploadEstimate) prices chart export like
 * ingest resolves it: request tier, else the project's, else the caller's origin default, capped by the deploy switch.
 */
const ON = { STRIPE_SECRET_KEY: "sk_test", DOCSLURP_CHART_EXPORT: "on" };
const files = [{ name: "q3-earnings.pdf", size: 2_400_000, pages: 40 }];
const charts = (quote: ReturnType<typeof quoteEstimate>) => quote.lines.find((line) => line.id === "charts");

afterEach(() => resetPricingProviderForTests());

describe("chart export in the public quote", () => {
  it("prices the free tier at 0 credits: no charts line, the same ingest credits as off", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const off = quoteEstimate({ files, settings: { chartExport: "off" } }, { env: ON });
    const free = quoteEstimate({ files, settings: { chartExport: "free" } }, { env: ON });
    expect(free.settings.chartExport).toBe("free");
    expect(charts(free)).toBeUndefined();
    expect(free.ingest.credits).toEqual(off.ingest.credits);
  });

  it("resolves no tier to off for machine callers (API, MCP, SDK, CLI) and free for the app", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    expect(quoteEstimate({ files }, { env: ON }).settings.chartExport).toBe("off");
    expect(quoteEstimate({ files }, { env: ON, origin: "machine" }).settings.chartExport).toBe("off");
    expect(quoteEstimate({ files }, { env: ON, origin: "app" }).settings.chartExport).toBe("free");
    expect(quoteEstimate({ files }, { env: { ...ON, DOCSLURP_CHART_EXPORT_API_DEFAULT: "free" }, origin: "machine" }).settings.chartExport).toBe("free");
    expect(quoteEstimate({ files }, { env: { ...ON, DOCSLURP_CHART_EXPORT_APP_DEFAULT: "off" }, origin: "app" }).settings.chartExport).toBe("off");
    // An explicit project tier wins over both defaults; the request wins over the project.
    const base = quoteSettingsForPipeline({ ...defaultPipelineFeatures, chartExport: { ...defaultPipelineFeatures.chartExport, tier: "models" } });
    expect(quoteEstimate({ files }, { env: ON, origin: "machine", base }).settings.chartExport).toBe("models");
    expect(quoteEstimate({ files, settings: { chartExport: "off" } }, { env: ON, origin: "app", base }).settings.chartExport).toBe("off");
    expect(quoteSettingsForPipeline(defaultPipelineFeatures).chartExport).toBeUndefined();
  });

  it("adds a neutral charts line for the models tier and counts it in ingest", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const off = quoteEstimate({ files, settings: { chartExport: "off" } }, { env: ON });
    const models = quoteEstimate({ files, settings: { chartExport: "models" } }, { env: ON });
    const line = charts(models)!;
    expect(line).toMatchObject({ id: "charts", label: "Charts read with AI", period: "once" });
    expect(line.credits.high).toBeGreaterThan(0);
    expect(models.ingest.credits!.high).toBeCloseTo(off.ingest.credits!.high + line.credits.high, 3);
    expect(models.rates.pagesPerDollar!.high).toBeLessThan(off.rates.pagesPerDollar!.high);
    expect(JSON.stringify(models.lines)).not.toMatch(/llm:\/\/|gemini|gpt|glm|luna|openrouter/i);
  });

  it("the deploy switch is the ceiling: a project on models quotes free under DOCSLURP_CHART_EXPORT=free, and a requested models is refused", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const base = quoteSettingsForPipeline({ ...defaultPipelineFeatures, chartExport: { ...defaultPipelineFeatures.chartExport, tier: "models" } });
    for (const flag of ["free", "off", undefined]) {
      const env = { STRIPE_SECRET_KEY: "sk_test", DOCSLURP_CHART_EXPORT: flag };
      const quote = quoteEstimate({ files }, { env, base });
      expect(charts(quote)).toBeUndefined();
      expect(quote.settings.chartExport).toBe(flag === "free" ? "free" : "off");
      expect(() => quoteEstimate({ files, settings: { chartExport: "models" } }, { env })).toThrow(QuoteSettingsError);
    }
    expect(() => quoteEstimate({ files, settings: { chartExport: "smart" as never } }, { env: ON })).toThrow();
  });

  it("estimatePipelineWork prices chart reads only with the switch on, never at free", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const features = { ...defaultPipelineFeatures, chartExport: { ...defaultPipelineFeatures.chartExport, tier: "models" as const } };
    const stages = compilePipelinePlan(features).stageOrder;
    const on = estimatePipelineWork({ features, stages, pages: 400, documents: 4, env: ON });
    const free = estimatePipelineWork({ features, stages, pages: 400, documents: 4, env: { ...ON, DOCSLURP_CHART_EXPORT: "free" } });
    expect(on.basis).toMatch(/chart export/);
    expect(free.basis).not.toMatch(/chart export/);
    expect(free.credits!.high).toBeLessThan(on.credits!.high);
  });
});

import { afterEach, describe, expect, it } from "vitest";

import {
  BILLABLE_UNIT_METRICS,
  CHART_EXPORT_DOCUMENT_CAPS,
  chartExportAvailable,
  CHART_EXPORT_CHARGING_STAGES,
  CHART_EXPORT_VISUALS_PER_PAGE_PRIOR,
  DISTINCT_TEST_PRICING,
  OPEN_PRICING,
  VISUAL_SOURCES,
  chartExportConfigOf,
  chartExportModelCallsPerVisual,
  compilePipelinePlan,
  defaultPipelineFeatures,
  estimatePipelineWork,
  expectedBillableVisuals,
  installTestPricing,
  isBillableVisualSource,
  normalizePipelineFeatures,
  resetPricingProviderForTests,
  visualExportCredits,
  type PipelineFeatures,
} from "../index.js";

afterEach(() => resetPricingProviderForTests());

const env = { STRIPE_SECRET_KEY: "sk_test", DOCSLURP_CHART_EXPORT: "on" };
const base = normalizePipelineFeatures(defaultPipelineFeatures);
// Tolerant of the pipeline schema not yet carrying `chartExport`: the estimate reads it off the features object.
const withChartExport = (chartExport: Record<string, unknown>): PipelineFeatures => ({ ...base, chartExport } as unknown as PipelineFeatures);

describe("chart export billable sources", () => {
  it("only model sources are billable", () => {
    expect(VISUAL_SOURCES.filter(isBillableVisualSource)).toEqual(["svg-assisted", "vision"]);
  });
  it("has its own unit metric", () => {
    expect(BILLABLE_UNIT_METRICS.chartExport).toBe("feature-chart-export");
  });
});

describe("chartExportModelCallsPerVisual", () => {
  it("derived formats share one call, direct formats each cost one", () => {
    expect(chartExportModelCallsPerVisual([])).toBe(0);
    expect(chartExportModelCallsPerVisual(["description", "mermaid", "csv"])).toBe(1);
    expect(chartExportModelCallsPerVisual(["description", "matplotlib"], { matplotlib: "direct" })).toBe(2);
    expect(chartExportModelCallsPerVisual(["matplotlib", "vega-lite"], { matplotlib: "direct", "vega-lite": "direct" })).toBe(2);
    expect(chartExportModelCallsPerVisual(["mermaid", "mermaid"])).toBe(1);
  });
});

describe("visualExportCredits", () => {
  it("is zero under the open default", () => {
    expect(OPEN_PRICING.visualExportCredits({ visuals: 100, callsPerVisual: 3, formats: ["mermaid"] })).toBe(0);
    expect(visualExportCredits({ visuals: 100, source: "vision", formats: ["mermaid"] })).toBe(0);
  });
  it("charges model sources through the provider and never deterministic ones", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    expect(visualExportCredits({ visuals: 10, source: "vision", formats: ["description", "mermaid"] })).toBeCloseTo(0.7);
    expect(visualExportCredits({ visuals: 10, source: "svg-assisted", formats: ["description"], modes: { description: "direct" } })).toBeCloseTo(0.7);
    expect(visualExportCredits({ visuals: 10, source: "vision", formats: ["description", "matplotlib"], modes: { matplotlib: "direct" } })).toBeCloseTo(1.4);
    for (const source of ["office-chart-xml", "embedded-spec", "svg-geometry"] as const) {
      expect(visualExportCredits({ visuals: 10, source, formats: ["description"] })).toBe(0);
    }
    expect(visualExportCredits({ visuals: -3, source: "vision", formats: ["description"] })).toBe(0);
    expect(visualExportCredits({ visuals: Number.NaN, source: "vision", formats: ["description"] })).toBe(0);
  });
  it("rejects a provider returning a negative or non-finite charge", () => {
    installTestPricing({ visualExportCredits: () => -1 });
    expect(() => visualExportCredits({ visuals: 1, source: "vision", formats: ["mermaid"] })).toThrow(/invalid visual export credits/);
  });
});

describe("expectedBillableVisuals", () => {
  it("uses recorded stats and subtracts deterministic exports", () => {
    const stats = { charts: 12, diagrams: 4, bySource: { "office-chart-xml": 5, vision: 3 } };
    expect(expectedBillableVisuals({ config: { diagrams: true }, pages: 100, stats })).toEqual({ low: 11, high: 11, basis: "measured" });
    expect(expectedBillableVisuals({ config: { diagrams: false }, pages: 100, stats })).toEqual({ low: 7, high: 7, basis: "measured" });
    expect(expectedBillableVisuals({ config: { diagrams: true }, pages: 1, stats: { charts: 1, bySource: { "svg-geometry": 9 } } }).high).toBe(0);
  });
  it("clamps to the per-document model-read cap, measured or prior", () => {
    const visuals = expectedBillableVisuals({ config: { diagrams: true }, pages: 2_000, documents: 1, stats: null });
    expect(visuals.high).toBe(CHART_EXPORT_DOCUMENT_CAPS.maxModelReadsPerDocument);
    expect(expectedBillableVisuals({ config: { diagrams: true }, pages: 10, documents: 1, stats: { charts: 900, bySource: { "office-chart-xml": 300 } } }).high)
      .toBe(CHART_EXPORT_DOCUMENT_CAPS.maxModelReadsPerDocument);
    expect(visuals.low).toBe(Math.ceil(2_000 * CHART_EXPORT_VISUALS_PER_PAGE_PRIOR.low));
    const many = expectedBillableVisuals({ config: { diagrams: true }, pages: 2_000, documents: 10, stats: null });
    expect(many.high).toBe(500);
  });
  it("falls back to a conservative per-page prior", () => {
    const visuals = expectedBillableVisuals({ config: { diagrams: true }, pages: 400, stats: null });
    expect(visuals).toEqual({
      low: Math.ceil(400 * CHART_EXPORT_VISUALS_PER_PAGE_PRIOR.low),
      high: Math.ceil(400 * CHART_EXPORT_VISUALS_PER_PAGE_PRIOR.high),
      basis: "prior",
    });
  });
});

describe("chartExportConfigOf", () => {
  it("is null when absent, off or invalid", () => {
    expect(chartExportConfigOf(base)).toBeNull();
    expect(chartExportConfigOf({ chartExport: { enabled: false } })).toBeNull();
    expect(chartExportConfigOf({ chartExport: { enabled: true, formats: ["bogus"] } })).toBeNull();
    expect(chartExportConfigOf({ chartExport: { enabled: true } })).toMatchObject({ formats: ["description", "mermaid"], diagrams: true });
  });
});

describe("estimatePipelineWork with chart export", () => {
  const stages = compilePipelinePlan(base).stageOrder;
  it("adds per-visual credits only when the option is on and a charging stage runs", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const off = estimatePipelineWork({ features: base, stages, pages: 400, documents: 4, env });
    const on = estimatePipelineWork({ features: withChartExport({ enabled: true }), stages, pages: 400, documents: 4, env });
    // Each visual: a first read (0.07) plus the expected half of a billed second read (test pricing 0.5 x 0.07).
    expect(on.credits!.low - off.credits!.low).toBeCloseTo(Math.ceil(400 * CHART_EXPORT_VISUALS_PER_PAGE_PRIOR.low) * (0.07 + 0.5 * 0.07), 4);
    expect(on.credits!.high - off.credits!.high).toBeCloseTo(Math.ceil(400 * CHART_EXPORT_VISUALS_PER_PAGE_PRIOR.high) * (0.07 + 0.5 * 0.07), 4);
    expect(on.basis).toMatch(/chart export: 8 to 100 model-read visuals \(per-page planning prior\)/);
    const indexOnly = estimatePipelineWork({ features: withChartExport({ enabled: true }), stages: ["index"], pages: 400, documents: 4, env });
    const indexOnlyOff = estimatePipelineWork({ features: base, stages: ["index"], pages: 400, documents: 4, env });
    expect(indexOnly.credits).toEqual(indexOnlyOff.credits);
    // The generator runs in vision-extract only: re-running extraction alone exports nothing.
    const markdownOnly = estimatePipelineWork({ features: withChartExport({ enabled: true }), stages: ["extract-markdown"], pages: 400, documents: 4, env });
    const markdownOnlyOff = estimatePipelineWork({ features: base, stages: ["extract-markdown"], pages: 400, documents: 4, env });
    expect(markdownOnly.credits).toEqual(markdownOnlyOff.credits);
    expect(CHART_EXPORT_CHARGING_STAGES).toEqual(["vision-extract"]);
  });
  it("prices recorded visual counts and direct-mode formats", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const features = withChartExport({ enabled: true, formats: ["description", "matplotlib"] });
    const off = estimatePipelineWork({ features: base, stages, pages: 400, documents: 4, env });
    const measured = estimatePipelineWork({
      features, stages, pages: 400, documents: 4, env,
      visualStats: { charts: 10, diagrams: 0, bySource: { "office-chart-xml": 4 } },
      chartExportModes: { matplotlib: "direct" },
    });
    // Two direct-mode calls on the first read; a second read is one call's worth.
    expect(measured.credits!.high - off.credits!.high).toBeCloseTo(6 * (2 * 0.07 + 0.5 * 0.07), 4);
    expect(measured.basis).toMatch(/6 model-read visuals \(recorded counts\)/);
  });
  it("prices nothing while the deployment kill switch is off", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    for (const flag of [undefined, "off", "no", "0", "enabled", ""]) {
      const killed = { STRIPE_SECRET_KEY: "sk_test", DOCSLURP_CHART_EXPORT: flag };
      const off = estimatePipelineWork({ features: base, stages, pages: 400, documents: 4, env: killed });
      const on = estimatePipelineWork({ features: withChartExport({ enabled: true }), stages, pages: 400, documents: 4, env: killed });
      expect(on.credits).toEqual(off.credits);
      expect(on.basis).not.toMatch(/chart export/);
    }
    for (const flag of ["on", " ON ", "1", "true", "True", "yes", "YES"]) expect(chartExportAvailable({ DOCSLURP_CHART_EXPORT: flag })).toBe(true);
    for (const flag of [undefined, "", "off", "0", "false", "no", "onn", "enabled"]) expect(chartExportAvailable({ DOCSLURP_CHART_EXPORT: flag })).toBe(false);
    expect(chartExportAvailable({})).toBe(false);
  });
  it("shows no credits when billing is disabled", () => {
    const e = estimatePipelineWork({ features: withChartExport({ enabled: true }), stages, pages: 400, documents: 4, env: {} });
    expect(e.credits).toBeNull();
  });
});

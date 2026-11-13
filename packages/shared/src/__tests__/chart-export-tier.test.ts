import { describe, expect, it } from "vitest";

import {
  chartExportModelsAllowed,
  chartExportOverrideRefusal,
  chartExportOverrideSchema,
  chartExportRuns,
  defaultChartExportConfig,
  defaultChartExportTier,
  effectiveChartExportConfig,
  pipelineFeatureOverridesSchema,
  reprocessRunSchema,
  resolveChartExportConfig,
  resolveChartExportTier,
} from "../index.js";

const ON = { DOCSLURP_CHART_EXPORT: "on" };

describe("chart export tier resolution", () => {
  it("defaults by origin: app free, machine off; the env flag flips the machine default", () => {
    expect(defaultChartExportTier("app", {})).toBe("free");
    expect(defaultChartExportTier("machine", {})).toBe("off");
    expect(defaultChartExportTier("machine", { DOCSLURP_CHART_EXPORT_API_DEFAULT: "free" })).toBe("free");
    expect(defaultChartExportTier("machine", { DOCSLURP_CHART_EXPORT_API_DEFAULT: " FREE " })).toBe("free");
    // Unknown and `models` never become a machine default.
    for (const value of ["models", "on", "bogus", ""]) expect(defaultChartExportTier("machine", { DOCSLURP_CHART_EXPORT_API_DEFAULT: value })).toBe("off");
    // The app default never changes with the machine flag.
    expect(defaultChartExportTier("app", { DOCSLURP_CHART_EXPORT_API_DEFAULT: "off" })).toBe("free");
    // The app default has its own flag (held off until the cost gate passes); only "off" changes it.
    expect(defaultChartExportTier("app", { DOCSLURP_CHART_EXPORT_APP_DEFAULT: "off" })).toBe("off");
    expect(defaultChartExportTier("app", { DOCSLURP_CHART_EXPORT_APP_DEFAULT: "models" })).toBe("free");
    expect(defaultChartExportTier("machine", { DOCSLURP_CHART_EXPORT_APP_DEFAULT: "off", DOCSLURP_CHART_EXPORT_API_DEFAULT: "free" })).toBe("free");
  });

  it("precedence: request override, then project tier, then origin default", () => {
    for (const origin of ["app", "machine"] as const) {
      expect(resolveChartExportTier({ origin, env: {} })).toBe(origin === "app" ? "free" : "off");
      // An explicit project tier wins over both origin defaults.
      expect(resolveChartExportTier({ project: { tier: "models" }, origin, env: {} })).toBe("models");
      expect(resolveChartExportTier({ project: { tier: "off" }, origin, env: {} })).toBe("off");
      // A per-request override wins over the project.
      expect(resolveChartExportTier({ requested: "free", project: { tier: "off" }, origin, env: {} })).toBe("free");
      expect(resolveChartExportTier({ requested: "off", project: { tier: "models" }, origin, env: {} })).toBe("off");
      expect(resolveChartExportTier({ requested: "models", origin, env: {} })).toBe("models");
    }
  });

  it("the deploy switch is the ceiling: off beats every tier, free caps models", () => {
    const models = resolveChartExportConfig({ project: { ...defaultChartExportConfig, tier: "models" }, origin: "app", env: {} });
    expect(effectiveChartExportConfig(models, {}).tier).toBe("off");
    expect(effectiveChartExportConfig(models, { DOCSLURP_CHART_EXPORT: "off" }).tier).toBe("off");
    expect(effectiveChartExportConfig(models, { DOCSLURP_CHART_EXPORT: "free" }).tier).toBe("free");
    expect(effectiveChartExportConfig(models, ON).tier).toBe("models");
    expect(chartExportRuns({ tier: "free" }, { DOCSLURP_CHART_EXPORT: "off" })).toBe(false);
    expect(chartExportModelsAllowed({ tier: "models" }, { DOCSLURP_CHART_EXPORT: "free" })).toBe(false);
    expect(chartExportModelsAllowed({ tier: "free" }, ON)).toBe(false);
    // Project off beats the app's free default.
    const off = resolveChartExportConfig({ project: { ...defaultChartExportConfig, tier: "off" }, origin: "app", env: {} });
    expect(effectiveChartExportConfig(off, ON).tier).toBe("off");
  });

  it("a models override is refused unless the switch is on; other tiers are always allowed", () => {
    expect(chartExportOverrideRefusal("models", { DOCSLURP_CHART_EXPORT: "free" })).toBe("chart_export_models_unavailable");
    expect(chartExportOverrideRefusal("models", {})).toBe("chart_export_models_unavailable");
    expect(chartExportOverrideRefusal("models", ON)).toBeNull();
    expect(chartExportOverrideRefusal("free", { DOCSLURP_CHART_EXPORT: "free" })).toBeNull();
    expect(chartExportOverrideRefusal("off", {})).toBeNull();
  });

  it("the override schema takes a tier only: unknown tiers and model names are refused", () => {
    expect(chartExportOverrideSchema.parse({ tier: "models" })).toEqual({ tier: "models" });
    expect(chartExportOverrideSchema.safeParse({ tier: "smart" }).success).toBe(false);
    expect(chartExportOverrideSchema.safeParse({ tier: "models", generatorModel: "llm://x/y" }).success).toBe(false);
    expect(reprocessRunSchema.safeParse({ chartExport: { tier: "free" } }).success).toBe(true);
    expect(reprocessRunSchema.safeParse({ chartExport: { tier: "bogus" } }).success).toBe(false);
    // Upload pipeline overrides use the same field.
    expect(pipelineFeatureOverridesSchema.safeParse({ chartExport: { tier: "models" } }).success).toBe(true);
    expect(pipelineFeatureOverridesSchema.safeParse({ chartExport: { tier: "bogus" } }).success).toBe(false);
    expect(pipelineFeatureOverridesSchema.safeParse({ chartExport: { tier: "models", generatorModel: "llm://x/y" } }).success).toBe(false);
    expect(pipelineFeatureOverridesSchema.safeParse({ figures: false }).success).toBe(true);
  });
});

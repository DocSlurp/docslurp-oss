import { describe, expect, it } from "vitest";

import {
  chartExportDefaults,
  chartExportFreeVmCap,
  explicitProjectChartTier,
  minChartExportTier,
  projectChartExportTierCap,
  chartExportDefaultsWarnings,
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
  upgradeStoredChartExport,
  upgradeStoredPipelineChartExport,
} from "../index.js";

const ON = { DOCSLURP_CHART_EXPORT: "on" };
const FREE_OK = { DOCSLURP_CHART_EXPORT_FREE_EXPLICIT: "on" };

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
    // The app default has its own flag (held off until the cost gate passes). Parsed strictly: only `free` (or unset) is
    // free; the off words and any unknown value are off (fail closed, toward lower cost).
    expect(defaultChartExportTier("app", { DOCSLURP_CHART_EXPORT_APP_DEFAULT: "free" })).toBe("free");
    for (const value of ["off", "0", "false", "no", "", "disabled", "off # comment", "models", "on"]) {
      expect(defaultChartExportTier("app", { DOCSLURP_CHART_EXPORT_APP_DEFAULT: value })).toBe("off");
    }
    expect(defaultChartExportTier("machine", { DOCSLURP_CHART_EXPORT_APP_DEFAULT: "off", DOCSLURP_CHART_EXPORT_API_DEFAULT: "free" })).toBe("free");
  });

  it("precedence: request override, then project tier, then origin default", () => {
    for (const origin of ["app", "machine"] as const) {
      expect(resolveChartExportTier({ origin, env: {} })).toBe(origin === "app" ? "free" : "off");
      // An explicit project tier wins over both origin defaults.
      expect(resolveChartExportTier({ project: { tier: "models" }, origin, env: {} })).toBe("models");
      expect(resolveChartExportTier({ project: { tier: "off" }, origin, env: {} })).toBe("off");
      // A per-request override wins over the project.
      expect(resolveChartExportTier({ requested: "free", project: { tier: "off" }, origin, env: FREE_OK })).toBe("free");
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

  it("an explicit free counts only behind DOCSLURP_CHART_EXPORT_FREE_EXPLICIT=on; otherwise it is the origin default", () => {
    expect(resolveChartExportTier({ requested: "free", project: { tier: "off" }, origin: "machine", env: {} })).toBe("off");
    expect(resolveChartExportTier({ project: { tier: "free" }, origin: "machine", env: {} })).toBe("off");
    expect(resolveChartExportTier({ project: { tier: "free" }, origin: "app", env: {} })).toBe("free");
    expect(resolveChartExportTier({ project: { tier: "free" }, origin: "app", env: { DOCSLURP_CHART_EXPORT_APP_DEFAULT: "off" } })).toBe("off");
    expect(resolveChartExportTier({ project: { tier: "free" }, origin: "machine", env: FREE_OK })).toBe("free");
    expect(resolveChartExportTier({ project: { tier: "free" }, origin: "machine", env: { DOCSLURP_CHART_EXPORT_FREE_EXPLICIT: "yes please" } })).toBe("off");
  });

  it("one refusal code for any tier the deployment does not allow; off is always allowed", () => {
    expect(chartExportOverrideRefusal("models", { DOCSLURP_CHART_EXPORT: "free" })).toBe("chart_export_tier_unavailable");
    expect(chartExportOverrideRefusal("models", {})).toBe("chart_export_tier_unavailable");
    expect(chartExportOverrideRefusal("models", ON)).toBeNull();
    // Explicit free needs its own gate, and a switch that is not off.
    expect(chartExportOverrideRefusal("free", ON)).toBe("chart_export_tier_unavailable");
    expect(chartExportOverrideRefusal("free", { DOCSLURP_CHART_EXPORT: "free" })).toBe("chart_export_tier_unavailable");
    expect(chartExportOverrideRefusal("free", { ...ON, ...FREE_OK })).toBeNull();
    expect(chartExportOverrideRefusal("free", { DOCSLURP_CHART_EXPORT: "off", ...FREE_OK })).toBe("chart_export_tier_unavailable");
    expect(chartExportOverrideRefusal("off", {})).toBeNull();
  });

  it("reports the deployment's actual defaults (production: app off, explicit free refused)", () => {
    const production = { DOCSLURP_CHART_EXPORT: "on", DOCSLURP_CHART_EXPORT_APP_DEFAULT: "off" };
    expect(chartExportDefaults(production)).toEqual({ app: "off", machine: "off", modelsAvailable: true, freeAvailable: false, ceiling: "on" });
    expect(chartExportDefaults({ DOCSLURP_CHART_EXPORT: "on" })).toEqual({ app: "free", machine: "off", modelsAvailable: true, freeAvailable: false, ceiling: "on" });
    expect(chartExportDefaults({ DOCSLURP_CHART_EXPORT: "free", ...FREE_OK })).toEqual({ app: "free", machine: "off", modelsAvailable: false, freeAvailable: true, ceiling: "free" });
    expect(chartExportDefaults({})).toEqual({ app: "off", machine: "off", modelsAvailable: false, freeAvailable: false, ceiling: "off" });
  });

  it("warns at startup on unknown default values", () => {
    expect(chartExportDefaultsWarnings({ DOCSLURP_CHART_EXPORT_APP_DEFAULT: "off", DOCSLURP_CHART_EXPORT_API_DEFAULT: "free", DOCSLURP_CHART_EXPORT_FREE_EXPLICIT: "off" })).toEqual([]);
    const warnings = chartExportDefaultsWarnings({ DOCSLURP_CHART_EXPORT_APP_DEFAULT: "disabled", DOCSLURP_CHART_EXPORT_API_DEFAULT: "bogus", DOCSLURP_CHART_EXPORT_FREE_EXPLICIT: "maybe" });
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).not.toMatch(/disabled|bogus|maybe/);
  });

  it("caps a replayed or inherited tier at what the project resolves to now (R2-M1)", () => {
    expect(minChartExportTier("models", "off")).toBe("off");
    expect(minChartExportTier("free", "models")).toBe("free");
    // An explicit project tier is the cap.
    expect(projectChartExportTierCap({ tier: "off" }, {})).toBe("off");
    expect(projectChartExportTierCap({ tier: "models" }, {})).toBe("models");
    // Unset: the higher origin default, never models.
    expect(projectChartExportTierCap({}, {})).toBe("free");
    expect(projectChartExportTierCap(null, { DOCSLURP_CHART_EXPORT_APP_DEFAULT: "off" })).toBe("off");
    expect(projectChartExportTierCap(null, { DOCSLURP_CHART_EXPORT_APP_DEFAULT: "off", DOCSLURP_CHART_EXPORT_API_DEFAULT: "free" })).toBe("free");
    // One "explicit" rule: a disallowed stored free counts as unset (R2-L4).
    expect(explicitProjectChartTier({ tier: "free" }, {})).toBeUndefined();
    expect(explicitProjectChartTier({ tier: "free" }, FREE_OK)).toBe("free");
    expect(explicitProjectChartTier({ tier: "off" }, {})).toBe("off");
    expect(projectChartExportTierCap({ tier: "free" }, { DOCSLURP_CHART_EXPORT_APP_DEFAULT: "off" })).toBe("off");
  });

  it("parses the free VM cap strictly: invalid values are 0, never the default (R2-L3)", () => {
    expect(chartExportFreeVmCap({})).toBe(200);
    expect(chartExportFreeVmCap({ DOCSLURP_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR: "12" })).toBe(12);
    for (const bad of ["-1", "x", "20O", "2.5"]) expect(chartExportFreeVmCap({ DOCSLURP_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR: bad })).toBe(0);
  });

  it("maps legacy stored keys on read (rows written before migration 0151 or by an older API)", () => {
    expect(upgradeStoredChartExport({ enabled: true, generatorModel: null, formats: ["csv"] })).toEqual({ tier: "models", formats: ["csv"] });
    expect(upgradeStoredChartExport({ enabled: false, generatorModel: "llm://x/y" })).toEqual({});
    // An explicit tier wins over a stale `enabled` written alongside it during deploy skew.
    expect(upgradeStoredChartExport({ tier: "off", enabled: true })).toEqual({ tier: "off" });
    expect(upgradeStoredChartExport({ tier: "models", enabled: false, generatorModel: null })).toEqual({ tier: "models" });
    const current = { tier: "free" };
    expect(upgradeStoredChartExport(current)).toBe(current);
    expect(upgradeStoredChartExport("x")).toBe("x");
    expect(upgradeStoredPipelineChartExport({ figures: false, chartExport: { enabled: true } })).toEqual({ figures: false, chartExport: { tier: "models" } });
    const untouched = { figures: true };
    expect(upgradeStoredPipelineChartExport(untouched)).toBe(untouched);
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

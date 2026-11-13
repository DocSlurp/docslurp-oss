import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures } from "@docslurp/shared";

import { assertChartExportChangeAllowed, ChartExportUnavailableError, stampRunChartExport } from "./chart-export-availability.js";
import { parseFormProjectIntakePipeline, parseProjectIntakePipeline } from "./project-intake-actions.js";
import { ProjectIntakeError } from "./project-intake.js";

afterEach(() => vi.unstubAllEnvs());

describe("upload pipeline override: chart export", () => {
  it("accepts every tier with the switch on, and free/off whatever the switch", () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    for (const tier of ["off", "free", "models"]) expect(parseProjectIntakePipeline({ chartExport: { tier } })).toMatchObject({ chartExport: { tier } });
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "free");
    expect(parseProjectIntakePipeline({ chartExport: { tier: "free" } })).toMatchObject({ chartExport: { tier: "free" } });
    expect(parseFormProjectIntakePipeline(JSON.stringify({ chartExport: { tier: "off" }, figures: false }))).toMatchObject({ chartExport: { tier: "off" }, figures: false });
  });

  it("refuses models under the free or off switch with a validation error, never a downgrade", () => {
    for (const flag of ["free", "off", ""]) {
      vi.stubEnv("DOCSLURP_CHART_EXPORT", flag);
      let caught: unknown;
      try { parseProjectIntakePipeline({ chartExport: { tier: "models" } }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(ProjectIntakeError);
      expect((caught as ProjectIntakeError).statusCode ?? (caught as { status?: number }).status).toBe(422);
      expect(JSON.stringify(caught)).toContain("chart_export_models_unavailable");
    }
  });

  it("refuses unknown tiers, model names and unknown keys", () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    for (const raw of [{ chartExport: { tier: "turbo" } }, { chartExport: { tier: "models", generatorModel: "llm://x/y" } }, { chartExport: { enabled: true } }, { origin: "app" }]) {
      expect(() => parseProjectIntakePipeline(raw)).toThrow(ProjectIntakeError);
    }
  });
});

describe("stampRunChartExport", () => {
  it("resolves an unset tier by origin and keeps an explicit (request or project) tier", () => {
    const base = defaultPipelineFeatures;
    expect(stampRunChartExport(base, "app", {}).chartExport.tier).toBe("free");
    expect(stampRunChartExport(base, "machine", {}).chartExport.tier).toBe("off");
    expect(stampRunChartExport(base, "machine", { DOCSLURP_CHART_EXPORT_API_DEFAULT: "free" }).chartExport.tier).toBe("free");
    for (const origin of ["app", "machine"] as const) {
      for (const tier of ["off", "free", "models"] as const) {
        expect(stampRunChartExport({ ...base, chartExport: { ...base.chartExport, tier } }, origin, {}).chartExport.tier).toBe(tier);
      }
    }
  });
});

describe("project settings: the models tier needs the switch on", () => {
  it("refuses moving to models unless DOCSLURP_CHART_EXPORT=on; free and off are always allowed", () => {
    const before = { chartExport: {} };
    for (const flag of ["off", "free", "bogus"]) {
      expect(() => assertChartExportChangeAllowed(before, { chartExport: { tier: "models" } }, { DOCSLURP_CHART_EXPORT: flag })).toThrow(ChartExportUnavailableError);
    }
    expect(() => assertChartExportChangeAllowed(before, { chartExport: { tier: "models" } }, { DOCSLURP_CHART_EXPORT: "on" })).not.toThrow();
    for (const tier of ["free", "off"]) expect(() => assertChartExportChangeAllowed(before, { chartExport: { tier } }, {})).not.toThrow();
    // A project already on models keeps it (no refusal on unrelated edits).
    expect(() => assertChartExportChangeAllowed({ chartExport: { tier: "models" } }, { chartExport: { tier: "models" } }, {})).not.toThrow();
  });
});

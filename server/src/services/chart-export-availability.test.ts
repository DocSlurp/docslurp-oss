import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures } from "@docslurp/shared";

import {
  assertChartExportChangeAllowed,
  assertChartExportModelsCeiling,
  ChartExportModelsForbiddenError,
  ChartExportUnavailableError,
  groupByChartTier,
  stampRunChartExport,
} from "./chart-export-availability.js";
import { parseFormProjectIntakePipeline, parseProjectIntakePipeline } from "./project-intake-actions.js";
import { ProjectIntakeError } from "./project-intake.js";

afterEach(() => vi.unstubAllEnvs());

describe("upload pipeline override: chart export", () => {
  it("accepts every tier with the switch on and explicit free allowed; off whatever the switch", () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    vi.stubEnv("DOCSLURP_CHART_EXPORT_FREE_EXPLICIT", "on");
    for (const tier of ["off", "free", "models"]) expect(parseProjectIntakePipeline({ chartExport: { tier } })).toMatchObject({ chartExport: { tier } });
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "free");
    expect(parseProjectIntakePipeline({ chartExport: { tier: "free" } })).toMatchObject({ chartExport: { tier: "free" } });
    expect(parseFormProjectIntakePipeline(JSON.stringify({ chartExport: { tier: "off" }, figures: false }))).toMatchObject({ chartExport: { tier: "off" }, figures: false });
  });

  it("refuses models under the free or off switch with 400 chart_export_tier_unavailable, never a downgrade", () => {
    for (const flag of ["free", "off", ""]) {
      vi.stubEnv("DOCSLURP_CHART_EXPORT", flag);
      let caught: unknown;
      try { parseProjectIntakePipeline({ chartExport: { tier: "models" } }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(ProjectIntakeError);
      expect((caught as ProjectIntakeError).statusCode).toBe(400);
      expect((caught as ProjectIntakeError).code).toBe("chart_export_tier_unavailable");
    }
  });

  it("refuses an explicit free unless DOCSLURP_CHART_EXPORT_FREE_EXPLICIT=on (unbilled VM boots), with the same code", () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    for (const gate of [undefined, "off", "maybe"]) {
      if (gate === undefined) vi.stubEnv("DOCSLURP_CHART_EXPORT_FREE_EXPLICIT", undefined as never); else vi.stubEnv("DOCSLURP_CHART_EXPORT_FREE_EXPLICIT", gate);
      let caught: unknown;
      try { parseProjectIntakePipeline({ chartExport: { tier: "free" } }); } catch (error) { caught = error; }
      expect((caught as ProjectIntakeError).code).toBe("chart_export_tier_unavailable");
      expect((caught as ProjectIntakeError).statusCode).toBe(400);
    }
    expect(parseProjectIntakePipeline({ chartExport: { tier: "off" } })).toMatchObject({ chartExport: { tier: "off" } });
  });

  it("refuses unknown tiers, model names and unknown keys", () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    for (const raw of [{ chartExport: { tier: "turbo" } }, { chartExport: { tier: "models", generatorModel: "llm://x/y" } }, { chartExport: { enabled: true } }, { origin: "app" }]) {
      expect(() => parseProjectIntakePipeline(raw)).toThrow(ProjectIntakeError);
    }
  });
});

describe("stampRunChartExport", () => {
  const FREE_OK = { DOCSLURP_CHART_EXPORT_FREE_EXPLICIT: "on" };
  it("resolves an unset tier by origin and keeps an explicit (request or project) tier", () => {
    const base = defaultPipelineFeatures;
    expect(stampRunChartExport(base, "app", {}).chartExport.tier).toBe("off");
    expect(stampRunChartExport(base, "app", { DOCSLURP_CHART_EXPORT_APP_DEFAULT: "free" }).chartExport.tier).toBe("free");
    expect(stampRunChartExport(base, "app", { DOCSLURP_CHART_EXPORT_APP_DEFAULT: "off" }).chartExport.tier).toBe("off");
    expect(stampRunChartExport(base, "machine", {}).chartExport.tier).toBe("off");
    expect(stampRunChartExport(base, "machine", { DOCSLURP_CHART_EXPORT_API_DEFAULT: "free" }).chartExport.tier).toBe("free");
    for (const origin of ["app", "machine"] as const) {
      for (const tier of ["off", "free", "models"] as const) {
        expect(stampRunChartExport({ ...base, chartExport: { ...base.chartExport, tier } }, origin, FREE_OK).chartExport.tier).toBe(tier);
      }
    }
    // An explicit free without the gate counts as unset (the origin default).
    expect(stampRunChartExport({ ...base, chartExport: { ...base.chartExport, tier: "free" } }, "machine", {}).chartExport.tier).toBe("off");
  });

  it("keeps a pipeline's already-resolved tier when stamped (reprocess, materialize), and maps legacy keys", () => {
    const base = defaultPipelineFeatures;
    expect(stampRunChartExport({ ...base, chartExport: { ...base.chartExport, tier: "free" } }, "machine", {}, { stamped: true }).chartExport.tier).toBe("free");
    const legacy = { ...base, chartExport: { enabled: true, generatorModel: null, formats: ["csv"], diagrams: true } } as never;
    expect((stampRunChartExport(legacy, "machine", {}) as typeof base).chartExport).toEqual({ tier: "models", formats: ["csv"], diagrams: true });
    expect(stampRunChartExport(base, "app", { DOCSLURP_CHART_EXPORT_APP_DEFAULT: "off" }, { stamped: true }).chartExport.tier).toBe("off");
  });
});

describe("maintenance runs keep each document's source-run tier (M5)", () => {
  it("groups documents by their own stamped tier, the fallback only for documents without one", () => {
    const docs = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const groups = groupByChartTier(docs, new Map([["a", "free"], ["b", "models"]] as const), "off");
    expect(Object.fromEntries([...groups].map(([tier, list]) => [tier, list.map((d) => d.id)]))).toEqual({ free: ["a"], models: ["b"], off: ["c"] });
    // Capped at what the project resolves to now: inheritance only ever lowers (R2-M1).
    const capped = groupByChartTier(docs, new Map([["a", "free"], ["b", "models"]] as const), "off", "free");
    expect(Object.fromEntries([...capped].map(([tier, list]) => [tier, list.map((d) => d.id)]))).toEqual({ free: ["a", "b"], off: ["c"] });
  });
});

describe("a project's explicit tier is a ceiling for models (adversarial M2)", () => {
  const scopes = (map: Record<string, readonly string[] | null>) => async (id: string) => map[id] ?? null;
  const base = { runTier: "models" as const, context: "test" };

  it("refuses a contributor (no editor rights) on an off or free project", async () => {
    for (const projectTier of ["off", "free"]) {
      await expect(assertChartExportModelsCeiling({ ...base, projectTier, canEdit: false })).rejects.toBeInstanceOf(ChartExportModelsForbiddenError);
    }
  });

  it("refuses an ingest-only key, a revoked or unknown key, even for an editor", async () => {
    const lookup = scopes({ ingest: ["ingest"], billed: ["ingest", "pipeline:billed-features"], manage: ["projects:manage"] });
    await expect(assertChartExportModelsCeiling({ ...base, projectTier: "off", canEdit: true, apiKeyId: "ingest", apiKeyScopes: lookup })).rejects.toMatchObject({ status: 403, code: "chart_export_models_forbidden" });
    // A revoked key reads as null scopes (activeApiKeyScopes filters revoked_at): refused.
    await expect(assertChartExportModelsCeiling({ ...base, projectTier: "off", canEdit: true, apiKeyId: "revoked", apiKeyScopes: lookup })).rejects.toBeInstanceOf(ChartExportModelsForbiddenError);
    // A lookup that fails is refused (fail closed).
    await expect(assertChartExportModelsCeiling({ ...base, projectTier: "free", canEdit: true, apiKeyId: "x", apiKeyScopes: async () => { throw new Error("db down"); } })).rejects.toBeInstanceOf(ChartExportModelsForbiddenError);
    // A key without the editor's rights is refused whatever its scopes.
    await expect(assertChartExportModelsCeiling({ ...base, projectTier: "off", canEdit: false, apiKeyId: "billed", apiKeyScopes: lookup })).rejects.toBeInstanceOf(ChartExportModelsForbiddenError);
  });

  it("allows an editor session, or an editor's key with pipeline:billed-features or projects:manage", async () => {
    const lookup = scopes({ billed: ["ingest", "pipeline:billed-features"], manage: ["projects:manage"] });
    await expect(assertChartExportModelsCeiling({ ...base, projectTier: "off", canEdit: true })).resolves.toBeUndefined();
    await expect(assertChartExportModelsCeiling({ ...base, projectTier: "free", canEdit: true, apiKeyId: "billed", apiKeyScopes: lookup })).resolves.toBeUndefined();
    await expect(assertChartExportModelsCeiling({ ...base, projectTier: "off", canEdit: true, apiKeyId: "manage", apiKeyScopes: lookup })).resolves.toBeUndefined();
  });

  it("a project with no tier is a ceiling of off too (council #387); only one saved on models, and non-models runs, keep the usual rules", async () => {
    for (const projectTier of [undefined, null, ""]) {
      await expect(assertChartExportModelsCeiling({ ...base, projectTier, canEdit: false })).rejects.toBeInstanceOf(ChartExportModelsForbiddenError);
      await expect(assertChartExportModelsCeiling({ ...base, projectTier, canEdit: true })).resolves.toBeUndefined();
    }
    await expect(assertChartExportModelsCeiling({ ...base, projectTier: "models", canEdit: false })).resolves.toBeUndefined();
    for (const runTier of ["off", "free"] as const) {
      await expect(assertChartExportModelsCeiling({ runTier, projectTier: "off", canEdit: false, context: "t" })).resolves.toBeUndefined();
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
    expect(() => assertChartExportChangeAllowed(before, { chartExport: { tier: "off" } }, {})).not.toThrow();
    // An explicit free needs its own gate (and a switch that is not off).
    expect(() => assertChartExportChangeAllowed(before, { chartExport: { tier: "free" } }, { DOCSLURP_CHART_EXPORT: "on" })).toThrow(ChartExportUnavailableError);
    expect(() => assertChartExportChangeAllowed(before, { chartExport: { tier: "free" } }, { DOCSLURP_CHART_EXPORT: "on", DOCSLURP_CHART_EXPORT_FREE_EXPLICIT: "on" })).not.toThrow();
    // The error carries the one public code and status.
    try { assertChartExportChangeAllowed(before, { chartExport: { tier: "models" } }, {}); } catch (error) {
      expect(error).toMatchObject({ status: 400, code: "chart_export_tier_unavailable" });
    }
    // A project already on models keeps it (no refusal on unrelated edits).
    expect(() => assertChartExportChangeAllowed({ chartExport: { tier: "models" } }, { chartExport: { tier: "models" } }, {})).not.toThrow();
  });
});

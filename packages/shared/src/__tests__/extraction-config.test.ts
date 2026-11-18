import { describe, expect, it } from "vitest";
import {
  applyExtractionConfigInput,
  applyProjectPipelineOverrides,
  deprecatedExtractionFields,
  extractionChoicesFor,
  extractionPolicyFromEnv,
  getProjectTemplate,
  mapLegacyExtractionSettings,
  mergePipelineFeatures,
  normalizePipelineFeatures,
  parseStoredPipelineFeatures,
  pipelineFeatureOverridesSchema,
  pipelineFeaturesSchema,
  projectExtractionView,
  projectTemplates,
  QUALITY_LEVEL_RANK,
  resolveExtractionSettings,
  runConfigSemantics,
  runEffectiveExtraction,
  runExtractionView,
  VISUALS_LEVEL_RANK,
  visualsDefaults,
  type ExtractionPolicy,
  type ExtractionResolutionInput,
  type QualityLevel,
  type VisualsLevel,
} from "../index.js";

const allowed = { explicitFreeAllowed: true };
const refused = { explicitFreeAllowed: false };

describe("mapping table (design 3.2)", () => {
  const rows: Array<[string, Record<string, unknown>, { explicitFreeAllowed: boolean }, QualityLevel, VisualsLevel | null, number]> = [
    ["fast", { quality: "fast" }, allowed, "fastest", null, 0],
    ["auto", { quality: "auto" }, allowed, "fastest", null, 0],
    ["auto + intelligent rung", { quality: "auto", ladder: { maxRung: "intelligent" } }, allowed, "smartest", null, 0],
    ["auto + ocr rung", { quality: "auto", ladder: { maxRung: "ocr" } }, allowed, "fastest", null, 0],
    ["auto + fast rung (Read scans off)", { quality: "auto", ladder: { maxRung: "fast" } }, allowed, "fastest", null, 0],
    ["junk rung fails closed to fastest", { quality: "auto", ladder: { maxRung: "vision" } }, allowed, "fastest", null, 0],
    ["smartest + local-only + hosted profile -> fastest", { quality: "auto", ladder: { maxRung: "intelligent" }, privacyMode: "local-only", vision: { profile: "good-fast-hosted" } }, allowed, "fastest", null, 1],
    ["good", { quality: "good" }, allowed, "smartest", null, 0],
    ["auto + visionFallback:false (Q1)", { quality: "auto", visionFallback: false }, allowed, "fastest", null, 0],
    ["fast + visionFallback:false", { quality: "fast", visionFallback: false }, allowed, "fastest", null, 0],
    ["good + visionFallback:false", { quality: "good", visionFallback: false }, allowed, "smartest", null, 0],
    ["figures:false, no tier (Q11)", { figures: false }, allowed, "fastest", "none", 0],
    ["figures:false + models (Q11, lowering)", { figures: false, chartExport: { tier: "models" } }, allowed, "fastest", "none", 0],
    ["figures:false + free", { figures: false, chartExport: { tier: "free" } }, allowed, "fastest", "none", 0],
    ["figures:true + off", { figures: true, chartExport: { tier: "off" } }, allowed, "fastest", "figures", 0],
    ["unset figures + off", { chartExport: { tier: "off" } }, allowed, "fastest", "figures", 0],
    ["free, explicit free allowed", { chartExport: { tier: "free" } }, allowed, "fastest", "charts", 0],
    ["free, explicit free refused -> unset", { chartExport: { tier: "free" } }, refused, "fastest", null, 0],
    ["models", { chartExport: { tier: "models" } }, allowed, "fastest", "charts-ai", 0],
    ["legacy parserPlaybook review-grade, no quality", { parserPlaybook: "review-grade" }, allowed, "fastest", null, 0],
    ["legacy vision.forceAllPages", { vision: { forceAllPages: true } }, allowed, "smartest", null, 0],
    ["legacy chartExport.enabled", { chartExport: { enabled: true } }, allowed, "fastest", "charts-ai", 0],
    ["tier unset", { chartExport: { formats: ["csv"] } }, allowed, "fastest", null, 0],
    ["good + local-only + hosted profile -> fastest", { quality: "good", privacyMode: "local-only", vision: { profile: "good-fast-hosted" } }, allowed, "fastest", null, 1],
    ["good + strict-privacy + local profile stays smartest", { quality: "good", privacyMode: "strict-privacy", vision: { profile: "good-fast-local" } }, allowed, "smartest", null, 0],
    ["models + local-only -> charts", { privacyMode: "local-only", chartExport: { tier: "models" } }, allowed, "fastest", "charts", 1],
    ["good + models + strict-privacy -> both lowered", { quality: "good", privacyMode: "strict-privacy", chartExport: { tier: "models" } }, allowed, "fastest", "charts", 2],
  ];
  it.each(rows)("%s", (_name, pipeline, options, quality, visuals, lowered) => {
    const mapped = mapLegacyExtractionSettings(pipeline, options);
    expect(mapped.quality).toBe(quality);
    expect(mapped.visuals).toBe(visuals);
    expect(mapped.lowered).toHaveLength(lowered);
  });

  it("never raises: every mapped rung is at most the legacy rung", () => {
    const legacyRank = { fast: 0, auto: 1, good: 2 } as const;
    const tierRank = { off: 1, free: 2, models: 3 } as const;
    for (const quality of ["fast", "auto", "good"] as const) {
      for (const tier of [undefined, "off", "free", "models"] as const) {
        for (const figures of [true, false, undefined]) {
          for (const privacyMode of ["standard", "local-only", "strict-privacy"]) {
            const mapped = mapLegacyExtractionSettings({ quality, figures, privacyMode, chartExport: tier ? { tier } : {} }, allowed);
            expect(QUALITY_LEVEL_RANK[mapped.quality]).toBeLessThanOrEqual(legacyRank[quality]);
            if (mapped.visuals) expect(VISUALS_LEVEL_RANK[mapped.visuals]).toBeLessThanOrEqual(figures === false ? 0 : tier ? tierRank[tier] : 3);
          }
        }
      }
    }
  });
});

describe("input conversion (R0 writes the legacy shape)", () => {
  it("maps the levels (and the deprecated aliases) onto auto plus the ladder's highest rung", () => {
    expect(applyExtractionConfigInput({ quality: "fastest" })).toEqual({ quality: "auto", ladder: { maxRung: "ocr" } });
    expect(applyExtractionConfigInput({ quality: "fastest", readScans: false })).toEqual({ quality: "auto", ladder: { maxRung: "fast" } });
    expect(applyExtractionConfigInput({ readScans: false })).toEqual({ quality: "auto", ladder: { maxRung: "fast" } });
    expect(applyExtractionConfigInput({ quality: "smartest" })).toEqual({ quality: "auto", ladder: { maxRung: "intelligent" }, visionFallback: true });
    expect(applyExtractionConfigInput({ quality: "balanced" })).toEqual({ quality: "auto", ladder: { maxRung: "ocr" } });
    expect(applyExtractionConfigInput({ quality: "smart" })).toEqual({ quality: "auto", ladder: { maxRung: "intelligent" }, visionFallback: true });
    // The level wins over a stored rung sent beside it; share caps are kept.
    expect(applyExtractionConfigInput({ quality: "smartest", ladder: { maxRung: "ocr", maxEscalationShare: { aboveFast: 0.5 } } }))
      .toEqual({ quality: "auto", ladder: { maxRung: "intelligent", maxEscalationShare: { aboveFast: 0.5 } }, visionFallback: true });
    expect(() => applyExtractionConfigInput({ quality: "smartest", readScans: false })).toThrow(/Smartest always reads scans/);
    expect(() => applyExtractionConfigInput({ readScans: "no" })).toThrow(/readScans/);
  });

  it("maps every visuals rung onto figures and the chart tier, keeping formats", () => {
    expect(applyExtractionConfigInput({ visuals: "none" })).toEqual({ figures: false, chartExport: { tier: "off" } });
    expect(applyExtractionConfigInput({ visuals: "figures" })).toEqual({ figures: true, chartExport: { tier: "off" } });
    expect(applyExtractionConfigInput({ visuals: "charts", chartExport: { formats: ["csv"] } })).toEqual({ figures: true, chartExport: { formats: ["csv"], tier: "free" } });
    expect(applyExtractionConfigInput({ visuals: "charts-ai" })).toEqual({ figures: true, chartExport: { tier: "models" } });
    expect(applyExtractionConfigInput({ visuals: null })).toEqual({ figures: true });
  });

  it("refuses a visuals value that disagrees with the legacy names in the same object", () => {
    expect(() => applyExtractionConfigInput({ visuals: "charts", chartExport: { tier: "models" } })).toThrow(/conflicts/);
    expect(() => applyExtractionConfigInput({ visuals: "figures", figures: false })).toThrow(/conflicts/);
    expect(applyExtractionConfigInput({ visuals: "charts", chartExport: { tier: "free" } })).toEqual({ figures: true, chartExport: { tier: "free" } });
  });

  it("the full schema accepts both shapes and stores legacy", () => {
    const parsed = pipelineFeaturesSchema.parse({ quality: "smart", visuals: "none" });
    expect(parsed.quality).toBe("auto");
    expect(parsed.ladder.maxRung).toBe("intelligent");
    expect(parsed.figures).toBe(false);
    expect(parsed.chartExport.tier).toBe("off");
    expect("visuals" in parsed).toBe(false);
    // A whole pipeline read back and sent with visuals: visuals wins over the stored legacy fields it carries.
    expect(pipelineFeaturesSchema.parse({ visuals: "charts", figures: false, chartExport: { tier: "models" } })).toMatchObject({ figures: true, chartExport: { tier: "free" } });
    expect(pipelineFeaturesSchema.safeParse({ visuals: "bogus" }).success).toBe(false);
  });

  it("the override schema converts, rejects bad values and conflicts", () => {
    expect(pipelineFeatureOverridesSchema.parse({ quality: "fastest", visuals: "charts" })).toEqual({ quality: "auto", ladder: { maxRung: "ocr" }, figures: true, chartExport: { tier: "free" } });
    expect(pipelineFeatureOverridesSchema.safeParse({ visuals: "everything" }).success).toBe(false);
    // A per-request override cannot reset visuals to the default (it merges onto the project).
    expect(pipelineFeatureOverridesSchema.safeParse({ visuals: null }).success).toBe(false);
    expect(pipelineFeatureOverridesSchema.safeParse({ quality: "best" }).success).toBe(false);
    expect(pipelineFeatureOverridesSchema.safeParse({ visuals: "none", figures: true }).success).toBe(false);
    // Clients never inject a stamped value.
    expect(pipelineFeatureOverridesSchema.safeParse({ effective: { readsPages: false } }).success).toBe(false);
  });

  it("merging visuals: null onto a project unsets its tier (origin default)", () => {
    const base = normalizePipelineFeatures({ chartExport: { tier: "models", formats: ["csv"] } });
    const merged = mergePipelineFeatures(base, { visuals: null } as never);
    expect(merged.chartExport.tier).toBeUndefined();
    expect(merged.chartExport.formats).toEqual(["csv"]);
  });

  it("reads a stored new-shape row (rollback from R1) and refuses unknown config versions", () => {
    const stored = parseStoredPipelineFeatures({ configVersion: 1, quality: "balanced", visuals: "charts-ai" }, "test");
    expect(stored.quality).toBe("auto");
    expect(stored.visionFallback).toBe(true);
    expect(stored.chartExport.tier).toBe("models");
    expect(() => parseStoredPipelineFeatures({ configVersion: 99, quality: "auto" }, "test")).toThrow(/configVersion 99/);
    // In a request it is a validation error, never a 500.
    expect(pipelineFeatureOverridesSchema.safeParse({ configVersion: 99 }).success).toBe(false);
    expect(pipelineFeaturesSchema.safeParse({ configVersion: "1" }).success).toBe(false);
  });

  it("legacy snapshots keep legacy semantics: no visionFallback widening", () => {
    expect(runConfigSemantics({ quality: "auto", visionFallback: false })).toBe("legacy");
    expect(parseStoredPipelineFeatures({ quality: "auto", visionFallback: false }, "test").visionFallback).toBe(false);
    expect(runConfigSemantics({ configVersion: 1 })).toBe(1);
  });

  it("names deprecated fields", () => {
    const fields = deprecatedExtractionFields({ quality: "auto", visionFallback: true, figures: false, chartExport: { tier: "free" } }, "pipeline.").map(w => w.field);
    expect(fields).toEqual(['pipeline.quality: "auto"', "pipeline.visionFallback", "pipeline.figures", "pipeline.chartExport.tier"]);
    expect(deprecatedExtractionFields({ quality: "fastest", visuals: "charts" })).toEqual([]);
    expect(deprecatedExtractionFields({ quality: "balanced" }).map(w => w.replacement)).toEqual(['quality: "fastest"']);
    expect(deprecatedExtractionFields({ quality: "fast" }).map(w => w.replacement)).toEqual(['quality: "fastest", readScans: false']);
  });
});

describe("templates (design 3.4)", () => {
  it("lock quality, never visionFallback separately, and their output maps cleanly", () => {
    for (const template of projectTemplates) {
      expect(template.lockedSettings).not.toContain("visionFallback");
      const mapped = mapLegacyExtractionSettings(template.pipeline, allowed);
      expect(mapped.lowered).toEqual([]);
    }
  });

  it("a quality lock holds visionFallback where the template sets it: an upload cannot turn its rescue reads off", () => {
    const template = projectTemplates.find(t => t.key === "medical-records")!;
    const run = applyProjectPipelineOverrides(template.pipeline, { visionFallback: false }, template);
    expect(run.visionFallback).toBe(true);
    expect(getProjectTemplate(template.key)).toBeTruthy();
  });

  it("a template that never set visionFallback keeps the project's own value (no silent raise in R0)", () => {
    const template = projectTemplates.find(t => t.key === "legal-contracts")!;
    const project = normalizePipelineFeatures({ ...template.pipeline, visionFallback: false });
    expect(applyProjectPipelineOverrides(project, {}, template).visionFallback).toBe(false);
  });
});

const policy = (over: Partial<ExtractionPolicy> = {}): ExtractionPolicy => ({
  originDefaults: { app: "figures", machine: "figures" },
  explicitChartsAllowed: true,
  disabled: new Set(),
  ...over,
});
const editorSession = { canEdit: true };
const contributor = { canEdit: false };
const billedKey = { canEdit: true, apiKey: { scopes: ["ingest", "pipeline:billed-features"] } };
const ingestKey = { canEdit: true, apiKey: { scopes: ["ingest"] } };
const revokedKey = { canEdit: true, apiKey: { scopes: null } };
const billedKeyOfViewer = { canEdit: false, apiKey: { scopes: ["pipeline:billed-features"] } };

const base = (over: Partial<ExtractionResolutionInput> = {}): ExtractionResolutionInput => ({
  project: { quality: "fastest", visuals: null },
  origin: "machine",
  caller: editorSession,
  constraints: { privacyMode: "standard" },
  policy: policy(),
  ...over,
});

describe("resolveExtractionSettings truth table (design 6)", () => {
  it("unset defaults: project quality, origin visuals default", () => {
    expect(resolveExtractionSettings(base())).toEqual({ ok: true, quality: "fastest", visuals: "figures", capsApplied: [] });
    expect(resolveExtractionSettings(base({ origin: "app", policy: policy({ originDefaults: { app: "charts", machine: "figures" } }) }))).toMatchObject({ visuals: "charts" });
  });

  const raises: Array<[string, ExtractionResolutionInput["caller"], boolean]> = [
    ["editor session", editorSession, true],
    ["editor's key with pipeline:billed-features", billedKey, true],
    ["editor's key with projects:manage", { canEdit: true, apiKey: { scopes: ["projects:manage"] } }, true],
    ["wrong-scope key (ingest only)", ingestKey, false],
    ["revoked or unknown key", revokedKey, false],
    ["billed key whose owner is not an editor", billedKeyOfViewer, false],
    ["contributor session", contributor, false],
  ];
  it.each(raises)("smart raise by %s", (_name, caller, ok) => {
    const result = resolveExtractionSettings(base({ caller, request: { quality: "smartest" } }));
    if (ok) expect(result).toMatchObject({ ok: true, quality: "smartest" });
    else expect(result).toMatchObject({ ok: false, error: { status: 403, code: "quality_smart_forbidden" } });
  });
  it.each(raises)("charts-ai raise by %s", (_name, caller, ok) => {
    const result = resolveExtractionSettings(base({ caller, request: { visuals: "charts-ai" } }));
    if (ok) expect(result).toMatchObject({ ok: true, visuals: "charts-ai" });
    else expect(result).toMatchObject({ ok: false, error: { status: 403, code: "chart_export_models_forbidden" } });
  });

  it("raises to balanced, charts and lowerings need no billed authority", () => {
    expect(resolveExtractionSettings(base({ caller: contributor, project: { quality: "fastest", visuals: null }, request: { quality: "fastest" } }))).toMatchObject({ ok: true, quality: "fastest" });
    expect(resolveExtractionSettings(base({ caller: contributor, request: { visuals: "charts" } }))).toMatchObject({ ok: true, visuals: "charts" });
    expect(resolveExtractionSettings(base({ caller: contributor, project: { quality: "smartest", visuals: "charts-ai" }, request: { quality: "fastest", visuals: "none" } }))).toMatchObject({ ok: true, quality: "fastest", visuals: "none" });
  });

  it("a project already on a billed rung needs no extra authority to run it", () => {
    expect(resolveExtractionSettings(base({ caller: ingestKey, project: { quality: "smartest", visuals: "charts-ai" }, request: { quality: "smartest", visuals: "charts-ai" } }))).toMatchObject({ ok: true, quality: "smartest", visuals: "charts-ai" });
  });

  it("explicit charts follows charts.explicitFree; a stored one counts as unset while refused", () => {
    expect(resolveExtractionSettings(base({ policy: policy({ explicitChartsAllowed: false }), request: { visuals: "charts" } }))).toMatchObject({ ok: false, error: { status: 400, code: "visuals_unavailable", reason: "switch" } });
    expect(resolveExtractionSettings(base({ policy: policy({ explicitChartsAllowed: false }), project: { quality: "fastest", visuals: "charts" } }))).toMatchObject({ ok: true, visuals: "figures" });
  });

  it("scopes never override switches or privacy: explicit requests 400, stored values are capped", () => {
    expect(resolveExtractionSettings(base({ caller: billedKey, request: { quality: "smartest" }, constraints: { privacyMode: "local-only", vision: { profile: "good-fast-hosted" } } })))
      .toMatchObject({ ok: false, error: { status: 400, code: "quality_unavailable", reason: "privacy" } });
    expect(resolveExtractionSettings(base({ caller: billedKey, request: { visuals: "charts-ai" }, constraints: { privacyMode: "strict-privacy" } })))
      .toMatchObject({ ok: false, error: { status: 400, code: "visuals_unavailable", reason: "privacy" } });
    expect(resolveExtractionSettings(base({ caller: billedKey, request: { visuals: "charts-ai" }, policy: policy({ disabled: new Set(["charts-ai"]) }) })))
      .toMatchObject({ ok: false, error: { status: 400, code: "visuals_unavailable", reason: "switch" } });
    expect(resolveExtractionSettings(base({ project: { quality: "smartest", visuals: "charts-ai" }, constraints: { privacyMode: "local-only" } }))).toEqual({
      ok: true, quality: "fastest", visuals: "charts",
      capsApplied: [{ field: "quality", from: "smartest", to: "fastest", reason: "privacy" }, { field: "visuals", from: "charts-ai", to: "charts", reason: "privacy" }],
    });
    expect(resolveExtractionSettings(base({ project: { quality: "smartest", visuals: "charts-ai" }, policy: policy({ disabled: new Set(["ai", "charts"]) }) }))).toMatchObject({
      ok: true, quality: "fastest", visuals: "figures",
    });
  });

  it("a local vision profile keeps smart under privacy", () => {
    expect(resolveExtractionSettings(base({ request: { quality: "smartest" }, constraints: { privacyMode: "strict-privacy", vision: { profile: "good-fast-local" } } }))).toMatchObject({ ok: true, quality: "smartest" });
  });

  it("reprocess: inherited values are capped at the project now; an explicit request goes through the raise check", () => {
    const replay = { quality: "smartest" as const, visuals: "charts-ai" as const };
    expect(resolveExtractionSettings(base({ caller: ingestKey, replay, project: { quality: "fastest", visuals: null } }))).toEqual({
      ok: true, quality: "fastest", visuals: "charts",
      capsApplied: [{ field: "quality", from: "smartest", to: "fastest", reason: "replay" }, { field: "visuals", from: "charts-ai", to: "charts", reason: "replay" }],
    });
    expect(resolveExtractionSettings(base({ caller: ingestKey, replay, request: { quality: "smartest" } }))).toMatchObject({ ok: false, error: { status: 403 } });
    expect(resolveExtractionSettings(base({ caller: editorSession, replay, request: { quality: "smartest" } }))).toMatchObject({ ok: true, quality: "smartest" });
  });

  it("resume/retry never exceeds the run's own authority", () => {
    expect(resolveExtractionSettings(base({ project: { quality: "smartest", visuals: "charts-ai" }, authority: { quality: "fastest", visuals: "figures" } }))).toMatchObject({ ok: true, quality: "fastest", visuals: "figures" });
  });

  it("MCP/chat Apply: a proposal applied by a non-editor never raises (same rule as any request)", () => {
    expect(resolveExtractionSettings(base({ caller: contributor, request: { quality: "smartest", visuals: "charts-ai" } }))).toMatchObject({ ok: false, error: { status: 403 } });
  });
});

describe("policy and stamped values", () => {
  it("derives switches and defaults from today's env", () => {
    const off = extractionPolicyFromEnv({ DOCSLURP_CHART_EXPORT: "off" });
    expect([...off.disabled].sort()).toEqual(["charts", "charts-ai"]);
    const on = extractionPolicyFromEnv({ DOCSLURP_CHART_EXPORT: "on", DOCSLURP_CHART_EXPORT_INLINE: "1", DOCSLURP_CHART_EXPORT_APP_DEFAULT: "free" });
    expect(on.disabled.size).toBe(0);
    expect(on.originDefaults).toEqual({ app: "charts", machine: "figures" });
    expect(on.explicitChartsAllowed).toBe(true);
    expect(visualsDefaults(on)).toEqual({ app: "charts", machine: "figures", available: ["none", "figures", "charts", "charts-ai"] });
    expect(visualsDefaults(off).available).toEqual(["none", "figures"]);
  });

  it("stamps readsPages from the resolved legacy pipeline", () => {
    expect(runEffectiveExtraction({ quality: "fast", visionFallback: true }).readsPages).toBe(false);
    expect(runEffectiveExtraction({ quality: "auto", visionFallback: false }).readsPages).toBe(false);
    // Fastest never reads a page with a vision model; Smartest does while vision is on.
    expect(runEffectiveExtraction({ quality: "auto", visionFallback: true }).readsPages).toBe(false);
    expect(runEffectiveExtraction({ quality: "auto", ladder: { maxRung: "intelligent" }, visionFallback: true }).readsPages).toBe(true);
    expect(runEffectiveExtraction({ quality: "auto", ladder: { maxRung: "intelligent" }, visionFallback: false }).readsPages).toBe(false);
    expect(runEffectiveExtraction({ quality: "good", visionFallback: true })).toMatchObject({ quality: "smartest", readsPages: true });
    expect(runEffectiveExtraction({ figures: false, chartExport: { tier: "off" } }).visuals).toBe("none");
  });

  it("maps old runs on read with legacy: true; stamped runs read their stamp", () => {
    expect(runExtractionView({ quality: "good", chartExport: { tier: "models" } })).toMatchObject({ quality: "smartest", visuals: "charts-ai", legacy: true });
    expect(runExtractionView({ quality: "fast", effective: { quality: "fastest", visuals: "none", readsPages: false, capsApplied: [] } })).toMatchObject({ visuals: "none", legacy: false });
  });

  it("project view reports stored values", () => {
    expect(projectExtractionView({ quality: "good", privacyMode: "local-only", chartExport: { tier: "models" } }, {})).toEqual({ quality: "smartest", readScans: true, visuals: "charts-ai" });
    expect(projectExtractionView({ quality: "auto", ladder: { maxRung: "fast" } }, {})).toEqual({ quality: "fastest", readScans: false, visuals: null });
    expect(projectExtractionView({ quality: "fast" }, {})).toEqual({ quality: "fastest", readScans: false, visuals: null });
  });
});

describe("extractionChoicesFor (project.extractionChoices)", () => {
  const choices = (pipeline: Record<string, unknown>, caller: Parameters<typeof extractionChoicesFor>[0]["caller"], over: Partial<ExtractionPolicy> = {}, origin: "app" | "machine" = "app") =>
    extractionChoicesFor({ pipeline, origin, caller, policy: policy(over) });

  it("a default-project contributor is never offered smart or charts-ai above the project", () => {
    const result = choices({ quality: "auto" }, contributor);
    expect(result.quality).toEqual(["fastest"]);
    expect(result.visuals).toEqual(["none", "figures", "charts"]);
  });

  it("an editor session is offered every rung the deployment and project allow", () => {
    const result = choices({ quality: "auto" }, editorSession, { disabled: new Set() });
    expect(result.quality).toEqual(["fastest", "smartest"]);
    expect(result.visuals).toEqual(["none", "figures", "charts", "charts-ai"]);
  });

  it("a contributor keeps the project's own billed rung (not a raise)", () => {
    const result = choices({ quality: "good", chartExport: { tier: "models" } }, contributor);
    expect(result.quality).toContain("smartest");
    expect(result.visuals).toContain("charts-ai");
  });

  it("keys need an editor owner and the billed scope; unreadable scopes fail closed", () => {
    expect(choices({ quality: "auto" }, billedKey, {}, "machine").quality).toContain("smartest");
    expect(choices({ quality: "auto" }, ingestKey, {}, "machine").quality).not.toContain("smartest");
    expect(choices({ quality: "auto" }, revokedKey, {}, "machine").quality).not.toContain("smartest");
    expect(choices({ quality: "auto" }, billedKeyOfViewer, {}, "machine").quality).not.toContain("smartest");
  });

  it("privacy, locality and switches remove rungs even for editors", () => {
    const restricted = choices({ quality: "auto", privacyMode: "strict-privacy" }, editorSession);
    expect(restricted.quality).toEqual(["fastest"]);
    expect(restricted.visuals).not.toContain("charts-ai");
    const local = choices({ quality: "auto", privacyMode: "local-only", vision: { profile: "good-fast-local" } }, editorSession);
    expect(local.quality).toContain("smartest");
    const switched = choices({ quality: "auto" }, editorSession, { disabled: new Set(["ai", "charts"]) });
    expect(switched.quality).toEqual(["fastest"]);
    expect(switched.visuals).toEqual(["none", "figures"]);
    expect(choices({ quality: "auto" }, editorSession, { explicitChartsAllowed: false }).visuals).not.toContain("charts");
  });

  it("a legacy project with figures off and a chart tier keeps its tier's rung, as run creation compares it", () => {
    expect(choices({ quality: "auto", figures: false, chartExport: { tier: "models" } }, contributor).visuals).toContain("charts-ai");
    expect(choices({ quality: "auto", figures: false }, contributor).visuals).not.toContain("charts-ai");
  });

  it("every offered rung is accepted by resolveExtractionSettings and every withheld one refused", () => {
    const pipelines = [{ quality: "fast" }, { quality: "auto", privacyMode: "local-only" }, { quality: "good", figures: false }, { quality: "auto", chartExport: { tier: "free" } }, { quality: "auto", ladder: { maxRung: "intelligent" } }];
    const callers = [editorSession, contributor, billedKey, ingestKey, revokedKey];
    for (const pipeline of pipelines) for (const caller of callers) {
      const offered = choices(pipeline, caller);
      const stored = mapLegacyExtractionSettings({ ...pipeline, privacyMode: "standard" }, allowed);
      for (const quality of ["fastest", "smartest"] as const) {
        const ok = resolveExtractionSettings({ request: { quality }, project: stored, origin: "app", caller, constraints: { privacyMode: pipeline.privacyMode, vision: undefined }, policy: policy() }).ok;
        expect(offered.quality.includes(quality)).toBe(ok);
      }
    }
  });
});

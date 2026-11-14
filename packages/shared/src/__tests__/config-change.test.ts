import { describe, expect, it } from "vitest";

import {
  PIPELINE_FIELD_IMPACT,
  analyzePipelineChange,
  analyzeSearchSettingsChange,
  estimatePipelineWork,
  indexConfigOf,
} from "../config-change.js";
import { affectedStages, defaultPipelineFeatures, normalizePipelineFeatures, pipelineFeaturesSchema, pipelineStagePlan, compilePipelinePlan } from "../index.js";

const ctx = { documents: 3, pages: 120, env: { DOCSLURP_CHART_EXPORT: "on" } };
const base = normalizePipelineFeatures(defaultPipelineFeatures);
const withF = (patch: Record<string, unknown>) => normalizePipelineFeatures({ ...base, ...patch } as never);

describe("PIPELINE_FIELD_IMPACT", () => {
  it("classifies every PipelineFeatures field", () => {
    const keys = Object.keys(pipelineFeaturesSchema.shape);
    expect(keys.length).toBeGreaterThan(30);
    expect(keys.filter((key) => !(key in PIPELINE_FIELD_IMPACT))).toEqual([]);
    expect(Object.keys(PIPELINE_FIELD_IMPACT).filter((key) => !keys.includes(key))).toEqual([]);
  });
});

describe("analyzePipelineChange", () => {
  it("no change is none", () => {
    const impact = analyzePipelineChange(base, base, ctx);
    expect(impact).toMatchObject({ kind: "none", stages: [], documents: 3, pages: 120 });
  });
  it("embedding model change requires re-embed through index", () => {
    const after = withF({ embedding: { profile: "cheapest-local" } });
    const impact = analyzePipelineChange(base, after, ctx);
    expect(impact.kind).toBe("reindex-required");
    expect(impact.stages[0]).toBe("embed");
    expect(impact.stages.at(-1)).toBe("index");
    expect(impact.reasons.some((r) => r.field === "embedding")).toBe(true);
  });
  it("chunking and vector backend changes are required", () => {
    expect(analyzePipelineChange(base, withF({ chunkOverlap: true }), ctx).kind).toBe("reindex-required");
    expect(analyzePipelineChange(base, withF({ vectorBackends: ["lancedb", "orama"] }), ctx).kind).toBe("reindex-required");
  });
  it("enabling summaries is recommended and only runs document-summary", () => {
    const impact = analyzePipelineChange(base, withF({ summarize: true }), ctx);
    expect(impact.kind).toBe("reindex-recommended");
    expect(impact.stages).toEqual(["document-summary"]);
  });
  it("disabling summaries needs no work", () => {
    const on = withF({ summarize: true });
    expect(analyzePipelineChange(on, base, ctx).kind).toBe("new-uploads");
  });
  it("budget change is new-uploads with no stages", () => {
    const impact = analyzePipelineChange(base, withF({ maxCostCents: 500 }), ctx);
    expect(impact).toMatchObject({ kind: "new-uploads", stages: [] });
  });
  it("PII action stricter is required, looser is new-uploads", () => {
    const flag = withF({ piiPolicy: { ...base.piiPolicy, enabled: true, action: "flag_for_review" } });
    const redact = withF({ piiPolicy: { ...base.piiPolicy, enabled: true, action: "redact_artifacts" } });
    const block = withF({ piiPolicy: { ...base.piiPolicy, enabled: true, action: "block_indexing" } });
    expect(analyzePipelineChange(flag, redact, ctx).kind).toBe("reindex-required");
    expect(analyzePipelineChange(redact, block, ctx).kind).toBe("reindex-required");
    expect(analyzePipelineChange(block, flag, ctx).kind).toBe("new-uploads");
    expect(analyzePipelineChange(base, flag, ctx).kind).not.toBe("none");
  });
  it("PII allowlist: removing entries is required, adding is new-uploads", () => {
    const withList = withF({ piiPolicy: { ...base.piiPolicy, enabled: true, allowlistPatterns: ["a", "b"] } });
    const fewer = withF({ piiPolicy: { ...base.piiPolicy, enabled: true, allowlistPatterns: ["a"] } });
    expect(analyzePipelineChange(withList, fewer, ctx).kind).toBe("reindex-required");
    expect(analyzePipelineChange(fewer, withList, ctx).kind).toBe("new-uploads");
  });
  it("PII action change re-runs consumers (embed, graph-enrich, index)", () => {
    const flag = withF({ graphRag: true, piiPolicy: { ...base.piiPolicy, enabled: true, action: "flag_for_review" } });
    const redact = withF({ graphRag: true, piiPolicy: { ...base.piiPolicy, enabled: true, action: "redact_artifacts" } });
    const stages = affectedStages(flag, redact);
    expect(stages).toEqual(expect.arrayContaining(["pii-detect", "embed", "graph-enrich", "index"]));
    expect(analyzePipelineChange(flag, redact, ctx).stages).toEqual(stages);
  });
  it("embedding change while embed is off is not a re-index", () => {
    const off = withF({ embed: false, indexVectors: false });
    const impact = analyzePipelineChange(off, withF({ embed: false, indexVectors: false, embedding: { profile: "cheapest-local" } }), ctx);
    expect(impact.kind).toBe("new-uploads");
    expect(impact.stages).toEqual([]);
    expect(impact.reasons[0]!.effect).toMatch(/remains until the feature is re-enabled/);
    // embed off + model changed in one edit
    const both = analyzePipelineChange(base, withF({ embed: false, indexVectors: false, embedding: { profile: "cheapest-local" } }), ctx);
    expect(both.kind).toBe("new-uploads");
    expect(both.stages).toEqual([]);
  });
  it("an unrelated recommended field neither masks nor inflates a required one", () => {
    const after = withF({ summarize: true, embedding: { profile: "cheapest-local" } });
    const impact = analyzePipelineChange(base, after, ctx);
    expect(impact.kind).toBe("reindex-required");
    const off = analyzePipelineChange(withF({ embed: false, indexVectors: false }), withF({ embed: false, indexVectors: false, summarize: true, embedding: { profile: "cheapest-local" } }), ctx);
    expect(off.kind).toBe("reindex-recommended");
    expect(off.stages).toEqual(["document-summary"]);
  });
  it("quality: upgrade is recommended, downgrade is new-uploads", () => {
    expect(analyzePipelineChange(base, withF({ quality: "good" }), ctx).kind).toBe("reindex-recommended");
    expect(analyzePipelineChange(base, withF({ quality: "fast" }), ctx).kind).toBe("new-uploads");
  });
  it("stricter privacyMode is required, looser is new-uploads", () => {
    // Strict privacy requires a local embedding profile; hold the embedding fixed so only the privacy mode differs.
    const local = withF({ embedding: { profile: "good-fast-local" } });
    const strict = withF({ embedding: { profile: "good-fast-local" }, privacyMode: "strict-privacy" });
    expect(analyzePipelineChange(local, strict, ctx).kind).toBe("reindex-required");
    expect(analyzePipelineChange(strict, local, ctx).kind).toBe("new-uploads");
  });
  it("takes the strictest kind and merges stages in pipeline order", () => {
    const impact = analyzePipelineChange(base, withF({ summarize: true, chunkOverlap: true, maxCostCents: 5 }), ctx);
    expect(impact.kind).toBe("reindex-required");
    expect(impact.stages).toContain("document-summary");
    expect(impact.stages).toContain("embed");
    const order = compilePipelinePlan(withF({ summarize: true })).stageOrder;
    expect(impact.stages).toEqual(order.filter((s) => impact.stages.includes(s)));
  });
  it("chart export: moving up a tier or adding formats recommends a reindex through vision-extract", () => {
    const models = withF({ chartExport: { tier: "models" } });
    const app = { ...ctx, origin: "app" as const };
    const enabled = analyzePipelineChange(base, models, app);
    expect(enabled.kind).toBe("reindex-recommended");
    expect(enabled.stages[0]).toBe("vision-extract");
    expect(enabled.reasons.find((r) => r.field === "chartExport")?.effect).toMatch(/reprocess/);
    const more = withF({ chartExport: { tier: "models", formats: ["description", "mermaid", "csv"] } });
    expect(analyzePipelineChange(models, more, app).kind).toBe("reindex-recommended");
    // Dropping a format, moving down a tier or turning it off applies to new uploads.
    expect(analyzePipelineChange(more, models, app).kind).toBe("new-uploads");
    expect(analyzePipelineChange(models, base, app).kind).toBe("new-uploads");
    expect(analyzePipelineChange(models, withF({ chartExport: { tier: "free" } }), app).kind).toBe("new-uploads");
    expect(analyzePipelineChange(base, withF({ chartExport: { tier: "off" } }), app).kind).toBe("new-uploads");
    // Formats edited while export is off do nothing to stored data.
    expect(analyzePipelineChange(base, withF({ chartExport: { tier: "off", formats: ["csv"] } }), app).kind).toBe("new-uploads");
  });
  it("chart export: an unset tier resolves for the caller's surface", () => {
    const free = withF({ chartExport: { tier: "free" } });
    const ctx = { documents: 3, pages: 120, env: { DOCSLURP_CHART_EXPORT: "on", DOCSLURP_CHART_EXPORT_FREE_EXPLICIT: "on" } };
    // With no default set, every surface defaults to off: free is an optional (free) reindex.
    expect(analyzePipelineChange(base, free, { ...ctx, origin: "app" }).kind).toBe("reindex-recommended");
    // DOCSLURP_CHART_EXPORT_APP_DEFAULT=free makes the app's default free: setting it explicitly changes nothing stored.
    expect(analyzePipelineChange(base, free, { ...ctx, origin: "app", env: { ...ctx.env, DOCSLURP_CHART_EXPORT_APP_DEFAULT: "free" } }).kind).toBe("new-uploads");
    expect(analyzePipelineChange(base, free, { ...ctx, origin: "machine" }).kind).toBe("reindex-recommended");
    // DOCSLURP_CHART_EXPORT_API_DEFAULT=free makes API callers' default free too.
    expect(analyzePipelineChange(base, free, { ...ctx, origin: "machine", env: { ...ctx.env, DOCSLURP_CHART_EXPORT_API_DEFAULT: "free" } }).kind).toBe("new-uploads");
  });
  it("chart export: classification follows the production defaults (switch on, app default off, explicit free refused)", () => {
    const production = { DOCSLURP_CHART_EXPORT: "on", DOCSLURP_CHART_EXPORT_APP_DEFAULT: "off" };
    const app = { ...ctx, origin: "app" as const, env: production };
    // Unset -> models: billed reads old documents gain on reprocess.
    expect(analyzePipelineChange(base, withF({ chartExport: { tier: "models" } }), app).kind).toBe("reindex-recommended");
    // A stored free counts as unset while explicit free is refused, so it changes nothing.
    expect(analyzePipelineChange(base, withF({ chartExport: { tier: "free" } }), app).kind).toBe("new-uploads");
    // With explicit free allowed, unset (off here) -> free is a reindex, not "new uploads only".
    const freeOk = { ...app, env: { ...production, DOCSLURP_CHART_EXPORT_FREE_EXPLICIT: "on" } };
    expect(analyzePipelineChange(base, withF({ chartExport: { tier: "free" } }), freeOk).kind).toBe("reindex-recommended");
    // A typo in the app default fails closed (off), never free.
    expect(analyzePipelineChange(base, withF({ chartExport: { tier: "free" } }), { ...freeOk, env: { ...freeOk.env, DOCSLURP_CHART_EXPORT_APP_DEFAULT: "of" } }).kind).toBe("reindex-recommended");
    // Clients pass the server-reported defaults instead of an environment.
    const reported = { app: "off" as const, machine: "off" as const, modelsAvailable: true, freeAvailable: true, ceiling: "on" as const };
    expect(analyzePipelineChange(base, withF({ chartExport: { tier: "free" } }), { documents: 3, pages: 120, origin: "app", chartExportDefaults: reported }).kind).toBe("reindex-recommended");
    // Under the switch off nothing runs, so no tier change recommends a reindex.
    expect(analyzePipelineChange(base, withF({ chartExport: { tier: "models" } }), { documents: 3, pages: 120, origin: "app", chartExportDefaults: { ...reported, ceiling: "off" } }).kind).toBe("new-uploads");
    // No defaults at all: conservative (nothing runs), never an assumed free.
    expect(analyzePipelineChange(base, withF({ chartExport: { tier: "models" } }), { documents: 3, pages: 120, origin: "app" }).kind).toBe("new-uploads");
  });
  it("chart export: vision-extract runs unless the tier is explicitly off", () => {
    const noVision = withF({ visionFallback: false });
    const off = withF({ visionFallback: false, chartExport: { tier: "off" } });
    const models = withF({ visionFallback: false, chartExport: { tier: "models" } });
    const impact = analyzePipelineChange(off, models, ctx);
    expect(impact.kind).toBe("reindex-recommended");
    expect(impact.stages).toContain("vision-extract");
    const stage = pipelineStagePlan.find((item) => item.stage === "vision-extract")!;
    expect(stage.isEnabled(off)).toBe(false);
    expect(stage.isEnabled(noVision)).toBe(true);
    expect(stage.isEnabled(models)).toBe(true);
  });
  it("chart export: no concrete default is stored, and unknown keys and model names are refused", () => {
    expect(base.chartExport).toEqual({ formats: ["description", "mermaid"], diagrams: true });
    expect(base.chartExport.tier).toBeUndefined();
    expect(() => pipelineFeaturesSchema.parse({ chartExport: { tier: "models", bogus: 1 } })).toThrow();
    expect(() => pipelineFeaturesSchema.parse({ chartExport: { tier: "models", generatorModel: "llm://x/y" } })).toThrow();
    expect(() => pipelineFeaturesSchema.parse({ chartExport: { enabled: true } })).toThrow();
    expect(() => pipelineFeaturesSchema.parse({ chartExport: { tier: "turbo" } })).toThrow();
    expect(() => pipelineFeaturesSchema.parse({ chartExport: { formats: ["png"] } })).toThrow();
  });
  it("figures: on by default; turning on recommends a reindex, turning off applies to new uploads", () => {
    expect(base.figures).toBe(true);
    const off = withF({ figures: false });
    const offImpact = analyzePipelineChange(base, off, ctx);
    expect(offImpact.kind).toBe("new-uploads");
    expect(offImpact.reasons.find((r) => r.field === "figures")?.effect).toMatch(/keep their figures until you reprocess/);
    const on = analyzePipelineChange(off, base, ctx);
    expect(on.kind).toBe("reindex-recommended");
    expect(on.stages[0]).toBe("extract-markdown");
    expect(() => pipelineFeaturesSchema.parse({ figures: "yes" })).toThrow();
  });
  it("is fast", () => {
    const after = withF({ summarize: true, chunkOverlap: true });
    analyzePipelineChange(base, after, ctx);
    const t = performance.now();
    for (let i = 0; i < 20; i += 1) analyzePipelineChange(base, after, ctx);
    expect((performance.now() - t) / 20).toBeLessThan(5);
  });
});

describe("misc helpers", () => {
  it("analyzeSearchSettingsChange is search-only or none", () => {
    expect(analyzeSearchSettingsChange({ a: 1 }, { a: 1 }, ctx).kind).toBe("none");
    expect(analyzeSearchSettingsChange({ a: 1 }, { a: 2 }, ctx).kind).toBe("search-only");
  });
  it("indexConfigOf reports model, dims, chunking, backends", () => {
    const cfg = indexConfigOf(base);
    expect(cfg.embeddingModel).toBe(base.embedding.modelUri);
    expect(cfg.vectorBackends).toEqual(base.vectorBackends);
    expect(cfg.chunking).toBeTypeOf("object");
    expect(indexConfigOf(withF({ chunkOverlap: true }))).not.toEqual(cfg);
  });
  it("affectedStages is empty for stage-free fields", () => {
    expect(affectedStages(base, withF({ maxCostCents: 1 }))).toEqual([]);
  });
});

describe("estimatePipelineWork", () => {
  const stages = compilePipelinePlan(base).stageOrder;
  const env = { STRIPE_SECRET_KEY: "sk_test" };
  it("is monotonic in pages", () => {
    let prev = -1;
    let prevSec = -1;
    for (const pages of [1, 10, 100, 1000, 10000]) {
      const e = estimatePipelineWork({ features: base, stages, pages, documents: 1, env });
      expect(e.credits!.high).toBeGreaterThanOrEqual(prev);
      expect(e.credits!.high).toBeGreaterThanOrEqual(e.credits!.low);
      expect(e.seconds!.high).toBeGreaterThanOrEqual(prevSec);
      prev = e.credits!.high;
      prevSec = e.seconds!.high;
    }
  });
  it("hides credits when billing is disabled", () => {
    const e = estimatePipelineWork({ features: base, stages, pages: 100, documents: 1, env: {} });
    expect(e.billing).toBe("disabled");
    expect(e.credits).toBeNull();
    expect(e.seconds).not.toBeNull();
  });
  it("prices fewer stages lower", () => {
    const full = estimatePipelineWork({ features: base, stages, pages: 500, documents: 5, env });
    const small = estimatePipelineWork({ features: base, stages: ["index"], pages: 500, documents: 5, env });
    expect(small.credits!.high).toBeLessThan(full.credits!.high);
    expect(estimatePipelineWork({ features: base, stages: [], pages: 500, documents: 5, env }).credits!.high).toBe(0);
  });
});

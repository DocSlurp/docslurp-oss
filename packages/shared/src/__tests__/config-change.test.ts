import { describe, expect, it } from "vitest";

import {
  PIPELINE_FIELD_IMPACT,
  analyzePipelineChange,
  analyzeSearchSettingsChange,
  estimatePipelineWork,
  indexConfigOf,
} from "../config-change.js";
import { affectedStages, defaultPipelineFeatures, normalizePipelineFeatures, pipelineFeaturesSchema, compilePipelinePlan } from "../index.js";

const ctx = { documents: 3, pages: 120 };
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
  it("parserPlaybook: upgrade is recommended, downgrade is new-uploads", () => {
    expect(analyzePipelineChange(base, withF({ parserPlaybook: "agentic" }), ctx).kind).toBe("reindex-recommended");
    expect(analyzePipelineChange(base, withF({ parserPlaybook: "fast" }), ctx).kind).toBe("new-uploads");
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

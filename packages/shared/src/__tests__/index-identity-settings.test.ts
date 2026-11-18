import { describe, expect, it } from "vitest";

import {
  analyzePipelineChange,
  assertIndexIdentityUnchanged,
  vectorsReenabled,
  changedIndexIdentitySettings,
  INDEX_IDENTITY_SETTINGS,
  indexConfigHash,
  indexConfigOf,
  indexRebuildStages,
  PIPELINE_FIELD_IMPACT,
  reindexProjectSchema,
} from "../config-change.js";
import { publicApiErrorDetails, publicApiErrorEnvelope } from "../api-error.js";
import { defaultPipelineFeatures, normalizePipelineFeatures, type PipelineFeatures } from "../index.js";

const base = normalizePipelineFeatures(defaultPipelineFeatures);
const withF = (patch: Record<string, unknown>) => normalizePipelineFeatures({ ...base, ...patch } as never);
const alternatives: Record<(typeof INDEX_IDENTITY_SETTINGS)[number], Partial<PipelineFeatures>> = {
  embedding: { embedding: normalizePipelineFeatures({ ...base, embedding: { profile: "fastest-local" } } as never).embedding },
  chunkOverlap: { chunkOverlap: !base.chunkOverlap },
  contextualChunkPreambles: { contextualChunkPreambles: !base.contextualChunkPreambles },
  vectorBackends: { vectorBackends: ["lancedb", "orama"] as never },
};

describe("INDEX_IDENTITY_SETTINGS", () => {
  it.each(INDEX_IDENTITY_SETTINGS)("%s changes the index identity and requires a re-index", (field) => {
    const after = withF(alternatives[field]);
    expect(indexConfigHash(indexConfigOf(after))).not.toBe(indexConfigHash(indexConfigOf(base)));
    expect(PIPELINE_FIELD_IMPACT[field]).toBe("reindex-required");
    expect(changedIndexIdentitySettings(base, after)).toEqual([field]);
  });

  it("is every field indexConfigOf reads: other fields leave the identity alone", () => {
    for (const [field, value] of [["summarize", true], ["quality", "smart"], ["pageIndex", true], ["maxCostCents", 5]] as const) {
      const after = withF({ [field]: value });
      expect(indexConfigHash(indexConfigOf(after))).toBe(indexConfigHash(indexConfigOf(base)));
      expect(changedIndexIdentitySettings(base, after)).toEqual([]);
    }
  });

  it("lists an identity change even while embedding is off (re-enabling it later must not apply it silently)", () => {
    const off = withF({ embed: false, indexVectors: false });
    expect(changedIndexIdentitySettings(off, { ...off, ...alternatives.embedding })).toEqual(["embedding"]);
  });

  it("ignores changes that leave the index hash alone, and never re-indexes for them", () => {
    const two = withF({ vectorBackends: ["lancedb", "orama"] });
    const reordered = withF({ vectorBackends: ["orama", "lancedb"] });
    expect(changedIndexIdentitySettings(two, reordered)).toEqual([]);
    expect(analyzePipelineChange(two, reordered, { documents: 1, pages: 1 }).kind).not.toMatch(/^reindex/);
    // A request option the vectors do not depend on (the embedding task).
    const task = withF({ embedding: { ...base.embedding, task: "code" } });
    expect(changedIndexIdentitySettings(base, task)).toEqual([]);
    expect(analyzePipelineChange(base, task, { documents: 1, pages: 1 }).stages).toEqual([]);
  });

  it("names the vector switches turned back on", () => {
    const off = withF({ embed: false, indexVectors: false });
    expect(vectorsReenabled(off, base)).toEqual(["embed", "indexVectors"]);
    expect(vectorsReenabled(base, off)).toEqual([]);
  });

  it("assertIndexIdentityUnchanged refuses identity changes only", () => {
    expect(() => assertIndexIdentityUnchanged(base, withF(alternatives.chunkOverlap), "test")).toThrow(/chunkOverlap/);
    expect(() => assertIndexIdentityUnchanged(base, withF({ summarize: true }), "test")).not.toThrow();
  });

  it("rebuilds the summary tree with the vectors when it is on", () => {
    const tree = withF({ summaryTree: { enabled: true } });
    expect(indexRebuildStages(tree)).toEqual(expect.arrayContaining(["embed", "index", "summary-tree"]));
  });

  it("rebuilds the embed and index stages", () => {
    expect(indexRebuildStages(base)).toEqual(expect.arrayContaining(["embed", "index"]));
  });
});

describe("reindexProjectSchema", () => {
  it("takes only index settings", () => {
    expect(reindexProjectSchema.safeParse({ pipeline: { embedding: { profile: "fastest-local" } } }).success).toBe(true);
    expect(reindexProjectSchema.safeParse({}).success).toBe(true);
    expect(reindexProjectSchema.safeParse({ pipeline: { summarize: true } }).success).toBe(false);
    expect(reindexProjectSchema.safeParse({ pipeline: { embed: true, indexVectors: true } }).success).toBe(true);
    expect(reindexProjectSchema.safeParse({ apply: "new-uploads" }).success).toBe(false);
    expect(reindexProjectSchema.safeParse({ confirmEstimate: "nope" }).success).toBe(false);
  });
});

describe("reindex_required details", () => {
  const reindex = { lockedSettings: ["embedding"], documents: 3, pages: 40, credits: { low: 1.2, high: 2.5 }, signature: "a".repeat(64), reindexUrl: "/v1/projects/p1/reindex" };

  it("crosses the boundary only in the expected shape", () => {
    expect(publicApiErrorDetails({ reindex })).toEqual({ reindex });
    expect(publicApiErrorDetails({ reindex: { ...reindex, lockedSettings: ["secret-field"] } })).toBeUndefined();
    expect(publicApiErrorDetails({ reindex: { ...reindex, reindexUrl: "https://evil.example/" } })).toBeUndefined();
    expect(publicApiErrorDetails({ reindex: { ...reindex, credits: null } })).toEqual({ reindex: { ...reindex, credits: null } });
    // The sanitizer's own copy of the list agrees with INDEX_IDENTITY_SETTINGS.
    expect(publicApiErrorDetails({ reindex: { ...reindex, lockedSettings: [...INDEX_IDENTITY_SETTINGS] } })).toEqual({ reindex: { ...reindex, lockedSettings: [...INDEX_IDENTITY_SETTINGS] } });
  });

  it("names the locked settings and the work in the public message", () => {
    const envelope = publicApiErrorEnvelope({ error: { code: "reindex_required", message: "internal", details: { reindex } } }, 409);
    expect(envelope?.error.message).toContain("Locked index settings changed: embedding.");
    expect(envelope?.error.message).toContain("3 documents (40 pages), about 1.2-2.5 credits");
  });
});

import { describe, expect, it } from "vitest";

import { analyzePipelineChange, PIPELINE_FIELD_IMPACT } from "../config-change.js";
import {
  affectedStages,
  defaultPipelineFeatures,
  mergePipelineFeatures,
  normalizePipelineFeatures,
  parseStoredPipelineFeatures,
  pipelineFeatureOverridesSchema,
  pipelineFeaturesSchema,
  type PipelineFeatures,
} from "../pipeline.js";
import {
  applyProjectPipelineOverrides,
  applyProjectTemplateLocks,
  defaultProjectSearchSettings,
  projectSearchRetrievalDefaultsSchema,
  projectTemplates,
  updateProjectSearchRetrievalDefaultsSchema,
} from "../project.js";
import { projectStateSchema } from "../project-state.js";
import {
  DEFAULT_SUMMARY_TREE_SEARCH_MODE,
  defaultSummaryTreePipelineConfig,
  effectiveSummaryTreeSearchMode,
  SUMMARY_TREE_BUILD_ENV_FLAG,
  SUMMARY_TREE_CONSTANTS,
  SUMMARY_TREE_MAX_GROUP_SIZE,
  SUMMARY_TREE_MIN_GROUP_SIZE,
  SUMMARY_TREE_SERVE_ENV_FLAG,
  summaryRowSchema,
  summaryTreeBuildActive,
  summaryTreeBuildAvailable,
  summaryTreeBuildStatus,
  SummaryTreeConfigError,
  summaryTreeConstantsSchema,
  summaryTreeDeadlineMs,
  summaryTreePipelineConfigSchema,
  summaryTreeSearchRefusal,
  summaryTreeServeAvailable,
  summaryTreeSwitchWarnings,
  updateProjectSummaryTreeSchema,
} from "../summary-tree.js";
import { LANCEDB_CHUNKS_TABLE, LANCEDB_SUMMARIES_TABLE, VectorNamespaceManager } from "../vector-namespace.js";

const ON = { [SUMMARY_TREE_BUILD_ENV_FLAG]: "on", [SUMMARY_TREE_SERVE_ENV_FLAG]: "on" };
const treeOn = (overrides: Partial<PipelineFeatures> = {}) => normalizePipelineFeatures({ ...defaultPipelineFeatures, ...overrides, summaryTree: { enabled: true } });

describe("summary tree: never on by default", () => {
  it("is off in every template and every default", () => {
    expect(defaultSummaryTreePipelineConfig).toEqual({ enabled: false });
    expect(summaryTreePipelineConfigSchema.parse({})).toEqual({ enabled: false });
    expect(defaultPipelineFeatures.summaryTree).toEqual({ enabled: false });
    expect(pipelineFeaturesSchema.parse({}).summaryTree).toEqual({ enabled: false });
    expect(normalizePipelineFeatures(null).summaryTree).toEqual({ enabled: false });
    expect(normalizePipelineFeatures({}).summaryTree).toEqual({ enabled: false });
    expect(parseStoredPipelineFeatures({ summaryTree: "yes" }).summaryTree).toEqual({ enabled: false });
    expect(projectTemplates.length).toBeGreaterThan(0);
    for (const template of projectTemplates) {
      expect(template.pipeline.summaryTree, template.key).toEqual({ enabled: false });
      expect(normalizePipelineFeatures(template.pipeline).summaryTree, template.key).toEqual({ enabled: false });
      expect(applyProjectTemplateLocks(normalizePipelineFeatures(null), template).summaryTree, template.key).toEqual({ enabled: false });
    }
    expect(DEFAULT_SUMMARY_TREE_SEARCH_MODE).toBe("off");
    expect(defaultProjectSearchSettings.retrievalDefaults.summaryTree).toBe("off");
    expect(projectSearchRetrievalDefaultsSchema.parse({}).summaryTree).toBe("off");
    // The retrieval update leaves it alone unless it is named.
    expect(updateProjectSearchRetrievalDefaultsSchema.parse({})).not.toHaveProperty("summaryTree");
    expect(updateProjectSearchRetrievalDefaultsSchema.safeParse({ summaryTree: "everything" }).success).toBe(false);
  });

  it("summaries never imply the tree, and the tree turns summaries on", () => {
    expect(normalizePipelineFeatures({ summarize: true }).summaryTree).toEqual({ enabled: false });
    expect(treeOn({ summarize: false })).toMatchObject({ summarize: true, summaryTree: { enabled: true } });
    expect(parseStoredPipelineFeatures({ summaryTree: { enabled: true }, summarize: false })).toMatchObject({ summarize: true, summaryTree: { enabled: true } });
  });

  it("rejects the tree without embeddings or the vector index", () => {
    for (const patch of [{ embed: false, indexVectors: false }, { indexVectors: false }]) {
      const parsed = pipelineFeaturesSchema.safeParse({ ...defaultPipelineFeatures, ...patch, summaryTree: { enabled: true } });
      expect(parsed.success).toBe(false);
      expect(parsed.error!.issues.map((issue) => issue.path.join("."))).toContain("summaryTree.enabled");
      expect(() => normalizePipelineFeatures({ ...defaultPipelineFeatures, ...patch, summaryTree: { enabled: true } } as PipelineFeatures)).toThrow(/summary tree needs embeddings/);
    }
    // Off, the same pipelines are fine.
    expect(pipelineFeaturesSchema.safeParse({ ...defaultPipelineFeatures, embed: false, indexVectors: false }).success).toBe(true);
    expect(summaryTreePipelineConfigSchema.safeParse({ enabled: true, prompt: "write like a pirate" }).success).toBe(false);
    expect(updateProjectSummaryTreeSchema.safeParse({ enabled: true, groupSize: 3 }).success).toBe(false);
    expect(updateProjectSummaryTreeSchema.safeParse({}).success).toBe(false);
  });

  it("fails loudly under a template that locks summaries off, and passes under the others", () => {
    const locking = projectTemplates.filter((template) => template.lockedSettings.includes("summarize") && template.pipeline.summarize === false);
    expect(locking.map((template) => template.key)).toContain("legal-contracts");
    for (const template of locking) {
      const pipeline = { ...template.pipeline, summarize: true, summaryTree: { enabled: true } };
      expect(() => applyProjectTemplateLocks(pipeline, template), template.key).toThrow(SummaryTreeConfigError);
      try {
        applyProjectTemplateLocks(pipeline, template.key);
      } catch (error) {
        expect(error).toMatchObject({ code: "summary_tree_summarize_locked", status: 409 });
      }
      // The lock itself still holds with the tree off.
      expect(applyProjectTemplateLocks({ ...template.pipeline, summarize: true }, template).summarize).toBe(false);
    }
    expect(applyProjectTemplateLocks(treeOn(), null)).toMatchObject({ summarize: true, summaryTree: { enabled: true } });
    for (const template of projectTemplates.filter((candidate) => !locking.includes(candidate))) {
      const pipeline = normalizePipelineFeatures({ ...template.pipeline, summaryTree: { enabled: true } });
      expect(applyProjectTemplateLocks(pipeline, template), template.key).toMatchObject({ summarize: true, summaryTree: { enabled: true } });
    }
  });

  it("is never an override: merging keeps the base's value", () => {
    const override = { summaryTree: { enabled: true }, pageIndex: true } as never;
    expect(mergePipelineFeatures(defaultPipelineFeatures, override)).toMatchObject({ pageIndex: true, summarize: false, summaryTree: { enabled: false } });
    expect(mergePipelineFeatures(null, override).summaryTree).toEqual({ enabled: false });
    expect(mergePipelineFeatures(defaultPipelineFeatures, { summaryTree: { enabled: true } } as never)).toEqual(normalizePipelineFeatures(defaultPipelineFeatures));
    expect(applyProjectPipelineOverrides(defaultPipelineFeatures, override, null).summaryTree).toEqual({ enabled: false });
    // And an override cannot turn a stored tree off.
    expect(mergePipelineFeatures(treeOn(), { summaryTree: { enabled: false }, summarize: false } as never)).toMatchObject({ summarize: true, summaryTree: { enabled: true } });
    // An upload that resends the project's pipeline is accepted; the key still changes nothing.
    const parsed = pipelineFeatureOverridesSchema.parse({ summaryTree: { enabled: true } });
    expect(mergePipelineFeatures(defaultPipelineFeatures, parsed).summaryTree).toEqual({ enabled: false });
  });

  it("is classified new-uploads with no seed stage, so a save never queues a build", () => {
    expect(PIPELINE_FIELD_IMPACT.summaryTree).toBe("new-uploads");
    const before = normalizePipelineFeatures({ summarize: true });
    const after = treeOn({ summarize: true });
    expect(affectedStages(before, after)).toEqual([]);
    expect(affectedStages(after, before)).toEqual([]);
    const impact = analyzePipelineChange(before, after, { documents: 12, pages: 400 });
    expect(impact).toMatchObject({ kind: "new-uploads", stages: [] });
    expect(impact.reasons.map((reason) => reason.field)).toEqual(["summaryTree"]);
  });
});

describe("summary tree kill switches", () => {
  it("are off unless set to an on value", () => {
    for (const value of ["on", "ON", " true ", "1", "yes"]) {
      expect(summaryTreeBuildAvailable({ [SUMMARY_TREE_BUILD_ENV_FLAG]: value }), value).toBe(true);
      expect(summaryTreeServeAvailable({ [SUMMARY_TREE_SERVE_ENV_FLAG]: value }), value).toBe(true);
    }
    for (const value of [undefined, "", "off", "0", "false", "no", "free", "enabled", "maybe"]) {
      expect(summaryTreeBuildAvailable({ [SUMMARY_TREE_BUILD_ENV_FLAG]: value }), String(value)).toBe(false);
      expect(summaryTreeServeAvailable({ [SUMMARY_TREE_SERVE_ENV_FLAG]: value }), String(value)).toBe(false);
    }
    // Independent of each other.
    expect(summaryTreeServeAvailable({ [SUMMARY_TREE_BUILD_ENV_FLAG]: "on" })).toBe(false);
    expect(summaryTreeBuildAvailable({ [SUMMARY_TREE_SERVE_ENV_FLAG]: "on" })).toBe(false);
  });

  it("warn about unknown values only", () => {
    expect(summaryTreeSwitchWarnings({})).toEqual([]);
    expect(summaryTreeSwitchWarnings({ ...ON, [SUMMARY_TREE_SERVE_ENV_FLAG]: "off" })).toEqual([]);
    const warnings = summaryTreeSwitchWarnings({ [SUMMARY_TREE_BUILD_ENV_FLAG]: "maybe", [SUMMARY_TREE_SERVE_ENV_FLAG]: "sometimes" });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(SUMMARY_TREE_BUILD_ENV_FLAG);
    expect(warnings.join(" ")).not.toContain("maybe");
  });

  it("a stored on stays inert while the build switch is off", () => {
    expect(summaryTreeBuildActive(treeOn(), ON)).toBe(true);
    expect(summaryTreeBuildActive(treeOn(), {})).toBe(false);
    expect(summaryTreeBuildActive(treeOn(), { [SUMMARY_TREE_SERVE_ENV_FLAG]: "on" })).toBe(false);
    expect(summaryTreeBuildActive(defaultPipelineFeatures, ON)).toBe(false);
    expect(summaryTreeBuildActive(null, ON)).toBe(false);
    expect(summaryTreeBuildActive({ summaryTree: { enabled: true }, embed: true, indexVectors: false }, ON)).toBe(false);
    expect(summaryTreeBuildActive({ summaryTree: { enabled: true } }, ON)).toBe(false);
  });

  it("the effective search mode is off unless the pipeline has the tree and the deployment serves it", () => {
    const on = treeOn();
    expect(effectiveSummaryTreeSearchMode({ pipeline: on, requested: "guide", env: ON })).toBe("guide");
    expect(effectiveSummaryTreeSearchMode({ pipeline: on, projectDefault: "include", env: ON })).toBe("include");
    expect(effectiveSummaryTreeSearchMode({ pipeline: on, requested: "off", projectDefault: "include", env: ON })).toBe("off");
    // Never derived "on" from the pipeline.
    expect(effectiveSummaryTreeSearchMode({ pipeline: on, env: ON })).toBe("off");
    expect(effectiveSummaryTreeSearchMode({ pipeline: defaultPipelineFeatures, requested: "guide", projectDefault: "include", env: ON })).toBe("off");
    expect(effectiveSummaryTreeSearchMode({ pipeline: null, requested: "guide", env: ON })).toBe("off");
    expect(effectiveSummaryTreeSearchMode({ pipeline: on, requested: "guide", env: {} })).toBe("off");
    expect(effectiveSummaryTreeSearchMode({ pipeline: on, requested: "guide", env: { [SUMMARY_TREE_BUILD_ENV_FLAG]: "on" } })).toBe("off");
    // The serve switch alone serves trees built earlier, with the build switch off.
    expect(effectiveSummaryTreeSearchMode({ pipeline: on, requested: "guide", env: { [SUMMARY_TREE_SERVE_ENV_FLAG]: "on" } })).toBe("guide");
    expect(effectiveSummaryTreeSearchMode({ pipeline: on, requested: "everything" as never, env: ON })).toBe("off");
    expect(summaryTreeSearchRefusal({ pipeline: defaultPipelineFeatures, env: ON })).toBe("disabled");
    expect(summaryTreeSearchRefusal({ pipeline: on, env: {} })).toBe("serve-off");
    expect(summaryTreeSearchRefusal({ pipeline: on, env: ON })).toBeNull();
  });
});

describe("summary tree constants and state", () => {
  it("exposes coherent read-only constants", () => {
    expect(summaryTreeConstantsSchema.parse(SUMMARY_TREE_CONSTANTS)).toEqual(SUMMARY_TREE_CONSTANTS);
    expect(Object.isFrozen(SUMMARY_TREE_CONSTANTS)).toBe(true);
    expect(SUMMARY_TREE_MIN_GROUP_SIZE).toBeLessThan(SUMMARY_TREE_MAX_GROUP_SIZE);
    // Both sides of a cut must be able to keep the minimum.
    expect(SUMMARY_TREE_MAX_GROUP_SIZE).toBeGreaterThanOrEqual(SUMMARY_TREE_MIN_GROUP_SIZE * 2);
    expect(SUMMARY_TREE_CONSTANTS.minDocumentLeaves).toBeGreaterThan(SUMMARY_TREE_MAX_GROUP_SIZE);
    expect(summaryTreeDeadlineMs(100)).toBe(Math.max(100 * SUMMARY_TREE_CONSTANTS.deadlineFactor, 100 + SUMMARY_TREE_CONSTANTS.deadlineGraceMs));
    expect(summaryTreeDeadlineMs(Number.NaN)).toBe(SUMMARY_TREE_CONSTANTS.deadlineGraceMs);
    expect(projectStateSchema.shape.summaryTree).toBeDefined();
  });

  it("derives the project build status", () => {
    const counts = { total: 4, ready: 4, building: 0, partial: 0, skipped: 0, missing: 0 };
    expect(summaryTreeBuildStatus(false, counts)).toBe("off");
    expect(summaryTreeBuildStatus(true, counts)).toBe("ready");
    expect(summaryTreeBuildStatus(true, { ...counts, ready: 2, skipped: 2 })).toBe("ready");
    expect(summaryTreeBuildStatus(true, { ...counts, ready: 3, missing: 1 })).toBe("partial");
    expect(summaryTreeBuildStatus(true, { ...counts, ready: 3, partial: 1 })).toBe("partial");
    expect(summaryTreeBuildStatus(true, { ...counts, ready: 2, partial: 1, building: 1 })).toBe("building");
  });

  it("validates the summaries row shape", () => {
    const row = { id: "doc-1:n0", documentId: "doc-1", runId: "run-1", level: 1, chunkStart: 0, chunkEnd: 3, pageStart: 1, pageEnd: 2, headingPath: "A > B", text: "Title\nSummary.", vector: [0.1, 0.2] };
    expect(summaryRowSchema.parse(row)).toEqual(row);
    for (const bad of [
      { id: "x' OR '1'='1" }, { documentId: "a/b" }, { documentId: "" }, { level: 0 }, { chunkEnd: -1 }, { chunkStart: 5, chunkEnd: 4 },
      { pageStart: 3, pageEnd: 2 }, { text: "" }, { vector: [] }, { vector: [Number.NaN] }, { extra: true },
    ]) {
      expect(summaryRowSchema.safeParse({ ...row, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("vector table names", () => {
  it("places the summaries table beside the chunks table in the project's database", () => {
    const chunks = VectorNamespaceManager.getEmbeddingLocation("s3://bucket/lancedb/", "org1", "proj1", "provider/model.v1", 1024);
    const summaries = VectorNamespaceManager.getEmbeddingLocation("s3://bucket/lancedb/", "org1", "proj1", "provider/model.v1", 1024, LANCEDB_SUMMARIES_TABLE);
    expect(chunks.table).toBe(LANCEDB_CHUNKS_TABLE);
    expect(summaries).toEqual({ uri: chunks.uri, table: "summaries" });
    expect(summaries.uri).toBe("s3://bucket/lancedb/org1/proj1/vectors-provider%2Fmodel%2Ev1-1024");
    expect(VectorNamespaceManager.summariesLocation(chunks)).toEqual(summaries);
    expect(() => VectorNamespaceManager.getEmbeddingLocation("/r", "org1", "proj1", "m", 4, "notes" as never)).toThrow(/known table/);
    expect(() => VectorNamespaceManager.getEmbeddingLocation("/r", "org1", "proj1", "m", 4, "../chunks" as never)).toThrow(/known table/);
  });
});

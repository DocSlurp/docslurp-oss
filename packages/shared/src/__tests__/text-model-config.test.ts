import { describe, expect, it } from "vitest";
import { DEFAULT_PIPELINE_TEXT_MODEL, normalizePipelineFeatures, pipelineTextOperationSchema, resolvePipelineTextModel, resolvePipelineTextGenerationOptions } from "../pipeline.js";

describe("pipeline text model configuration", () => {
  it("inherits the deployment profile and applies explicit workspace task controls", () => {
    const inherited = resolvePipelineTextGenerationOptions({ operation: "community-summary", deploymentProfile: "grounded-low", maxOutputTokens: 220 });
    expect(inherited).toMatchObject({ profile: "grounded-low", reasoningEffort: "low", maxOutputTokens: 256 });
    const config = normalizePipelineFeatures({ textGeneration: { profile: "grounded-low", reasoningEffort: "high", reasoningEfforts: { "community-summary": "low" }, maxOutputTokens: { "community-summary": 600 } } }).textGeneration;
    expect(resolvePipelineTextGenerationOptions({ operation: "community-summary", config, maxOutputTokens: 220 })).toMatchObject({ reasoningEffort: "low", maxOutputTokens: 600 });
    expect(resolvePipelineTextGenerationOptions({ operation: "document-summary", config, maxOutputTokens: 512 })).toMatchObject({ reasoningEffort: "high", maxOutputTokens: 512 });
  });

  it("preserves provider defaults and rejects invalid calibration controls", () => {
    expect(resolvePipelineTextGenerationOptions({ operation: "contextual-chunk-preamble", maxOutputTokens: 96 })).toMatchObject({ profile: "provider-default", reasoningEffort: undefined, maxOutputTokens: 96, systemSuffix: undefined });
    expect(() => normalizePipelineFeatures({ textGeneration: { maxOutputTokens: { "document-summary": 0 } } })).toThrow();
    expect(() => normalizePipelineFeatures({ textGeneration: { profile: "unknown" } } as never)).toThrow();
  });

  it("lets explicit thinking disable override grounded and per-task effort defaults", () => {
    const config = normalizePipelineFeatures({ textGeneration: { profile: "grounded-low", reasoningEffort: "none", reasoningEfforts: { "graph-extraction": "low" } } }).textGeneration;
    expect(resolvePipelineTextGenerationOptions({ operation: "document-summary", config, maxOutputTokens: 512 }).reasoningEffort).toBe("none");
    expect(resolvePipelineTextGenerationOptions({ operation: "graph-extraction", config, maxOutputTokens: 2048 }).reasoningEffort).toBe("low");
  });

  it("applies task, workspace, deployment, and built-in precedence for every operation", () => {
    for (const operation of pipelineTextOperationSchema.options) {
      const pipeline = normalizePipelineFeatures({ textGeneration: { model: "vendor/workspace", models: { [operation]: "vendor/task" } } });
      expect(resolvePipelineTextModel(pipeline, operation, "vendor/deployment")).toBe("vendor/task");
      expect(resolvePipelineTextModel(normalizePipelineFeatures({ textGeneration: { model: "vendor/workspace" } }), operation, "vendor/deployment")).toBe("vendor/workspace");
      expect(resolvePipelineTextModel(normalizePipelineFeatures(), operation, "vendor/deployment")).toBe("vendor/deployment");
      expect(resolvePipelineTextModel(normalizePipelineFeatures(), operation)).toBe(DEFAULT_PIPELINE_TEXT_MODEL);
    }
  });

  it("defaults stored configurations to inheritance and accepts partial settings", () => {
    expect(normalizePipelineFeatures({ textGeneration: null }).textGeneration).toEqual({ model: null, models: {} });
    const pipeline = normalizePipelineFeatures({ textGeneration: { models: { "document-summary": " vendor/custom " } } });
    expect(pipeline.textGeneration.model).toBeNull();
    expect(resolvePipelineTextModel(pipeline, "document-summary")).toBe("vendor/custom");
    expect(pipeline.structuredExtraction.model).toBeNull();
  });

  it("rejects blank IDs and unknown task names", () => {
    expect(() => normalizePipelineFeatures({ textGeneration: { model: " " } })).toThrow();
    expect(() => normalizePipelineFeatures({ textGeneration: { models: { unknown: "vendor/model" } } } as unknown as Parameters<typeof normalizePipelineFeatures>[0])).toThrow();
  });
});

import { describe, expect, it } from "vitest";

import { forecastRunCost } from "../pipeline/cost-forecast.js";
import type { Document } from "../models.js";
import type { PipelineFeatures } from "@docslurp/shared";
import { applyDefaultVisionOverride, defaultPipelineFeatures } from "@docslurp/shared";
import type { WorkerDeploymentProfile } from "../pipeline/local-compute-cost.js";

const profile: WorkerDeploymentProfile = {
  id: "lean:test:local",
  lane: "lean",
  workerClass: "test",
  region: "local",
  image: "test-image",
  allocatedVcpu: 1,
  allocatedMemoryGb: 1,
  rates: {
    cpuCentsPerSecond: 0.1,
    memoryCentsPerGbSecond: 0.01,
    gpuCentsPerSecond: 0,
    storageCentsPerGbMonth: 2,
    networkIngressCentsPerGb: 0,
    networkEgressCentsPerGb: 0,
  },
};

function forecast(documents: Document[], pipeline: PipelineFeatures) {
  return forecastRunCost(documents, pipeline, profile);
}

function makeDoc(pageCount: number, id = "doc-1"): Document {
  return {
    id,
    userId: "user-1",
    runId: "run-1",
    filename: "test.pdf",
    mimeType: "application/pdf",
    sourceKey: "test/test.pdf",
    status: "processing",
    extractionMode: "auto",
    pageCount,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("forecastRunCost", () => {
  it("returns zero costs for an empty document list", () => {
    const result = forecast([], defaultPipelineFeatures);
    expect(result.minCents).toBe(0);
    expect(result.maxCents).toBe(0);
    expect(result.breakdown.embedding).toBe(0);
    expect(result.breakdown.vision).toBe(0);
    expect(result.breakdown.overhead).toBe(0);
    expect(result.breakdown.localCompute).toBe(0);
  });

  it("minCents excludes vision, maxCents includes vision", () => {
    const pipeline: PipelineFeatures = {
      ...defaultPipelineFeatures,
      embed: true,
      visionFallback: true,
    };
    const result = forecast([makeDoc(10)], pipeline);
    expect(result.minCents).toBeLessThan(result.maxCents);
    expect(result.breakdown.vision).toBeGreaterThan(0);
  });

  it("vision breakdown is 0 when visionFallback is false", () => {
    const pipeline: PipelineFeatures = {
      ...defaultPipelineFeatures,
      visionFallback: false,
    };
    const result = forecast([makeDoc(10)], pipeline);
    expect(result.breakdown.vision).toBe(0);
    expect(result.maxCents).toBeGreaterThan(result.minCents);
  });

  it("embedding breakdown is 0 when embed is false", () => {
    const pipeline: PipelineFeatures = {
      ...defaultPipelineFeatures,
      embed: false,
      visionFallback: false,
    };
    const result = forecast([makeDoc(10)], pipeline);
    expect(result.breakdown.embedding).toBe(0);
  });

  it("treats 0-page documents as at least 1 page", () => {
    const pipeline: PipelineFeatures = { ...defaultPipelineFeatures };
    const withZero = forecast([makeDoc(0)], pipeline);
    const withOne = forecast([makeDoc(1, "doc-2")], pipeline);
    expect(withZero.maxCents).toBe(withOne.maxCents);
  });

  it("embedding cost scales linearly with page count", () => {
    const pipeline: PipelineFeatures = {
      ...defaultPipelineFeatures,
      embed: true,
      visionFallback: false,
    };
    const r5 = forecast([makeDoc(5)], pipeline);
    const r10 = forecast([makeDoc(10, "doc-b")], pipeline);
    // embedding cost for 10 pages should be roughly double 5 pages
    expect(r10.breakdown.embedding).toBeCloseTo(r5.breakdown.embedding * 2, 3);
  });

  it("overhead scales with document count, not page count", () => {
    const pipeline: PipelineFeatures = {
      ...defaultPipelineFeatures,
      embed: false,
      visionFallback: false,
    };
    const r1 = forecast([makeDoc(1)], pipeline);
    const r2 = forecast([makeDoc(1, "doc-a"), makeDoc(1, "doc-b")], pipeline);
    expect(r2.breakdown.overhead).toBeCloseTo(r1.breakdown.overhead * 2, 3);
  });

  it("minCents and maxCents are non-negative", () => {
    const result = forecast([makeDoc(5)], defaultPipelineFeatures);
    expect(result.minCents).toBeGreaterThanOrEqual(0);
    expect(result.maxCents).toBeGreaterThanOrEqual(0);
  });

  it("breakdown values sum to approximately maxCents", () => {
    const pipeline: PipelineFeatures = {
      ...defaultPipelineFeatures,
      embed: true,
      visionFallback: true,
    };
    const result = forecast([makeDoc(10)], pipeline);
    const breakdownSum =
      result.breakdown.embedding
      + result.breakdown.vision
      + result.breakdown.overhead
      + result.breakdown.localCompute;
    // Allow small floating-point rounding difference from Math.ceil
    expect(Math.abs(breakdownSum - result.maxCents)).toBeLessThan(0.05);
  });

  it("includes non-zero local parser compute and deployment metadata", () => {
    const result = forecast([makeDoc(2)], {
      ...defaultPipelineFeatures,
      embed: false,
      visionFallback: false,
    });

    expect(result.breakdown.localCompute).toBeGreaterThan(0);
    expect(result.minCents).toBeGreaterThan(result.breakdown.overhead);
    expect(result.deploymentProfile).toBe(profile.id);
  });

  it("forecasts the DOCSLURP_VISION_MODEL_URI model, matching the server preview", () => {
    const docs = [makeDoc(10)];
    const base = forecast(docs, defaultPipelineFeatures);
    const overridden = applyDefaultVisionOverride(defaultPipelineFeatures, { DOCSLURP_VISION_MODEL_URI: "llm://openrouter/z-ai/glm-5.3-flash" });
    expect(overridden.vision.modelUri).toBe("llm://openrouter/z-ai/glm-5.3-flash");
    expect(forecast(docs, overridden).maxCents).toBeLessThan(base.maxCents);
  });
});

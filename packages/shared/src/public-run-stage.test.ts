import { describe, expect, it } from "vitest";
import {
  defaultPipelineFeatures,
  FIRST_PASS_PUBLIC_STAGE,
  getPipelineStageLabel,
  pipelineFeaturesSchema,
  pipelineRunStageSchema,
  pipelineStageOrder,
  publicRunStage,
  runStageSchema,
} from "./pipeline.js";

describe("publicRunStage", () => {
  it("returns public stages unchanged", () => {
    for (const stage of runStageSchema.options) expect(publicRunStage(stage)).toBe(stage);
  });

  it("reports every internal first-pass checkpoint as the public first-pass stage", () => {
    for (const raw of ["first-pass", "first-pass:page-count", "first-pass:figures", "first-pass:anything-later"]) {
      expect(publicRunStage(raw)).toBe(FIRST_PASS_PUBLIC_STAGE);
    }
    expect(getPipelineStageLabel("first-pass")).toBe("First pass");
  });

  it("returns null for stages the contract cannot name", () => {
    for (const raw of ["future-internal-stage", "first-passage", "", null, undefined, 42]) expect(publicRunStage(raw)).toBeNull();
  });

  it("keeps first-pass a reporting stage: never runnable, restartable or planned", () => {
    expect(pipelineRunStageSchema.safeParse("first-pass").success).toBe(false);
    expect(pipelineStageOrder).not.toContain("first-pass");
    expect(pipelineFeaturesSchema.safeParse({ ...defaultPipelineFeatures, restartFromStage: "first-pass" }).success).toBe(false);
    expect(pipelineFeaturesSchema.safeParse({ ...defaultPipelineFeatures, restartFromStage: "extract-markdown" }).success).toBe(true);
  });
});

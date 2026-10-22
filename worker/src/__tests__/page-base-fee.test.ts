import { describe, expect, it } from "vitest";
import { compilePipelinePlan, type PipelineRunStage } from "@docslurp/shared";
import { pageBaseFeeMultiplier } from "../db/page-base-fee.js";

const plan = (stageOrder: PipelineRunStage[], reusedStages: PipelineRunStage[] = []) => ({ stageOrder, reusedStages });

describe("pageBaseFeeMultiplier", () => {
  it("charges full runs the whole fee", () => {
    expect(pageBaseFeeMultiplier(compilePipelinePlan({}))).toBe(1);
  });

  it("charges reindex-only partial runs nothing", () => {
    expect(pageBaseFeeMultiplier(plan(["pii-detect", "embed", "index"], ["quarantine", "extract-markdown"]))).toBe(0);
  });

  it("charges other partial runs the share of enabled stages they execute", () => {
    expect(pageBaseFeeMultiplier(plan(
      ["extract-markdown", "embed", "index"],
      ["quarantine", "format-detect", "split-pages"],
    ))).toBe(0.5);
  });

  it("follows the compiled plan for a reindex request", () => {
    const reindex = compilePipelinePlan({ stageSubset: ["embed", "index"] } as never);
    expect(reindex.reusedStages.length).toBeGreaterThan(0);
    expect(pageBaseFeeMultiplier(reindex)).toBe(0);
  });
});

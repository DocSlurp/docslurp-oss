import { describe, expect, it } from "vitest";
import { compilePipelinePlan, type PipelineRunStage } from "@docslurp/shared";
import { pageBaseFeeMultiplier, pageBaseFeeRateCents } from "../db/page-base-fee.js";

const plan = (stageOrder: PipelineRunStage[], reusedStages: PipelineRunStage[] = []) => ({ stageOrder, reusedStages });

describe("pageBaseFeeRateCents", () => {
  it("converts dollars per page to cents per page", () => {
    expect(pageBaseFeeRateCents("0.0003")).toBeCloseTo(0.03);
    expect(pageBaseFeeRateCents("0")).toBe(0);
  });

  it("rejects negative or non-numeric rates", () => {
    expect(() => pageBaseFeeRateCents("-1")).toThrow();
    expect(() => pageBaseFeeRateCents("abc")).toThrow();
  });
});

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

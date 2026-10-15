import { describe, expect, it } from "vitest";

import {
  executionStageOrder,
  getPipelineStageOrder,
  inferExecutionStageOrder,
  normalizePipelineFeatures,
  pipelineStageOrder,
  postIndexStages,
  stageDataFlow,
  stageOutputs,
  type PipelineRunStage,
} from "./pipeline.js";

const everything = normalizePipelineFeatures({
  summarize: true,
  outputSchema: { type: "object", properties: { title: { type: "string" } } } as never,
  graphRag: true,
  pageIndex: true,
  propositionIndex: true,
  piiPolicy: { enabled: true, patterns: ["ssn"], action: "redact_artifacts" } as never,
});

describe("executionStageOrder", () => {
  it("keeps the canonical order when the flag is off", () => {
    const order = getPipelineStageOrder(everything);
    expect(executionStageOrder(order)).toEqual(order);
    expect(executionStageOrder(order, { indexBeforeEnrich: false })).toEqual(order);
  });

  it("runs index right after embed and the enrichment stages after it", () => {
    const order = executionStageOrder(getPipelineStageOrder(everything), { indexBeforeEnrich: true });
    expect(order.slice(order.indexOf("pii-detect"))).toEqual([
      "pii-detect",
      "embed",
      "index",
      "document-summary",
      "structured-extract",
      "graph-enrich",
      "page-index",
      "proposition-index",
    ]);
    expect([...order].sort()).toEqual([...getPipelineStageOrder(everything)].sort());
  });

  it("leaves the default pipeline (no enrichment stages) unchanged", () => {
    const order = getPipelineStageOrder(normalizePipelineFeatures({}));
    expect(executionStageOrder(order, { indexBeforeEnrich: true })).toEqual(order);
  });

  it("moves nothing when the run has no index stage", () => {
    const order: PipelineRunStage[] = ["extract-markdown", "document-summary", "embed"];
    expect(executionStageOrder(order, { indexBeforeEnrich: true })).toEqual(order);
  });

  it("never runs a stage before a stage that produces one of its inputs", () => {
    const order = executionStageOrder([...pipelineStageOrder], { indexBeforeEnrich: true });
    for (const [position, stage] of order.entries()) {
      const consumes = new Set([
        ...(stageDataFlow[stage].consumes ?? []),
        ...(stageDataFlow[stage].requires ?? []).flat(),
        ...(stageDataFlow[stage].sameRun ?? []),
      ]);
      // Stages that now run later but were canonically earlier must not feed this one.
      for (const later of order.slice(position + 1)) {
        if (pipelineStageOrder.indexOf(later) > pipelineStageOrder.indexOf(stage)) continue;
        const fed = stageOutputs(later, everything).filter((output) => consumes.has(output));
        expect(fed, `${stage} reads ${fed.join(",")} from ${later}, which now runs after it`).toEqual([]);
      }
    }
    expect(postIndexStages.every((stage) => order.indexOf(stage) > order.indexOf("index"))).toBe(true);
  });
});

describe("inferExecutionStageOrder", () => {
  const canonical = getPipelineStageOrder(everything);
  const moved = executionStageOrder(canonical, { indexBeforeEnrich: true });
  const has = (...stages: string[]) => (stage: string) => stages.includes(stage);

  it("keeps the canonical order before embed is reached", () => {
    expect(inferExecutionStageOrder(canonical, { hasState: has("quarantine", "pii-detect"), currentStage: "pii-detect" })).toEqual(canonical);
  });

  it("detects a run that moved enrichment after index once embed or index starts", () => {
    expect(inferExecutionStageOrder(canonical, { hasState: has("pii-detect"), currentStage: "embed" })).toEqual(moved);
    expect(inferExecutionStageOrder(canonical, { hasState: has("pii-detect", "embed", "index"), currentStage: "graph-enrich" })).toEqual(moved);
  });

  it("keeps the canonical order when the enrichment stages ran before embed", () => {
    const ran = has("document-summary", "structured-extract", "embed");
    expect(inferExecutionStageOrder(canonical, { hasState: ran, currentStage: "embed" })).toEqual(canonical);
    // graph-enrich and later follow embed canonically, so missing rows there prove nothing.
    expect(inferExecutionStageOrder(canonical, { hasState: ran, currentStage: "graph-enrich" })).toEqual(canonical);
  });
});

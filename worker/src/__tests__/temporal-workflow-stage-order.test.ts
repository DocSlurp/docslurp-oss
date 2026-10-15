import { describe, expect, it } from "vitest";

import { executionStageOrder, pipelineStageOrder } from "@docslurp/shared";

import { resolvePipelineWorkflowStageOrder } from "../temporal/pipeline-workflow-plan.js";
import { WORKFLOW_STAGE_ORDER } from "../temporal/workflow-stage-order.js";

describe("Temporal workflow stage order", () => {
  it("matches the shared pipeline stage order without importing the shared barrel in workflows", () => {
    expect(WORKFLOW_STAGE_ORDER).toEqual(pipelineStageOrder);
  });

  it("uses the compiled workflow input stage order when one is provided", () => {
    expect(
      resolvePipelineWorkflowStageOrder({
        stageOrder: ["quarantine", "extract-markdown", "embed"],
      }),
    ).toEqual(["quarantine", "extract-markdown", "embed"]);
  });

  it("runs an index-before-enrichment order recorded in workflow input as is", () => {
    const order = executionStageOrder(pipelineStageOrder, { indexBeforeEnrich: true });
    expect(resolvePipelineWorkflowStageOrder({ stageOrder: order })).toEqual(order);
    expect(order.indexOf("index")).toBe(order.indexOf("embed") + 1);
  });

  it("falls back to the full workflow-safe order for legacy workflow inputs", () => {
    expect(resolvePipelineWorkflowStageOrder({})).toEqual(WORKFLOW_STAGE_ORDER);
    expect(resolvePipelineWorkflowStageOrder({ stageOrder: ["not-a-stage"] })).toEqual(
      WORKFLOW_STAGE_ORDER,
    );
  });
});

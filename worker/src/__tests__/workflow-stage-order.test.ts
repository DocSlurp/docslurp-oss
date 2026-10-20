import { pipelineStageOrder } from "@docslurp/shared";
import { describe, expect, it } from "vitest";
import { WORKFLOW_STAGE_ORDER } from "../temporal/workflow-stage-order.js";

describe("WORKFLOW_STAGE_ORDER", () => {
  it("lists the same stages in the same order as pipelineStageOrder", () => {
    expect([...WORKFLOW_STAGE_ORDER]).toEqual(pipelineStageOrder);
  });
});

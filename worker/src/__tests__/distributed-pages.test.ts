import { describe, expect, it, vi } from "vitest";
import { VisionExtractStage } from "../stages/vision-extract.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";

describe("distributed vision checkpoints", () => {
  it("assembles cached pages in source order without another provider call or charge", async () => {
    const renderSelectedPages = vi.fn(() => { throw new Error("should not render or call provider"); });
    const stage = new VisionExtractStage({} as never, {} as never, {} as never, {renderSelectedPages} as never);
    const state = { distributedVisionPages: new Map([
      ["doc:2", {pageNumber:2, text:"second"}], ["doc:1", {pageNumber:1,text:"first"}], ["doc:3", null],
    ]), usageLedger: new PipelineUsageEventLedger() } as unknown as WorkflowState;
    const extract = (stage as any).extractVisionPagesFromCache.bind(stage);
    expect(await extract(state, {id:"doc"}, {maxPagesPerDocument:20}, [2,3,1])).toEqual([
      {pageNumber:1,text:"first"}, {pageNumber:2,text:"second"},
    ]);
    expect(renderSelectedPages).not.toHaveBeenCalled();
    expect(state.usageLedger.snapshot()).toEqual([]);
  });
  it("retains budget admission for capped runs", async () => {
    const stage = new VisionExtractStage({} as never, {} as never, {} as never, {} as never);
    expect(await stage.planPageTasks({run:{pipeline:{visionFallback:true,maxCostCents:100}}} as WorkflowState)).toEqual([]);
  });
});

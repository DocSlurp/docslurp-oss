import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ budget: false, cleanupInit: false, spendPause: false, activities: {} as Record<string, any> }));
vi.mock("@temporalio/workflow", async () => ({
  ActivityFailure: (await import("@temporalio/common")).ActivityFailure,
  sleep: async () => {},
  patched: (id: string) => (id === "pipeline-init-lifecycle-v1" && mocks.cleanupInit) || (id === "admission-history-budget-v1" && mocks.budget)
    || (id === "page-task-spend-pause-v1" && mocks.spendPause),
  proxyActivities: () => new Proxy({}, { get: (_, key: string) => (...args: unknown[]) => mocks.activities[key](...args) }),
  defineQuery: (name:string) => name, defineSignal: (name:string) => name,
  CancellationScope: { nonCancellable: async (fn: () => Promise<unknown>) => fn() },
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT_CANCELLATION_COMPLETED" },
  setHandler: vi.fn(), condition: async () => {},
  ApplicationFailure: (await import("@temporalio/common")).ApplicationFailure, rootCause:(e:unknown)=>e,
}));
import { documentPipeline } from "../temporal/workflows.js";
const zero = {inputTokens:0,outputTokens:0,costCents:0};
describe("page workflow scheduling", () => {
  beforeEach(() => {
    mocks.cleanupInit = false;
    Object.assign(mocks.activities, {
      initPipelineRun: vi.fn(async()=>({artifacts:{},documentIds:["doc"]})),
      runPipelineStage: vi.fn(async()=>({artifacts:{},usage:zero})),
      completePipelineRun: vi.fn(async()=>({})), failPipelineRun: vi.fn(async()=>{}),
      prepareVisionPageTasks: vi.fn(async()=>Array.from({length:25},(_,i)=>({pageNumber:i+1}))),
      runVisionPageTask: vi.fn(async()=>zero),
      runVisionPageBundle: vi.fn(async()=>zero),
    });
  });
  it("bounds page activity concurrency and waits before reconciliation", async () => {
    let active=0, peak=0, completed=0;
    mocks.activities.runVisionPageTask.mockImplementation(async()=>{
      active++; peak=Math.max(peak,active); await new Promise(resolve=>setTimeout(resolve,2)); active--; completed++;return zero;
    });
    mocks.activities.runPipelineStage.mockImplementation(async()=>{expect(completed).toBe(25);return {artifacts:{},usage:zero};});
    await documentPipeline({runId:"run",pipeline:{} as never,stageOrder:["vision-extract"],pageConcurrency:10});
    expect(peak).toBe(10);expect(completed).toBe(25);
  });
  it("bundles within documents and bounds concurrent provider calls", async () => {
    mocks.activities.prepareVisionPageTasks.mockResolvedValue([
      ...Array.from({length: 5}, (_, i) => ({documentId: "a", pageNumber: i + 1})),
      ...Array.from({length: 3}, (_, i) => ({documentId: "b", pageNumber: i + 1})),
    ]);
    let active = 0, peak = 0;
    mocks.activities.runVisionPageBundle.mockImplementation(async (tasks: {documentId: string}[]) => {
      expect(new Set(tasks.map(t => t.documentId)).size).toBe(1);
      expect(tasks.length).toBeLessThanOrEqual(2);
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return zero;
    });
    await documentPipeline({runId:"run", pipeline:{} as never, stageOrder:["vision-extract"], pageConcurrency:4, pageBundleSize:2});
    expect(peak).toBe(2);
    expect(mocks.activities.runVisionPageBundle).toHaveBeenCalledTimes(5);
    expect(mocks.activities.runVisionPageTask).not.toHaveBeenCalled();
  });
  it("passes the owned run generation to vision reconciliation", async () => {
    await documentPipeline({ runId: "run", pipeline: {} as never, stageOrder: ["vision-extract"],
      pageConcurrency: 4, executionGeneration: "generation-1" });
    const owner = expect.objectContaining({ runId: "run", executionGeneration: "generation-1" });
    expect(mocks.activities.prepareVisionPageTasks).toHaveBeenCalledWith(owner);
    expect(mocks.activities.runPipelineStage).toHaveBeenCalledWith(owner);
  });

  it("does not change activity commands for old workflow input", async()=>{
    await documentPipeline({runId:"old",pipeline:{} as never,stageOrder:["vision-extract"]});
    expect(mocks.activities.prepareVisionPageTasks).not.toHaveBeenCalled();
    expect(mocks.activities.runVisionPageTask).not.toHaveBeenCalled();
  });
  it("drains already-started page tasks before writing run failure", async()=>{
    let active=0;
    mocks.activities.runVisionPageTask.mockImplementation(async(task:{pageNumber:number})=>{
      active++; await new Promise(resolve=>setTimeout(resolve,task.pageNumber===1?1:10));active--;
      if(task.pageNumber===1) throw new Error("provider unavailable");return zero;
    });
    mocks.activities.failPipelineRun.mockImplementation(async()=>{expect(active).toBe(0);});
    await documentPipeline({runId:"run",pipeline:{} as never,stageOrder:["vision-extract"],pageConcurrency:10}).catch(()=>{});
    expect(mocks.activities.failPipelineRun).toHaveBeenCalled();expect(mocks.activities.runPipelineStage).not.toHaveBeenCalled();
  });
});

describe("page tasks refused for funds (council #469)", () => {
  const spendPaused = async () => {
    const { ActivityFailure, ApplicationFailure } = await import("@temporalio/common");
    const { PAGE_TASK_SPEND_PAUSED } = await import("../temporal/shared.js");
    return new ActivityFailure("activity failed", "runVisionPageTask", "1", 1 as never, undefined,
      ApplicationFailure.create({ type: PAGE_TASK_SPEND_PAUSED, message: "Credits do not cover the OCR read; run paused", nonRetryable: true }));
  };
  beforeEach(() => {
    Object.assign(mocks.activities, {
      initPipelineRun: vi.fn(async()=>({artifacts:{},documentIds:["doc"]})),
      runPipelineStage: vi.fn(async()=>({artifacts:{},usage:zero})),
      completePipelineRun: vi.fn(async()=>({})), failPipelineRun: vi.fn(async()=>{}),
      prepareVisionPageTasks: vi.fn(async()=>Array.from({length:5},(_,i)=>({documentId:"doc",pageNumber:i+1}))),
      runVisionPageTask: vi.fn(async()=>zero),
      runVisionPageBundle: vi.fn(async()=>zero),
    });
  });

  it("requeues the bundle and redispatches it instead of failing the run", async () => {
    mocks.spendPause = true;
    try {
      const failure = await spendPaused();
      let refused = 0;
      mocks.activities.runVisionPageTask.mockImplementation(async (task: { pageNumber: number }) => {
        if (task.pageNumber === 2 && refused < 2) { refused++; throw failure; }
        return zero;
      });
      await documentPipeline({ runId: "run", pipeline: {} as never, stageOrder: ["vision-extract"], pageConcurrency: 2 });
      expect(refused).toBe(2);
      const pages = mocks.activities.runVisionPageTask.mock.calls.map((call: [{ pageNumber: number }]) => call[0].pageNumber);
      expect(pages.filter((page: number) => page === 2)).toHaveLength(3);
      expect(mocks.activities.failPipelineRun).not.toHaveBeenCalled();
      expect(mocks.activities.completePipelineRun).toHaveBeenCalled();
    } finally {
      mocks.spendPause = false;
    }
  });

  it("keeps the old outcome for runs from before the rule (patch absent): the refusal fails the fan-out", async () => {
    const failure = await spendPaused();
    mocks.activities.runVisionPageTask.mockImplementation(async (task: { pageNumber: number }) => {
      if (task.pageNumber === 2) throw failure;
      return zero;
    });
    await documentPipeline({ runId: "run", pipeline: {} as never, stageOrder: ["vision-extract"], pageConcurrency: 2 }).catch(() => {});
    expect(mocks.activities.failPipelineRun).toHaveBeenCalled();
  });
});

describe("initialization lifecycle", () => {
  it.each([false, true])("preserves old init failure history (patch=%s)", async (enabled) => {
    mocks.cleanupInit = enabled;
    const failure = new Error("init failed");
    mocks.activities.initPipelineRun = vi.fn().mockRejectedValue(failure);
    mocks.activities.failPipelineRun = vi.fn().mockRejectedValue(new Error("cleanup failed"));
    await expect(documentPipeline({runId:"run",pipeline:{} as never,stageOrder:[]})).rejects.toBe(failure);
    expect(mocks.activities.failPipelineRun).toHaveBeenCalledTimes(enabled ? 1 : 0);
  });
  it("cleans up cancelled initialization without replacing cancellation", async () => {
    mocks.cleanupInit = true;
    const cancellation = new Error("cancelled");
    mocks.activities.initPipelineRun = vi.fn().mockRejectedValue(cancellation);
    mocks.activities.failPipelineRun = vi.fn().mockResolvedValue(undefined);
    await expect(documentPipeline({runId:"run",pipeline:{} as never,stageOrder:[]})).rejects.toBe(cancellation);
    expect(mocks.activities.failPipelineRun).toHaveBeenCalledOnce();
  });
});

 it("bounds stage slot denial loops and finalizes failure", async () => {
   const { ActivityFailure, ApplicationFailure, RetryState } = await import("@temporalio/common");
   const { WORKER_SLOT_UNAVAILABLE } = await import("../temporal/shared.js");
   mocks.budget = true;
   mocks.activities.initPipelineRun = vi.fn().mockResolvedValue({ artifacts: {}, documentIds: [] });
   mocks.activities.failPipelineRun = vi.fn().mockResolvedValue(undefined);
   mocks.activities.runPipelineStage = vi.fn().mockRejectedValue(new ActivityFailure(
     "denied", "runPipelineStage", "1", RetryState.NON_RETRYABLE_FAILURE, "worker",
     ApplicationFailure.nonRetryable("full", WORKER_SLOT_UNAVAILABLE),
   ));
   await expect(documentPipeline({runId:"run", pipeline:{} as never, stageOrder:["extract-markdown"], slotGate:true}))
     .rejects.toMatchObject({type:"AdmissionExhausted", nonRetryable:true});
   expect(mocks.activities.runPipelineStage).toHaveBeenCalledTimes(2048);
   expect(mocks.activities.failPipelineRun).toHaveBeenCalledOnce();
   mocks.budget = false;
 });

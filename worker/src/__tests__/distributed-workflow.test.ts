import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ activities: {} as Record<string, any> }));
vi.mock("@temporalio/workflow", () => ({
  patched: () => false,
  proxyActivities: () => new Proxy({}, { get: (_, key: string) => (...args: unknown[]) => mocks.activities[key](...args) }),
  defineQuery: (name:string) => name, defineSignal: (name:string) => name,
  CancellationScope: { nonCancellable: async (fn: () => Promise<unknown>) => fn() },
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT_CANCELLATION_COMPLETED" },
  setHandler: vi.fn(), condition: async () => {},
  ApplicationFailure: {nonRetryable:(message:string)=>new Error(message)}, rootCause:(e:unknown)=>e,
}));
import { documentPipeline } from "../temporal/workflows.js";
const zero = {inputTokens:0,outputTokens:0,costCents:0};
describe("page workflow scheduling", () => {
  beforeEach(() => {
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

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ activities: {} as Record<string, any>, calls: [] as string[], cancel: undefined as undefined | (() => void) }));
vi.mock("@temporalio/workflow", async () => ({
  ActivityFailure: (await import("@temporalio/common")).ActivityFailure,
  sleep: async () => {},
  patched: () => false,
  proxyActivities: () => new Proxy({}, { get: (_, key: string) => (...args: unknown[]) => { mocks.calls.push(key); return mocks.activities[key](...args); } }),
  defineQuery: (name: string) => name, defineSignal: (name: string) => name,
  CancellationScope: { nonCancellable: async (fn: () => Promise<unknown>) => fn() },
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT_CANCELLATION_COMPLETED" },
  setHandler: vi.fn((signal: string, handler: () => void) => { if (signal === "cancel") mocks.cancel = handler; }),
  condition: async () => {},
  workflowInfo: () => ({ workflowId: "wf", runId: "run-id-0000" }),
  startChild: vi.fn(),
  ApplicationFailure: (await import("@temporalio/common")).ApplicationFailure, rootCause: (e: unknown) => (e as Error)?.message,
}));
import { documentPipeline } from "../temporal/workflows.js";

const zero = { inputTokens: 0, outputTokens: 0, costCents: 0 };
const ORDER = ["quarantine", "format-detect", "extract-markdown", "embed", "index"] as never;

function stageNames() {
  return mocks.activities.runPipelineStage.mock.calls.map(([input]: [{ stageName: string }]) => input.stageName);
}

beforeEach(() => {
  mocks.calls = [];
  mocks.cancel = undefined;
  mocks.activities = {
    initPipelineRun: vi.fn(async () => ({ artifacts: {}, documentIds: ["a", "b", "c"] })),
    runPipelineStage: vi.fn(async () => ({ artifacts: {}, usage: zero })),
    completePipelineRun: vi.fn(async () => ({})),
    failPipelineRun: vi.fn(async () => {}),
    planFirstPass: vi.fn(async () => ({ batches: [["a"], ["b"], ["c"]], coversRun: true })),
    runPipelineStages: vi.fn(async ({ stageNames }: { stageNames: string[] }) => ({ artifacts: {}, usage: zero, stagesRun: stageNames.length })),
    runFirstPassBatch: vi.fn(async ({ documentIds }: { documentIds: string[] }) => ({ usage: { ...zero, costCents: 1 }, indexed: documentIds, extracted: [], handedBack: [], timings: {} })),
  };
});

describe("first pass in the pipeline workflow", () => {
  it("runs after format-detect with bounded parallel batches, then the stage loop follows", async () => {
    let active = 0, peak = 0;
    mocks.activities.runFirstPassBatch.mockImplementation(async ({ documentIds }: { documentIds: string[] }) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { usage: zero, indexed: documentIds, extracted: [], handedBack: [], timings: {} };
    });
    await documentPipeline({ runId: "run", pipeline: {} as never, stageOrder: ORDER, slotGate: true, firstPass: { maxParallelBatches: 2, afterFirstPass: "auto" } });
    const order = mocks.calls.filter((c) => c !== "setRunShardDemand");
    expect(order.slice(0, 4)).toEqual(["initPipelineRun", "runPipelineStage", "runPipelineStage", "planFirstPass"]);
    expect(stageNames()).toEqual(["quarantine", "format-detect", "extract-markdown", "embed", "index"]);
    expect(mocks.activities.runFirstPassBatch).toHaveBeenCalledTimes(3);
    expect(peak).toBeLessThanOrEqual(2);
    expect(order.lastIndexOf("runFirstPassBatch")).toBeLessThan(order.indexOf("runPipelineStage", order.indexOf("planFirstPass")));
    expect(order.at(-1)).toBe("completePipelineRun");
    // Format-detect and the following stages know the run recorded the first pass.
    expect(mocks.activities.runPipelineStage.mock.calls.every(([input]: [{ firstPass?: boolean }]) => input.firstPass === true)).toBe(true);
  });

  it("a recorded stage group ends at format-detect so the first pass runs before extraction", async () => {
    const groupable = ["quarantine", "format-detect", "extract-markdown", "embed", "index"];
    await documentPipeline({ runId: "run", pipeline: {} as never, stageOrder: ORDER, slotGate: true, groupableStages: groupable,
      firstPass: { maxParallelBatches: 2, afterFirstPass: "auto" } });
    const groups = mocks.activities.runPipelineStages.mock.calls.map(([input]: [{ stageNames: string[] }]) => input.stageNames);
    expect(groups[0]).toEqual(["quarantine", "format-detect"]);
    const order = mocks.calls;
    expect(order.indexOf("planFirstPass")).toBeGreaterThan(order.indexOf("runPipelineStages"));
    expect(order.indexOf("planFirstPass")).toBeLessThan(order.lastIndexOf("runPipelineStages"));
    expect(groups.at(-1)).toEqual(["extract-markdown", "embed", "index"]);
  });

  it("legacy light-stage grouping also stops at format-detect for the first pass", async () => {
    await documentPipeline({ runId: "run", pipeline: {} as never, stageOrder: ["quarantine", "format-detect", "to-canonical", "extract-markdown"] as never,
      slotGate: true, groupLightStages: true, firstPass: { maxParallelBatches: 2, afterFirstPass: "auto" } });
    const groups = mocks.activities.runPipelineStages.mock.calls.map(([input]: [{ stageNames: string[] }]) => input.stageNames);
    expect(groups[0]).toEqual(["quarantine", "format-detect"]);
    expect(mocks.calls.indexOf("planFirstPass")).toBeGreaterThan(mocks.calls.indexOf("runPipelineStages"));
  });

  it("afterFirstPass none stops after a first pass that finished every document", async () => {
    await documentPipeline({ runId: "run", pipeline: {} as never, stageOrder: ORDER, slotGate: true, firstPass: { maxParallelBatches: 4, afterFirstPass: "none" } });
    expect(stageNames()).toEqual(["quarantine", "format-detect"]);
    expect(mocks.activities.completePipelineRun).toHaveBeenCalledOnce();
  });

  it("afterFirstPass none still runs the stage loop when a document was handed back or a batch failed", async () => {
    mocks.activities.runFirstPassBatch.mockImplementationOnce(async () => { throw new Error("VM capacity"); });
    await documentPipeline({ runId: "run", pipeline: {} as never, stageOrder: ORDER, slotGate: true, firstPass: { maxParallelBatches: 1, afterFirstPass: "none" } });
    expect(stageNames()).toEqual(["quarantine", "format-detect", "extract-markdown", "embed", "index"]);
  });

  it("without recorded first-pass input the command sequence is today's", async () => {
    await documentPipeline({ runId: "run", pipeline: {} as never, stageOrder: ORDER, slotGate: true });
    expect(mocks.calls).toEqual(["initPipelineRun", "runPipelineStage", "runPipelineStage", "runPipelineStage", "runPipelineStage", "runPipelineStage", "completePipelineRun"]);
    expect(mocks.activities.runPipelineStage.mock.calls.some(([input]: [{ firstPass?: boolean }]) => "firstPass" in input)).toBe(false);
  });

  it("a cancel during the batches starts no new batch and fails the run as cancelled", async () => {
    mocks.activities.runFirstPassBatch.mockImplementationOnce(async ({ documentIds }: { documentIds: string[] }) => {
      mocks.cancel?.();
      return { usage: zero, indexed: documentIds, extracted: [], handedBack: [], timings: {} };
    });
    await expect(documentPipeline({ runId: "run", pipeline: {} as never, stageOrder: ORDER, slotGate: true, firstPass: { maxParallelBatches: 1, afterFirstPass: "auto" } }))
      .rejects.toThrow("Run cancelled by user");
    expect(mocks.activities.runFirstPassBatch).toHaveBeenCalledTimes(1);
    expect(stageNames()).toEqual(["quarantine", "format-detect"]);
  });
});

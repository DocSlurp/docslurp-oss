import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ activities: {} as Record<string, any>, queues: [] as Array<string | undefined> }));
vi.mock("@temporalio/workflow", () => ({
  proxyActivities: (options: { taskQueue?: string }) => {
    mocks.queues.push(options.taskQueue);
    return new Proxy({}, { get: (_, key: string) => (...args: unknown[]) => mocks.activities[key](...args) });
  },
  defineQuery: (name: string) => name, defineSignal: (name: string) => name,
  CancellationScope: { nonCancellable: async (fn: () => Promise<unknown>) => fn() },
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT_CANCELLATION_COMPLETED" },
  ActivityFailure: class extends Error {}, ApplicationFailure: class extends Error {
    static nonRetryable(message: string) { return new Error(message); }
  },
  setHandler: vi.fn(), condition: async () => {}, sleep: async () => {}, rootCause: (e: unknown) => e,
  patched: () => false,
  workflowInfo: () => ({ workflowId: "run-run", runId: "temporal-run" }),
}));
import { planDocumentShards } from "../temporal/document-shards.js";
import { documentPipeline } from "../temporal/workflows.js";

const zero = { inputTokens: 0, outputTokens: 0, costCents: 0 };
const ids = (n: number) => Array.from({ length: n }, (_, i) => `doc-${i}`);

describe("planDocumentShards", () => {
  it("does not split runs too small for two shards", () => {
    expect(planDocumentShards(["a"], [10], { minDocsPerShard: 1, maxShards: 8 })).toEqual([]);
    expect(planDocumentShards(ids(3), undefined, { minDocsPerShard: 2, maxShards: 8 })).toEqual([]);
    expect(planDocumentShards(ids(5), undefined, { minDocsPerShard: 1, maxShards: 1 })).toEqual([]);
  });

  it("assigns every document exactly once within the shard cap", () => {
    const shards = planDocumentShards(ids(100), undefined, { minDocsPerShard: 1, maxShards: 16 });
    expect(shards).toHaveLength(16);
    expect(shards.flat().sort()).toEqual(ids(100).sort());
    const sizes = shards.map((shard) => shard.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it("keeps shards big enough to carry their fixed overhead", () => {
    const pages = Array.from({ length: 32 }, () => 10);
    expect(planDocumentShards(ids(32), pages, { minDocsPerShard: 2, maxShards: 32, minPagesPerShard: 16 })).toHaveLength(16);
    expect(planDocumentShards(ids(32), pages, { minDocsPerShard: 1, maxShards: 32, minPagesPerShard: 40 })).toHaveLength(8);
    expect(planDocumentShards(ids(4), [3, 3, 3, 3], { minDocsPerShard: 1, maxShards: 32, minPagesPerShard: 16 })).toEqual([]);
  });

  it("balances by pages so one long document gets a shard to itself", () => {
    const shards = planDocumentShards(["big", "a", "b", "c", "d"], [400, 10, 10, 10, 10], { minDocsPerShard: 1, maxShards: 2 });
    expect(shards).toEqual([["big"], ["a", "b", "c", "d"]]);
  });
});

describe("document-sharded workflow stages", () => {
  beforeEach(() => {
    mocks.queues.length = 0;
    for (const key of Object.keys(mocks.activities)) delete mocks.activities[key];
    Object.assign(mocks.activities, {
      initPipelineRun: vi.fn(async () => ({ artifacts: {}, documentIds: ids(6), documentPages: [1, 1, 1, 1, 1, 1] })),
      runPipelineStage: vi.fn(async () => ({ artifacts: {}, usage: zero })),
      runPipelineStageShard: vi.fn(async () => ({ inputTokens: 1, outputTokens: 0, costCents: 2 })),
      setRunShardDemand: vi.fn(async () => {}),
      completePipelineRun: vi.fn(async () => ({})), failPipelineRun: vi.fn(async () => {}),
    });
  });

  const sharded = { runId: "run", pipeline: {} as never, slotGate: true,
    documentSharding: { minDocsPerShard: 1, maxShards: 3 }, activityTaskQueue: "acts" };

  it("fans shardable stages out before the stage pass, and leaves other stages alone", async () => {
    const order: string[] = [];
    mocks.activities.runPipelineStageShard.mockImplementation(async (shard: { stageName: string; documentIds: string[]; artifacts: object }) => {
      order.push(`shard:${shard.stageName}:${shard.documentIds.length}`);
      expect(shard.artifacts).toEqual({});
      return zero;
    });
    mocks.activities.runPipelineStage.mockImplementation(async (stage: { stageName: string }) => {
      order.push(`stage:${stage.stageName}`);
      return { artifacts: {}, usage: zero };
    });
    await documentPipeline({ ...sharded, stageOrder: ["quarantine", "embed", "index"] });
    expect(order).toEqual(["stage:quarantine", "shard:embed:2", "shard:embed:2", "shard:embed:2", "stage:embed", "stage:index"]);
    expect(mocks.activities.setRunShardDemand).toHaveBeenCalledWith({ runId: "run", shards: 3 });
    expect(mocks.queues.every((queue) => queue === undefined || queue === "acts")).toBe(true);
  });

  it("shards only the documents a format-specific stage works on", async () => {
    mocks.activities.initPipelineRun.mockResolvedValue({ artifacts: {}, documentIds: ids(6), documentPages: [1, 1, 1, 1, 1, 1],
      documentMimeTypes: ["text/html", "application/pdf", "text/html", "application/pdf", "image/png", "text/html"] });
    const seen: string[][] = [];
    mocks.activities.runPipelineStageShard.mockImplementation(async (shard: { documentIds: string[] }) => { seen.push(shard.documentIds); return zero; });
    await documentPipeline({ ...sharded, stageOrder: ["render-images"] });
    expect(seen.flat().sort()).toEqual(["doc-1", "doc-3", "doc-4"]);
    expect(mocks.activities.runPipelineStage).toHaveBeenCalledTimes(1);
  });

  it("lets the stage pass retry documents a failed shard left behind", async () => {
    mocks.activities.runPipelineStageShard
      .mockRejectedValueOnce(new Error("embedder crashed"))
      .mockResolvedValue(zero);
    await documentPipeline({ ...sharded, stageOrder: ["embed"] });
    expect(mocks.activities.runPipelineStageShard).toHaveBeenCalledTimes(3);
    expect(mocks.activities.runPipelineStage).toHaveBeenCalledTimes(1);
    expect(mocks.activities.completePipelineRun).toHaveBeenCalled();
  });

  it("runs adjacent light stages in one activity", async () => {
    mocks.activities.runPipelineStages = vi.fn(async () => ({ artifacts: { "a": "1" }, usage: zero, stats: {} }));
    const order: string[] = [];
    mocks.activities.runPipelineStage.mockImplementation(async (stage: { stageName: string }) => { order.push(stage.stageName); return { artifacts: {}, usage: zero }; });
    mocks.activities.runPipelineStages.mockImplementation(async (group: { stageNames: string[] }) => { order.push(group.stageNames.join("+")); return { artifacts: {}, usage: zero, stats: {} }; });
    await documentPipeline({ runId: "run", pipeline: {} as never, slotGate: true, groupLightStages: true,
      stageOrder: ["quarantine", "format-detect", "normalize", "pdf-tooling", "split-pages", "index"] });
    expect(order).toEqual(["quarantine+format-detect+normalize", "pdf-tooling", "split-pages", "index"]);
  });

  it("keeps one activity per stage for workflow input without sharding", async () => {
    await documentPipeline({ runId: "old", pipeline: {} as never, slotGate: true, stageOrder: ["embed"] });
    expect(mocks.activities.runPipelineStageShard).not.toHaveBeenCalled();
    expect(mocks.activities.setRunShardDemand).not.toHaveBeenCalled();
  });
});

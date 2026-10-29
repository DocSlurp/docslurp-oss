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
import { resolveShardPageRanges, pageInRanges } from "../pipeline/page-ranges.js";
import { planRunPageRanges } from "../pipeline/page-range-plan.js";
import { SHARD_PROFILES } from "../temporal/page-shard-profiles.js";
import { documentPipeline } from "../temporal/workflows.js";

const zero = { inputTokens: 0, outputTokens: 0, costCents: 0 };
const ids = (n: number) => Array.from({ length: n }, (_, i) => `doc-${i}`);

describe("resolveShardPageRanges", () => {
  const docs = [{ id: "a", pageCount: 100 }, { id: "b", pageCount: 5 }];
  it("merges and sorts one document's ranges", () => {
    const ranges = resolveShardPageRanges([{ documentId: "a", first: 33, last: 64 }, { documentId: "a", first: 1, last: 32 }], docs);
    expect(ranges.get("a")).toEqual([{ first: 1, last: 64 }]);
    expect(pageInRanges(64, ranges.get("a"))).toBe(true);
    expect(pageInRanges(65, ranges.get("a"))).toBe(false);
  });
  it("rejects a range for a document outside the shard", () => {
    expect(() => resolveShardPageRanges([{ documentId: "other-tenant-doc", first: 1, last: 2 }], docs)).toThrow("outside this shard");
  });
  it("rejects out-of-bounds, inverted, fractional and empty ranges instead of clamping", () => {
    expect(() => resolveShardPageRanges([{ documentId: "b", first: 1, last: 6 }], docs)).toThrow("invalid range");
    expect(() => resolveShardPageRanges([{ documentId: "b", first: 3, last: 2 }], docs)).toThrow("invalid range");
    expect(() => resolveShardPageRanges([{ documentId: "b", first: 0, last: 2 }], docs)).toThrow("invalid range");
    expect(() => resolveShardPageRanges([{ documentId: "b", first: 1.5, last: 2 }], docs)).toThrow("invalid range");
    expect(() => resolveShardPageRanges([], docs)).toThrow("no ranges");
  });
});

describe("planRunPageRanges", () => {
  const profile = SHARD_PROFILES["render-images:fly-shared-slot"];
  it("covers every page of a long PDF exactly once and leaves short documents whole", () => {
    const plan = planRunPageRanges({ profile, maxShards: 8, documents: [
      { id: "long", pageCount: 998, mimeType: "application/pdf" },
      { id: "short", pageCount: 12, mimeType: "application/pdf" },
      { id: "html", pageCount: 900, mimeType: "text/html" },
    ] });
    expect(plan.shards.length).toBeGreaterThan(1);
    expect(plan.shards.length).toBeLessThanOrEqual(8);
    const ranges = plan.shards.flat();
    expect(new Set(ranges.map((r) => r.documentId))).toEqual(new Set(["long"]));
    const pages = ranges.flatMap((r) => Array.from({ length: r.last - r.first + 1 }, (_, i) => r.first + i));
    expect(pages).toEqual(Array.from({ length: 998 }, (_, i) => i + 1));
  });
  it("returns no shards without budget, for completed documents, or when nothing is worth splitting", () => {
    const doc = { id: "long", pageCount: 998, mimeType: "application/pdf" };
    expect(planRunPageRanges({ profile, maxShards: 1, documents: [doc] }).shards).toEqual([]);
    expect(planRunPageRanges({ profile, maxShards: 8, documents: [{ ...doc, completed: true }] }).shards).toEqual([]);
    expect(planRunPageRanges({ profile, maxShards: 8, documents: [{ ...doc, pageCount: 40 }] }).shards).toEqual([]);
  });
  it("shares the shard budget across documents, longest first", () => {
    const plan = planRunPageRanges({ profile, maxShards: 8, documents: [
      { id: "a", pageCount: 3000, mimeType: "application/pdf" }, { id: "b", pageCount: 2000, mimeType: "application/pdf" },
    ] });
    expect(plan.shards.length).toBeLessThanOrEqual(8);
    expect(plan.shards[0]![0]!.documentId).toBe("a");
  });
});

describe("page-range sharded workflow stages", () => {
  beforeEach(() => {
    mocks.queues.length = 0;
    for (const key of Object.keys(mocks.activities)) delete mocks.activities[key];
    Object.assign(mocks.activities, {
      initPipelineRun: vi.fn(async () => ({ artifacts: {}, documentIds: ["big"], documentPages: [998], documentMimeTypes: ["application/pdf"] })),
      runPipelineStage: vi.fn(async () => ({ artifacts: {}, usage: zero })),
      runPipelineStageShard: vi.fn(async () => ({ inputTokens: 0, outputTokens: 0, costCents: 1 })),
      setRunShardDemand: vi.fn(async () => {}),
      planPageRangeShards: vi.fn(async () => ({ shards: [
        [{ documentId: "big", first: 1, last: 500 }], [{ documentId: "big", first: 501, last: 998 }],
      ] })),
      completePipelineRun: vi.fn(async () => ({})), failPipelineRun: vi.fn(async () => {}),
    });
  });
  const input = { runId: "run", pipeline: {} as never, slotGate: true, activityTaskQueue: "acts",
    pageRangeSharding: { stages: ["render-images", "embed"], maxShards: 8 } };

  it("dispatches range shards before the stage pass, only for range-shardable stages", async () => {
    const order: string[] = [];
    mocks.activities.runPipelineStageShard.mockImplementation(async (shard: { stageName: string; pageRanges?: Array<{ first: number }>; documentIds: string[] }) => {
      order.push(`range:${shard.stageName}:${shard.pageRanges?.[0]?.first}:${shard.documentIds.join(",")}`); return zero;
    });
    mocks.activities.runPipelineStage.mockImplementation(async (stage: { stageName: string }) => { order.push(`stage:${stage.stageName}`); return { artifacts: {}, usage: zero }; });
    await documentPipeline({ ...input, stageOrder: ["render-images", "embed"] });
    expect(order).toEqual(["range:render-images:1:big", "range:render-images:501:big", "stage:render-images", "stage:embed"]);
    expect(mocks.activities.planPageRangeShards).toHaveBeenCalledTimes(1);
    expect(mocks.activities.planPageRangeShards).toHaveBeenCalledWith({ runId: "run", stageName: "render-images", maxShards: 8 });
    expect(mocks.activities.setRunShardDemand).toHaveBeenCalledWith({ runId: "run", shards: 2 });
  });

  it("lets the stage pass finish when a range shard fails", async () => {
    mocks.activities.runPipelineStageShard.mockRejectedValueOnce(new Error("renderer crashed")).mockResolvedValue(zero);
    await documentPipeline({ ...input, stageOrder: ["render-images"] });
    expect(mocks.activities.runPipelineStage).toHaveBeenCalledTimes(1);
    expect(mocks.activities.completePipelineRun).toHaveBeenCalled();
  });

  it("does not dispatch for a one-shard plan or for input recorded without page-range sharding", async () => {
    mocks.activities.planPageRangeShards.mockResolvedValue({ shards: [] });
    await documentPipeline({ ...input, stageOrder: ["render-images"] });
    expect(mocks.activities.runPipelineStageShard).not.toHaveBeenCalled();
    mocks.activities.planPageRangeShards.mockClear();
    await documentPipeline({ runId: "old", pipeline: {} as never, slotGate: true, stageOrder: ["render-images"] });
    expect(mocks.activities.planPageRangeShards).not.toHaveBeenCalled();
  });
});

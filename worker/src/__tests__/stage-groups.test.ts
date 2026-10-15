import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ activities: {} as Record<string, any> }));
vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => new Proxy({}, { get: (_, key: string) => (...args: unknown[]) => mocks.activities[key](...args) }),
  defineQuery: (name: string) => name, defineSignal: (name: string) => name,
  CancellationScope: { nonCancellable: async (fn: () => Promise<unknown>) => fn() },
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT_CANCELLATION_COMPLETED" },
  ActivityFailure: class extends Error {}, ApplicationFailure: class extends Error {
    static nonRetryable(message: string) { return new Error(message); }
  },
  setHandler: vi.fn(), condition: async () => {}, sleep: async () => {}, rootCause: (e: unknown) => e,
  patched: () => false,
  startChild: vi.fn(),
  workflowInfo: () => ({ workflowId: "run-run", runId: "temporal-run" }),
}));
import { getPipelineStageOrder, normalizePipelineFeatures, pipelineStageOrder } from "@docslurp/shared";

import { planStageGroupEnd } from "../temporal/stage-groups.js";
import { documentPipeline } from "../temporal/workflows.js";

const zero = { inputTokens: 0, outputTokens: 0, costCents: 0 };
const ids = (n: number) => Array.from({ length: n }, (_, i) => `doc-${i}`);
/** The default pipeline's stages, as the app records them for a run. */
const defaultOrder = getPipelineStageOrder(normalizePipelineFeatures({}));

describe("planStageGroupEnd", () => {
  const order = ["a", "b", "c", "d", "e"];
  it("groups adjacent groupable stages until one needs pre-work", () => {
    const groupable = new Set(order);
    expect(planStageGroupEnd({ stageOrder: order, start: 0, groupable, needsPreWork: () => false })).toBe(5);
    expect(planStageGroupEnd({ stageOrder: order, start: 0, groupable, needsPreWork: (stage) => stage === "c" })).toBe(2);
    // A stage with pre-work may lead a group.
    expect(planStageGroupEnd({ stageOrder: order, start: 2, groupable, needsPreWork: (stage) => stage === "c" })).toBe(5);
  });

  it("keeps stages outside the groupable set alone", () => {
    const groupable = new Set(["a", "b", "d", "e"]);
    expect(planStageGroupEnd({ stageOrder: order, start: 0, groupable, needsPreWork: () => false })).toBe(2);
    expect(planStageGroupEnd({ stageOrder: order, start: 2, groupable, needsPreWork: () => false })).toBe(3);
  });
});

describe("workflow stage groups (groupableStages)", () => {
  let calls: string[];
  beforeEach(() => {
    calls = [];
    for (const key of Object.keys(mocks.activities)) delete mocks.activities[key];
    const record = (name: string) => vi.fn(async (input: { stageName?: string; stageNames?: string[] }) => {
      calls.push(input.stageNames ? `${name}:${input.stageNames.join("+")}` : input.stageName ? `${name}:${input.stageName}` : name);
      if (name === "runPipelineStageShard") return zero;
      return { artifacts: {}, usage: zero, stats: {} };
    });
    Object.assign(mocks.activities, {
      initPipelineRun: vi.fn(async () => { calls.push("initPipelineRun"); return { artifacts: {}, documentIds: ids(1), documentPages: [20], documentMimeTypes: ["application/pdf"] }; }),
      runPipelineStage: record("runPipelineStage"),
      runPipelineStages: record("runPipelineStages"),
      runPipelineStageShard: record("runPipelineStageShard"),
      prepareVisionPageBatches: vi.fn(async () => { calls.push("prepareVisionPageBatches"); return { total: 0 }; }),
      setRunShardDemand: vi.fn(async () => { calls.push("setRunShardDemand"); }),
      completePipelineRun: vi.fn(async () => { calls.push("completePipelineRun"); }),
      failPipelineRun: vi.fn(async () => {}),
    });
  });

  // Production input shape (server/src/lib/temporal.ts) for a single PDF.
  const production = {
    runId: "run", pipeline: {} as never, slotGate: true, pageConcurrency: 8, pageBundleSize: 1, pageChildBatchSize: 500,
    documentSharding: { minDocsPerShard: 2, maxShards: 8, minPagesPerShard: 32 }, groupLightStages: true,
  };

  it("cuts a default single-PDF run from 12 to 5 sequential activities", async () => {
    await documentPipeline({ ...production, stageOrder: defaultOrder });
    const before = [...calls];
    expect(before).toEqual([
      "initPipelineRun",
      "runPipelineStages:quarantine+format-detect+to-canonical+format-tooling+normalize",
      "runPipelineStage:pdf-tooling",
      "runPipelineStage:split-pages",
      "runPipelineStage:extract-markdown",
      "runPipelineStage:classify-route",
      "runPipelineStage:render-images",
      "prepareVisionPageBatches",
      "runPipelineStage:vision-extract",
      "runPipelineStage:embed",
      "runPipelineStage:index",
      "completePipelineRun",
    ]);

    calls = [];
    await documentPipeline({ ...production, stageOrder: defaultOrder, groupableStages: [...pipelineStageOrder] });
    expect(calls).toEqual([
      "initPipelineRun",
      "runPipelineStages:quarantine+format-detect+to-canonical+format-tooling+normalize+pdf-tooling+split-pages+extract-markdown+classify-route+render-images",
      "prepareVisionPageBatches",
      "runPipelineStages:vision-extract+embed+index",
      "completePipelineRun",
    ]);
  });

  it("never puts a sharded stage in the middle of a group; its stage pass leads the next one", async () => {
    mocks.activities.initPipelineRun = vi.fn(async () => {
      calls.push("initPipelineRun");
      return { artifacts: {}, documentIds: ids(4), documentPages: [40, 40, 40, 40], documentMimeTypes: Array(4).fill("application/pdf") };
    });
    await documentPipeline({
      ...production, pageConcurrency: 1, documentSharding: { minDocsPerShard: 1, maxShards: 2, minPagesPerShard: 32 },
      stageOrder: ["quarantine", "split-pages", "extract-markdown", "classify-route", "embed", "index"],
      groupableStages: [...pipelineStageOrder],
    });
    expect(calls).toEqual([
      "initPipelineRun",
      "runPipelineStages:quarantine+split-pages",
      "setRunShardDemand",
      "runPipelineStageShard:extract-markdown",
      "runPipelineStageShard:extract-markdown",
      // classify-route is shardable too, so it starts its own shards after extract-markdown's pass.
      "runPipelineStage:extract-markdown",
      "setRunShardDemand",
      "runPipelineStageShard:classify-route",
      "runPipelineStageShard:classify-route",
      "runPipelineStage:classify-route",
      "setRunShardDemand",
      "runPipelineStageShard:embed",
      "runPipelineStageShard:embed",
      "runPipelineStages:embed+index",
      "completePipelineRun",
    ]);
  });

  it("resumes at the next stage when a group yields to a pause request", async () => {
    let first = true;
    mocks.activities.runPipelineStages = vi.fn(async (input: { stageNames: string[]; yieldToControl?: boolean }) => {
      calls.push(`runPipelineStages:${input.stageNames.join("+")}`);
      expect(input.yieldToControl).toBe(true);
      if (first) { first = false; return { artifacts: {}, usage: zero, stats: {}, stagesRun: 2 }; }
      return { artifacts: {}, usage: zero, stats: {}, stagesRun: input.stageNames.length };
    });
    await documentPipeline({ ...production, stageOrder: ["quarantine", "format-detect", "normalize", "split-pages"], groupableStages: [...pipelineStageOrder] });
    expect(calls).toEqual([
      "initPipelineRun",
      "runPipelineStages:quarantine+format-detect+normalize+split-pages",
      "runPipelineStages:normalize+split-pages",
      "completePipelineRun",
    ]);
  });

  it("keeps a run with index before enrichment complete only after its last stage", async () => {
    const order = [...defaultOrder.slice(0, -2), "embed", "index", "document-summary", "proposition-index"] as typeof defaultOrder;
    await documentPipeline({ ...production, stageOrder: order, groupableStages: [...pipelineStageOrder] });
    expect(calls.at(-2)).toBe("runPipelineStages:vision-extract+embed+index+document-summary+proposition-index");
    expect(calls.at(-1)).toBe("completePipelineRun");
  });
  it("tells failPipelineRun which group was running when a group fails", async () => {
    mocks.activities.runPipelineStages = vi.fn(async () => { throw new Error("index failed"); });
    const failed: unknown[] = [];
    mocks.activities.failPipelineRun = vi.fn(async (input: unknown) => { failed.push(input); });
    await expect(documentPipeline({ ...production, stageOrder: ["quarantine", "format-detect", "normalize"], groupableStages: [...pipelineStageOrder] }))
      .rejects.toThrow("index failed");
    expect(failed).toEqual([expect.objectContaining({ runId: "run", stage: "quarantine", stageGroup: ["quarantine", "format-detect", "normalize"] })]);
  });
});

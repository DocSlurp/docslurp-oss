import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: vi.fn() }));

const { resolvePageConcurrency } = await import("../lib/temporal.js");

describe("resolvePageConcurrency", () => {
  it("caps the deployment setting by the org's worker slots and the per-run fan-out ceiling", () => {
    expect(resolvePageConcurrency("64", 2)).toBe(2);
    expect(resolvePageConcurrency("64", 20)).toBe(20);
    expect(resolvePageConcurrency("512", 1_000)).toBe(128);
    expect(resolvePageConcurrency("8", 1_000)).toBe(8);
  });

  it("falls back to the deployment setting when the org is unknown", () => {
    expect(resolvePageConcurrency("16", null)).toBe(16);
    expect(resolvePageConcurrency(undefined, null)).toBe(1);
    expect(resolvePageConcurrency("nonsense", 5)).toBe(1);
  });
});

const { resolveWorkflowScalingInput, resolveWorkflowPriority, resolveRunTaskQueue } = await import("../lib/temporal.js");

describe("resolveWorkflowScalingInput", () => {
  it("opts new runs into slot gating and 500-page child batches by default", () => {
    expect(resolveWorkflowScalingInput({ NODE_ENV: "production" })).toEqual({ slotGate: true, pageChildBatchSize: 500, documentSharding: { minDocsPerShard: 2, maxShards: 32, minPagesPerShard: 16 }, groupLightStages: true });
  });

  it("honours overrides and clamps the batch size", () => {
    expect(resolveWorkflowScalingInput({ WORKER_SLOT_ENFORCEMENT: "false", WORKER_PAGE_CHILD_BATCH_SIZE: "0", WORKER_DOCUMENT_SHARDING: "false", WORKER_GROUP_LIGHT_STAGES: "false" })).toEqual({});
    expect(resolveWorkflowScalingInput({ WORKER_PAGE_CHILD_BATCH_SIZE: "10" }).pageChildBatchSize).toBe(50);
    expect(resolveWorkflowScalingInput({ TEMPORAL_ACTIVITY_TASK_QUEUE: "acts" }).activityTaskQueue).toBe("acts");
    expect(resolveWorkflowScalingInput({ TEMPORAL_ACTIVITY_TASK_QUEUE: "acts" }, { loadtest: true }).activityTaskQueue).toBeUndefined();
  });

  it("shards documents up to the org's worker slots", () => {
    expect(resolveWorkflowScalingInput({}, { loadtest: false }, { workerSlots: 64 }).documentSharding)
      .toEqual({ minDocsPerShard: 2, maxShards: 32, minPagesPerShard: 16 });
    expect(resolveWorkflowScalingInput({}, { loadtest: false }, { workerSlots: 8 }).documentSharding?.maxShards).toBe(8);
    expect(resolveWorkflowScalingInput({ WORKER_DOCUMENT_SHARDING: "false" }, { loadtest: false }, { workerSlots: 64 }).documentSharding)
      .toBeUndefined();
    expect(resolveWorkflowScalingInput({}, { loadtest: false }, { workerSlots: 1 }).documentSharding).toBeUndefined();
  });
});

describe("resolveWorkflowPriority", () => {
  it("keys fairness by org and weights it by plan worker slots", () => {
    expect(resolveWorkflowPriority({ orgKey: "org-1", workerSlots: 1_000 }, {})).toEqual({ fairnessKey: "org-1", fairnessWeight: 1_000 });
    expect(resolveWorkflowPriority({ orgKey: "org-2", workerSlots: 2 }, {})).toEqual({ fairnessKey: "org-2", fairnessWeight: 2 });
    expect(resolveWorkflowPriority({ orgKey: "x".repeat(80), workerSlots: null }, {})?.fairnessKey).toHaveLength(64);
    expect(resolveWorkflowPriority({ orgKey: "org-1", workerSlots: 20 }, { TEMPORAL_FAIRNESS: "false" })).toBeUndefined();
    expect(resolveWorkflowPriority(null, {})).toBeUndefined();
  });
});

describe("resolveRunTaskQueue", () => {
  const env = { TEMPORAL_LOADTEST_TASK_QUEUE: "docslurp-loadtest", TEMPORAL_LOADTEST_ORG_IDS: "lt-org, other-lt" };

  it("routes only listed load-test orgs to the load-test queue", () => {
    expect(resolveRunTaskQueue({ orgKey: "lt-org" }, "docslurp-pipeline", env)).toEqual({ taskQueue: "docslurp-loadtest", loadtest: true });
    expect(resolveRunTaskQueue({ orgKey: "customer" }, "docslurp-pipeline", env)).toEqual({ taskQueue: "docslurp-pipeline", loadtest: false });
    expect(resolveRunTaskQueue({ orgKey: "lt-org" }, "docslurp-pipeline", {})).toEqual({ taskQueue: "docslurp-pipeline", loadtest: false });
    expect(resolveRunTaskQueue(null, "docslurp-pipeline", env).loadtest).toBe(false);
  });
});

const { resolveWorkflowStageOrder } = await import("../lib/temporal.js");
const { normalizePipelineFeatures } = await import("@docslurp/shared");

describe("resolveWorkflowStageOrder", () => {
  const enriched = normalizePipelineFeatures({ summarize: true, propositionIndex: true });

  it("runs index right after embed outside production by default", () => {
    const order = resolveWorkflowStageOrder(enriched, { NODE_ENV: "development" });
    expect(order.slice(order.indexOf("embed"))).toEqual(["embed", "index", "document-summary", "proposition-index"]);
  });

  it("keeps the canonical order in production unless WORKER_INDEX_BEFORE_ENRICH is set", () => {
    const canonical = resolveWorkflowStageOrder(enriched, { NODE_ENV: "production" });
    expect(canonical.slice(canonical.indexOf("document-summary"))).toEqual(["document-summary", "embed", "proposition-index", "index"]);
    expect(resolveWorkflowStageOrder(enriched, { NODE_ENV: "production", WORKER_INDEX_BEFORE_ENRICH: "true" }).at(-1)).toBe("proposition-index");
    expect(resolveWorkflowStageOrder(enriched, { NODE_ENV: "development", WORKER_INDEX_BEFORE_ENRICH: "false" })).toEqual(canonical);
  });
});

const { resolveGroupableStages } = await import("../lib/temporal.js");
const { pipelineStageOrder } = await import("@docslurp/shared");

describe("resolveGroupableStages", () => {
  it("lets every stage share an activity outside production by default", () => {
    expect(resolveGroupableStages({ NODE_ENV: "development" }).groupableStages).toEqual(pipelineStageOrder);
    expect(resolveWorkflowScalingInput({ NODE_ENV: "development" }).groupableStages).toEqual(pipelineStageOrder);
  });

  it("is off in production unless WORKER_GROUP_ADJACENT_STAGES is set, and off with all grouping", () => {
    expect(resolveGroupableStages({ NODE_ENV: "production" })).toEqual({});
    expect(resolveGroupableStages({ NODE_ENV: "production", WORKER_GROUP_ADJACENT_STAGES: "true" }).groupableStages).toEqual(pipelineStageOrder);
    expect(resolveGroupableStages({ WORKER_GROUP_LIGHT_STAGES: "false", WORKER_GROUP_ADJACENT_STAGES: "true" })).toEqual({});
  });

  it("keeps WORKER_UNGROUPED_STAGES in activities of their own", () => {
    const stages = resolveGroupableStages({ NODE_ENV: "development", WORKER_UNGROUPED_STAGES: "embed, extract-markdown" }).groupableStages;
    expect(stages).not.toContain("embed");
    expect(stages).not.toContain("extract-markdown");
    expect(stages).toContain("index");
  });
});

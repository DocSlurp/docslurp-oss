import { afterEach, describe, expect, it } from "vitest";
import { setVmIsolatedPageRangeStagesForTest } from "../pipeline/page-ranges.js";
import { defaultPipelineFeatures } from "@docslurp/shared";

import type { Config } from "../config.js";
import type { Document, StageState, WorkspaceRun, WorkspaceRunEvent } from "../models.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import {
  createStageExecution,
  loadRunState,
  type StageExecutionStore,
} from "../pipeline/stage-execution.js";

const config = { workerDocConcurrency: 2, workerAdaptiveTuning: false } as Config;

function makeRun(overrides: Partial<WorkspaceRun> = {}): WorkspaceRun {
  return {
    id: "run-1", orgId: "org-1", userId: "user-1", workspaceId: "ws-1", kind: "bulk-upload",
    status: "queued", stage: "queued", totalDocuments: 1, processedDocuments: 0, pagesTotal: 2,
    pagesProcessed: 0, spentCents: 0, pipeline: defaultPipelineFeatures,
    error: null, stats: {}, artifacts: { "doc-1:parse": "s3://db/parse" }, claimId: null,
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function makeDocument(): Document {
  return {
    id: "doc-1", userId: "user-1", runId: "run-1", filename: "a.pdf", mimeType: "application/pdf",
    sourceKey: "raw/a.pdf", status: "queued", extractionMode: "hybrid", pageCount: 2,
    createdAt: new Date(), updatedAt: new Date(),
  } as Document;
}

/** In-memory store implementing only the narrow Stage Execution interface. */
class FakeStore implements StageExecutionStore {
  run = makeRun();
  documents = [makeDocument()];
  checkpoints: StageState[] = [];
  completedPages = new Map<string, unknown>();
  events: WorkspaceRunEvent[] = [];
  calls: string[] = [];
  stageStatus = new Map<string, string>();
  runStatus = "queued";
  failures: Array<{ stage: string; message: string }> = [];
  notifications: string[] = [];
  failWebhooks = false;

  readonly pageTasks = { completed: async () => this.completedPages } as unknown as StageExecutionStore["pageTasks"];

  async loadRun() { return structuredClone(this.run); }
  async loadDocumentsForRun() { return structuredClone(this.documents); }
  async hydrateState(state: WorkflowState) {
    this.calls.push("hydrateState");
    for (const checkpoint of this.checkpoints) state.setRunStage(checkpoint);
  }
  async renewHeartbeat() { this.calls.push("renewHeartbeat"); }
  async startRunStage(_state: WorkflowState, stage: string) { this.stageStatus.set(stage, "processing"); }
  async completeRunStage(_state: WorkflowState, stage: string) { this.stageStatus.set(stage, "completed"); }
  shardsFinished: string[][] = [];
  async finishShard(state: WorkflowState) { this.shardsFinished.push(state.documents.map((document) => document.id)); }
  ordinaryFailures = new Map<string, number>();
  async failRunStage(_state: WorkflowState, stage: string, message: string, options: { countFailure?: boolean } = {}) {
    this.stageStatus.set(stage, `failed:${message}`);
    const total = (this.ordinaryFailures.get(stage) ?? 0) + (options.countFailure === false ? 0 : 1);
    this.ordinaryFailures.set(stage, total);
    return total;
  }
  async updateProgress(state: WorkflowState) { this.runStatus = state.run.status; this.calls.push("updateProgress"); }
  async appendEvent(event: WorkspaceRunEvent) { this.events.push(event); }
  async completeRun(state: WorkflowState) { this.runStatus = "completed"; this.calls.push(`completeRun:${state.totalStages}`); }
  async failRun(_runId: string, stage: string, message: string) { this.runStatus = "failed"; this.failures.push({ stage, message }); }
  currentStage: string | null = null;
  async currentRunStage() { return this.currentStage; }
  seeded: Array<{ runId: string; reusedStages: readonly string[] }> = [];
  async seedReusedStageOutputs(runId: string, reusedStages: readonly string[]) {
    this.seeded.push({ runId, reusedStages });
    return { seededDocuments: this.documents.length, unavailable: [] };
  }
  async triggerRunEmails(_runId: string, event: string) { this.notifications.push(`email:${event}`); }
  async triggerWebhooks(_runId: string, event: string) {
    if (this.failWebhooks) throw new Error("webhook down");
    this.notifications.push(`webhook:${event}`);
  }
}

function stage(name: string, run: Stage["run"]): Stage {
  return { name, run };
}

function runtime(overrides: Partial<{ heartbeatIntervalMs: number }> = {}) {
  const heartbeats: Array<Record<string, unknown>> = [];
  return {
    heartbeats,
    runtime: {
      signal: new AbortController().signal,
      heartbeat: (details: Record<string, unknown>) => heartbeats.push(details),
      attempt: 1,
      ...overrides,
    },
  };
}

const input = (stageName: string) => ({
  stageName,
  runId: "run-1",
  totalStages: 3,
  artifacts: { "doc-1:parse": "s3://workflow/parse", "doc-1:fetch": "s3://workflow/fetch" },
});

describe("Stage Execution", () => {
  it("runs a document shard without touching the run-stage checkpoint", async () => {
    const store = new FakeStore();
    store.documents = [makeDocument(), { ...makeDocument(), id: "doc-2" }, { ...makeDocument(), id: "doc-3" }];
    const seen: string[][] = [];
    const execution = createStageExecution({
      store,
      config,
      stages: [stage("embed", async (state) => {
        seen.push(state.documents.map((document) => document.id));
        expect(state.shard).not.toBeNull();
        state.artifactLedger.record("doc-3:embeddings", "s3://shard/doc-3");
      })],
    });
    const { runtime: rt } = runtime();
    const output = await execution.runStage(input("embed"), { ...rt, documentIds: ["doc-3", "doc-1"] });
    expect(seen).toEqual([["doc-1", "doc-3"]]);
    expect(store.shardsFinished).toEqual([["doc-1", "doc-3"]]);
    expect(store.stageStatus.has("embed")).toBe(false);
    expect(output.artifacts).toEqual({});
  });

  afterEach(() => setVmIsolatedPageRangeStagesForTest([]));

  it("refuses page-range shards for a stage whose executor is not VM-isolated", async () => {
    const store = new FakeStore();
    store.documents = [{ ...makeDocument(), pageCount: 100 }];
    let ranged = 0;
    const execution = createStageExecution({
      store, config,
      stages: [{ name: "render-images", run: async () => {}, runPageRanges: async () => { ranged++; } }],
    });
    const { runtime: rt } = runtime();
    await expect(execution.runStage(input("render-images"), { ...rt, documentIds: ["doc-1"], pageRanges: [{ documentId: "doc-1", first: 33, last: 64 }], shardIndex: 1, shardCount: 3 }))
      .rejects.toThrow(/not VM-isolated/);
    expect(ranged).toBe(0);
  });

  it("runs a page-range shard through runPageRanges and leaves the stage and documents to the stage pass", async () => {
    setVmIsolatedPageRangeStagesForTest(["render-images"]);
    const store = new FakeStore();
    store.documents = [{ ...makeDocument(), pageCount: 100 }];
    const seen: Array<[string, unknown]> = [];
    let wholeRuns = 0;
    const execution = createStageExecution({
      store, config,
      stages: [{ name: "render-images", run: async () => { wholeRuns++; },
        runPageRanges: async (_state, ranges) => { for (const [id, list] of ranges) seen.push([id, list]); } }],
    });
    const { runtime: rt } = runtime();
    await execution.runStage(input("render-images"), { ...rt, documentIds: ["doc-1"], pageRanges: [{ documentId: "doc-1", first: 33, last: 64 }], shardIndex: 1, shardCount: 3 });
    expect(seen).toEqual([["doc-1", [{ first: 33, last: 64 }]]]);
    expect(wholeRuns).toBe(0);
    expect(store.shardsFinished).toEqual([["doc-1"]]);
    expect(store.stageStatus.has("render-images")).toBe(false);
  });

  it("refuses page-range shards for unsupported stages, foreign documents and bad bounds before doing any work", async () => {
    const work: string[] = [];
    const make = () => {
      const store = new FakeStore();
      store.documents = [{ ...makeDocument(), pageCount: 10 }, { ...makeDocument(), id: "doc-2", pageCount: 10 }];
      return { store, execution: createStageExecution({ store, config, stages: [
        stage("embed", async () => { work.push("embed"); }),
        { name: "render-images", run: async () => { work.push("run"); }, runPageRanges: async () => { work.push("ranges"); } },
      ] }) };
    };
    const { runtime: rt } = runtime();
    await expect(make().execution.runStage(input("embed"), { ...rt, documentIds: ["doc-1"], pageRanges: [{ documentId: "doc-1", first: 1, last: 5 }] }))
      .rejects.toThrow("does not support page-range shards");
    // doc-2 belongs to the run but not to this shard: beginShard drops it, so its range is foreign here.
    await expect(make().execution.runStage(input("render-images"), { ...rt, documentIds: ["doc-1"], pageRanges: [{ documentId: "doc-2", first: 1, last: 5 }] }))
      .rejects.toThrow("outside this shard");
    await expect(make().execution.runStage(input("render-images"), { ...rt, documentIds: ["doc-1"], pageRanges: [{ documentId: "doc-1", first: 1, last: 11 }] }))
      .rejects.toThrow("invalid range");
    await expect(make().execution.runStage(input("render-images"), { ...rt, pageRanges: [{ documentId: "doc-1", first: 1, last: 5 }] }))
      .rejects.toThrow("requires its document ids");
    expect(work).toEqual([]);
  });

  it("leaves a failed shard's stage to the unsharded pass", async () => {
    const store = new FakeStore();
    const execution = createStageExecution({
      store,
      config,
      stages: [stage("embed", async () => { throw new Error("embedder crashed"); })],
    });
    const { runtime: rt } = runtime();
    await expect(execution.runStage(input("embed"), { ...rt, documentIds: ["doc-1"] })).rejects.toThrow("embedder crashed");
    expect(store.stageStatus.has("embed")).toBe(false);
    expect(store.calls).toContain("updateProgress");
  });

  it("loads a Run once with persisted artifacts winning over workflow artifacts", async () => {
    const store = new FakeStore();
    const state = await loadRunState(store, "run-1", { artifacts: input("x").artifacts, totalStages: 3 });
    expect(state.artifacts).toMatchObject({ "doc-1:parse": "s3://db/parse", "doc-1:fetch": "s3://workflow/fetch" });
    expect(state.totalStages).toBe(3);
    expect(store.calls).toEqual(["hydrateState"]);

    const pageState = await loadRunState(store, "run-1", { hydrate: false });
    expect(pageState.documents).toHaveLength(1);
    expect(store.calls).toEqual(["hydrateState"]);
  });

  it("starts a Run as processing and reports its documents and artifacts", async () => {
    const store = new FakeStore();
    const execution = createStageExecution({ store, stages: [], config });
    const output = await execution.startRun({ runId: "run-1", totalStages: 3 });

    expect(store.runStatus).toBe("processing");
    expect(output).toEqual({ documentIds: ["doc-1"], artifacts: { "doc-1:parse": "s3://db/parse", "run:vision-routing-version": "v1" }, documentPages: [2], documentMimeTypes: ["application/pdf"] });
    expect(store.events.map((event) => event.eventType)).toEqual(["run.started"]);
  });

  it("runs a stage with checkpoints, usage, new artifacts, and a progress event", async () => {
    const store = new FakeStore();
    const { runtime: rt } = runtime();
    let receivedSignal: AbortSignal | undefined;
    const execution = createStageExecution({
      store,
      config,
      stages: [stage("summarize", async (state, signal) => {
        receivedSignal = signal;
        expect(state.docConcurrency).toBeGreaterThan(0);
        state.artifactLedger.record("doc-1:summary", "s3://new/summary");
        state.usageLedger.enqueue({
          provider: "openrouter", model: "m", metric: "summarize", amount: 15, unit: "tokens",
          costCents: 0, inputTokens: 10, outputTokens: 5,
        });
      })],
    });

    const output = await execution.runStage(input("summarize"), rt);

    // The stage gets the orchestrator signal combined with the stall detector (OP-08).
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);
    expect(store.stageStatus.get("summarize")).toBe("completed");
    expect(output.artifacts).toEqual({ "doc-1:parse": "s3://db/parse", "doc-1:summary": "s3://new/summary" });
    expect(output.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(output.stats).toMatchObject({ documents: 1, adaptiveTuning: { docConcurrency: 2 } });
    expect(store.events.at(-1)).toMatchObject({ eventType: "run.progress", stageName: "summarize" });
  });

  it("checkpoints a failed stage and rethrows", async () => {
    const store = new FakeStore();
    const execution = createStageExecution({
      store,
      config,
      stages: [stage("summarize", async () => { throw new Error("model exploded"); })],
    });

    await expect(execution.runStage(input("summarize"), runtime().runtime)).rejects.toThrow("model exploded");
    expect(store.stageStatus.get("summarize")).toBe("failed:model exploded");
  });

  it("leaves the stage resumable when the worker is interrupted", async () => {
    const store = new FakeStore();
    const execution = createStageExecution({
      store,
      config,
      stages: [stage("summarize", async () => { throw new Error("WORKER_SHUTDOWN"); })],
    });

    await expect(execution.runStage(input("summarize"), runtime().runtime)).rejects.toThrow("WORKER_SHUTDOWN");
    expect(store.stageStatus.get("summarize")).toBe("processing");
  });

  it("heartbeats through the injected runtime while a stage runs", async () => {
    const store = new FakeStore();
    const { runtime: rt, heartbeats } = runtime({ heartbeatIntervalMs: 5 });
    const execution = createStageExecution({
      store,
      config,
      stages: [stage("summarize", () => new Promise((resolve) => setTimeout(resolve, 40)))],
    });

    await execution.runStage(input("summarize"), rt);
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats[0]).toMatchObject({ stage: "summarize", docs: 1 });
    expect(store.calls).toContain("renewHeartbeat");
  });

  it("does not restart the run stage when distributed vision pages already completed", async () => {
    const store = new FakeStore();
    store.completedPages.set("doc-1:1", {});
    const execution = createStageExecution({
      store,
      config,
      stages: [stage("vision-extract", async () => {})],
    });

    await execution.runStage(input("vision-extract"), runtime().runtime);
    // startRunStage skipped; the stage is still completed.
    expect(store.stageStatus.get("vision-extract")).toBe("completed");
    expect([...store.stageStatus.keys()]).toEqual(["vision-extract"]);
  });

  it("rejects unknown stages before touching the Run", async () => {
    const store = new FakeStore();
    const execution = createStageExecution({ store, config, stages: [] });
    await expect(execution.runStage(input("nope"), runtime().runtime)).rejects.toThrow("unknown stage: nope");
    expect(store.calls).toEqual([]);
  });

  it("completes a Run, emits run.completed, and notifies even when a webhook fails", async () => {
    const store = new FakeStore();
    store.failWebhooks = true;
    const execution = createStageExecution({ store, config, stages: [] });

    await execution.completeRun({ runId: "run-1" });

    expect(store.runStatus).toBe("completed");
    expect(store.calls.find((call) => call.startsWith("completeRun:"))).not.toBe("completeRun:0");
    expect(store.events.map((event) => event.eventType)).toEqual(["run.completed"]);
    expect(store.notifications).toEqual(["email:run.completed"]);
  });

  it("fails a Run through the store and notifies", async () => {
    const store = new FakeStore();
    const execution = createStageExecution({ store, config, stages: [] });

    await execution.failRun({ runId: "run-1", stage: "parse", message: "parser crashed" });

    expect(store.runStatus).toBe("failed");
    expect(store.failures).toEqual([{ stage: "parse", message: "parser crashed" }]);
    expect(store.notifications).toEqual(["email:run.failed", "webhook:run.failed"]);
  });

  it("records the group stage that was running when a stage group fails", async () => {
    const store = new FakeStore();
    const execution = createStageExecution({ store, config, stages: [] });

    store.currentStage = "embed";
    await execution.failRun({ runId: "run-1", stage: "vision-extract", message: "boom", stageGroup: ["vision-extract", "embed", "index"] });
    // A run stage outside the group (stale or unexpected) keeps the workflow's stage.
    store.currentStage = "quarantine";
    await execution.failRun({ runId: "run-1", stage: "vision-extract", message: "boom", stageGroup: ["vision-extract", "embed", "index"] });

    expect(store.failures.map((failure) => failure.stage)).toEqual(["embed", "vision-extract"]);
  });

  it("aborts a stage that stops making progress as hung work and stops heartbeating", async () => {
    const store = new FakeStore();
    const { runtime: rt, heartbeats } = runtime({ heartbeatIntervalMs: 10 });
    const execution = createStageExecution({
      store,
      config,
      stages: [stage("parse", (_state, signal) => new Promise<void>((_resolve, reject) => {
        // A hung provider socket: nothing happens until the signal aborts.
        signal?.addEventListener("abort", () => reject(new Error("socket aborted")), { once: true });
      }))],
    });
    const error = await execution.runStage(input("parse"), { ...rt, stallTimeoutMs: 60, progressFromProcessCpu: false })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^\[hung-work\] stage parse made no progress/);
    expect(store.stageStatus.get("parse")).toMatch(/^failed:\[hung-work\]/);
    const beatsAtFailure = heartbeats.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heartbeats.length).toBe(beatsAtFailure);
  });

  it("keeps heartbeating while the stage reports progress", async () => {
    const store = new FakeStore();
    const { runtime: rt, heartbeats } = runtime({ heartbeatIntervalMs: 10 });
    const { noteWorkProgress } = await import("../lib/work-progress.js");
    const execution = createStageExecution({
      store,
      config,
      stages: [stage("parse", async () => {
        for (let step = 0; step < 12; step++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          noteWorkProgress("command:pdftotext");
        }
      })],
    });
    await execution.runStage(input("parse"), { ...rt, stallTimeoutMs: 60, progressFromProcessCpu: false });
    expect(store.stageStatus.get("parse")).toBe("completed");
    expect(heartbeats.length).toBeGreaterThan(3);
    expect(heartbeats.at(-1)).toMatchObject({ lastProgress: "command:pdftotext" });
  });
});

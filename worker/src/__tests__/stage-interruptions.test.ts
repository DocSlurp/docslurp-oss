/**
 * OP-07: infrastructure interruptions (deploy drain, scale-in, the 6 h
 * recycle, heartbeat timeout after SIGKILL) must not use up ordinary stage
 * attempts. Drives the real runPipelineStage activity through a simulated
 * Temporal retry loop with the production retry budget.
 */
import { ApplicationFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import { markWorkerShuttingDown, resetWorkerShutdownForTests } from "../lib/worker-lifecycle.js";
import type { Document, StageState, WorkspaceRun } from "../models.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import { createActivities, toStageActivityFailure } from "../temporal/activities.js";
import { HUNG_WORK_TIMEOUT, WORKER_INTERRUPTED } from "../temporal/failure-classification.js";
import { STAGE_ORDINARY_ATTEMPTS, STAGE_THROTTLED_ATTEMPTS } from "../temporal/shared.js";
import { HungWorkError } from "../lib/hung-work.js";
import type { ArtifactStore } from "../tools/storage.js";

const run: WorkspaceRun = {
  id: "run-1", orgId: "org-1", userId: "user-1", workspaceId: "ws-1", kind: "bulk-upload",
  status: "processing", stage: "extract-markdown", totalDocuments: 1, processedDocuments: 0, pagesTotal: 400,
  pagesProcessed: 0, spentCents: 0, pipeline: defaultPipelineFeatures,
  error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
} as WorkspaceRun;
const document = {
  id: "doc-1", userId: "user-1", runId: "run-1", filename: "book.pdf", mimeType: "application/pdf",
  sourceKey: "raw/book.pdf", status: "processing", extractionMode: "hybrid", pageCount: 400,
  createdAt: new Date(), updatedAt: new Date(),
} as Document;

/** Stage checkpoints as workspace_run_stage_states keeps them, including stats.ordinaryFailures. */
class CheckpointStore {
  stages = new Map<string, StageState & { ordinaryFailures: number }>();
  readonly pageTasks = { completed: async () => new Map() };
  async loadRun() { return structuredClone(run); }
  async loadDocumentsForRun() { return [structuredClone(document)]; }
  async hydrateState(state: WorkflowState) {
    for (const checkpoint of this.stages.values()) state.setRunStage(checkpoint);
  }
  async renewHeartbeat() {}
  private upsert(stage: string, status: string, error = "") {
    const current = this.stages.get(stage);
    this.stages.set(stage, {
      runId: run.id, stageName: stage, status, attempts: (current?.attempts ?? 0) + (status === "processing" ? 1 : 0),
      artifactUri: "", stats: {}, error, startedAt: new Date(), completedAt: null, updatedAt: new Date(),
      ordinaryFailures: current?.ordinaryFailures ?? 0,
    } as StageState & { ordinaryFailures: number });
  }
  async startRunStage(_state: WorkflowState, stage: string) { this.upsert(stage, "processing"); }
  async completeRunStage(_state: WorkflowState, stage: string) { this.upsert(stage, "completed"); }
  async failRunStage(_state: WorkflowState, stage: string, message: string, options: { countFailure?: boolean } = {}) {
    this.upsert(stage, "failed", message);
    const checkpoint = this.stages.get(stage)!;
    checkpoint.ordinaryFailures += options.countFailure === false ? 0 : 1;
    return checkpoint.ordinaryFailures;
  }
  async updateProgress() {}
  async appendEvent() {}
  async completeRun() {}
  async failRun() {}
  async triggerRunEmails() {}
  async triggerWebhooks() {}
}

type Behavior = "deploy" | "recycle" | "sigkill" | "error" | "hang" | "succeed";

/**
 * One long stage whose attempt N behaves as `plan[N - 1]`. "deploy" waits for
 * Temporal's WORKER_SHUTDOWN cancellation after the drain grace, as a parser
 * still running at deploy time does.
 */
function harness(plan: Behavior[]) {
  const store = new CheckpointStore();
  let currentEnv: MockActivityEnvironment | null = null;
  const stage: Stage = {
    name: "extract-markdown",
    async run(_state, signal) {
      const attempt = currentEnv!.context.info.attempt;
      const behavior = plan[attempt - 1] ?? "succeed";
      if (behavior === "succeed") return;
      if (behavior === "error") throw new Error("pdf parser exited 1: corrupt xref");
      if (behavior === "hang") throw new HungWorkError("command-timeout", "pdftotext exceeded its 330 s wall-clock budget (400 pages)");
      if (behavior === "recycle") markWorkerShuttingDown("max-runtime");
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error(`subprocess aborted: ${String((signal.reason as Error)?.message ?? signal.reason)}`)), { once: true });
        // The machine stops partway through the stage.
        setTimeout(() => currentEnv!.cancel("WORKER_SHUTDOWN"), 5);
      });
    },
  };
  const activities = createActivities({
    store: store as unknown as Store,
    storage: {} as ArtifactStore,
    stages: [stage],
    config: { workerDocConcurrency: 1, workerAdaptiveTuning: false } as Config,
  });

  /** Temporal's side: retry until success, a non-retryable failure, or maximumAttempts. */
  async function drive(): Promise<{ outcome: "completed" | "failed"; attempts: Array<{ attempt: number; type?: string; nonRetryable?: boolean }> }> {
    const attempts: Array<{ attempt: number; type?: string; nonRetryable?: boolean }> = [];
    for (let attempt = 1; attempt <= STAGE_THROTTLED_ATTEMPTS; attempt++) {
      resetWorkerShutdownForTests();
      if (plan[attempt - 1] === "sigkill") {
        // SIGKILL after kill_timeout: no activity code runs to report a failure;
        // Temporal's heartbeat timeout schedules the next attempt. The stage
        // checkpoint is left "processing" by the previous start.
        await store.startRunStage({} as WorkflowState, "extract-markdown");
        attempts.push({ attempt, type: "HeartbeatTimeout", nonRetryable: false });
        continue;
      }
      currentEnv = new MockActivityEnvironment({ attempt });
      try {
        await currentEnv.run(activities.runPipelineStage, { stageName: "extract-markdown", runId: "run-1", totalStages: 1, artifacts: {} });
        attempts.push({ attempt });
        return { outcome: "completed", attempts };
      } catch (error) {
        const failure = error as ApplicationFailure;
        attempts.push({ attempt, type: failure.type ?? failure.name, nonRetryable: failure.nonRetryable ?? undefined });
        if (failure.nonRetryable) return { outcome: "failed", attempts };
      }
    }
    return { outcome: "failed", attempts };
  }
  return { drive, store };
}

afterEach(() => resetWorkerShutdownForTests());

describe("stage retries across infrastructure interruptions", () => {
  it("survives 3 deploys during one long stage and completes on the 4th attempt", async () => {
    const { drive, store } = harness(["deploy", "deploy", "deploy", "succeed"]);
    const result = await drive();
    expect(result.outcome).toBe("completed");
    expect(result.attempts.slice(0, 3)).toEqual([1, 2, 3].map((attempt) => ({ attempt, type: WORKER_INTERRUPTED, nonRetryable: false })));
    // Before OP-07, attempt 3 (>= STAGE_ORDINARY_ATTEMPTS) turned the interruption non-retryable.
    expect(STAGE_ORDINARY_ATTEMPTS).toBeLessThanOrEqual(3);
    expect(store.stages.get("extract-markdown")).toMatchObject({ status: "completed", ordinaryFailures: 0 });
  });

  it("still allows STAGE_ORDINARY_ATTEMPTS real failures after deploys, a recycle and a SIGKILL", async () => {
    const { drive, store } = harness(["deploy", "recycle", "sigkill", "error", "error", "succeed"]);
    const result = await drive();
    expect(result.outcome).toBe("completed");
    expect(result.attempts.map((attempt) => attempt.type)).toEqual([WORKER_INTERRUPTED, WORKER_INTERRUPTED, "HeartbeatTimeout", "Error", "Error", undefined]);
    expect(result.attempts.every((attempt) => attempt.nonRetryable !== true)).toBe(true);
    expect(store.stages.get("extract-markdown")?.ordinaryFailures).toBe(2);
  });

  it("stops after STAGE_ORDINARY_ATTEMPTS ordinary failures, counted from checkpoints", async () => {
    const { drive, store } = harness(["deploy", "error", "deploy", "error", "error", "succeed"]);
    const result = await drive();
    expect(result.outcome).toBe("failed");
    expect(result.attempts.at(-1)).toEqual({ attempt: 5, type: "Error", nonRetryable: true });
    expect(store.stages.get("extract-markdown")?.ordinaryFailures).toBe(STAGE_ORDINARY_ATTEMPTS);
  });

  it("fails hung work on the first timeout instead of retrying it", async () => {
    const { drive } = harness(["hang", "succeed"]);
    const result = await drive();
    expect(result.outcome).toBe("failed");
    expect(result.attempts).toEqual([{ attempt: 1, type: HUNG_WORK_TIMEOUT, nonRetryable: true }]);
  });

  it("passes server-requested cancellation through unchanged", () => {
    const cancelled = new Error("CANCELLED");
    expect(toStageActivityFailure(cancelled, { classification: "cancelled", attempt: 5, ordinaryAttemptLimit: 3 })).toBe(cancelled);
  });
});

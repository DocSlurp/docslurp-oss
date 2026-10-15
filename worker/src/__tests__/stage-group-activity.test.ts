/**
 * runPipelineStages (stage groups): a retry resumes at the first stage the
 * earlier attempt left unfinished, and a group yields between stages to a
 * pause or cancel request.
 */
import { MockActivityEnvironment } from "@temporalio/testing";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { describe, expect, it } from "vitest";

import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import type { Document, StageState, WorkspaceRun } from "../models.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import { createActivities } from "../temporal/activities.js";
import type { StageOutput } from "../temporal/shared.js";
import type { ArtifactStore } from "../tools/storage.js";

const run = {
  id: "run-1", orgId: "org-1", userId: "user-1", workspaceId: "ws-1", kind: "bulk-upload",
  status: "processing", stage: "embed", totalDocuments: 1, processedDocuments: 0, pagesTotal: 1,
  pagesProcessed: 0, spentCents: 0, pipeline: defaultPipelineFeatures,
  error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
} as WorkspaceRun;
const document = {
  id: "doc-1", userId: "user-1", runId: "run-1", filename: "a.pdf", mimeType: "application/pdf",
  sourceKey: "raw/a.pdf", status: "processing", extractionMode: "hybrid", pageCount: 1,
  createdAt: new Date(), updatedAt: new Date(),
} as Document;

class GroupStore {
  stages = new Map<string, StageState>();
  controlRequest = false;
  readonly pageTasks = { completed: async () => new Map() };
  async loadRun() { return structuredClone(run); }
  async loadDocumentsForRun() { return [structuredClone(document)]; }
  async hydrateState(state: WorkflowState) {
    for (const checkpoint of this.stages.values()) state.setRunStage(checkpoint);
  }
  async renewHeartbeat() {}
  private upsert(stage: string, status: string) {
    this.stages.set(stage, {
      runId: run.id, stageName: stage, status, attempts: 1, artifactUri: "", stats: {}, error: "",
      startedAt: new Date(), completedAt: null, updatedAt: new Date(),
    } as StageState);
  }
  async startRunStage(_state: WorkflowState, stage: string) { this.upsert(stage, "processing"); }
  async completeRunStage(_state: WorkflowState, stage: string) { this.upsert(stage, "completed"); }
  async failRunStage(_state: WorkflowState, stage: string) { this.upsert(stage, "failed"); return 1; }
  async updateProgress() {}
  async appendEvent() {}
  async completedRunStages(_runId: string, stages: readonly string[]) {
    return new Set(stages.filter((stage) => this.stages.get(stage)?.status === "completed"));
  }
  async hasRunControlRequest() { return this.controlRequest; }
}

function harness(failOnce: string | null) {
  const store = new GroupStore();
  const ran: string[] = [];
  let failed = false;
  const stage = (name: string): Stage => ({
    name,
    async run() {
      ran.push(name);
      if (name === failOnce && !failed) {
        failed = true;
        throw new Error(`${name} provider down`);
      }
    },
  });
  const activities = createActivities({
    store: store as unknown as Store,
    storage: {} as ArtifactStore,
    stages: ["embed", "index", "graph-enrich", "page-index"].map(stage),
    config: { workerDocConcurrency: 1, workerAdaptiveTuning: false } as Config,
  });
  const group = (attempt: number, yieldToControl = true): Promise<StageOutput> =>
    new MockActivityEnvironment({ attempt }).run(activities.runPipelineStages, {
      stageNames: ["embed", "index", "graph-enrich", "page-index"], runId: "run-1", totalStages: 4, artifacts: {}, yieldToControl,
    });
  return { store, ran, group };
}

describe("runPipelineStages", () => {
  it("resumes a retry after the stages the failed attempt completed", async () => {
    const { ran, group } = harness("page-index");
    await expect(group(1)).rejects.toThrow();
    expect(ran).toEqual(["embed", "index", "graph-enrich", "page-index"]);

    ran.length = 0;
    const output = await group(2);
    // graph-enrich has no document checkpoints; it must not repeat its model calls.
    expect(ran).toEqual(["page-index"]);
    expect(output.stagesRun).toBe(4);
  });

  it("reports every stage run when a retry finds the whole group completed", async () => {
    const { store, ran, group } = harness(null);
    for (const stage of ["embed", "index", "graph-enrich", "page-index"]) await store.completeRunStage({} as WorkflowState, stage);
    const output = await group(2);
    expect(ran).toEqual([]);
    expect(output.stagesRun).toBe(4);
  });

  it("runs every stage again on a first attempt (a run retried from the start)", async () => {
    const { store, ran, group } = harness(null);
    await store.completeRunStage({} as WorkflowState, "embed");
    await group(1);
    expect(ran).toEqual(["embed", "index", "graph-enrich", "page-index"]);
  });

  it("yields to a pause or cancel request after the first stage it runs", async () => {
    const { store, ran, group } = harness(null);
    store.controlRequest = true;
    const output = await group(1);
    expect(ran).toEqual(["embed"]);
    expect(output.stagesRun).toBe(1);
  });
});

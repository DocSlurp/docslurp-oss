import { describe, expect, it } from "vitest";
import {
  defaultPipelineFeatures,
  type WorkspaceRun,
  type WorkspaceRunStageState,
  type WorkspaceRunTemporal,
} from "@docslurp/shared";

import { buildProgressModule } from "../services/progress-snapshot.js";

function run(overrides: Partial<WorkspaceRun> = {}): WorkspaceRun {
  const now = new Date("2026-05-08T12:00:00.000Z").toISOString();
  return {
    id: "run-1",
    userId: "user-1",
    orgId: "org-1",
    workspaceId: "workspace-1",
    workspaceName: "Contracts",
    kind: "bulk-upload",
    status: "processing",
    priority: 0,
    controlState: null,
    controlRequestedAt: null,
    stage: "render-images",
    totalDocuments: 2,
    processedDocuments: 0,
    pagesTotal: 10,
    pagesProcessed: 3,
    costCents: 0,
    computeEstimated: false,
    billedCostCents: 0,
    pipeline: defaultPipelineFeatures,
    stats: {},
    artifacts: {},
    error: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function stageState(
  overrides: Partial<WorkspaceRunStageState>,
): WorkspaceRunStageState {
  return {
    runId: "run-1",
    documentId: null,
    stage: "quarantine",
    status: "queued",
    attempts: 0,
    artifactUri: null,
    stats: {},
    error: null,
    startedAt: null,
    completedAt: null,
    updatedAt: new Date("2026-05-08T12:00:00.000Z").toISOString(),
    ...overrides,
  };
}

function temporal(overrides: Partial<WorkspaceRunTemporal> = {}): WorkspaceRunTemporal {
  return {
    workflowId: "run-run-1",
    workflowRunId: "temporal-run-1",
    workflowStatus: "RUNNING",
    stage: "render-images",
    stageIndex: 7,
    totalStages: 16,
    historyLength: 24,
    historySizeBytes: 4096,
    startTime: "2026-05-08T12:00:00.000Z",
    executionTime: "2026-05-08T12:00:00.000Z",
    closeTime: null,
    elapsedMs: 30000,
    activityUsageTally: {
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
    },
    queriedAt: "2026-05-08T12:00:30.000Z",
    ...overrides,
  };
}

describe("buildProgressModule", () => {
  it("reports terminal completion despite stale checkpoint percentages and excess counters", () => {
    const progress = buildProgressModule({
      run: run({ status: "completed", pagesProcessed: 12, stats: { percentComplete: 65 } }),
      temporal: null, stages: [], pageProgress: {}, cpuUserMs: 0, cpuSystemMs: 0,
      rssDeltaBytes: 0, peakRssBytes: 0, inputTokens: 0, outputTokens: 0, costCents: 0,
    });
    expect(progress.percentComplete).toBe(100);
    expect(progress.pageRollup.completed).toBe(10);
  });

  it("builds lifecycle, stage, page, usage, and resource rollups", () => {
    const progress = buildProgressModule({
      run: run(),
      temporal: temporal(),
      stages: [
        stageState({
          stage: "quarantine",
          status: "completed",
          stats: { durationMs: 100 },
        }),
        stageState({
          documentId: "document-1",
          stage: "render-images",
          status: "processing",
          stats: { latencyMs: 42 },
        }),
        stageState({
          documentId: "document-2",
          stage: "render-images",
          status: "queued",
        }),
      ],
      pageProgress: {
        "document-1": {
          "render-images": 3,
        },
      },
      cpuUserMs: 12,
      cpuSystemMs: 7,
      rssDeltaBytes: 128,
      peakRssBytes: 2048,
      inputTokens: 1000,
      outputTokens: 120,
      costCents: 9,
    });

    expect(progress.lifecycleStatus).toBe("processing");
    expect(progress.currentStage).toBe("render-images");
    expect(progress.percentComplete).toBeGreaterThan(0);
    expect(progress.pageRollup.byStage["render-images"]).toBe(3);
    expect(progress.usageTotals).toMatchObject({
      inputTokens: 1000,
      outputTokens: 120,
      costCents: 9,
    });
    expect(progress.resourceTotals.cpuTotalMs).toBe(19);

    const quarantine = progress.stageRollups.find((stage) => stage.stage === "quarantine");
    expect(quarantine?.status).toBe("completed");
    expect(quarantine?.durationMs).toBe(100);

    const renderImages = progress.stageRollups.find((stage) => stage.stage === "render-images");
    expect(renderImages?.status).toBe("processing");
    expect(renderImages?.documents).toMatchObject({
      processing: 1,
      queued: 1,
      total: 2,
    });
    expect(renderImages?.latencyMs).toBe(42);
  });

  it("treats terminal Temporal failure as failed progress", () => {
    const progress = buildProgressModule({
      run: run({ status: "processing", stage: "extract-markdown" }),
      temporal: temporal({
        workflowStatus: "FAILED",
        stage: "extract-markdown",
        closeTime: "2026-05-08T12:01:00.000Z",
      }),
      stages: [],
      pageProgress: {},
      cpuUserMs: 0,
      cpuSystemMs: 0,
      rssDeltaBytes: 0,
      peakRssBytes: 0,
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
    });

    expect(progress.lifecycleStatus).toBe("failed");
    expect(progress.stageRollups.find((stage) => stage.stage === "extract-markdown")?.status).toBe("failed");
  });
  it("keeps enrichment stages a run moved after index queued while embed and index run", () => {
    const pipeline = { ...defaultPipelineFeatures, summarize: true };
    const base = {
      pageProgress: {}, cpuUserMs: 0, cpuSystemMs: 0, rssDeltaBytes: 0, peakRssBytes: 0,
      inputTokens: 0, outputTokens: 0, costCents: 0,
    };
    const embedding = buildProgressModule({
      ...base,
      run: run({ pipeline, stage: "embed" }),
      temporal: temporal({ stage: "embed" }),
      stages: [stageState({ stage: "vision-extract", status: "completed" }), stageState({ stage: "embed", status: "processing" })],
    });
    const tone = (module: typeof embedding, stage: string) => module.stageRollups.find((rollup) => rollup.stage === stage)?.status;
    expect(tone(embedding, "document-summary")).toBe("queued");
    expect(tone(embedding, "embed")).toBe("processing");
    expect(embedding.expectedStages.slice(-3)).toEqual(["embed", "index", "document-summary"]);

    // Canonical order: the summary ran before embed, so it has rows and stays where it was.
    const canonical = buildProgressModule({
      ...base,
      run: run({ pipeline, stage: "embed" }),
      temporal: temporal({ stage: "embed" }),
      stages: [stageState({ stage: "document-summary", status: "completed" }), stageState({ stage: "embed", status: "processing" })],
    });
    expect(tone(canonical, "document-summary")).toBe("completed");
    expect(canonical.expectedStages.slice(-3)).toEqual(["document-summary", "embed", "index"]);
  });
});

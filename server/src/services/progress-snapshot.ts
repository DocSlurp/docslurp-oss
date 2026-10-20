import {
  compilePipelinePlan,
  inferExecutionStageOrder,
  getPipelineStageLabel,
  type RunStage,
  type WorkspaceRun,
  type WorkspaceRunLifecycleStatus,
  type WorkspaceRunProgressModule,
  type WorkspaceRunProgressTone,
  type WorkspaceRunStageState,
  type WorkspaceRunTemporal,
} from "@docslurp/shared";

type StageAggregate = {
  completed: number;
  failed: number;
  processing: number;
  queued: number;
  documentsCompleted: number;
  documentsFailed: number;
  documentsProcessing: number;
  documentsQueued: number;
  documentsTotal: number;
};

export type ProgressSnapshotPageProgress = Record<string, Record<string, number>>;

export type ProgressSnapshotInput = {
  run: WorkspaceRun;
  stages: WorkspaceRunStageState[];
  temporal: WorkspaceRunTemporal | null;
  pageProgress: ProgressSnapshotPageProgress;
  cpuUserMs: number;
  cpuSystemMs: number;
  rssDeltaBytes: number;
  peakRssBytes: number;
  /** Per-stage worker CPU (ms) and RSS high-water mark (bytes), keyed by stage name. */
  stageResources?: Record<string, { cpuMs: number; peakRssBytes: number }>;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  billedCostCents?: number;
  aiCostCents?: number;
  selfHostedCostCents?: number;
  selfHostedListCents?: number;
  feeCostCents?: number;
  computeCostCents?: number;
  computeEstimated?: boolean;
  workerClasses?: string[];
  regions?: string[];
};

function lifecycleStatus(
  run: WorkspaceRun,
  temporal: WorkspaceRunTemporal | null,
): WorkspaceRunLifecycleStatus {
  const temporalStatus = temporal?.workflowStatus ?? null;
  if (temporalStatus === "PAUSED") {
    return "paused";
  }

  if (temporalStatus === "RUNNING") {
    return run.status === "queued" ? "queued" : "processing";
  }

  if (temporalStatus === "COMPLETED") {
    return "completed";
  }

  if (
    temporalStatus === "FAILED" ||
    temporalStatus === "TIMED_OUT" ||
    temporalStatus === "TERMINATED" ||
    temporalStatus === "CANCELLED"
  ) {
    return "failed";
  }

  return run.status === "blocked" ? "queued" : run.status;
}

function aggregateStageStates(stages: WorkspaceRunStageState[]): Map<RunStage, StageAggregate> {
  const map = new Map<RunStage, StageAggregate>();

  for (const stage of stages) {
    const current = map.get(stage.stage) ?? {
      completed: 0,
      failed: 0,
      processing: 0,
      queued: 0,
      documentsCompleted: 0,
      documentsFailed: 0,
      documentsProcessing: 0,
      documentsQueued: 0,
      documentsTotal: 0,
    };

    current[stage.status] += 1;

    if (stage.documentId) {
      current.documentsTotal += 1;

      if (stage.status === "completed") {
        current.documentsCompleted += 1;
      } else if (stage.status === "failed") {
        current.documentsFailed += 1;
      } else if (stage.status === "processing") {
        current.documentsProcessing += 1;
      } else {
        current.documentsQueued += 1;
      }
    }

    map.set(stage.stage, current);
  }

  return map;
}

function stageTone(args: {
  stage: RunStage;
  status: WorkspaceRunLifecycleStatus;
  currentStage: RunStage;
  expectedStages: RunStage[];
  aggregates: Map<RunStage, StageAggregate>;
}): WorkspaceRunProgressTone {
  if (args.status === "completed") {
    return "completed";
  }

  const aggregate = args.aggregates.get(args.stage);
  if (aggregate && aggregate.failed > 0) {
    return "failed";
  }

  if (args.status === "failed" && args.currentStage === args.stage) {
    return "failed";
  }

  const stageIndex = args.expectedStages.indexOf(args.stage);
  const currentStageIndex = args.expectedStages.indexOf(args.currentStage);

  if (aggregate && aggregate.documentsTotal > 0) {
    if (aggregate.documentsCompleted === aggregate.documentsTotal) {
      return "completed";
    }

    if (aggregate.documentsProcessing > 0 || aggregate.documentsCompleted > 0) {
      return "processing";
    }
  }

  if ((args.status === "processing" || args.status === "paused") && args.currentStage === args.stage) {
    return "processing";
  }

  if (stageIndex > -1 && currentStageIndex > -1 && stageIndex < currentStageIndex) {
    return "completed";
  }

  return "queued";
}

function sumStageMetric(
  stages: WorkspaceRunStageState[],
  stage: RunStage,
  key: string,
): number {
  return stages.reduce((total, stageState) => {
    if (stageState.stage !== stage) {
      return total;
    }

    const value = stageState.stats?.[key];
    return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
}

export function buildProgressModule(args: ProgressSnapshotInput): WorkspaceRunProgressModule {
  const compiledPlan = compilePipelinePlan(args.run.pipeline);
  const aggregates = aggregateStageStates(args.stages);
  const status = lifecycleStatus(args.run, args.temporal);
  const currentStage = args.temporal?.stage ?? args.run.stage;
  // Execution order (index may run before enrichment), so stages the run moved
  // later are not shown completed while earlier stages run.
  const expectedStages: RunStage[] = inferExecutionStageOrder(compiledPlan.stageOrder, {
    hasState: (stage) => aggregates.has(stage as RunStage),
    currentStage,
  });
  const currentStageIndex = expectedStages.indexOf(currentStage);
  const pagesTotal = Math.max(args.run.pagesTotal, 0);
  const byStage: Record<string, number> = {};

  for (const progressByStage of Object.values(args.pageProgress)) {
    for (const [stage, completedPages] of Object.entries(progressByStage)) {
      byStage[stage] = (byStage[stage] ?? 0) + completedPages;
    }
  }

  const tones = new Map<RunStage, WorkspaceRunProgressTone>();
  for (const stage of expectedStages) {
    tones.set(
      stage,
      stageTone({
        stage,
        status,
        currentStage,
        expectedStages,
        aggregates,
      }),
    );
  }

  const completedStages =
    status === "completed"
      ? expectedStages.length
      : expectedStages.filter((stage) => tones.get(stage) === "completed").length;

  const stageRollups = expectedStages.map((stage) => {
    const tone = tones.get(stage) ?? "queued";
    const liveCompletedPages = Math.min(byStage[stage] ?? 0, pagesTotal);
    const completedPages = tone === "completed" ? pagesTotal : Math.max(0, liveCompletedPages);
    const aggregate = aggregates.get(stage);

    return {
      stage,
      label: getPipelineStageLabel(stage),
      status: tone,
      completedPages,
      totalPages: pagesTotal,
      pageRatio: pagesTotal > 0 ? Math.min(1, completedPages / pagesTotal) : tone === "completed" ? 1 : 0,
      documents: {
        completed: aggregate?.documentsCompleted ?? 0,
        processing: aggregate?.documentsProcessing ?? 0,
        failed: aggregate?.documentsFailed ?? 0,
        queued: Math.max(
          aggregate?.documentsQueued ??
            Math.max(
              (aggregate?.documentsTotal ?? 0) -
                (aggregate?.documentsCompleted ?? 0) -
                (aggregate?.documentsProcessing ?? 0) -
                (aggregate?.documentsFailed ?? 0),
              0,
            ),
          0,
        ),
        total: Math.max(aggregate?.documentsTotal ?? 0, args.run.totalDocuments),
      },
      durationMs: sumStageMetric(args.stages, stage, "durationMs"),
      latencyMs: sumStageMetric(args.stages, stage, "latencyMs"),
      inputTokens: sumStageMetric(args.stages, stage, "inputTokens"),
      outputTokens: sumStageMetric(args.stages, stage, "outputTokens"),
      costCents: sumStageMetric(args.stages, stage, "costCents"),
      cpuMs: args.stageResources?.[stage]?.cpuMs ?? 0,
      peakRssBytes: args.stageResources?.[stage]?.peakRssBytes ?? 0,
    };
  });

  const hasPageProgress = stageRollups.some(
    (rollup) => rollup.completedPages > 0 && rollup.status !== "completed",
  );
  const percentComplete = status === "completed" ? 100 :
    typeof args.run.stats?.percentComplete === "number" && Number.isFinite(args.run.stats.percentComplete)
      ? Math.max(0, Math.min(100, Math.round(args.run.stats.percentComplete)))
      : status === "queued"
          ? 0
          : hasPageProgress
            ? Math.round(
                (stageRollups.reduce((total, rollup) => total + rollup.pageRatio, 0) /
                  Math.max(stageRollups.length, 1)) *
                  100,
              )
            : Math.round((completedStages / Math.max(expectedStages.length, 1)) * 100);

  const phases = compiledPlan.phases
    .map((phase) => {
      const phaseStages = phase.stages;
      const completedPhaseStages = phaseStages.filter((stage) => tones.get(stage) === "completed").length;
      const phaseStatus: WorkspaceRunProgressTone = phaseStages.some((stage) => tones.get(stage) === "failed")
        ? "failed"
        : completedPhaseStages === phaseStages.length
          ? "completed"
          : phaseStages.some((stage) => tones.get(stage) === "processing")
            ? "processing"
            : "queued";

      return {
        key: phase.key,
        label: phase.label,
        stages: phaseStages,
        status: phaseStatus,
        completedStages: completedPhaseStages,
        totalStages: phaseStages.length,
      };
    })
    .filter((phase) => phase.totalStages > 0);

  return {
    lifecycleStatus: status,
    currentStage,
    currentStageLabel: getPipelineStageLabel(currentStage),
    currentStageIndex: currentStageIndex > -1 ? currentStageIndex : null,
    currentStagePosition:
      status === "completed" ? expectedStages.length : currentStageIndex > -1 ? currentStageIndex + 1 : null,
    expectedStages,
    completedStages,
    totalStages: expectedStages.length,
    percentComplete,
    phases,
    stageRollups,
    pageRollup: {
      completed: Math.min(pagesTotal, Math.max(args.run.pagesProcessed, 0)),
      total: pagesTotal,
      byStage,
      byDocument: args.pageProgress,
    },
    usageTotals: {
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      costCents: args.costCents,
      billedCostCents: args.billedCostCents ?? args.costCents,
      aiCostCents: args.aiCostCents ?? 0,
      selfHostedCostCents: args.selfHostedCostCents ?? 0,
      selfHostedListCents: args.selfHostedListCents ?? 0,
      feeCostCents: args.feeCostCents ?? 0,
      computeCostCents: args.computeCostCents ?? 0,
      computeEstimated: args.computeEstimated ?? false,
      workerClasses: args.workerClasses ?? [],
      regions: args.regions ?? [],
    },
    resourceTotals: {
      elapsedMs: args.temporal?.elapsedMs ?? 0,
      cpuUserMs: args.cpuUserMs,
      cpuSystemMs: args.cpuSystemMs,
      cpuTotalMs: args.cpuUserMs + args.cpuSystemMs,
      rssDeltaBytes: args.rssDeltaBytes,
      peakRssBytes: args.peakRssBytes,
    },
  };
}

import {
  CHAT_MODEL_PRICES_USD_PER_MTOK,
  customerPipelineView,
  DEFAULT_PIPELINE_TEXT_MODEL,
  defaultPipelineFeatures,
  embeddingProfileCatalog,
  supportedEmbeddingModels,
  visionModelCatalog,
} from "@docslurp/shared";
import { CHAT_TIER_MODELS, PROJECT_CHAT_MODELS } from "@docslurp/shared/project-chat-models";
import {
  compilePipelinePlan,
  inferExecutionStageOrder,
  getPipelineStageLabel,
  type RunStage,
  type ProjectRun,
  type ProjectRunLifecycleStatus,
  type ProjectRunProgressModule,
  type ProjectRunProgressSnapshot,
  type ProjectRunProgressTone,
  type ProjectRunStageState,
  type ProjectRunTemporal,
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
  run: ProjectRun;
  stages: ProjectRunStageState[];
  temporal: ProjectRunTemporal | null;
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

function lifecycleStatus(run: ProjectRun): ProjectRunLifecycleStatus {
  // A diagnostic executor snapshot may be stale or from a prior generation.
  // Only persisted owner state can establish completion, failure or a pause.
  if ((run.status === "queued" || run.status === "processing") && run.controlState === "paused") return "paused";
  return run.status === "blocked" ? "queued" : run.status;
}

function aggregateStageStates(stages: ProjectRunStageState[]): Map<RunStage, StageAggregate> {
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
  status: ProjectRunLifecycleStatus;
  currentStage: RunStage;
  expectedStages: RunStage[];
  aggregates: Map<RunStage, StageAggregate>;
}): ProjectRunProgressTone {
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
  stages: ProjectRunStageState[],
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

export function buildProgressModule(args: ProgressSnapshotInput): ProjectRunProgressModule {
  const compiledPlan = compilePipelinePlan(args.run.pipeline);
  const aggregates = aggregateStageStates(args.stages);
  const status = lifecycleStatus(args.run);
  const currentStage = args.run.stage;
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

  const tones = new Map<RunStage, ProjectRunProgressTone>();
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
      const phaseStatus: ProjectRunProgressTone = phaseStages.some((stage) => tones.get(stage) === "failed")
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

/**
 * Keys that describe the worker machine rather than the customer's run: CPU and RAM (`cpuUserMs`, `rssBytes`, `peakRssMb`),
 * the machine, the worker and its settings (`workerClass`, `workerId`), and the region it ran in (`region`, `regions`).
 * Layout `regionBoxes` and the like are the customer's data and stay.
 */
const OPERATOR_KEY = /^(?:cpu|rss|peakRss|machine|worker|flyRegion|regions?$)/i;
/** Nesting below which the walk stops and drops the subtree, so a hostile or runaway structure cannot hide a key. */
const OPERATOR_KEY_MAX_DEPTH = 12;

/** `value` without operator keys at any depth. Returns a copy; a subtree nested deeper than the limit is dropped (fail closed). */
export function redactOperatorKeys<T>(value: T, depth = 0): T {
  if (value === null || typeof value !== "object") return value;
  if (depth >= OPERATOR_KEY_MAX_DEPTH) return null as T;
  if (Array.isArray(value)) return value.map((item) => redactOperatorKeys(item, depth + 1)) as T;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !OPERATOR_KEY.test(key))
      .map(([key, item]) => [key, redactOperatorKeys(item, depth + 1)]),
  ) as T;
}

/** A run event for a caller that is not a platform operator: heartbeat metrics, stats and progress without worker diagnostics. */
export function redactOperatorEvent<E extends { progress?: unknown; stats?: unknown; payload?: unknown }>(event: E): E {
  // Customers never see backend models in events either (the routing stage's decisionModel and its decision trace, a
  // provider error's message): every field loses model keys and model ids, and the stat fields lose operator keys.
  const redacted = redactModelKeys(event);
  for (const field of ["progress", "stats", "payload"] as const) if (field in redacted) redacted[field] = redactOperatorKeys(redacted[field]) as E[typeof field];
  return redacted;
}

/**
 * Keys that name, describe or count a backend model or provider: kept for platform operators, removed for customers.
 * Fail-closed by name: any key containing "model" or "provider" goes (embeddingModel, servedModel, decisionChain's
 * models, providerCostUsd...), plus the router's free-text note and decision traces, which carry model ids in values.
 */
const MODEL_KEY = /model|provider|^(?:decisionChain|decisionServedBy|routerNote|remoteFallback\w*)$/i;

/** Model ids DocSlurp can call (chat, pipeline defaults, embedding and vision catalogs), as they may appear in text. */
const CUSTOMER_HIDDEN_MODEL_IDS: readonly string[] = (() => {
  const ids = new Set<string>();
  const add = (raw: string) => {
    const value = raw.trim();
    if (!value || /\s/.test(value)) return;
    const bare = value.startsWith("llm://") ? value.slice("llm://".length).split("/").slice(1).join("/") : value;
    for (const id of [value, bare, bare.replace(/:[a-z-]+$/i, "")]) {
      if (id.length >= 5) ids.add(id.toLowerCase());
      const tail = id.split("/").at(-1) ?? "";
      // The vendor-less name ("gpt-6-luna"), when it is distinctive enough not to match ordinary words.
      if (tail.length >= 6 && /\d/.test(tail)) ids.add(tail.toLowerCase());
    }
  };
  const walk = (value: unknown, key = "", depth = 0): void => {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === "string") { if (/model|uri/i.test(key) || value.startsWith("llm://")) add(value); return; }
    if (Array.isArray(value)) { for (const item of value) walk(item, key, depth + 1); return; }
    if (typeof value === "object") for (const [k, item] of Object.entries(value)) walk(item, k, depth + 1);
  };
  for (const model of PROJECT_CHAT_MODELS) add(model.id);
  for (const model of Object.values(CHAT_TIER_MODELS) as string[]) add(model);
  for (const model of Object.keys(CHAT_MODEL_PRICES_USD_PER_MTOK)) add(model);
  for (const model of supportedEmbeddingModels) add(model);
  for (const model of visionModelCatalog) { add(model.id); add(model.uri); }
  walk(embeddingProfileCatalog);
  walk(defaultPipelineFeatures);
  add(DEFAULT_PIPELINE_TEXT_MODEL);
  // Longest first, so a full id is replaced before its vendor-less tail.
  return [...ids].sort((a, b) => b.length - a.length);
})();

const MODEL_ID_PATTERN = new RegExp(CUSTOMER_HIDDEN_MODEL_IDS.map((id) => id.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|"), "gi");

/** A string with any catalog model id replaced by a neutral word. */
export function redactModelIdsInText(text: string): string {
  return text.replace(MODEL_ID_PATTERN, "managed-model");
}

/** The catalog model ids customers must never see (tests walk customer payloads against it). */
export function customerHiddenModelIds(): readonly string[] {
  return CUSTOMER_HIDDEN_MODEL_IDS;
}

/**
 * Removes backend model and provider keys from a stats structure, at any depth (bounded like redactOperatorKeys), and
 * replaces any catalog model id left inside a string value (an error message, a note) with a neutral word.
 */
export function redactModelKeys<T>(value: T, depth = 0): T {
  if (typeof value === "string") return redactModelIdsInText(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (depth >= OPERATOR_KEY_MAX_DEPTH) return null as T;
  if (Array.isArray(value)) return value.map((item) => redactModelKeys(item, depth + 1)) as T;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !MODEL_KEY.test(key))
      .map(([key, item]) => [key, redactModelKeys(item, depth + 1)]),
  ) as T;
}

/**
 * A run as customers read it: operator machine stats removed, backend model and provider keys and model ids removed from
 * every field (stats, error text), and the managed model fields removed from its pipeline snapshot
 * (managed-pipeline-models.ts).
 */
export function redactOperatorRun<R extends { stats?: unknown; pipeline?: unknown }>(run: R): R {
  const { pipeline, ...rest } = run as R & Record<string, unknown>;
  const out = redactModelKeys(rest) as R;
  if ("stats" in run) out.stats = redactOperatorKeys(out.stats);
  if ("pipeline" in run) out.pipeline = pipeline ? customerPipelineView(pipeline) : pipeline;
  return out;
}

/**
 * Platform-operator-only diagnostics: worker CPU and RAM per run, stage and event, and which worker classes and regions
 * served it. Customers (including org owners and admins) see cost, speed and page counts, not the machines behind them, so
 * this is removed on the server for every caller that is not a platform operator rather than hidden in a client: from the
 * snapshot's stats, rollups and totals, and by key from the heartbeat events, stage stats and run stats it carries.
 * Returns a copy; the input is not mutated.
 */
export function redactOperatorRunFields(snapshot: ProjectRunProgressSnapshot): ProjectRunProgressSnapshot {
  const progress = snapshot.progress && {
    ...snapshot.progress,
    stageRollups: snapshot.progress.stageRollups.map((rollup) => ({ ...rollup, cpuMs: 0, peakRssBytes: 0 })),
    usageTotals: { ...snapshot.progress.usageTotals, workerClasses: [], regions: [] },
    resourceTotals: { ...snapshot.progress.resourceTotals, cpuUserMs: 0, cpuSystemMs: 0, cpuTotalMs: 0, rssDeltaBytes: 0, peakRssBytes: 0 },
  };
  return {
    ...snapshot,
    run: redactOperatorRun(snapshot.run),
    stages: snapshot.stages.map((stage) => {
      const redacted = redactModelKeys(stage);
      return { ...redacted, stats: redactOperatorKeys(redacted.stats) };
    }),
    recentEvents: snapshot.recentEvents.map(redactOperatorEvent),
    stats: redactOperatorKeys(redactModelKeys(snapshot.stats)),
    progress: redactModelKeys(progress),
  };
}

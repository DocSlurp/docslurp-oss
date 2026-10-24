import { reportException, initializeWorkerErrorReporting } from "@docslurp/shared/error-reporting";
import type { PreloadedRunState } from "../db/store.js";
import { extendDbTraceLabel } from "../lib/db-trace.js";
import { compilePipelinePlan, deferredProfilesEnabled, getPipelineStageOrder } from "@docslurp/shared";
import { withObservation, flushObservability } from "@docslurp/shared/observability";
import { ApplicationFailure } from "@temporalio/common";

import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import { captureProcessStats, pushProcessStatsDelta } from "../lib/perf-context.js";
import type {
  CompleteRunInput,
  FailRunInput,
  InitRunInput,
  InitRunOutput,
  StageInput,
  StageOutput,
  UsageSummary,
} from "../temporal/shared.js";
import {
  applyAdaptiveStageTuning,
  adaptiveTuningPerformanceEvents,
  resolveAdaptiveStageTuning,
} from "./adaptive-tuning.js";
import { forecastRunCost } from "./cost-forecast.js";
import {
  buildLocalComputePerformanceEvents,
  buildLocalComputeUsageEvent,
  buildAllocatedResourceObservation,
  resolveWorkerDeploymentProfile,
} from "./local-compute-cost.js";
import { hasFailedDocumentStage } from "./document-health.js";
import { WorkflowState, type Stage } from "./pipeline.js";
import { HungWorkError } from "../lib/hung-work.js";
import { runWithPrivacyAuditScope } from "../lib/privacy-guard.js";
import { ProgressTracker, resolveStageStallTimeoutMs, runWithProgressTracker } from "../lib/work-progress.js";
import {
  buildRunCompletedEvent,
  buildRunProgressEvent,
  buildRunStartedEvent,
} from "./run-ledger.js";

/**
 * Stage Execution: load a Run, run one stage with full lifecycle bookkeeping,
 * and report the outcome. Orchestrator-agnostic: Temporal activities are thin
 * adapters that inject heartbeat, cancellation, and attempt number.
 */

/** The narrow slice of the worker Store that stage execution needs. */
export type StageExecutionStore = Pick<
  Store,
  | "loadRun"
  | "loadDocumentsForRun"
  | "hydrateState"
  | "renewHeartbeat"
  | "startRunStage"
  | "completeRunStage"
  | "failRunStage"
  | "updateProgress"
  | "appendEvent"
  | "completeRun"
  | "failRun"
  | "currentRunStage"
  | "triggerRunEmails"
  | "triggerWebhooks"
  | "seedReusedStageOutputs"
  | "finishShard"
> & {
  readonly pageTasks: Pick<Store["pageTasks"], "completed">;
};

/** Orchestrator hooks injected per stage execution. */
export interface StageRuntime {
  signal: AbortSignal;
  heartbeat(details: Record<string, unknown>): void;
  attempt?: number;
  /** Defaults to 30s. */
  heartbeatIntervalMs?: number;
  /**
   * Orchestrator failure classes (temporal/failure-classification.ts).
   * Interruptions and cancellations leave no failure checkpoint; only
   * "ordinary" (and "hung") failures count toward the stage's ordinary
   * failure total. Defaults to message matching (isWorkerInterruption).
   */
  classifyError?(error: unknown): StageFailureClass;
  /** No progress for this long fails the stage as hung (default WORKER_STAGE_STALL_TIMEOUT_MS, 30 min). */
  stallTimeoutMs?: number;
  /** Count this process's CPU time as progress (default true; tests turn it off). */
  progressFromProcessCpu?: boolean;
  /**
   * Run the stage for these documents only, as one shard beside others. The
   * shard checkpoints its documents and merges its artifacts and cost into the
   * run row, but leaves the run-stage checkpoint (start, completion, failure)
   * to the unsharded stage activity that follows the shards.
   */
  documentIds?: readonly string[];
  /**
   * Read the run's pause/cancel request in the stage-completion checkpoint and report it as
   * StageOutput.controlRequested, so a stage group does not spend a round trip asking between stages.
   */
  readControlState?: boolean;
  /**
   * Read the next stage's opening reads (run, documents, checkpoints) in the stage-completion checkpoint
   * and report them as StageOutput.preloaded; a stage group passes them to its next stage as `preloaded`.
   */
  preloadRunState?: boolean;
  preloaded?: PreloadedRunState;
  /** Called after a failure checkpoint with the stage's ordinary failure total. */
  onStageFailure?(failure: { classification: StageFailureClass; ordinaryFailures: number | undefined }): void;
}

export type StageFailureClass = "interruption" | "cancelled" | "throttled" | "hung" | "ordinary";

export type LoadRunOptions = {
  /** Fixed, or derived from the loaded run (e.g. its pipeline's stage count). */
  totalStages?: number | ((run: WorkflowState["run"]) => number);
  /** Hydrate stage checkpoints from the store (default true). */
  hydrate?: boolean;
  /** Apply the worker's configured document concurrency. */
  docConcurrency?: number;
  /** Workflow-accumulated artifacts that fill gaps in the persisted Run (DB wins). */
  artifacts?: Record<string, string>;
  /** The run, documents and checkpoints already read at the previous stage's completion (same activity). */
  preloaded?: PreloadedRunState;
};

/**
 * With DOCSLURP_DEFERRED_PROFILES off, a stored `map`/`visual` pipeline runs as
 * `full`, so the deferred stages never execute locator-only.
 */
export function coerceIndexingModeForFlag<T extends { pipeline: { indexingMode?: string } }>(run: T, enabled = deferredProfilesEnabled()): T {
  if (!enabled && run.pipeline && run.pipeline.indexingMode && run.pipeline.indexingMode !== "full") {
    run.pipeline = { ...run.pipeline, indexingMode: "full" };
  }
  return run;
}

/** The one Run hydration path for every activity entry point. */
export async function loadRunState(
  store: Pick<StageExecutionStore, "loadRun" | "loadDocumentsForRun" | "hydrateState"> & {
    /** Reads the run's stage checkpoints so they travel beside the run and document reads. */
    readStageStates?(runId: string): Promise<unknown>;
  },
  runId: string,
  options: LoadRunOptions = {},
): Promise<WorkflowState> {
  // The checkpoint read needs only the run id: issue it with the other two reads (one
  // round trip on separate pooled connections instead of two in sequence).
  const stageStates = options.preloaded
    ? Promise.resolve(options.preloaded.stageStates)
    : options.hydrate !== false ? store.readStageStates?.(runId) : undefined;
  stageStates?.catch(() => undefined);
  const [run, documents] = options.preloaded
    ? [options.preloaded.run, options.preloaded.documents]
    : await Promise.all([store.loadRun(runId), store.loadDocumentsForRun(runId)]);
  const state = WorkflowState.create(coerceIndexingModeForFlag(run), documents);
  if (options.docConcurrency !== undefined) state.docConcurrency = options.docConcurrency;
  if (options.totalStages !== undefined) {
    state.totalStages = typeof options.totalStages === "function" ? options.totalStages(state.run) : options.totalStages;
  }
  for (const [key, value] of Object.entries(options.artifacts ?? {})) {
    if (!state.artifactLedger.read(key)) {
      state.artifactLedger.record(key, value);
    }
  }
  if (options.hydrate !== false) await (stageStates ? (store.hydrateState as (state: WorkflowState, stageStates?: unknown) => Promise<void>)(state, stageStates) : store.hydrateState(state));
  return state;
}

export function isWorkerInterruption(message: string): boolean {
  return (
    message === "WORKER_SHUTDOWN" ||
    message.includes("Worker is shutting down") ||
    message.includes("activity did not complete in time")
  );
}

export function createStageExecution(deps: {
  store: StageExecutionStore;
  stages: Stage[];
  config: Config;
}) {
  const { store, config } = deps;
  const stageMap = new Map(deps.stages.map((s) => [s.name, s]));

  /**
   * Partial runs (restartFromStage / stageSubset) skip the plan's reused
   * stages; their outputs are copied from each document's source version
   * before anything loads the Run, so executed stages read them as if this
   * run had produced them. Nothing is executed or billed for reused stages.
   */
  async function seedReusedStages(runId: string, plan: ReturnType<typeof compilePipelinePlan>): Promise<void> {
    const seeded = await store.seedReusedStageOutputs(runId, plan.reusedStages);
    if (seeded.unavailable.length > 0) {
      const details = seeded.unavailable.slice(0, 5).map((gap) => `${gap.documentId} ${gap.reason}`).join("; ");
      // Not retryable: the source outputs will not come back.
      throw ApplicationFailure.nonRetryable(
        `partial run ${runId} cannot reuse ${plan.reusedStages.join(",")}: ${details}. Reprocess every stage instead.`,
        "PartialRunSourceUnavailable",
      );
    }
    console.log(
      `[temporal] run=${runId} partial plan stages=${plan.stageOrder.join(",")} ` +
        `reused=${plan.reusedStages.join(",")} seededDocs=${seeded.seededDocuments}`,
    );
  }

  /**
   * Begin a Run: hydrate checkpoints, mark it processing, log the cost
   * forecast and resume state, and emit run.started.
   */
  async function startRun(input: InitRunInput): Promise<InitRunOutput> {
    const loadOptions = { docConcurrency: config.workerDocConcurrency, hydrate: false };
    // Checkpoints are read beside the run and documents; seeding reused stages rewrites them, so
    // a partial run reads them again afterwards.
    const prefetch = (store as { readStageStates?(runId: string): Promise<unknown> }).readStageStates;
    let stageStates = prefetch?.call(store, input.runId);
    stageStates?.catch(() => undefined);
    let state = await loadRunState(store, input.runId, loadOptions);
    const plan = compilePipelinePlan(state.run.pipeline);
    if (plan.reusedStages.length > 0) {
      await seedReusedStages(input.runId, plan);
      state = await loadRunState(store, input.runId, loadOptions);
      stageStates = undefined;
    }
    await (stageStates
      ? (store.hydrateState as (state: WorkflowState, stageStates?: unknown) => Promise<void>)(state, stageStates)
      : store.hydrateState(state));
    const { run, documents } = state;

    // Mark run as processing
    state.run.status = "processing";
    state.totalStages = input.totalStages;
    state.refreshStats();
    await store.updateProgress(state);

    // Log cost forecast
    const forecast = forecastRunCost(documents, state.run.pipeline);
    const completedRunStages = Array.from(state.runStages.values())
      .filter((s) => s.status === "completed")
      .map((s) => s.stageName);
    const completedDocStages = Array.from(state.documentStages.entries()).flatMap(
      ([docId, stages]) =>
        Array.from(stages.values())
          .filter((s) => s.status === "completed")
          .map((s) => `${docId}:${s.stageName}`),
    );
    console.log(
      `[temporal] run=${run.id} status=init docs=${documents.length} ` +
        `minCents=${forecast.minCents} maxCents=${forecast.maxCents} ` +
        `completedRunStages=${completedRunStages.length} completedDocStages=${completedDocStages.length} ` +
        `artifactKeys=${Object.keys(state.artifacts).length}`,
    );
    if (completedRunStages.length > 0) {
      console.log(
        `[temporal-debug] run=${run.id} resumedRunStages=${completedRunStages.join(",")}`,
      );
    }
    if (completedDocStages.length > 0) {
      console.log(
        `[temporal-debug] run=${run.id} resumedDocStages=${completedDocStages.slice(0, 20).join(",")}${completedDocStages.length > 20 ? "..." : ""}`,
      );
    }

    // Log start event
    await store.appendEvent(
      buildRunStartedEvent(state, "temporal workflow started"),
    );

    return {
      documentIds: documents.map((d) => d.id),
      artifacts: { ...state.artifacts },
      documentPages: documents.map((d) => Math.max(1, d.pageCount || 1)),
      documentMimeTypes: documents.map((d) => d.mimeType ?? ""),
    };
  }

  /**
   * Run a single pipeline stage. Loads state from DB, merges accumulated
   * artifacts, executes the stage, flushes progress, and returns outputs.
   * A failed stage is checkpointed as failed and rethrown; worker
   * interruptions are rethrown without a failure checkpoint so a retry resumes.
   */
  function runStage(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
    return extendDbTraceLabel(input.stageName, () => runStageUntraced(input, runtime));
  }

  async function runStageUntraced(input: StageInput, runtime: StageRuntime): Promise<StageOutput> {
    const { stageName, runId, artifacts } = input;

    const stage = stageMap.get(stageName);
    if (!stage) {
      throw new Error(`unknown stage: ${stageName}`);
    }

    // Load current state from DB. Workflow artifacts fill gaps (DB is source of
    // truth); checkpoints drive document-level skip logic.
    const state = await loadRunState(store, runId, {
      docConcurrency: config.workerDocConcurrency,
      totalStages: input.totalStages,
      artifacts,
      preloaded: runtime.preloaded,
    });
    const shard = runtime.documentIds !== undefined;
    if (runtime.documentIds) state.beginShard(runtime.documentIds);
    const { documents } = state;

    if (stageName === "vision-extract") state.distributedVisionPages = await store.pageTasks.completed(runId);

    const tuning = resolveAdaptiveStageTuning({
      config,
      state,
      stageName,
    });
    applyAdaptiveStageTuning(state, tuning);
    state.pendingPerformance.push(...adaptiveTuningPerformanceEvents(tuning));

    const completedDocs = documents.filter((d) => {
      const s = state.documentStages.get(d.id)?.get(stageName);
      return s?.status === "completed";
    });
    const failedDocs = documents.filter((d) => {
      const s = state.documentStages.get(d.id)?.get(stageName);
      return s?.status === "failed";
    });
    console.log(
      `[temporal-debug] run=${runId} stage=${stageName} hydrated ` +
        `docs=${documents.length} completedDocs=${completedDocs.length} failedDocs=${failedDocs.length} ` +
        `artifactKeys=${Object.keys(state.artifacts).length} inputArtifactKeys=${Object.keys(artifacts).length} ` +
        `docConcurrency=${tuning.docConcurrency}/${tuning.maxDocConcurrency} ` +
        `memoryHeadroomMb=${tuning.resource.memoryHeadroomMb} ` +
        `recommendedEmbeddingBatchSize=${tuning.recommendedEmbeddingBatchSize} ` +
        `recommendedUnstructuredChunkPages=${tuning.recommendedUnstructuredChunkPages}`,
    );

    // Capture process stats before stage execution
    const processStatsStart = captureProcessStats();

    // Heartbeats reflect real progress (OP-08): the stage's counters, plus
    // subprocess CPU, AI and embedding calls reported through the tracker.
    // With no progress for stallTimeoutMs the heartbeat stops and the stage
    // is aborted as hung work instead of holding its slot until the 4 h
    // start-to-close timeout.
    const tracker = new ProgressTracker();
    const stallTimeoutMs = runtime.stallTimeoutMs ?? resolveStageStallTimeoutMs();
    const stallController = new AbortController();
    const stageSignal = AbortSignal.any([runtime.signal, stallController.signal]);
    let lastCounters = "";
    const heartbeatIntervalMs = runtime.heartbeatIntervalMs ?? 30_000;
    let lastCpuMs = processStatsStart.cpuUserMs + processStatsStart.cpuSystemMs;
    let peakRssBytes = processStatsStart.rssBytes;
    const heartbeatTimer = setInterval(() => {
      const currentStats = captureProcessStats();
      peakRssBytes = Math.max(peakRssBytes, currentStats.rssBytes);

      const completedNow = Array.from(state.documentStages.values()).reduce(
        (sum, m) => sum + Array.from(m.values()).filter((s) => s.status === "completed").length,
        0,
      );
      const failedNow = Array.from(state.documentStages.values()).reduce(
        (sum, m) => sum + Array.from(m.values()).filter((s) => s.status === "failed").length,
        0,
      );

      // Accumulate token usage for real-time visibility
      const { inputTokens, outputTokens, costCents } = state.usageLedger.totals();
      const counters = [completedNow, failedNow, state.run.stats.percentComplete ?? 0, state.run.pagesProcessed ?? 0,
        inputTokens, outputTokens, Object.keys(state.artifacts).length].join(":");
      if (counters !== lastCounters) {
        lastCounters = counters;
        tracker.note("stage-counters");
      }
      // Node-side work (parsing, chunking, LanceDB writes) shows up as process
      // CPU. Errs toward "alive": another activity's CPU can mask a hang, which
      // the per-command and per-request timeouts still bound.
      const cpuMs = currentStats.cpuUserMs + currentStats.cpuSystemMs;
      if (runtime.progressFromProcessCpu !== false && cpuMs - lastCpuMs >= heartbeatIntervalMs * 0.02) tracker.note("process-cpu");
      lastCpuMs = cpuMs;
      const idleMs = tracker.idleMs();
      if (idleMs >= stallTimeoutMs) {
        if (!stallController.signal.aborted) {
          console.error(
            `[temporal] run=${runId} stage=${stageName} status=stalled idleMs=${idleMs} lastProgress=${tracker.lastLabel}`,
          );
          stallController.abort(new HungWorkError(
            "stage-stalled",
            `stage ${stageName} made no progress for ${Math.round(idleMs / 1000)} s (last progress: ${tracker.lastLabel})`,
          ));
        }
        // No heartbeat: if the stage cannot unwind, the Temporal heartbeat timeout frees the slot.
        return;
      }

      runtime.heartbeat({
        stage: stageName,
        docs: documents.length,
        percentComplete: state.run.stats.percentComplete ?? 0,
        idleMs,
        lastProgress: tracker.lastLabel,
      });

      console.log(
        `[temporal-debug] run=${runId} stage=${stageName} heartbeat ` +
          `completedDocs=${completedNow} failedDocs=${failedNow} ` +
          `percentComplete=${state.run.stats.percentComplete ?? 0} ` +
          `inputTokens=${inputTokens} outputTokens=${outputTokens} ` +
          `rssMb=${Math.round(currentStats.rssBytes / 1024 / 1024)} ` +
          `peakRssMb=${Math.round(peakRssBytes / 1024 / 1024)}`,
      );
      Promise.all([
        store.renewHeartbeat(runId),
        store.appendEvent(
          buildRunProgressEvent(state, {
            kind: "heartbeat",
            stageName,
            completedDocumentStages: completedNow,
            failedDocumentStages: failedNow,
            metrics: {
              inputTokens,
              outputTokens,
              costCents,
              rssBytes: currentStats.rssBytes,
              peakRssBytes,
              cpuUserMs: Math.round(currentStats.cpuUserMs - processStatsStart.cpuUserMs),
              cpuSystemMs: Math.round(currentStats.cpuSystemMs - processStatsStart.cpuSystemMs),
            },
          }),
        ),
      ]).catch((err) =>
        console.warn(`[temporal] heartbeat persistence failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, heartbeatIntervalMs);

    try {
      // A previous attempt that left the stage "processing" without a failure
      // checkpoint was interrupted (drain timeout, scale-in, recycle, or a
      // heartbeat timeout after SIGKILL). Resume from checkpoints; it costs no
      // ordinary attempt.
      const previous = state.runStages.get(stageName);
      if ((runtime.attempt ?? 1) > 1 && previous?.status === "processing") {
        console.warn(
          `[temporal] run=${runId} stage=${stageName} attempt=${runtime.attempt} ` +
            `resuming after an infrastructure interruption (no failure checkpoint from the previous attempt)`,
        );
      }

      // Mark stage started
      state.stage = stageName;
      state.refreshStats();

      // startRunStage checkpoints progress in the same transaction.
      if (shard) {
        // The unsharded pass owns the stage checkpoint; a shard only does documents.
      } else if (stageName === "vision-extract" && state.distributedVisionPages.size) await store.updateProgress(state);
      else await store.startRunStage(state, stageName);

      console.log(
        `[temporal] run=${runId} stage=${stageName} status=${shard ? "shard-started" : "started"} docs=${documents.length}`,
      );
      const startedAt = Date.now();

      // Run the stage with the orchestrator's cancellation signal
      await withObservation({ name: `worker.stage.${stageName}`,
        metadata: { runId, workspaceId: state.run.workspaceId, orgId: state.run.orgId,
          temporalAttempt: runtime.attempt, stage: stageName },
      }, () => runWithPrivacyAuditScope({ workspaceId: state.run.workspaceId ?? null, runId },
        () => runWithProgressTracker(tracker, () => stage.run(state, stageSignal))));

      const durationMs = Date.now() - startedAt;
      const newArtifactKeys = Object.keys(state.artifactLedger.changedSince(artifacts));

      // Record CPU/RAM delta
      const processStatsEnd = captureProcessStats();
      pushProcessStatsDelta(processStatsStart, processStatsEnd, ["run", "stage"], {
        runId,
        stage: stageName,
        documents: documents.length,
      }, peakRssBytes);

      const rssDelta = Math.round(processStatsEnd.rssBytes - processStatsStart.rssBytes);
      const peakRssDelta = Math.round(peakRssBytes - processStatsStart.rssBytes);
      const cpuSeconds = Math.max(
        0,
        processStatsEnd.cpuUserMs
          - processStatsStart.cpuUserMs
          + processStatsEnd.cpuSystemMs
          - processStatsStart.cpuSystemMs,
      ) / 1000;
      const deploymentProfile = resolveWorkerDeploymentProfile();
      const localObservation = buildAllocatedResourceObservation({
        profile: deploymentProfile,
        wallTimeMs: durationMs,
        pages: documents.reduce((total, document) => total + Math.max(1, document.pageCount), 0),
        cold: false,
      });
      state.usageLedger.enqueue(buildLocalComputeUsageEvent({
        metric: "worker-stage",
        profile: deploymentProfile,
        observation: localObservation,
        metadata: {
          runId,
          stage: stageName,
          measurement: "allocated-capacity",
          processCpuSeconds: cpuSeconds,
          processPeakRssDeltaBytes: Math.max(0, peakRssDelta),
        },
      }));
      state.pendingPerformance.push(...buildLocalComputePerformanceEvents({
        scope: "run",
        stageName,
        profile: deploymentProfile,
        observation: localObservation,
        metadata: {
          runId,
          measurement: "allocated-capacity",
          processCpuSeconds: cpuSeconds,
          processPeakRssDeltaBytes: Math.max(0, peakRssDelta),
        },
      }));
      console.log(
        `[temporal] run=${runId} stage=${stageName} status=completed durationMs=${durationMs} ` +
          `newArtifacts=${newArtifactKeys.length} ` +
          `cpuUserMs=${Math.round(processStatsEnd.cpuUserMs - processStatsStart.cpuUserMs)} ` +
          `rssDeltaBytes=${rssDelta} ` +
          `peakRssBytes=${peakRssDelta}`,
      );

      // Record stage duration
      state.pendingPerformance.push({
        scope: "run",
        stageName,
        metric: "stage-duration",
        value: durationMs,
        unit: "ms",
        tags: ["run", "stage"],
        metadata: {
          documents: documents.length,
          artifacts: Object.keys(state.artifacts).length,
        },
      });

      // Complete stage and flush
      const stageStats = {
        documents: documents.length,
        artifacts: Object.keys(state.artifacts).length,
        durationMs,
        adaptiveTuning: {
          docConcurrency: tuning.docConcurrency,
          maxDocConcurrency: tuning.maxDocConcurrency,
          recommendedEmbeddingBatchSize: tuning.recommendedEmbeddingBatchSize,
          recommendedUnstructuredChunkPages: tuning.recommendedUnstructuredChunkPages,
          recommendedUnstructuredConcurrency: tuning.recommendedUnstructuredConcurrency,
          resource: tuning.resource,
          speed: tuning.speed,
          reasons: tuning.reasons,
        },
      };
      // Everything this attempt recorded, including events already flushed by
      // mid-stage checkpoints. The pending buffer alone (ledger.snapshot())
      // misses those: it reported only the trailing worker-stage compute event
      // while preamble, embedding and vision spend had been checkpointed.
      const usage: UsageSummary = state.usageLedger.totals();

      if (shard) {
        // Checkpoints this shard's usage and artifacts, then releases its share of the fleet demand.
        await store.finishShard(state);
        return { artifacts: {}, usage, stats: stageStats };
      }

      // Also checkpoints progress (and this stage's usage) in the same transaction.
      const completion = await store.completeRunStage(state, stageName, "", stageStats,
        runtime.readControlState || runtime.preloadRunState
          ? { readControlState: runtime.readControlState, preloadRunState: runtime.preloadRunState }
          : undefined) as { controlRequested?: boolean; preloaded?: PreloadedRunState } | undefined;

      // Emit a run.progress event on stage completion so dashboard gets a fresh snapshot
      await store.appendEvent(
        buildRunProgressEvent(state, {
          kind: "stage",
          stageName,
          outcome: "completed",
        }),
      );

      // Compute new artifacts (diff from input)
      const newArtifacts = state.artifactLedger.changedSince(artifacts);

      return {
        artifacts: newArtifacts,
        usage,
        stats: stageStats,
        ...(completion?.controlRequested === undefined ? {} : { controlRequested: completion.controlRequested }),
        ...(completion?.preloaded ? { preloaded: completion.preloaded } : {}),
      };
    } catch (caught) {
      // A stall abort surfaces as whatever the stage threw on abort; report the hang itself.
      const error: unknown = stallController.signal.aborted && !runtime.signal.aborted ? stallController.signal.reason : caught;
      initializeWorkerErrorReporting();
      reportException(error, { runId, stage: stageName });
      const message = error instanceof Error ? error.message : String(error);
      const partialArtifacts = Object.keys(state.artifactLedger.changedSince(artifacts));
      const classification: StageFailureClass = runtime.classifyError?.(error)
        ?? (isWorkerInterruption(message) ? "interruption" : "ordinary");
      if (classification === "interruption" || classification === "cancelled") {
        console.warn(
          `[temporal] run=${runId} stage=${stageName} status=interrupted class=${classification} message=${message} ` +
            `partialArtifacts=${partialArtifacts.length}`,
        );
        throw error;
      }
      console.error(
        `[temporal] run=${runId} stage=${stageName} status=${shard ? "shard-failed" : "failed"} class=${classification} message=${message} ` +
          `partialArtifacts=${partialArtifacts.length} ` +
          `partialArtifactKeys=${partialArtifacts.slice(0, 10).join(",")}${partialArtifacts.length > 10 ? "..." : ""}`,
      );
      if (shard) {
        // Keep what this shard finished (usage, artifacts); the unsharded pass retries the rest
        // and decides whether the stage fails. Never fail the stage or other shards' documents here.
        await store.updateProgress(state).catch((flushError) => console.warn(
          `[temporal] run=${runId} stage=${stageName} shard progress flush failed: ${String(flushError)}`));
        throw error;
      }
      // Throttling waits out Retry-After; it is not a document failure.
      const ordinaryFailures = await store.failRunStage(state, stageName, message, {
        countFailure: classification !== "throttled",
      });
      runtime.onStageFailure?.({ classification, ordinaryFailures: typeof ordinaryFailures === "number" ? ordinaryFailures : undefined });
      await store.updateProgress(state);
      throw error;
    } finally {
      clearInterval(heartbeatTimer);
      await flushObservability();
    }
  }

  async function notifyTerminal(runId: string, event: "run.completed" | "run.failed"): Promise<void> {
    await store
      .triggerRunEmails(runId, event)
      .catch((err) =>
        console.error(
          "run email failed:",
          err instanceof Error ? err.message : String(err),
        ),
      );

    await store
      .triggerWebhooks(runId, event)
      .catch((err) =>
        console.error(
          "webhook trigger failed:",
          err instanceof Error ? err.message : String(err),
        ),
      );
  }

  /** Mark a Run completed, emit run.completed, and notify emails/webhooks. */
  async function completeRun(input: CompleteRunInput): Promise<void> {
    const state = await loadRunState(store, input.runId, { totalStages: (run) => getPipelineStageOrder(run.pipeline).length });

    // A Run with some failed Documents still completes (the count is in its
    // stats). It fails only when no Document could succeed.
    const failed = state.documents.filter((document) => hasFailedDocumentStage(state, document.id));
    if (failed.length > 0 && failed.length === state.documents.length) {
      const first = failed
        .flatMap((document) => Array.from(state.documentStages.get(document.id)?.entries() ?? []))
        .find(([, stage]) => stage.status === "failed");
      const detail = first ? ` (${first[0]}: ${first[1].error})` : "";
      const noun = failed.length === 1 ? "document" : "documents";
      const message = `All ${failed.length} ${noun} failed${detail}`;
      console.error(`[temporal] run=${input.runId} status=failed message=${message}`);
      await store.failRun(input.runId, first?.[0] ?? state.stage, message);
      await notifyTerminal(input.runId, "run.failed");
      return;
    }

    console.log(
      `[temporal] run=${input.runId} status=completed failedDocuments=${failed.length}`,
    );
    await store.completeRun(state);

    await store.appendEvent(
      buildRunCompletedEvent(state, "pipeline completed"),
    );

    await notifyTerminal(input.runId, "run.completed");
  }

  /**
   * Mark a Run failed (failure_count, dead-letter bookkeeping, run.failed
   * event live in the store) and notify emails/webhooks.
   */
  async function failRun(input: FailRunInput): Promise<void> {
    let stage = input.stage;
    if (input.stageGroup?.length) {
      const current = await store.currentRunStage(input.runId);
      if (current && input.stageGroup.includes(current)) stage = current;
    }
    console.error(
      `[temporal] run=${input.runId} stage=${stage} status=failed message=${input.message}`,
    );

    await store.failRun(input.runId, stage, input.message);

    await notifyTerminal(input.runId, "run.failed");
  }

  return { startRun, runStage, completeRun, failRun };
}

export type StageExecution = ReturnType<typeof createStageExecution>;

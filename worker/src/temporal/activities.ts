import { renderDocumentPage } from "../deferred/render-page.js";
import { buildDocumentExport, DOCUMENT_EXPORT_MAX_ATTEMPTS } from "../exports/build-document-export.js";
import { runPageBundle } from "./page-bundle.js";
import { VisionExtractStage } from "../stages/vision-extract.js";
import type { VisionPageTask } from "./shared.js";
import { runWithProviderRateScope } from "../lib/provider-rate-limit.js";
import { runWithPrivacyAuditScope } from "../lib/privacy-guard.js";
/**
 * Temporal activities — thin adapters over Stage Execution
 * (pipeline/stage-execution.ts) plus the distributed vision page tasks.
 * Temporal concerns (heartbeat, cancellation, attempt) are injected here.
 *
 * Activities are created via a factory function that closes over shared
 * infrastructure (Store, CommandRunner, ArtifactStore, compiled stages).
 * The Temporal worker creates these once at startup and passes them to
 * Worker.create().
 */

import { Context } from "@temporalio/activity";
import { dbTraceEnabled, withDbTraceLabel } from "../lib/db-trace.js";
import { ApplicationFailure } from "@temporalio/common";

import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import type { CommandRunner } from "../tools/runner.js";
import type { MaterializePagesInput } from "@docslurp/shared";
import { completeMaterializeRun, runMaterializeRange } from "../deferred/materialize-activity.js";
import type { MaterializeResult } from "./materialize-ranges.js";
import type { Stage } from "../pipeline/pipeline.js";
import {
  createStageExecution,
  loadRunState,
} from "../pipeline/stage-execution.js";
import {
  buildLocalComputeUsageEvent,
  buildAllocatedResourceObservation,
  resolveWorkerDeploymentProfile,
} from "../pipeline/local-compute-cost.js";
import type { ArtifactStore } from "../tools/storage.js";
import { findProviderRetryableError } from "../lib/provider-retry.js";
import { workerShutdownState } from "../lib/worker-lifecycle.js";
import {
  classifyActivityError,
  hungWorkFailure,
  interruptionFailure,
  type ActivityErrorClass,
} from "./failure-classification.js";
import { resolveWorkerSlotOptions, type WorkerSlotKind } from "../db/worker-slot-store.js";
import {
  PROVIDER_RATE_LIMITED,
  STAGE_ORDINARY_ATTEMPTS,
  WORKER_SLOT_UNAVAILABLE,
  type VisionPageBatchPlan,
} from "./shared.js";
import type {
  StageGroupInput,
  StageInput,
  StageShardInput,
  StageOutput,
  InitRunInput,
  InitRunOutput,
  CompleteRunInput,
  FailRunInput,
  UsageSummary,
} from "./shared.js";

export interface ActivityDependencies {
  store: Store;
  storage: ArtifactStore;
  stages: Stage[];
  config: Config;
  /** Command runner for the materialize activities (deferred indexing). */
  runner?: CommandRunner;
}

/**
 * Provider throttling becomes a retryable Temporal failure that waits out
 * Retry-After. With `ordinaryAttemptLimit`, any other failure on that attempt
 * or later becomes non-retryable, so an activity whose retry policy allows
 * extra attempts for throttling still gives up on ordinary errors on time.
 */
export function toActivityFailure(error: unknown, attempt?: number, ordinaryAttemptLimit?: number): unknown {
  const throttled = findProviderRetryableError(error);
  if (!throttled) {
    const exhausted = attempt !== undefined && ordinaryAttemptLimit !== undefined && attempt >= ordinaryAttemptLimit;
    if (!exhausted) return error;
    if (error instanceof ApplicationFailure) {
      if (error.nonRetryable || error.type === PROVIDER_RATE_LIMITED) return error;
      return ApplicationFailure.create({ type: error.type ?? undefined, message: error.message, nonRetryable: true, details: error.details as unknown[] | undefined, cause: error });
    }
    const message = error instanceof Error ? error.message : String(error);
    return ApplicationFailure.create({ type: error instanceof Error ? error.name : "Error", message, nonRetryable: true, cause: error instanceof Error ? error : undefined });
  }
  if (error instanceof ApplicationFailure) return error;
  return ApplicationFailure.create({
    type: PROVIDER_RATE_LIMITED,
    message: throttled.message,
    nonRetryable: false,
    ...(throttled.retryAfterMs !== null ? { nextRetryDelay: Math.max(1_000, Math.min(throttled.retryAfterMs, 600_000)) } : {}),
    details: [{ provider: throttled.provider, status: throttled.status, attempts: throttled.attempts }],
    cause: error instanceof Error ? error : undefined,
  });
}

/**
 * Stage activities: classify first (failure-classification.ts). Interruptions
 * retry without spending an ordinary attempt; hung work is final; ordinary
 * failures become non-retryable once the stage checkpoint has recorded
 * STAGE_ORDINARY_ATTEMPTS of them. `ordinaryFailures` comes from
 * workspace_run_stage_states, so attempts lost to deploys, scale-in, the 6 h
 * recycle or a heartbeat timeout after SIGKILL do not count. It falls back to
 * the Temporal attempt only when the store did not report a count.
 */
export function toStageActivityFailure(
  error: unknown,
  args: { classification: ActivityErrorClass; ordinaryFailures?: number; attempt: number; ordinaryAttemptLimit: number },
): unknown {
  switch (args.classification) {
    case "interruption":
      return interruptionFailure(error);
    case "cancelled":
      return error;
    case "hung":
      return hungWorkFailure(error);
    case "throttled":
      return toActivityFailure(error);
    case "ordinary":
      return toActivityFailure(error, args.ordinaryFailures ?? args.attempt, args.ordinaryAttemptLimit);
  }
}

export function workerIdentity(): string {
  return process.env.FLY_MACHINE_ID ?? `local-${process.pid}`;
}

/**
 * Holds one org worker slot around `work`. Throws a non-retryable
 * WORKER_SLOT_UNAVAILABLE failure when the org (or fleet) is full; the
 * workflow backs off and re-dispatches, so a full org never parks activities
 * on machines other orgs could use.
 */
export async function withWorkerSlot<T>(
  store: Store,
  args: { runId: string; kind: WorkerSlotKind; enabled: boolean },
  work: () => Promise<T>,
): Promise<T> {
  if (!args.enabled) return work();
  const slots = store.workerSlots;
  const workerId = workerIdentity();
  const claim = await slots.acquire({ runId: args.runId, kind: args.kind, workerId });
  if (!claim.acquired) {
    throw ApplicationFailure.create({
      type: WORKER_SLOT_UNAVAILABLE,
      message: `org ${claim.orgKey} has ${claim.inflight}/${claim.cap} worker slots in use (${claim.reason})`,
      nonRetryable: true,
      details: [{ orgKey: claim.orgKey, inflight: claim.inflight, cap: claim.cap, reason: claim.reason }],
    });
  }
  const renewEveryMs = Math.max(5_000, Math.floor(slots.ttlMs / 3));
  const timer = setInterval(() => {
    slots.renew(claim.leaseId).then((alive) => {
      if (!alive) console.warn(`[worker-slot] lease expired before renewal lease=${claim.leaseId} run=${args.runId}`);
    }).catch((error) => console.warn(`[worker-slot] renew failed: ${String(error)}`));
  }, renewEveryMs);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await slots.release(claim.leaseId).catch((error) => {
      // The lease expires on its own; the slot is only held up to the TTL.
      console.warn(`[worker-slot] release failed lease=${claim.leaseId}: ${String(error)}`);
    });
  }
}

export function createActivities(deps: ActivityDependencies) {
  const { store } = deps;
  const stageMap = new Map(deps.stages.map((s) => [s.name, s]));
  const execution = createStageExecution(deps);
  const slotsEnabled = resolveWorkerSlotOptions().enabled;

  const activities = {
    async renderDocumentPageActivity(input: import("@docslurp/shared").RenderDocumentPageInput): Promise<void> {
      if (!deps.runner) throw ApplicationFailure.nonRetryable("Page rendering requires a command runner");
      const context = Context.current();
      const timer = setInterval(() => context.heartbeat(), 10_000);
      try { await renderDocumentPage({ store, storage: deps.storage, runner: deps.runner }, input, context.cancellationSignal); }
      finally { clearInterval(timer); }
    },
    /**
     * Heartbeats only on progress (each file and chunk), so a hung storage read
     * misses the heartbeat timeout and is retried instead of holding the slot.
     */
    async buildDocumentExportActivity(input: import("@docslurp/shared").BuildDocumentExportInput): Promise<void> {
      const context = Context.current();
      await buildDocumentExport({ sql: store.stageSql, storage: deps.storage }, input.exportId, {
        signal: context.cancellationSignal,
        heartbeat: () => context.heartbeat(),
        attempt: context.info.attempt,
        final: context.info.attempt >= DOCUMENT_EXPORT_MAX_ATTEMPTS,
      });
    },
    /** One contiguous page range of a materializePages workflow. */
    async materializePageRangeActivity(input: MaterializePagesInput): Promise<MaterializeResult> {
      const context = Context.current();
      if (!deps.runner) throw ApplicationFailure.nonRetryable("materialize activities require a command runner");
      return runMaterializeRange({
        store, sql: store.stageSql,
        materializer: { storage: deps.storage, runner: deps.runner, config: deps.config },
        heartbeat: () => context.heartbeat(),
        signal: context.cancellationSignal,
        startToCloseMs: 5 * 60_000,
      }, input);
    },

    /** Marks the materialize run row terminal once every range has settled. */
    async completeMaterializeRun(input: { runId: string; result: MaterializeResult }): Promise<void> {
      await completeMaterializeRun(store.stageSql, input.runId, input.result);
    },

    async runVisionPageBundle(tasks: VisionPageTask[]): Promise<UsageSummary> {
      return runPageBundle(tasks, (task) => activities.runVisionPageTask(task, 1 / Math.min(2, tasks.length)));
    },

    async prepareVisionPageTasks(input: StageInput): Promise<VisionPageTask[]> {
      const stage = stageMap.get("vision-extract");
      if (!(stage instanceof VisionExtractStage)) return [];
      const state = await loadRunState(store, input.runId, { totalStages: input.totalStages });
      const tasks = await stage.planPageTasks(state, Context.current().cancellationSignal);
      if (tasks.length) {
        state.stage = "vision-extract";
        await store.startRunStage(state, state.stage);
        await store.pageTasks.enqueue(tasks);
      }
      return tasks;
    },

    /** Plans page tasks and stores them (with payload) for child workflows; returns only the count. */
    async prepareVisionPageBatches(input: StageInput): Promise<VisionPageBatchPlan> {
      const stage = stageMap.get("vision-extract");
      if (!(stage instanceof VisionExtractStage)) return { total: 0 };
      const state = await loadRunState(store, input.runId, { totalStages: input.totalStages });
      const tasks = await stage.planPageTasks(state, Context.current().cancellationSignal);
      if (!tasks.length) return { total: 0 };
      state.stage = "vision-extract";
      await store.startRunStage(state, state.stage);
      return { total: await store.pageTasks.enqueueWithPayload(tasks) };
    },

    async loadVisionPageBatch(input: { runId: string; offset: number; limit: number }): Promise<VisionPageTask[]> {
      return store.pageTasks.loadBatch(input.runId, input.offset, Math.min(2_000, input.limit));
    },

    async runVisionPageTask(task: VisionPageTask, allocationFraction = 1): Promise<UsageSummary> {
      try {
        return await withWorkerSlot(store, { runId: task.runId, kind: "page", enabled: slotsEnabled && task.slotGate === true },
          () => runVisionPage(task, allocationFraction));
      } catch (error) {
        const classification = classifyActivityError(error, { signal: Context.current().cancellationSignal });
        if (classification === "interruption") throw interruptionFailure(error);
        if (classification === "hung") throw hungWorkFailure(error);
        throw toActivityFailure(error);
      }
    },

    /** Initialize a pipeline run: hydrate checkpoints and mark it processing. */
    async initPipelineRun(input: InitRunInput): Promise<InitRunOutput> {
      return execution.startRun(input);
    },

    /** Run a single pipeline stage with Temporal heartbeat and cancellation. */
    async runPipelineStage(input: StageInput): Promise<StageOutput> {
      const context = Context.current();
      const classify = (error: unknown) => classifyActivityError(error, { signal: context.cancellationSignal });
      let ordinaryFailures: number | undefined;
      try {
        return await withWorkerSlot(store, { runId: input.runId, kind: "stage", enabled: slotsEnabled && input.slotGate === true },
          () => execution.runStage(input, {
            signal: context.cancellationSignal,
            heartbeat: (details) => context.heartbeat(details),
            attempt: context.info.attempt,
            classifyError: classify,
            onStageFailure: (failure) => { ordinaryFailures = failure.ordinaryFailures; },
          }));
      } catch (error) {
        const classification = classify(error);
        if (classification === "interruption") {
          console.warn(`[temporal] run=${input.runId} stage=${input.stageName} attempt=${context.info.attempt} ` +
            `class=interruption reason=${workerShutdownState()?.reason ?? "cancelled"}; retrying without spending an ordinary attempt`);
        }
        throw toStageActivityFailure(error, {
          classification,
          ordinaryFailures,
          attempt: context.info.attempt,
          ordinaryAttemptLimit: STAGE_ORDINARY_ATTEMPTS,
        });
      }
    },

    /**
     * Several light stages back to back under one worker slot, each with its
     * own checkpoints exactly as runPipelineStage. A retry re-runs the group;
     * stages already completed skip their finished documents.
     */
    async runPipelineStages(input: StageGroupInput): Promise<StageOutput> {
      const context = Context.current();
      const classify = (error: unknown) => classifyActivityError(error, { signal: context.cancellationSignal });
      let ordinaryFailures: number | undefined;
      let current = input.stageNames[0] ?? "";
      try {
        return await withWorkerSlot(store, { runId: input.runId, kind: "stage", enabled: slotsEnabled && input.slotGate === true },
          async () => {
            let artifacts = { ...input.artifacts };
            const merged: StageOutput = { artifacts: {}, usage: { inputTokens: 0, outputTokens: 0, costCents: 0 }, stats: {} };
            // A retry resumes at the first stage the earlier attempt left unfinished, as
            // one-activity-per-stage would: stages without document checkpoints
            // (graph-enrich) would otherwise repeat their model calls.
            let resumeAt = 0;
            if (context.info.attempt > 1) {
              const completed = await store.completedRunStages(input.runId, input.stageNames);
              while (resumeAt < input.stageNames.length && completed.has(input.stageNames[resumeAt]!)) resumeAt++;
              if (resumeAt > 0) {
                console.log(`[temporal] run=${input.runId} stage group attempt=${context.info.attempt} ` +
                  `resumes after completed ${input.stageNames.slice(0, resumeAt).join(",")}`);
              }
              merged.stagesRun = resumeAt;
            }
            // The previous stage's completion checkpoint already read the control state.
            let controlRequested: boolean | undefined;
            let preloaded: import("../db/store.js").PreloadedRunState | undefined;
            for (const [position, stageName] of input.stageNames.entries()) {
              if (position < resumeAt) continue;
              if (position > resumeAt && input.yieldToControl && (controlRequested ?? await store.hasRunControlRequest(input.runId))) {
                console.log(`[temporal] run=${input.runId} stage group yields before ${stageName}: control request`);
                break;
              }
              current = stageName;
              const output = await execution.runStage({ stageName, runId: input.runId, totalStages: input.totalStages, artifacts }, {
                signal: context.cancellationSignal,
                heartbeat: (details) => context.heartbeat(details),
                attempt: context.info.attempt,
                classifyError: classify,
                readControlState: input.yieldToControl === true,
                // The next stage of this group opens with the reads this checkpoint already made.
                preloadRunState: position < input.stageNames.length - 1,
                preloaded,
                onStageFailure: (failure) => { ordinaryFailures = failure.ordinaryFailures; },
              });
              controlRequested = output.controlRequested;
              preloaded = output.preloaded;
              artifacts = { ...artifacts, ...output.artifacts };
              Object.assign(merged.artifacts, output.artifacts);
              merged.usage.inputTokens += output.usage.inputTokens;
              merged.usage.outputTokens += output.usage.outputTokens;
              merged.usage.costCents += output.usage.costCents;
              merged.stats[stageName] = output.stats;
              merged.stagesRun = position + 1;
            }
            return merged;
          });
      } catch (error) {
        const classification = classify(error);
        if (classification === "interruption") {
          console.warn(`[temporal] run=${input.runId} stage=${current} attempt=${context.info.attempt} ` +
            `class=interruption reason=${workerShutdownState()?.reason ?? "cancelled"}; retrying without spending an ordinary attempt`);
        }
        throw toStageActivityFailure(error, {
          classification,
          ordinaryFailures,
          attempt: context.info.attempt,
          ordinaryAttemptLimit: STAGE_ORDINARY_ATTEMPTS,
        });
      }
    },

    /** Shards still pending for the stage the workflow is fanning out; the autoscaler reads it. */
    async setRunShardDemand(input: { runId: string; shards: number }): Promise<void> {
      await store.setRunShardDemand(input.runId, input.shards);
    },

    /**
     * One document shard of a stage. Returns usage only: artifacts and
     * checkpoints go to the database, and the unsharded stage activity that
     * follows completes the stage.
     */
    async runPipelineStageShard(input: StageShardInput): Promise<UsageSummary> {
      const context = Context.current();
      const classify = (error: unknown) => classifyActivityError(error, { signal: context.cancellationSignal });
      try {
        const output = await withWorkerSlot(store, { runId: input.runId, kind: "stage", enabled: slotsEnabled && input.slotGate === true },
          () => execution.runStage(input, {
            signal: context.cancellationSignal,
            heartbeat: (details) => context.heartbeat(details),
            attempt: context.info.attempt,
            classifyError: classify,
            documentIds: input.documentIds,
          }));
        return output.usage;
      } catch (error) {
        const classification = classify(error);
        if (classification === "interruption") throw interruptionFailure(error);
        if (classification === "hung") throw hungWorkFailure(error);
        throw toActivityFailure(error);
      }
    },

    /** Mark a run as completed. Triggers emails and webhooks. */
    async completePipelineRun(input: CompleteRunInput): Promise<void> {
      await execution.completeRun(input);
    },

    /** Mark a run as failed. Triggers failure emails and webhooks. */
    async failPipelineRun(input: FailRunInput): Promise<void> {
      await execution.failRun(input);
    },
  };

  if (dbTraceEnabled) {
    for (const [name, fn] of Object.entries(activities)) {
      (activities as Record<string, unknown>)[name] = (...args: unknown[]) => withDbTraceLabel(name, () => (fn as (...a: unknown[]) => unknown)(...args));
    }
  }

  async function runVisionPage(task: VisionPageTask, allocationFraction: number): Promise<UsageSummary> {
      const stage = stageMap.get("vision-extract");
      if (!(stage instanceof VisionExtractStage)) throw new Error("Vision stage unavailable");
      const context = Context.current();
      const workerId = workerIdentity();
      let lease = await store.pageTasks.claim(task, workerId);
      while (lease === "busy") {
        context.heartbeat({ waitingForLease: true });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { context.cancellationSignal.removeEventListener("abort", cancel); resolve(); }, 10_000);
          const cancel = () => { clearTimeout(timer); reject(context.cancellationSignal.reason); };
          context.cancellationSignal.addEventListener("abort", cancel, { once: true });
          if (context.cancellationSignal.aborted) cancel();
        });
        lease = await store.pageTasks.claim(task, workerId);
      }
      if (!lease) {
        const output = (await store.pageTasks.completed(task.runId)).get(`${task.documentId}:${task.pageNumber}`) as
          { inputTokens?: number; outputTokens?: number; costCents?: number } | null;
        return { inputTokens: output?.inputTokens ?? 0, outputTokens: output?.outputTokens ?? 0, costCents: output?.costCents ?? 0 };
      }
      const ownedLease = lease;
      const pageStartedAt = Date.now();
      // Page work needs source metadata, not the whole run's checkpoint/history scan.
      // Leave state.store unset: never flush a stale run snapshot over other pages.
      const state = await loadRunState(store, task.runId, { hydrate: false });
      state.stage = "vision-extract";
      const controller = new AbortController();
      const abort = () => controller.abort(context.cancellationSignal.reason);
      context.cancellationSignal.addEventListener("abort", abort, { once: true });
      if (context.cancellationSignal.aborted) abort();
      const timer = setInterval(() => {
        context.heartbeat({ documentId: task.documentId, pageNumber: task.pageNumber, workerId });
        Promise.all([store.pageTasks.renew(task, ownedLease), store.renewHeartbeat(task.runId)])
          .catch(error => controller.abort(error));
      }, 20_000);
      let computeRecorded = false;
      const recordPageCompute = () => {
        if (computeRecorded) return;
        computeRecorded = true;
        const profile = resolveWorkerDeploymentProfile();
        state.usageLedger.enqueue(buildLocalComputeUsageEvent({ metric: "worker-page", profile,
          observation: buildAllocatedResourceObservation({profile, wallTimeMs: (Date.now() - pageStartedAt) * allocationFraction, pages: 1, cold: false}),
          costRollup: "authoritative", metadata: {allocationFraction, runId: task.runId, documentId: task.documentId,
            pageNumber: task.pageNumber, workerId, stage: "vision-extract", measurement: "allocated-capacity"},
        }));
      };
      console.log(`[page-task] run=${task.runId} document=${task.documentId} page=${task.pageNumber} worker=${workerId} started`);
      try {
        const result = await runWithProviderRateScope({ orgId: state.run.orgId },
          () => runWithPrivacyAuditScope({ workspaceId: state.run.workspaceId ?? null, runId: task.runId, documentId: task.documentId },
            () => stage.runPageTask(state, task, controller.signal)));
        recordPageCompute();
        await store.pageTasks.finish(task, ownedLease, state, result);
        await store.appendEvent({ userId: state.run.userId, runId: task.runId, documentId: task.documentId,
          stageName: "vision-extract", eventType: "run.progress", status: "processing",
          message: `Page ${task.pageNumber} extracted`, progress: { pageNumber: task.pageNumber, pageCount: task.pageCount },
          stats: { workerId } }).catch(error => console.warn(`[page-task] progress event: ${String(error)}`));
        console.log(`[page-task] run=${task.runId} page=${task.pageNumber} worker=${workerId} completed`);
        return state.usageLedger.totals();
      } catch (error) {
        recordPageCompute();
        await store.pageTasks.finish(task, ownedLease, state, null, true).catch(checkpointError => {
          console.error(`[page-task] failed checkpoint: ${String(checkpointError)}`);
        });
        throw error;
      } finally {
        clearInterval(timer);
        context.cancellationSignal.removeEventListener("abort", abort);
      }
  }
  return activities;
}

export type Activities = ReturnType<typeof createActivities>;

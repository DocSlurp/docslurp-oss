/**
 * Temporal workflow definition for the document processing pipeline.
 *
 * This file runs inside Temporal's deterministic V8 sandbox.
 * It must NOT import any I/O, non-deterministic, or Node.js modules.
 * Only @temporalio/workflow and pure type/constant imports are allowed.
 *
 * REPLAY SAFETY: rolling worker deploys replay runs that are still open (up to
 * 24 h) through this code. Any change to the command sequence (activities,
 * timers, child workflows, waits) must be gated on workflow input or
 * patched(), and must keep the replay test passing
 * (pnpm --filter @docslurp/worker test:temporal-replay). Do not re-record the
 * fixtures to make it pass. See docs/temporal-workflow-changes.md.
 */

import {
  proxyActivities,
  CancellationScope,
  ActivityCancellationType,
  ActivityFailure,
  defineQuery,
  defineSignal,
  setHandler,
  condition,
  sleep,
  startChild,
  workflowInfo,
  patched,
  ApplicationFailure,
  rootCause,
  type ChildWorkflowHandle,
  type SignalDefinition,
} from "@temporalio/workflow";

import type { MaterializePagesInput } from "@docslurp/shared";
import type { Activities } from "./activities.js";
import { mergeMaterializeResults, splitMaterializeRanges, type MaterializeResult } from "./materialize-ranges.js";
import { bundlePageTasks, runPageFanOut, slotBackoffMs } from "./page-fanout.js";
import { planDocumentShards } from "./document-shards.js";
import { planStageGroupEnd } from "./stage-groups.js";
import { resolvePipelineWorkflowStageOrder } from "./pipeline-workflow-plan.js";
import {
  LIGHT_STAGES,
  SHARDABLE_STAGES,
  STAGE_THROTTLED_ATTEMPTS,
  stageWorksOn,
  WORKER_SLOT_UNAVAILABLE,
  type PipelineWorkflowInput,
  type PipelineWorkflowOutput,
  type RunProgress,
  type UsageSummary,
  type VisionPageBatchInput,
} from "./shared.js";

// ── Activity proxies ──

const {
  initPipelineRun,
  prepareVisionPageTasks,
  runVisionPageTask,
  runVisionPageBundle,
  completePipelineRun,
  failPipelineRun,
} = proxyActivities<Activities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "2 minutes",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: {
    maximumAttempts: 3,
    initialInterval: "5s",
    backoffCoefficient: 2,
    maximumInterval: "2 minutes",
  },
});

// Override for fast stages that don't need 30 min timeout
const quickActivities = proxyActivities<Activities>({
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout: "2 minutes",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: {
    maximumAttempts: 3,
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
  },
});

// Document-stage activities only: extra attempts let provider throttling wait out
// Retry-After; runPipelineStage makes every other failure non-retryable from
// STAGE_ORDINARY_ATTEMPTS on, so ordinary errors still stop after 3 attempts.
const stageRetry = { maximumAttempts: STAGE_THROTTLED_ATTEMPTS, initialInterval: "5s", backoffCoefficient: 2, maximumInterval: "2 minutes" } as const;
const legacyStageActivities = proxyActivities<Activities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "2 minutes",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: stageRetry,
});
const legacyLongStageActivities = proxyActivities<Activities>({
  startToCloseTimeout: "4 hours",
  heartbeatTimeout: "2 minutes",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: stageRetry,
});

const longRunningStageNames = [
  "pdf-tooling",
  "render-images",
  "extract-markdown",
  "extract-html",
  "embed",
  "index",
] as const;

function isLongRunningStage(stageName: string): boolean {
  return longRunningStageNames.some((candidate) => candidate === stageName);
}

/**
 * Activity proxies for slot-gated runs. Same timeouts as the legacy proxies;
 * page tasks get more attempts because provider 429s now surface as
 * retryable failures (with nextRetryDelay) instead of silently skipped pages.
 */
function scalingActivityProxies(taskQueue: string | undefined) {
  const queue = taskQueue ? { taskQueue } : {};
  const base = {
    ...queue,
    heartbeatTimeout: "2 minutes",
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  } as const;
  return {
    standard: proxyActivities<Activities>({ ...base, startToCloseTimeout: "30 minutes",
      retry: { maximumAttempts: 3, initialInterval: "5s", backoffCoefficient: 2, maximumInterval: "2 minutes" } }),
    longRunning: proxyActivities<Activities>({ ...base, startToCloseTimeout: "4 hours",
      retry: { maximumAttempts: 3, initialInterval: "5s", backoffCoefficient: 2, maximumInterval: "2 minutes" } }),
    quick: proxyActivities<Activities>({ ...base, startToCloseTimeout: "5 minutes",
      retry: { maximumAttempts: 3, initialInterval: "2s", backoffCoefficient: 2, maximumInterval: "30 seconds" } }),
    pages: proxyActivities<Activities>({ ...base, startToCloseTimeout: "30 minutes",
      retry: { maximumAttempts: 8, initialInterval: "5s", backoffCoefficient: 2, maximumInterval: "5 minutes" } }),
    stage: proxyActivities<Activities>({ ...base, startToCloseTimeout: "30 minutes",
      retry: { maximumAttempts: STAGE_THROTTLED_ATTEMPTS, initialInterval: "5s", backoffCoefficient: 2, maximumInterval: "2 minutes" } }),
    longStage: proxyActivities<Activities>({ ...base, startToCloseTimeout: "4 hours",
      retry: { maximumAttempts: STAGE_THROTTLED_ATTEMPTS, initialInterval: "5s", backoffCoefficient: 2, maximumInterval: "2 minutes" } }),
  };
}

/**
 * Document shards share the activity queue and its slots with every other
 * activity, so they fill the slots of running machines before the
 * autoscaler starts more. Few attempts: the unsharded stage pass after the
 * shards retries whatever a shard leaves unfinished.
 */
function shardActivityProxies(taskQueue: string | undefined) {
  return proxyActivities<Activities>({
    ...(taskQueue ? { taskQueue } : {}),
    startToCloseTimeout: "4 hours",
    heartbeatTimeout: "2 minutes",
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: { maximumAttempts: 2, initialInterval: "5s", backoffCoefficient: 2, maximumInterval: "1 minute" },
  });
}

function isSlotUnavailable(error: unknown): boolean {
  return error instanceof ActivityFailure
    && error.cause instanceof ApplicationFailure
    && error.cause.type === WORKER_SLOT_UNAVAILABLE;
}

function addUsage(left: UsageSummary, right: UsageSummary): UsageSummary {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    costCents: left.costCents + right.costCents,
  };
}

// ── Queries ──

export const progressQuery = defineQuery<RunProgress>("progress");
export const usageQuery = defineQuery<UsageSummary>("usage");

// ── Signals ──

export const cancelSignal = defineSignal("cancel");
export const pauseSignal = defineSignal("pause");
export const resumeSignal = defineSignal("resume");

// ── Workflow ──

export async function documentPipeline(
  input: PipelineWorkflowInput
): Promise<PipelineWorkflowOutput> {
  const stageOrder = resolvePipelineWorkflowStageOrder(input, patched);
  // Workflow-local state (survives replays)
  let progress: RunProgress = {
    stage: "init",
    stageIndex: 0,
    totalStages: stageOrder.length,
    usage: { inputTokens: 0, outputTokens: 0, costCents: 0 },
    percentComplete: 0,
    documentsProgress: [],
    cpuMs: 0,
    rssBytes: 0,
  };
  let usage: UsageSummary = { inputTokens: 0, outputTokens: 0, costCents: 0 };
  let paused = false;
  let cancelled = false;

  // Register query handlers (read-only, synchronous)
  setHandler(progressQuery, () => progress);
  setHandler(usageQuery, () => usage);

  // Running page-batch children (slot-gated runs only) follow pause/resume/cancel.
  const pageChildren = new Map<string, ChildWorkflowHandle<typeof visionPageBatch>>();
  const forward = (signal: SignalDefinition<[], string>) => {
    for (const child of pageChildren.values()) void child.signal(signal).catch(() => undefined);
  };

  // Register signal handlers
  setHandler(cancelSignal, () => {
    cancelled = true;
    forward(cancelSignal);
  });
  setHandler(pauseSignal, () => {
    paused = true;
    forward(pauseSignal);
  });
  setHandler(resumeSignal, () => {
    paused = false;
    forward(resumeSignal);
  });

  const scaling = input.slotGate || input.pageChildBatchSize || input.activityTaskQueue
    ? scalingActivityProxies(input.activityTaskQueue)
    : null;
  /** Retries a slot-gated activity until the org has a free worker slot. */
  const withStageSlot = async <T>(call: () => Promise<T>): Promise<T> => {
    for (let denials = 0; ; denials++) {
      try {
        return await call();
      } catch (error) {
        if (!input.slotGate || !isSlotUnavailable(error) || cancelled) throw error;
        await sleep(slotBackoffMs(denials, Math.random));
      }
    }
  };

  // Initialize the run: load docs, set processing status
  const initResult = await (scaling?.quick ?? quickActivities).initPipelineRun({
    runId: input.runId,
    totalStages: stageOrder.length,
  });
  let artifacts = initResult.artifacts;

  /** Document shards this run dispatches for a stage (fewer than two: none). */
  const shardPlan = (stageName: string): string[][] => {
    const sharding = input.documentSharding;
    if (!sharding || !scaling || !SHARDABLE_STAGES.includes(stageName)) return [];
    // Only the documents this stage works on; the stage pass takes the rest as no-ops.
    const types = initResult.documentMimeTypes;
    const picked = initResult.documentIds.flatMap((id, index) => !types || stageWorksOn(stageName, types[index]) ? [index] : []);
    return planDocumentShards(
      picked.map((index) => initResult.documentIds[index]!),
      initResult.documentPages ? picked.map((index) => initResult.documentPages![index]!) : undefined,
      sharding,
    );
  };
  // Recorded in workflow input: runs started without it keep LIGHT_STAGES grouping (or none).
  const groupable = scaling && input.groupableStages ? new Set<string>(input.groupableStages) : null;
  const needsPreWork = (stageName: string): boolean =>
    (stageName === "vision-extract" && (input.pageConcurrency ?? 0) > 1) || shardPlan(stageName).length > 1;

  try {
    // Execute each stage sequentially
    for (let i = 0; i < stageOrder.length; i++) {
      // Handle pause/cancel signals
      while (paused && !cancelled) {
        await condition(() => !paused || cancelled);
      }
      if (cancelled) {
        throw ApplicationFailure.nonRetryable("Run cancelled by user");
      }

      const stageName = stageOrder[i]!;

      // Recorded in workflow input: runs started without it keep one activity per stage.
      if (!groupable && input.groupLightStages && scaling && LIGHT_STAGES.includes(stageName)) {
        let end = i;
        while (end < stageOrder.length && LIGHT_STAGES.includes(stageOrder[end]!)) end++;
        const group = stageOrder.slice(i, end);
        if (group.length > 1) {
          progress = {
            stage: group[group.length - 1]!,
            stageIndex: end - 1,
            totalStages: stageOrder.length,
            usage: { ...usage },
            percentComplete: Math.round((end / stageOrder.length) * 100),
            documentsProgress: [],
            cpuMs: 0,
            rssBytes: 0,
          };
          const groupInput = {
            stageNames: [...group],
            runId: input.runId,
            totalStages: stageOrder.length,
            artifacts,
            ...(input.slotGate ? { slotGate: true } : {}),
          };
          const result = await withStageSlot(() => scaling.longStage.runPipelineStages(groupInput));
          artifacts = { ...artifacts, ...result.artifacts };
          usage = addUsage(usage, result.usage);
          i = end - 1;
          continue;
        }
      }

      const stagePercent = Math.round(((i + 1) / stageOrder.length) * 100);
      progress = {
        stage: stageName,
        stageIndex: i,
        totalStages: stageOrder.length,
        usage: { ...usage },
        percentComplete: stagePercent,
        documentsProgress: [],
        cpuMs: 0,
        rssBytes: 0,
      };

      // The opt-in value is recorded in workflow input: existing histories retain their command sequence.
      if (stageName === "vision-extract" && (input.pageConcurrency ?? 0) > 1 && scaling && input.pageChildBatchSize) {
        const plan = await scaling.standard.prepareVisionPageBatches({ stageName, runId: input.runId, totalStages: stageOrder.length, artifacts });
        const batchSize = Math.max(50, Math.min(2_000, input.pageChildBatchSize));
        const batches = Math.ceil(plan.total / batchSize);
        // Two children overlap so one batch's tail does not idle the run's window.
        const parallel = Math.min(batches, 2);
        const childConcurrency = Math.max(1, Math.floor(Math.min(128, input.pageConcurrency!) / Math.max(1, parallel)));
        const idPrefix = `${workflowInfo().workflowId}-pages-${workflowInfo().runId.slice(0, 8)}`;
        let nextBatch = 0;
        let childFailure: unknown;
        await Promise.all(Array.from({ length: parallel }, async () => {
          while (nextBatch < batches && !childFailure) {
            while (paused && !cancelled) await condition(() => !paused || cancelled);
            if (cancelled) return;
            const index = nextBatch++;
            const childInput: VisionPageBatchInput = {
              runId: input.runId, offset: index * batchSize, limit: batchSize,
              pageConcurrency: childConcurrency, pageBundleSize: Math.max(1, Math.min(8, input.pageBundleSize ?? 1)),
              slotGate: input.slotGate === true,
              ...(input.activityTaskQueue ? { activityTaskQueue: input.activityTaskQueue } : {}),
            };
            const workflowId = `${idPrefix}-${index}`;
            try {
              const child = await startChild(visionPageBatch, { workflowId, args: [childInput] });
              pageChildren.set(workflowId, child);
              if (paused) void child.signal(pauseSignal).catch(() => undefined);
              const childUsage = await child.result();
              usage = addUsage(usage, childUsage);
              progress = { ...progress, usage: { ...usage } };
            } catch (error) {
              childFailure ??= error;
            } finally {
              pageChildren.delete(workflowId);
            }
          }
        }));
        if (childFailure) throw childFailure;
        if (cancelled) throw ApplicationFailure.nonRetryable("Run cancelled by user");
      } else if (stageName === "vision-extract" && (input.pageConcurrency ?? 0) > 1) {
        const tasks = await prepareVisionPageTasks({ stageName, runId: input.runId, totalStages: stageOrder.length, artifacts });
        const bundleSize = Math.max(1, Math.min(8, input.pageBundleSize ?? 1));
        const bundles: typeof tasks[] = [];
        for (const task of tasks) {
          const previous = bundles[bundles.length - 1];
          if (previous && previous.length < bundleSize && previous[0]!.documentId === task.documentId) previous.push(task);
          else bundles.push([task]);
        }
        const concurrency = Math.max(1, Math.floor(Math.min(128, input.pageConcurrency!) / Math.min(2, bundleSize)));
        let cursor = 0;
        let pageFailure: unknown;
        await Promise.all(Array.from({ length: Math.min(bundles.length, concurrency) }, async () => {
          while (cursor < bundles.length && !pageFailure) {
            while (paused && !cancelled) await condition(() => !paused || cancelled);
            if (cancelled) return;
            const bundle = bundles[cursor++]!;
            try {
              const pageUsage = bundleSize > 1 ? await runVisionPageBundle(bundle) : await runVisionPageTask(bundle[0]!);
              usage = { inputTokens: usage.inputTokens + pageUsage.inputTokens, outputTokens: usage.outputTokens + pageUsage.outputTokens, costCents: usage.costCents + pageUsage.costCents };
              progress = { ...progress, usage: { ...usage } };
            } catch (error) { pageFailure = error; }
          }
        }));
        // Drain in-flight pages before any whole-run write, including the failure path.
        if (pageFailure) throw pageFailure;
        if (cancelled) throw ApplicationFailure.nonRetryable("Run cancelled by user");
      }

      // Recorded in workflow input: runs started without it keep one activity per stage.
      if (input.documentSharding && scaling && SHARDABLE_STAGES.includes(stageName)) {
        const shards = shardPlan(stageName);
        if (shards.length > 1) {
          const shardActivities = shardActivityProxies(input.activityTaskQueue);
          await scaling.quick.setRunShardDemand({ runId: input.runId, shards: shards.length });
          await runPageFanOut({
            bundles: shards.map((documentIds, shardIndex) => ({ documentIds, shardIndex })),
            concurrency: shards.length,
            run: async ({ documentIds, shardIndex }) => {
              try {
                // No artifacts: shards read them from the run row, and per-shard copies would bloat history.
                return await shardActivities.runPipelineStageShard({
                  stageName, runId: input.runId, totalStages: stageOrder.length, artifacts: {},
                  documentIds, shardIndex, shardCount: shards.length,
                  ...(input.slotGate ? { slotGate: true } : {}),
                });
              } catch (error) {
                if ((input.slotGate && isSlotUnavailable(error)) || cancelled) throw error;
                // The unsharded pass below processes these documents again.
                return { inputTokens: 0, outputTokens: 0, costCents: 0 };
              }
            },
            onUsage: (shardUsage) => {
              usage = addUsage(usage, shardUsage);
              progress = { ...progress, usage: { ...usage } };
            },
            isSlotUnavailable: (error) => input.slotGate === true && isSlotUnavailable(error),
            waitFor: (predicate) => condition(predicate),
            sleep: (ms) => sleep(ms),
            now: () => Date.now(),
            random: () => Math.random(),
            isPaused: () => paused,
            isCancelled: () => cancelled,
          });
          if (cancelled) throw ApplicationFailure.nonRetryable("Run cancelled by user");
        }
      }

      // The stage pass, plus the following stages that need no pre-work, in one activity.
      const groupEnd = groupable && scaling
        ? planStageGroupEnd({ stageOrder, start: i, groupable, needsPreWork })
        : i + 1;
      if (groupEnd - i > 1 && scaling) {
        const group = stageOrder.slice(i, groupEnd);
        const groupInput = {
          stageNames: [...group],
          runId: input.runId,
          totalStages: stageOrder.length,
          artifacts,
          // Stop between stages on a pause request; the loop resumes at the next stage.
          yieldToControl: true,
          ...(input.slotGate ? { slotGate: true } : {}),
        };
        // Queries and the failure record learn the group (not part of the command sequence).
        progress = { ...progress, stageGroup: [...group] };
        const result = await withStageSlot(() => scaling.longStage.runPipelineStages(groupInput));
        artifacts = { ...artifacts, ...result.artifacts };
        usage = addUsage(usage, result.usage);
        const ran = Math.max(1, Math.min(group.length, result.stagesRun ?? group.length));
        progress = { ...progress, stage: group[ran - 1]!, stageIndex: i + ran - 1, usage: { ...usage }, stageGroup: undefined };
        i += ran - 1;
        continue;
      }

      const stageActivities = scaling
        ? (isLongRunningStage(stageName) ? scaling.longStage : scaling.stage)
        : isLongRunningStage(stageName)
          ? legacyLongStageActivities
          : legacyStageActivities;
      const stageInput = {
        stageName,
        runId: input.runId,
        totalStages: stageOrder.length,
        artifacts,
        ...(input.slotGate ? { slotGate: true } : {}),
      };
      const result = await withStageSlot(() => stageActivities.runPipelineStage(stageInput));

      // Accumulate artifacts and usage
      artifacts = { ...artifacts, ...result.artifacts };
      usage = {
        inputTokens: usage.inputTokens + result.usage.inputTokens,
        outputTokens: usage.outputTokens + result.usage.outputTokens,
        costCents: usage.costCents + result.usage.costCents,
      };
    }

    // Mark run as completed
    progress = {
      stage: "completed",
      stageIndex: stageOrder.length,
      totalStages: stageOrder.length,
      usage: { ...usage },
      percentComplete: 100,
      documentsProgress: [],
      cpuMs: 0,
      rssBytes: 0,
    };

    await (scaling?.quick ?? quickActivities).completePipelineRun({ runId: input.runId });

    return { runId: input.runId, usage };
  } catch (error) {
    // Record failure in DB (best-effort — don't let this throw mask the real error)
    const message =
      rootCause(error) ?? (error instanceof Error ? error.message : String(error));
    await CancellationScope.nonCancellable(() => (scaling?.quick ?? quickActivities)
      .failPipelineRun({
        runId: input.runId,
        stage: progress.stage,
        message,
        ...(progress.stageGroup?.length ? { stageGroup: progress.stageGroup } : {}),
      })
      .catch(() => {}));

    throw error;
  }
}

/**
 * One bounded slice of a run's page tasks (at most pageChildBatchSize pages),
 * so a 100,000-page run is many small histories instead of one that hits
 * Temporal's event and size limits. Tasks are loaded from page_work_tasks by
 * offset; they never travel through the parent's history.
 */
export async function visionPageBatch(input: VisionPageBatchInput): Promise<UsageSummary> {
  let paused = false;
  let cancelled = false;
  let usage: UsageSummary = { inputTokens: 0, outputTokens: 0, costCents: 0 };
  setHandler(cancelSignal, () => { cancelled = true; });
  setHandler(pauseSignal, () => { paused = true; });
  setHandler(resumeSignal, () => { paused = false; });
  setHandler(usageQuery, () => usage);

  const activities = scalingActivityProxies(input.activityTaskQueue);
  const tasks = await activities.quick.loadVisionPageBatch({ runId: input.runId, offset: input.offset, limit: input.limit });
  const bundleSize = Math.max(1, Math.min(8, input.pageBundleSize));
  const bundles = bundlePageTasks(tasks.map((task) => (input.slotGate ? { ...task, slotGate: true } : task)), bundleSize);
  await runPageFanOut({
    bundles,
    concurrency: Math.max(1, Math.floor(Math.min(128, input.pageConcurrency) / Math.min(2, bundleSize))),
    run: (bundle) => bundle.length > 1
      ? activities.pages.runVisionPageBundle(bundle)
      : activities.pages.runVisionPageTask(bundle[0]!),
    onUsage: (pageUsage) => { usage = addUsage(usage, pageUsage); },
    isSlotUnavailable: (error) => input.slotGate && isSlotUnavailable(error),
    waitFor: (predicate) => condition(predicate),
    sleep: (ms) => sleep(ms),
    now: () => Date.now(),
    random: () => Math.random(),
    isPaused: () => paused,
    isCancelled: () => cancelled,
  });
  if (cancelled) throw ApplicationFailure.nonRetryable("Run cancelled by user");
  return usage;
}

// ── Deferred indexing: materialize pages on demand ──

const materializeActivities = proxyActivities<Activities>({
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 2, initialInterval: "2s", backoffCoefficient: 2, maximumInterval: "30 seconds" },
});

/**
 * Parses and indexes only the requested pages of one document. Started by
 * search on its own task queue with the deterministic id
 * `materialize:<documentId>:<hash(pages)>` (computed app-side), so an identical
 * concurrent start returns the running workflow. One activity per contiguous
 * range; a range that fails after retries reports its pages as failed.
 */
export async function materializePages(input: MaterializePagesInput): Promise<MaterializeResult> {
  const ranges = splitMaterializeRanges(input.pages);
  const settled = await Promise.all(ranges.map(async (pages): Promise<MaterializeResult> => {
    try {
      return await materializeActivities.materializePageRangeActivity({ ...input, pages });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { indexed: [], blocked: [], failed: pages.map((page) => ({ page, reason })), costCredits: 0 };
    }
  }));
  const result = mergeMaterializeResults(settled);
  await materializeActivities.completeMaterializeRun({ runId: input.runId, result });
  return result;
}

const pageRenderActivities = proxyActivities<Activities>({
  startToCloseTimeout: "2 minutes", heartbeatTimeout: "30 seconds",
  retry: { maximumAttempts: 3, initialInterval: "2s", maximumInterval: "15s" },
});
/** A new workflow type, independent of documentPipeline replay history. */
export async function renderDocumentPage(input: import("@docslurp/shared").RenderDocumentPageInput): Promise<void> {
  await pageRenderActivities.renderDocumentPageActivity(input);
}

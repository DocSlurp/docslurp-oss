import "../env.js";

/**
 * Temporal client for the API layer.
 *
 * Lazily connects to Temporal server and provides helpers to start
 * and query pipeline workflows.
 */

import { Client, Connection, WorkflowExecutionAlreadyStartedError, type WorkflowExecutionStatusName } from "@temporalio/client";
import {
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
  type Duration,
} from "@temporalio/common";
import {
  DEFAULT_MATERIALIZE_TASK_QUEUE,
  DEFAULT_DOCUMENT_EXPORT_TASK_QUEUE,
  DEFAULT_PAGE_RENDER_TASK_QUEUE,
  DOCUMENT_EXPORT_WORKFLOW,
  documentExportWorkflowId,
  PAGE_RENDER_WORKFLOW,
  pageRenderWorkflowId,
  MATERIALIZE_WORKFLOW,
  MAX_PAGE_FANOUT_PER_RUN,
  deferredProfilesEnabled,
  executionStageOrder,
  getPipelineStageOrder,
  pipelineStageOrder,
  runStageSchema,
  type MaterializePagesInput,
  type PipelineFeatures,
  type PipelineRunStage,
  type WorkerCapability,
  type WorkspaceRunTemporal,
} from "@docslurp/shared";
import { formatTemporalConnectionError } from "@docslurp/shared/temporal-connection";
import { createTemporalSecurityConfig } from "@docslurp/shared/temporal-security";

import { sql } from "../db.js";
import { configuredGatedFlags, effectiveFleetCapabilities, taskQueueForOrgKey } from "../services/worker-fleet.js";

const temporal = createTemporalSecurityConfig(process.env);
const WORKFLOW_ID_PREFIX = "run-";
const workflowExecutionTimeout = (
  process.env.TEMPORAL_WORKFLOW_EXECUTION_TIMEOUT?.trim() || "24 hours"
) as Duration;

let _client: Client | null = null;
let pendingClient: Promise<Client> | null = null;
let optionalRetryAt = 0;

// Request paths (uploads, retries) must not block on an unreachable Temporal:
// ingestion is durably queued in SQL and the run-start recovery loop starts
// deferred runs later. Background connects (boot warm-up, recovery loop) may
// wait longer, so a cold Temporal endpoint (DNS, TLS, an auto-started machine)
// still connects instead of failing the 2 s request deadline forever.
const REQUEST_CONNECT_TIMEOUT_MS = 2_000;
const BACKGROUND_CONNECT_TIMEOUT_MS = Math.max(
  REQUEST_CONNECT_TIMEOUT_MS,
  Number(process.env.TEMPORAL_BACKGROUND_CONNECT_TIMEOUT_MS ?? 10_000) || 10_000,
);

const connectedListeners = new Set<() => void>();

/**
 * Called each time the API's Temporal client (re)connects. Returns an
 * unsubscribe function. Used to start runs whose workflow start was deferred.
 */
export function onTemporalClientConnected(listener: () => void): () => void {
  connectedListeners.add(listener);
  return () => connectedListeners.delete(listener);
}

export function isTemporalClientConnected(): boolean {
  return _client !== null;
}

function notifyConnected(): void {
  for (const listener of connectedListeners) {
    try {
      listener();
    } catch (error) {
      console.warn(`[temporal] connect listener failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function connectClient(connectTimeout: number): Promise<Client> {
  return (async () => {
    try {
      const connection = await Connection.connect({
        address: temporal.address,
        tls: temporal.tls,
        connectTimeout,
      });
      _client = new Client({
        connection,
        namespace: temporal.namespace,
        identity: process.env.TEMPORAL_CLIENT_IDENTITY?.trim() || "docslurp-app"
      });
      optionalRetryAt = 0;
      queueMicrotask(notifyConnected);
      return _client;
    } catch (error) {
      optionalRetryAt = Date.now() + 5_000;
      throw new Error(formatTemporalConnectionError({
        address: temporal.address,
        namespace: temporal.namespace,
        taskQueue: temporal.taskQueue,
      }, "Temporal API client", error));
    } finally {
      pendingClient = null;
    }
  })();
}

/** Bound a request's wait on a (possibly longer) background connect. */
function withRequestDeadline(pending: Promise<Client>): Promise<Client> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(formatTemporalConnectionError({
        address: temporal.address,
        namespace: temporal.namespace,
        taskQueue: temporal.taskQueue,
      }, "Temporal API client", new Error("Failed to connect before the deadline (connection still pending)"))));
    }, REQUEST_CONNECT_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([pending, deadline]).finally(() => clearTimeout(timer));
}

async function getClient(options?: { background?: boolean }): Promise<Client> {
  if (_client) {
    return _client;
  }
  const background = options?.background === true;
  if (!pendingClient) {
    pendingClient = connectClient(background ? BACKGROUND_CONNECT_TIMEOUT_MS : REQUEST_CONNECT_TIMEOUT_MS);
    return pendingClient;
  }
  return background ? pendingClient : withRequestDeadline(pendingClient);
}

/**
 * Connect the client in the background (boot warm-up and the run-start
 * recovery loop) with the longer background deadline. Resolves true once
 * connected; never throws.
 */
let lastWarmFailureLogAt = 0;

export async function warmTemporalClient(): Promise<boolean> {
  if (_client) return true;
  try {
    await getClient({ background: true });
    return true;
  } catch (error) {
    // The recovery loop retries every few seconds; log at most once a minute.
    if (Date.now() - lastWarmFailureLogAt >= 60_000) {
      lastWarmFailureLogAt = Date.now();
      console.warn(`[temporal] background connect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }
}

async function getOptionalClient(): Promise<Client | null> {
  if (!_client && Date.now() < optionalRetryAt) {
    return null;
  }
  try {
    return await getClient();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[temporal] client unavailable: ${message}`);
    return null;
  }
}

/**
 * Page tasks one run may fan out to: the deployment's WORKER_PAGE_CONCURRENCY,
 * capped by the org's plan worker slots and the per-run fan-out ceiling.
 */
export function resolvePageConcurrency(envValue: string | undefined, orgWorkerSlots: number | null | undefined): number {
  const configured = Number.parseInt(envValue ?? "1", 10) || 1;
  const slots = orgWorkerSlots && orgWorkerSlots > 0 ? orgWorkerSlots : MAX_PAGE_FANOUT_PER_RUN;
  return Math.max(1, Math.min(configured, slots, MAX_PAGE_FANOUT_PER_RUN));
}

interface RunSlotScope {
  /** Org id, or workspace:<id> for runs without an org — matches worker_slot_leases.org_key. */
  orgKey: string;
  workerSlots: number | null;
}

async function runSlotScope(runId: string): Promise<RunSlotScope | null> {
  try {
    const [row] = await sql<{ org_key: string; worker_slots: number | null }[]>`
      select coalesce(r.org_id, 'workspace:' || r.workspace_id) as org_key, o.worker_slots
      from workspace_runs r
      left join organizations o on o.id = r.org_id
      where r.id = ${runId}
      limit 1
    `;
    return row ? { orgKey: row.org_key, workerSlots: row.worker_slots === null ? null : Number(row.worker_slots) } : null;
  } catch (error) {
    console.warn(`[temporal] worker slot lookup failed run=${runId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  return !["0", "false", "off", "no"].includes(normalized);
}

/**
 * Scaling options recorded in workflow input (so replay never depends on
 * later env changes): slot gating, child-workflow page batches, an optional
 * activity task queue, and document sharding.
 *
 * Document sharding splits per-document stages (extraction, summaries,
 * embedding, ...) into shards, one activity slot each, so a run fills free
 * slots across the fleet. Shards are capped by the org's worker slots: more
 * would only wait for a slot. WORKER_DOCUMENT_SHARDING=false turns it off
 * for new runs.
 */
export function resolveWorkflowScalingInput(
  env: NodeJS.ProcessEnv = process.env,
  route?: { loadtest: boolean },
  scope?: { workerSlots?: number | null } | null,
  capabilities?: ReadonlySet<WorkerCapability> | null,
): {
  slotGate?: boolean;
  pageChildBatchSize?: number;
  activityTaskQueue?: string;
  documentSharding?: { minDocsPerShard: number; maxShards: number; minPagesPerShard: number };
  groupLightStages?: boolean;
  groupableStages?: string[];
} {
  const batch = Number.parseInt(env.WORKER_PAGE_CHILD_BATCH_SIZE ?? "500", 10);
  // Load-test workers serve workflows and activities from their one queue.
  const activityTaskQueue = route?.loadtest ? undefined : env.TEMPORAL_ACTIVITY_TASK_QUEUE?.trim();
  const orgSlots = scope?.workerSlots ?? Number.parseInt(env.WORKER_DEFAULT_ORG_SLOTS ?? "50", 10);
  const maxShards = Math.min(
    Math.max(0, Number.parseInt(env.WORKER_MAX_DOCUMENT_SHARDS ?? "32", 10) || 0),
    Math.max(1, Number(orgSlots) || 1),
    64,
  );
  const sharding = envFlag(env.WORKER_DOCUMENT_SHARDING, true) && maxShards >= 2
    ? {
        minDocsPerShard: Math.max(1, Number.parseInt(env.WORKER_MIN_DOCS_PER_SHARD ?? "2", 10) || 2),
        maxShards,
        // A shard costs ~2-4 s of fixed overhead (cross-region DB round trips),
        // so each one should carry enough pages to be worth it.
        minPagesPerShard: Math.max(1, Number.parseInt(env.WORKER_MIN_PAGES_PER_SHARD ?? "16", 10) || 16),
      }
    : null;
  return {
    ...(envFlag(env.WORKER_SLOT_ENFORCEMENT, true) ? { slotGate: true } : {}),
    ...(Number.isFinite(batch) && batch > 0 ? { pageChildBatchSize: Math.max(50, Math.min(2_000, batch)) } : {}),
    ...(activityTaskQueue ? { activityTaskQueue } : {}),
    ...(sharding ? { documentSharding: sharding } : {}),
    // Adjacent light stages share one activity (worker LIGHT_STAGES); WORKER_GROUP_LIGHT_STAGES=false turns it off.
    ...(envFlag(env.WORKER_GROUP_LIGHT_STAGES, true) ? { groupLightStages: true } : {}),
    ...resolveGroupableStages(env, capabilities),
  };
}

/**
 * WORKER_GROUP_ADJACENT_STAGES: any adjacent stages share one activity unless
 * the workflow dispatches shards or page tasks for the later one
 * (worker/src/temporal/stage-groups.ts), instead of only LIGHT_STAGES. Each
 * boundary otherwise costs a Temporal round trip and a run reload (~3 s).
 * Default on unless NODE_ENV=production. WORKER_UNGROUPED_STAGES (comma list)
 * keeps named stages in activities of their own. WORKER_GROUP_LIGHT_STAGES=false
 * turns all grouping off.
 *
 * Gated on the worker fleet (services/worker-fleet.ts): with `capabilities`
 * given, the flag applies only when every worker advertises
 * workflow.group-adjacent-stages. Undefined or null = ungated.
 */
export function resolveGroupableStages(
  env: NodeJS.ProcessEnv = process.env,
  capabilities?: ReadonlySet<WorkerCapability> | null,
): { groupableStages?: string[] } {
  if (!envFlag(env.WORKER_GROUP_LIGHT_STAGES, true)) return {};
  if (!envFlag(env.WORKER_GROUP_ADJACENT_STAGES, env.NODE_ENV !== "production")) return {};
  if (capabilities && !capabilities.has("workflow.group-adjacent-stages")) return {};
  const ungrouped = new Set((env.WORKER_UNGROUPED_STAGES ?? "").split(",").map((stage) => stage.trim()).filter(Boolean));
  return { groupableStages: pipelineStageOrder.filter((stage) => !ungrouped.has(stage)) };
}

/**
 * The stage order recorded in workflow input (replay never depends on later
 * env changes). WORKER_INDEX_BEFORE_ENRICH runs `index` right after `embed`
 * so documents become searchable before summaries, structured extraction,
 * graph, page and proposition indexing finish; the run still completes only
 * after every stage. Default on outside production; false keeps the
 * canonical order. Gated like resolveGroupableStages, on
 * workflow.index-before-enrich.
 */
export function resolveWorkflowStageOrder(
  pipeline: PipelineFeatures,
  env: NodeJS.ProcessEnv = process.env,
  capabilities?: ReadonlySet<WorkerCapability> | null,
): PipelineRunStage[] {
  const indexBeforeEnrich = envFlag(env.WORKER_INDEX_BEFORE_ENRICH, env.NODE_ENV !== "production")
    && (!capabilities || capabilities.has("workflow.index-before-enrich"));
  return executionStageOrder(pipelineStageOrderForStart(pipeline), { indexBeforeEnrich });
}

/**
 * Load-test routing: runs of orgs listed in TEMPORAL_LOADTEST_ORG_IDS start
 * on TEMPORAL_LOADTEST_TASK_QUEUE, which only the load-test worker
 * fleet polls (fly.worker-loadtest.toml). Every other org stays on the
 * production queue, and production workers never poll the load-test queue.
 */
export function resolveRunTaskQueue(
  scope: Pick<RunSlotScope, "orgKey"> | null,
  defaultQueue: string,
  env: NodeJS.ProcessEnv = process.env,
): { taskQueue: string; loadtest: boolean } {
  return taskQueueForOrgKey(scope?.orgKey, defaultQueue, env);
}

/**
 * Temporal task-queue fairness (server >= 1.29 with fairness enabled, or
 * Temporal Cloud): backlogged tasks dispatch per org in proportion to its
 * plan's worker slots, so one Platinum batch cannot starve Free/Silver orgs
 * waiting in the same queue. Ignored by servers without fairness.
 */
export function resolveWorkflowPriority(scope: RunSlotScope | null, env: NodeJS.ProcessEnv = process.env) {
  if (!scope || !envFlag(env.TEMPORAL_FAIRNESS, true)) return undefined;
  const weight = Math.max(1, Math.min(1_000, scope.workerSlots ?? 1));
  // Fairness keys are limited to 64 bytes.
  return { fairnessKey: scope.orgKey.slice(0, 64), fairnessWeight: weight };
}

/**
 * Stage order handed to the workflow. With DOCSLURP_DEFERRED_PROFILES off the worker runs a stored
 * `map`/`visual` pipeline as `full`, so the explicit order must be compiled from that same coerced
 * pipeline; otherwise the workflow would skip the full stages the worker then expects.
 */
export function pipelineStageOrderForStart(pipeline: PipelineFeatures, flagEnabled = deferredProfilesEnabled()) {
  const effective = !flagEnabled && pipeline.indexingMode && pipeline.indexingMode !== "full"
    ? { ...pipeline, indexingMode: "full" as const }
    : pipeline;
  return getPipelineStageOrder(effective);
}

export async function startPipelineWorkflow(
  runId: string,
  pipeline: PipelineFeatures,
  options?: { restartExisting?: boolean }
): Promise<void> {
  const client = await getClient();
  const scope = await runSlotScope(runId);
  const pageConcurrency = resolvePageConcurrency(process.env.WORKER_PAGE_CONCURRENCY, scope?.workerSlots);
  const priority = resolveWorkflowPriority(scope);
  const route = resolveRunTaskQueue(scope, temporal.taskQueue);
  // Gated flags only take effect once every worker on the queue supports them
  // (services/worker-fleet.ts); unknown resolves to the old behaviour. Skipped
  // when no workflow-input flag is on (nothing to gate).
  const configured = configuredGatedFlags();
  const capabilities = configured.WORKER_INDEX_BEFORE_ENRICH || configured.WORKER_GROUP_ADJACENT_STAGES
    ? await effectiveFleetCapabilities(route.taskQueue)
    : null;
  await client.workflow.start("documentPipeline", {
    taskQueue: route.taskQueue,
    workflowId: `${WORKFLOW_ID_PREFIX}${runId}`,
    args: [{ runId, pipeline, stageOrder: resolveWorkflowStageOrder(pipeline, process.env, capabilities),
      pageBundleSize: Math.max(1, Math.min(8, Number.parseInt(process.env.WORKER_PAGE_BUNDLE_SIZE ?? "1", 10) || 1)),
      pageConcurrency, ...resolveWorkflowScalingInput(process.env, route, scope, capabilities) }],
    ...(priority ? { priority } : {}),
    // Let queued runs survive worker deploys and heavy-doc retries without
    // leaving SQL state stranded in "processing" when Temporal closes them.
    workflowExecutionTimeout,
    workflowIdReusePolicy: options?.restartExisting
      ? WorkflowIdReusePolicy.ALLOW_DUPLICATE
      : undefined,
    workflowIdConflictPolicy: options?.restartExisting
      ? WorkflowIdConflictPolicy.TERMINATE_EXISTING
      : undefined,
  });
}

/**
 * Start the worker's `materializePages` workflow on its own task queue. The
 * workflow id is deterministic per (document, page set), so an identical
 * concurrent start is an "already running" success, not an error.
 */
export async function startMaterializeWorkflow(
  input: MaterializePagesInput,
  workflowId: string,
): Promise<"started" | "already-running"> {
  const client = await getClient();
  try {
    await client.workflow.start(MATERIALIZE_WORKFLOW, {
      taskQueue: process.env.TEMPORAL_MATERIALIZE_TASK_QUEUE?.trim() || DEFAULT_MATERIALIZE_TASK_QUEUE,
      workflowId,
      args: [input],
      workflowExecutionTimeout: "15 minutes",
    });
    return "started";
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) return "already-running";
    throw error;
  }
}

export interface TemporalRunProgress {
  stage: string;
  /** Set while a stage group runs; `stage` is then only the group's first stage. */
  stageGroup?: string[];
  stageIndex: number;
  totalStages: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costCents: number;
  };
}

export async function queryPipelineProgress(
  runId: string
): Promise<TemporalRunProgress | null> {
  const client = await getOptionalClient();
  if (!client) {
    return null;
  }
  try {
    const handle = client.workflow.getHandle(
      `${WORKFLOW_ID_PREFIX}${runId}`
    );
    // Workers may be scaled to zero. Keep saved database progress available.
    return await client.connection.withDeadline(Date.now() + 2_000, () =>
      handle.query<TemporalRunProgress>("progress")
    );
  } catch {
    return null;
  }
}

function toIsoString(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export interface TemporalWorkflowDescription {
  workflowId: string;
  workflowRunId: string | null;
  workflowStatus: WorkflowExecutionStatusName | null;
  historyLength: number | null;
  historySizeBytes: number | null;
  startTime: string | null;
  executionTime: string | null;
  closeTime: string | null;
}

export async function describePipelineWorkflow(
  runId: string
): Promise<TemporalWorkflowDescription | null> {
  const client = await getOptionalClient();
  if (!client) {
    return null;
  }
  try {
    const handle = client.workflow.getHandle(
      `${WORKFLOW_ID_PREFIX}${runId}`
    );
    const description = await client.connection.withDeadline(Date.now() + 2_000, () =>
      handle.describe()
    );
    return {
      workflowId: description.workflowId,
      workflowRunId: description.runId,
      workflowStatus: description.status?.name ?? null,
      historyLength: description.historyLength ?? null,
      historySizeBytes: description.historySize ?? null,
      startTime: toIsoString(description.startTime),
      executionTime: toIsoString(description.executionTime),
      closeTime: toIsoString(description.closeTime),
    };
  } catch {
    return null;
  }
}

export async function getPipelineTemporalSnapshot(
  runId: string
): Promise<WorkspaceRunTemporal | null> {
  const queriedAt = new Date().toISOString();
  const [description, progress] = await Promise.all([
    describePipelineWorkflow(runId),
    queryPipelineProgress(runId),
  ]);

  if (!description && !progress) {
    return null;
  }

  // Inside a stage group the workflow only knows the group's first stage; the
  // run row (updated as each stage starts) has the current one, so report none.
  const grouped = (progress?.stageGroup?.length ?? 0) > 0;
  const parsedStage = progress?.stage && !grouped ? runStageSchema.safeParse(progress.stage) : null;
  const startTime = description?.startTime ?? null;
  const closeTime = description?.closeTime ?? null;
  const elapsedMs = startTime
    ? Math.max(
        0,
        new Date(closeTime ?? queriedAt).getTime() - new Date(startTime).getTime()
      )
    : null;

  return {
    workflowId: description?.workflowId ?? `${WORKFLOW_ID_PREFIX}${runId}`,
    workflowRunId: description?.workflowRunId ?? null,
    workflowStatus: description?.workflowStatus ?? null,
    stage: parsedStage?.success ? parsedStage.data : null,
    stageIndex: grouped ? null : progress?.stageIndex ?? null,
    totalStages: progress?.totalStages ?? null,
    historyLength: description?.historyLength ?? null,
    historySizeBytes: description?.historySizeBytes ?? null,
    startTime,
    executionTime: description?.executionTime ?? null,
    closeTime,
    elapsedMs,
    // Diagnostic tally only; the run's cost comes from usage_attribution.
    activityUsageTally: progress?.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
    },
    queriedAt,
  };
}

export async function signalPipelineCancel(runId: string): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle(
    `${WORKFLOW_ID_PREFIX}${runId}`
  );
  // Cancel in-flight activities too; a signal alone only stops between stages.
  await handle.cancel();
}

export async function signalPipelinePause(runId: string): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle(
    `${WORKFLOW_ID_PREFIX}${runId}`
  );
  await handle.signal("pause");
}

export async function signalPipelineResume(runId: string, timeoutMs = 5_000): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle(
    `${WORKFLOW_ID_PREFIX}${runId}`
  );
  // Resume runs inside the funding transaction: bound the actual gRPC call,
  // not just connection establishment or a detached Promise.race waiter.
  await client.connection.withDeadline(Date.now() + timeoutMs, () => handle.signal("resume"));
}

export interface TaskQueuePoller {
  identity: string;
  /** Epoch ms of the poller's last poll, or null when the server omits it. */
  lastAccessMs: number | null;
  /** Build id the worker reported (worker-versioning.ts), when the server returns it. */
  buildId: string | null;
}

/**
 * Task queues the worker fleet polls: the workflow queue, plus the separate
 * activity queue when TEMPORAL_ACTIVITY_TASK_QUEUE is set.
 */
export function workerTaskQueues(env: NodeJS.ProcessEnv = process.env): Array<{ name: string; type: "workflow" | "activity" }> {
  const activityQueue = env.TEMPORAL_ACTIVITY_TASK_QUEUE?.trim();
  if (activityQueue && activityQueue !== temporal.taskQueue) {
    return [{ name: temporal.taskQueue, type: "workflow" }, { name: activityQueue, type: "activity" }];
  }
  return [{ name: temporal.taskQueue, type: "activity" }];
}

/**
 * Pollers Temporal has seen recently on a task queue (alert evaluator). Uses
 * the background connect deadline and throws when Temporal is unreachable so
 * the caller can tell "no workers" from "no Temporal".
 */
export async function describeTaskQueuePollers(
  taskQueue: string,
  type: "workflow" | "activity",
  timeoutMs = 5_000,
): Promise<TaskQueuePoller[]> {
  const client = await getClient({ background: true });
  const response = await client.connection.withDeadline(Date.now() + timeoutMs, () =>
    client.workflowService.describeTaskQueue({
      namespace: temporal.namespace,
      taskQueue: { name: taskQueue },
      // 1 = TASK_QUEUE_TYPE_WORKFLOW, 2 = TASK_QUEUE_TYPE_ACTIVITY.
      taskQueueType: type === "activity" ? 2 : 1,
    })
  );
  return (response.pollers ?? []).map((poller) => {
    const seconds = poller.lastAccessTime?.seconds;
    const nanos = poller.lastAccessTime?.nanos ?? 0;
    const lastAccessMs = seconds === undefined || seconds === null
      ? null
      : Number(seconds) * 1000 + Math.floor(Number(nanos) / 1e6);
    const buildId = poller.deploymentOptions?.buildId || poller.workerVersionCapabilities?.buildId || null;
    return { identity: poller.identity ?? "", lastAccessMs, buildId };
  });
}

/**
 * Readiness probe (`/ready`): Temporal answers DescribeNamespace for the
 * configured namespace within `timeoutMs`. Throws when it does not.
 */
export async function describeTemporalNamespace(timeoutMs = 2_000): Promise<void> {
  const client = await getClient({ background: true });
  await client.connection.withDeadline(Date.now() + timeoutMs, () =>
    client.workflowService.describeNamespace({ namespace: temporal.namespace })
  );
}

/** A deterministic exact-page workflow coalesces concurrent browser requests. */
export async function startPageRenderWorkflow(input: import("@docslurp/shared").RenderDocumentPageInput): Promise<void> {
  const client = await getClient();
  try {
    await client.workflow.start(PAGE_RENDER_WORKFLOW, {
      taskQueue: process.env.TEMPORAL_PAGE_RENDER_TASK_QUEUE?.trim() || DEFAULT_PAGE_RENDER_TASK_QUEUE,
      workflowId: pageRenderWorkflowId(input), args: [input],
      workflowExecutionTimeout: "5 minutes",
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
}

/** One workflow per export id; a duplicate start (double click, retry) is a no-op. */
export async function startDocumentExportWorkflow(input: import("@docslurp/shared").BuildDocumentExportInput): Promise<void> {
  const client = await getClient();
  try {
    await client.workflow.start(DOCUMENT_EXPORT_WORKFLOW, {
      taskQueue: process.env.TEMPORAL_DOCUMENT_EXPORT_TASK_QUEUE?.trim() || DEFAULT_DOCUMENT_EXPORT_TASK_QUEUE,
      workflowId: documentExportWorkflowId(input.exportId), args: [input],
      // Four 2-hour attempts with backoff; the export sweep fails stalled exports after 10 hours.
      workflowExecutionTimeout: "9 hours",
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
}

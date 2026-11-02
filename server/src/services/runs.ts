import { publicDiagnostics, publicDocumentError, publicProcessingMessage, type ApiErrorCode } from "@docslurp/shared";
import {
  planRunControlUpdate,
  runLifecycle,
  type RunControlAction,
  type RunRetryOutcome,
} from "./run-lifecycle.js";

import {
  compilePipelinePlan,
  effectiveIndexingMode,
  findMissingReuseInputs,
  withoutStageSelection,
  workspaceRunEventSchema,
  workspaceRunProgressSnapshotSchema,
  workspaceRunStageStateSchema,
  type DocumentRecord,
  type PipelineFeatures,
  type WorkspaceRun,
  type WorkspaceRunEvent,
  type WorkspaceRunProgressSnapshot,
  type WorkspaceRunStageState,
} from "@docslurp/shared";

import { runCreation } from "./run-creation.js";
import {
  jsonRecord,
  mapDocument,
  mapWorkspaceRun,
  serializeOptionalTimestamp,
  serializeTimestamp,
  type DocumentRow,
  type WorkspaceRunRow,
} from "./run-records.js";
import { sql } from "../db.js";
import { RUN_EVENTS_CHANNEL, RunEventHub, type RunEventHubRow } from "./run-event-hub.js";
import { env as apiEnv } from "../config.js";
import { getPipelineTemporalSnapshot } from "../lib/temporal.js";
import { buildProgressModule } from "./progress-snapshot.js";
import {
  buildRunProcessingPreview,
  getRunProcessingPreview,
} from "./run-processing-preview.js";
import {
  canContributeToWorkspace,
  getWorkspaceAccess,
  listAccessibleWorkspaceIds,
} from "./organizations.js";
import {
  admitRunSpend,
  assertCanSpend,
  SpendBlockedError,
} from "./billing/spend-guard.js";
import { resumeSpendPausedRunOutcome } from "./spend-paused-runs.js";
import {
  runUsageCostSummaries,
  runUsageCostTotals,
  summarizeRunUsageCost,
} from "./usage-attribution.js";
import { processSingleton } from "../lib/process-singleton.js";
import { extractNotReprocessable, ReprocessRejectedError } from "./reprocess-errors.js";

export { summarizeRunUsageCost };
export { isRunCreationBlockedError, RunCreationBlockedError } from "./run-creation.js";

export { buildRunProcessingPreview, getRunProcessingPreview };

type StageStateRow = {
  run_id: string;
  document_id: string | null;
  stage_name: WorkspaceRunStageState["stage"];
  status: WorkspaceRunStageState["status"];
  attempts: number;
  artifact_uri: string | null;
  stats: Record<string, unknown> | null;
  error: string | null;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  updated_at: string | Date;
};

type WorkspaceRunEventRow = {
  id: string;
  user_id: string;
  run_id: string;
  document_id: string | null;
  stage_name: WorkspaceRunEvent["stage"];
  event_type: WorkspaceRunEvent["type"];
  status: WorkspaceRunEvent["status"];
  message: string | null;
  progress: Record<string, unknown> | null;
  stats: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
  created_at: string | Date;
};

const temporalTerminalRunMessages = {
  FAILED:
    "Temporal workflow failed before pipeline cleanup could persist the final run state.",
  TIMED_OUT:
    "Temporal workflow timed out before pipeline cleanup could persist the final run state.",
  CANCELLED:
    "Temporal workflow was cancelled before pipeline cleanup could persist the final run state.",
  TERMINATED:
    "Temporal workflow was terminated before pipeline cleanup could persist the final run state.",
} as const;

const STALLED_RUN_HEARTBEAT_GRACE_MS = Math.max(
  60_000,
  Number(process.env.RUN_STALLED_HEARTBEAT_GRACE_MS ?? 5 * 60_000),
);

type RunHeartbeatRow = {
  last_heartbeat_at: string | Date | null;
  lease_expires_at: string | Date | null;
  updated_at: string | Date;
};

function timestampMs(value: string | Date | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function shouldFailStaleProcessingRun(args: {
  runStatus: WorkspaceRun["status"];
  temporalStatus: string | null;
  lastHeartbeatAt: string | Date | null;
  leaseExpiresAt: string | Date | null;
  updatedAt: string | Date;
  nowMs?: number;
  graceMs?: number;
}): boolean {
  if (args.runStatus !== "processing") {
    return false;
  }

  if (
    args.temporalStatus &&
    !["RUNNING", "UNKNOWN", "UNSPECIFIED"].includes(args.temporalStatus)
  ) {
    return false;
  }

  const referenceMs =
    timestampMs(args.leaseExpiresAt) ??
    timestampMs(args.lastHeartbeatAt) ??
    timestampMs(args.updatedAt);
  if (referenceMs === null) {
    return false;
  }

  return (args.nowMs ?? Date.now()) - referenceMs > (args.graceMs ?? STALLED_RUN_HEARTBEAT_GRACE_MS);
}

async function loadRunHeartbeat(runId: string): Promise<RunHeartbeatRow | null> {
  const [row] = await sql<RunHeartbeatRow[]>`
    select last_heartbeat_at, lease_expires_at, updated_at
    from workspace_runs
    where id = ${runId}
    limit 1
  `;

  return row ?? null;
}

async function markRunFailedFromReconciliation(args: {
  run: WorkspaceRun;
  stage: WorkspaceRun["stage"];
  message: string;
  stats: Record<string, unknown>;
  payload: Record<string, unknown>;
}): Promise<WorkspaceRun> {
  const row = await runLifecycle.fail(args.run.id, {
    stage: args.stage,
    message: args.message,
    fromStatuses: ["queued", "processing"],
    stats: args.stats,
    payload: args.payload,
  });

  if (!row) {
    return args.run;
  }

  return mapWorkspaceRun({
    ...(row as unknown as WorkspaceRunRow),
    workspace_name: args.run.workspaceName,
  }, args.run);
}

async function reconcileTemporalRunState(
  run: WorkspaceRun,
  temporal: Awaited<ReturnType<typeof getPipelineTemporalSnapshot>>,
): Promise<WorkspaceRun> {
  const workflowStatus = temporal?.workflowStatus ?? null;
  if (
    run.status === "completed" ||
    run.status === "failed"
  ) {
    return run;
  }

  // A newly queued retry may briefly observe the previous workflow execution.
  if (run.status === "queued" && temporal?.closeTime &&
      new Date(temporal.closeTime).getTime() < new Date(run.updatedAt).getTime()) {
    return run;
  }

  const terminalMessage =
    temporalTerminalRunMessages[
      workflowStatus as keyof typeof temporalTerminalRunMessages
    ] ?? null;

  if (terminalMessage) {
    const nowIso = new Date().toISOString();
    const nextStage = temporal?.stage ?? run.stage;
    const nextStats = {
      ...(run.stats ?? {}),
      temporalReconciledAt: nowIso,
      temporalWorkflowStatus: workflowStatus,
      temporalCloseTime: temporal?.closeTime ?? null,
    };

    return await markRunFailedFromReconciliation({
      run,
      stage: nextStage,
      message: terminalMessage,
      stats: nextStats,
      payload: {
        reconciledFromStatus: run.status,
        workflowStatus,
        workflowRunId: temporal?.workflowRunId ?? null,
      },
    });
  }

  const heartbeat = run.status === "processing"
    ? await loadRunHeartbeat(run.id)
    : null;
  const stalled = heartbeat
    ? shouldFailStaleProcessingRun({
        runStatus: run.status,
        temporalStatus: workflowStatus,
        lastHeartbeatAt: heartbeat.last_heartbeat_at,
        leaseExpiresAt: heartbeat.lease_expires_at,
        updatedAt: heartbeat.updated_at,
      })
    : false;

  if (!stalled) {
    return run;
  }

  const nowIso = new Date().toISOString();
  const nextStage = temporal?.stage ?? run.stage;
  const lastHeartbeatAt = serializeOptionalTimestamp(heartbeat?.last_heartbeat_at ?? null);
  const leaseExpiresAt = serializeOptionalTimestamp(heartbeat?.lease_expires_at ?? null);
  const message = workflowStatus === "RUNNING"
    ? "Worker heartbeat expired while Temporal still reports the workflow running. Marked failed so indexing can be restarted."
    : "Worker heartbeat expired and no active Temporal progress was available. Marked failed so indexing can be restarted.";
  const nextStats = {
    ...(run.stats ?? {}),
    stalledReconciledAt: nowIso,
    temporalWorkflowStatus: workflowStatus,
    lastHeartbeatAt,
    leaseExpiresAt,
  };

  return await markRunFailedFromReconciliation({
    run,
    stage: nextStage,
    message,
    stats: nextStats,
    payload: {
      reconciledFromStatus: run.status,
      workflowStatus,
      workflowRunId: temporal?.workflowRunId ?? null,
      lastHeartbeatAt,
      leaseExpiresAt,
    },
  });
}

/** Fill runs' cost from the usage ledger in one statement. */
export async function withRunCosts(runs: WorkspaceRun[]): Promise<WorkspaceRun[]> {
  if (runs.length === 0) return runs;
  const costs = await runUsageCostSummaries(runs.map((run) => run.id));
  return runs.map((run) => {
    const cost = costs.get(run.id);
    return cost ? { ...run, costCents: cost.costCents, computeEstimated: cost.computeEstimated, billedCostCents: cost.billedCostCents } : run;
  });
}

function mapStageState(row: StageStateRow): WorkspaceRunStageState {
  return workspaceRunStageStateSchema.parse({
    runId: row.run_id,
    documentId: row.document_id,
    stage: row.stage_name,
    status: row.status,
    attempts: row.attempts,
    artifactUri: row.artifact_uri,
    stats: publicDiagnostics(row.stats ?? {}),
    error: publicDocumentError(row.error),
    startedAt: serializeOptionalTimestamp(row.started_at),
    completedAt: serializeOptionalTimestamp(row.completed_at),
    updatedAt: serializeTimestamp(row.updated_at),
  });
}

function mapWorkspaceRunEvent(row: WorkspaceRunEventRow): WorkspaceRunEvent {
  return workspaceRunEventSchema.parse({
    id: row.id,
    userId: row.user_id,
    runId: row.run_id,
    documentId: row.document_id,
    stage: row.stage_name,
    type: row.event_type,
    status: row.status,
    message: row.message ? publicProcessingMessage(row.status ?? row.event_type.split(".").at(-1) ?? null) : null,
    progress: row.progress ?? {},
    stats: publicDiagnostics(row.stats ?? {}),
    payload: publicDiagnostics(row.payload ?? {}),
    createdAt: serializeTimestamp(row.created_at),
  });
}

export async function listRuns(userId: string, activityOnly = false): Promise<WorkspaceRun[]> {
  const workspaceIds = await listAccessibleWorkspaceIds(userId);
  if (workspaceIds.length === 0) {
    return [];
  }

  if (activityOnly) {
    // Include every active upload, even when it is older than the history window.
    const rows = await sql<WorkspaceRunRow[]>`
      select runs.*, workspaces.name as workspace_name
      from workspace_runs runs
      join workspaces on workspaces.id = runs.workspace_id
      where runs.workspace_id = any(${sql.array(workspaceIds)})
        and (runs.status in ('queued', 'processing') or runs.updated_at > now() - interval '5 minutes')
      order by runs.updated_at desc
    `;
    const result: WorkspaceRun[] = [];
    // Reconcile cold leases without asking Temporal about every healthy upload.
    for (let index = 0; index < rows.length; index += 8) {
      result.push(...await Promise.all(rows.slice(index, index + 8).map(async row => {
        const run = mapWorkspaceRun(row);
        if (run.controlState === "paused" || !shouldFailStaleProcessingRun({
          runStatus: run.status, temporalStatus: null,
          lastHeartbeatAt: row.last_heartbeat_at ?? null,
          leaseExpiresAt: row.lease_expires_at ?? null, updatedAt: run.updatedAt,
        })) return run;
        return reconcileTemporalRunState(run, await getPipelineTemporalSnapshot(run.id));
      })));
    }
    return await withRunCosts(result);
  }

  const rows = await sql<WorkspaceRunRow[]>`
    select
      runs.*,
      workspaces.name as workspace_name
    from workspace_runs runs
    join workspaces on workspaces.id = runs.workspace_id
    where runs.workspace_id = any(${sql.array(workspaceIds)})
    order by runs.priority desc, runs.created_at desc
    limit 50
  `;

  return await withRunCosts(rows.map((row) => mapWorkspaceRun(row)));
}

export async function getRun(
  runId: string,
  userId: string,
  /** `cost: false` skips the usage aggregate (costCents 0) for callers that never return the run. */
  options: { cost?: boolean } = {},
): Promise<WorkspaceRun | null> {
  const workspaceIds = await listAccessibleWorkspaceIds(userId);
  if (workspaceIds.length === 0) {
    return null;
  }

  const [row] = await sql<WorkspaceRunRow[]>`
    select
      runs.*,
      workspaces.name as workspace_name
    from workspace_runs runs
    join workspaces on workspaces.id = runs.workspace_id
    where runs.id = ${runId} and runs.workspace_id = any(${sql.array(workspaceIds)})
    limit 1
  `;

  if (!row) return null;
  const run = mapWorkspaceRun(row);
  // Progress snapshots compute the cost themselves (buildRunProgressSnapshot).
  return options.cost === false ? run : (await withRunCosts([run]))[0]!;
}

export async function listDocuments(userId: string): Promise<DocumentRecord[]> {
  const workspaceIds = await listAccessibleWorkspaceIds(userId);
  if (workspaceIds.length === 0) {
    return [];
  }

  const rows = await sql<DocumentRow[]>`
    select *
    from documents
    where workspace_id = any(${sql.array(workspaceIds)})
    order by created_at desc
    limit 100
  `;

  return rows.map(mapDocument);
}

export async function getDocumentVersions(
  docId: string,
  userId: string,
): Promise<DocumentRecord[]> {
  const workspaceIds = await listAccessibleWorkspaceIds(userId);
  if (workspaceIds.length === 0) {
    return [];
  }

  const versions: DocumentRecord[] = [];
  let currentId: string | null = docId;

  while (currentId !== null) {
    const lookupId: string = currentId;
    const rows: DocumentRow[] = await sql<DocumentRow[]>`
      select * from documents
      where id = ${lookupId} and workspace_id = any(${sql.array(workspaceIds)})
      limit 1
    `;

    const row: DocumentRow | undefined = rows[0];
    if (!row) break;
    versions.push(mapDocument(row));
    currentId = row.previous_version_id;
  }

  return versions;
}

export { ReprocessRejectedError, isReprocessRejectedError } from "./reprocess-errors.js";

type ReuseSourceRow = {
  id: string;
  status: string;
  purged_at: Date | string | null;
};

/**
 * A partial reprocess reuses the skipped stages' outputs from the source
 * documents, so every source document must have completed, still hold its
 * derived data, and carry the artifacts the executed stages read.
 */
async function assertReusableSource(
  original: Pick<WorkspaceRun, "id" | "artifacts">,
  plan: ReturnType<typeof compilePipelinePlan>,
  documentIds?: string[],
): Promise<void> {
  const [runRow] = await sql<{ artifacts_purged_at: Date | string | null }[]>`
    select artifacts_purged_at from workspace_runs where id = ${original.id}
  `;
  const sources = await sql<ReuseSourceRow[]>`
    select id, status, purged_at from documents where run_id = ${original.id}
    ${documentIds ? sql`and id = any(${documentIds})` : sql``}
    order by created_at, id
  `;
  checkReusableSource(original, runRow?.artifacts_purged_at ?? null, sources, plan);
}

/** Pure reuse validation over already-loaded rows (shared by the single-run and batched paths). */
function checkReusableSource(
  original: Pick<WorkspaceRun, "id" | "artifacts">,
  artifactsPurgedAt: Date | string | null,
  sources: ReuseSourceRow[],
  plan: ReturnType<typeof compilePipelinePlan>,
): void {
  if (artifactsPurgedAt) {
    throw new ReprocessRejectedError(
      "The source run's artifacts were purged by retention; reprocess every stage instead.",
      409,
      "source_not_reusable",
      { reason: "artifacts_purged" },
    );
  }

  const unusable = sources.filter((doc) => doc.status !== "completed" || doc.purged_at);
  if (unusable.length > 0) {
    throw new ReprocessRejectedError(
      "Only completed documents whose outputs still exist can be reprocessed from a later stage.",
      409,
      "source_not_reusable",
      { documents: unusable.slice(0, 20).map((doc) => ({ id: doc.id, status: doc.status, purged: Boolean(doc.purged_at) })) },
    );
  }

  const artifacts = original.artifacts ?? {};
  const missing = sources.flatMap((doc) => {
    const prefix = `${doc.id}:`;
    const names = new Set(
      Object.keys(artifacts)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length)),
    );
    return findMissingReuseInputs(plan, names).map((gap) => ({ documentId: doc.id, ...gap }));
  });
  if (missing.length > 0) {
    throw new ReprocessRejectedError(
      "The source run lacks artifacts the requested stages need; restart from an earlier stage.",
      409,
      "missing_stage_artifacts",
      { missing: missing.slice(0, 20) },
    );
  }
}


/**
 * Reprocess a run into a new run with new document versions. Without a stage
 * selection every enabled stage runs again. With `stageFrom` / `stages`
 * the new run executes only the planned stages (see compilePipelinePlan) and
 * the worker seeds the others from the source documents, which are validated
 * here so an impossible restart fails with a 4xx instead of a broken run.
 * The new Run is created, started or deferred by Run creation.
 */
export async function reprocessRun(
  runId: string,
  userId: string,
  options?: { stages?: string[]; stageFrom?: string; speedBoost?: boolean },
): Promise<{ run: WorkspaceRun; deferredReason: string | null } | null> {
  const original = await getRun(runId, userId);
  if (!original) return null;
  const access = await getWorkspaceAccess(original.workspaceId, userId);
  if (!access || !canContributeToWorkspace(access, userId)) {
    throw new Error("Forbidden");
  }
  const [extractRun] = await sql<{ extract_id: string | null }[]>`select extract_id from workspace_runs where id = ${runId}`;
  if (extractRun?.extract_id) throw extractNotReprocessable();

  const docs = await sql<DocumentRow[]>`
    select * from documents where run_id = ${runId} order by created_at, id
  `;

  // A mode-switch backfill re-keys onto the source document, which keeps its original run: the run pipeline
  // still names the old mode. The document's own indexing_mode is the truth, so reprocess follows it.
  const liveModes = new Set(docs.filter((doc) => !doc.superseded_at && doc.indexing_mode).map((doc) => doc.indexing_mode as string));
  const adoptedMode = liveModes.size === 1 ? effectiveIndexingMode([...liveModes][0] as PipelineFeatures["indexingMode"]) : null;

  // A reprocess of a partial run starts from that run's full feature set.
  const pipelineConfig: PipelineFeatures = {
    ...(JSON.parse(JSON.stringify(withoutStageSelection(original.pipeline))) as PipelineFeatures),
    speedBoost: options?.speedBoost === true,
    ...(adoptedMode ? { indexingMode: adoptedMode } : {}),
    ...(options?.stages?.length ? { stageSubset: [...options.stages] } : {}),
    ...(options?.stageFrom && !options?.stages?.length ? { restartFromStage: options.stageFrom } : {}),
  };
  const plan = compilePipelinePlan(pipelineConfig);
  if (plan.stageOrder.length === 0) {
    throw new ReprocessRejectedError(
      "None of the requested stages is enabled in this run's pipeline.",
      400,
      "no_stages_to_run",
      { requested: options?.stages ?? options?.stageFrom ?? null },
    );
  }
  const partial = plan.reusedStages.length > 0;
  if (partial) await assertReusableSource(original, plan);

  const created = await runCreation.create({
    userId,
    workspaceId: original.workspaceId,
    kind: original.kind,
    priority: original.priority ?? 0,
    speedBoost: options?.speedBoost === true,
    pipeline: pipelineConfig,
    sources: { kind: "versionsOf", documentIds: docs.map((doc) => doc.id), reuse: partial },
  });
  return { run: created.run, deferredReason: created.deferredReason };
}

type RunEventHubRowSql = Omit<WorkspaceRunEventRow, "stats" | "payload"> & { cursor: string };

function mapHubRow(row: RunEventHubRowSql): RunEventHubRow {
  // Live deltas stay compact, as the NOTIFY payloads were: full stats and
  // payload remain available from the event and progress APIs.
  return { event: mapWorkspaceRunEvent({ ...row, stats: {}, payload: {} }), cursor: row.cursor };
}

let runEventHub: RunEventHub | null = null;

function getRunEventHub(): RunEventHub {
  // One hub (and LISTEN callback) per process, also across dev module reloads.
  runEventHub ??= processSingleton("run-event-hub", () => new RunEventHub({
    listen: async (onHint) => {
      const listener = await sql.listen(RUN_EVENTS_CHANNEL, (payload) => {
        if (payload) onHint(payload);
      });
      return { close: () => listener.unlisten() };
    },
    fetchEvents: async (cursors, limit) => {
      const rows = await sql<RunEventHubRowSql[]>`
        select
          events.id, events.user_id, events.run_id, events.document_id, events.stage_name,
          events.event_type, events.status, events.message, events.progress,
          events.created_at::text, to_char(events.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor
        from jsonb_to_recordset(${sql.json(cursors.map(({ runId, after }) => ({ run_id: runId, after })))}::jsonb)
          as wanted(run_id text, after timestamptz)
        join workspace_run_events events
          on events.run_id = wanted.run_id and events.created_at >= wanted.after
        order by events.created_at asc, events.id asc
        limit ${limit}
      `;
      return rows.map(mapHubRow);
    },
    latestEvents: async (runId, lookbackMs) => {
      const rows = await sql<RunEventHubRowSql[]>`
        select
          events.id, events.user_id, events.run_id, events.document_id, events.stage_name,
          events.event_type, events.status, events.message, events.progress,
          events.created_at::text, to_char(events.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor
        from workspace_run_events events
        where events.run_id = ${runId}
          and events.created_at >= (
            select max(created_at) from workspace_run_events where run_id = ${runId}
          ) - (${lookbackMs} * interval '1 millisecond')
      `;
      return rows.map(mapHubRow);
    },
  }));
  return runEventHub;
}

/**
 * Live run events for SSE routes: one run's (`runId`) or all runs'. Events
 * are read by cursor from workspace_run_events; NOTIFY only wakes the reader
 * (see run-event-hub.ts). Callers still check access per event.
 */
export async function listenForRunEvents(
  onEvent: (event: WorkspaceRunEvent) => void | Promise<void>,
  filter: { runId?: string } = {},
): Promise<{ close: () => Promise<void> }> {
  return await getRunEventHub().subscribe(onEvent, filter);
}

export async function retryRun(
  runId: string,
  userId: string,
): Promise<{ run: WorkspaceRun; outcome: RunRetryOutcome } | null> {
  const run = await getRun(runId, userId);
  if (!run) {
    return null;
  }
  const access = await getWorkspaceAccess(run.workspaceId, userId);
  if (!access || !canContributeToWorkspace(access, userId)) {
    throw new Error("Forbidden");
  }

  // All retries retain their immutable original mode. Admission, checkpoint reset,
  // queued transition and lease acquisition commit together; Temporal starts only afterward.
  let outcome: RunRetryOutcome;
  {
    const notRetryable = Symbol("retry-no-longer-eligible");
    try {
      const prepared = await admitRunSpend(run.orgId, run.workspaceId, async tx => {
        const status = await runLifecycle.prepareRetry(run, tx);
        // Abort admission before its post-callback lease acquisition. A stale or
        // clean completed run must not retain credits for work it cannot retry.
        if (status === "not-retryable") throw notRetryable;
        return status;
      }, { speedBoost: run.pipeline.speedBoost === true, leaseRunId: run.id });
      outcome = { status: prepared, start: await runLifecycle.start(run, { restartExisting: true }) };
    } catch (error) {
      if (error !== notRetryable) throw error;
      outcome = { status: "not-retryable" };
    }
  }
  if (outcome.status === "not-retryable") return { run, outcome };
  return { run: (await getRun(run.id, userId)) ?? run, outcome };
}

export { planRunControlUpdate, type RunControlAction };

export async function controlRun(
  runId: string,
  userId: string,
  input: { action: RunControlAction; priority?: number },
): Promise<WorkspaceRun | null> {
  const run = await getRun(runId, userId);
  if (!run) {
    return null;
  }
  const access = await getWorkspaceAccess(run.workspaceId, userId);
  if (!access || !canContributeToWorkspace(access, userId)) {
    throw new Error("Forbidden");
  }

  if (
    ["completed", "failed"].includes(run.status) &&
    !["reprioritize", "recover"].includes(input.action)
  ) {
    return run;
  }

  if (input.action === "resume") {
    // Resuming continues spending; a run paused for credits or budget stays
    // paused until the org may spend again.
    await assertCanSpend(run.orgId, run.workspaceId);
    // A spend-paused run is still in flight: resume it in place. With credit
    // leases it resumes only if it gets a lease; a refusal must not fall
    // through to the operator resume below.
    const outcome = await resumeSpendPausedRunOutcome(run.id);
    if (outcome.status === "resumed" || outcome.status === "deferred") return getRun(run.id, userId);
    if (outcome.status === "blocked") {
      const code = (["workspace_budget_paused", "org_budget_paused", "plan_not_entitled"] as const)
        .find((candidate) => candidate === outcome.reason) ?? "credit_exhausted";
      throw new SpendBlockedError(
        code === "credit_exhausted"
          ? "Out of credits: other runs in this organization hold the remaining credits. " +
            "Buy credits or turn on auto top-up at /app/billing to continue."
          : "AI processing is paused for this workspace or organization. Raise the budget to resume.",
        code,
      );
    }
  }
  const changedRunId = await runLifecycle.control(run, input);
  return changedRunId ? getRun(changedRunId, userId) : null;
}

export async function listRunStageStates(
  runId: string,
  userId: string,
): Promise<WorkspaceRunStageState[]> {
  const run = await getRun(runId, userId);
  if (!run) {
    return [];
  }

  return await listRunStageStatesForRunId(run.id);
}

async function listRunStageStatesForRunId(
  runId: string,
): Promise<WorkspaceRunStageState[]> {
  const rows = await sql<StageStateRow[]>`
    select
      rss.run_id,
      null::text as document_id,
      rss.stage_name,
      rss.status,
      rss.attempts,
      rss.artifact_uri,
      rss.stats,
      rss.error,
      rss.started_at::text,
      rss.completed_at::text,
      rss.updated_at::text
    from workspace_run_stage_states rss
    join workspace_runs runs on runs.id = rss.run_id
    where rss.run_id = ${runId}
    union all
    select
      drss.run_id,
      drss.document_id,
      drss.stage_name,
      drss.status,
      drss.attempts,
      drss.artifact_uri,
      drss.stats,
      drss.error,
      drss.started_at::text,
      drss.completed_at::text,
      drss.updated_at::text
    from document_run_stage_states drss
    join workspace_runs runs on runs.id = drss.run_id
    where drss.run_id = ${runId}
    order by updated_at asc
  `;

  return rows.map(mapStageState);
}

export async function listRunEvents(args: {
  runId: string;
  userId: string;
  after?: string;
  limit?: number;
}): Promise<WorkspaceRunEvent[]> {
  const run = await getRun(args.runId, args.userId);
  if (!run) {
    return [];
  }

  return await listRunEventsForRunId({
    runId: run.id,
    after: args.after,
    limit: args.limit,
  });
}

export async function listRunEventsForRunId(args: {
  runId: string;
  after?: string;
  limit?: number;
}): Promise<WorkspaceRunEvent[]> {
  const limit = Math.max(1, Math.min(args.limit ?? 50, 200));
  const rows = await sql<WorkspaceRunEventRow[]>`
    select
      events.id,
      events.user_id,
      events.run_id,
      events.document_id,
      events.stage_name,
      events.event_type,
      events.status,
      events.message,
      events.progress,
      events.stats,
      events.payload,
      events.created_at::text
    from workspace_run_events events
    join workspace_runs runs on runs.id = events.run_id
    where events.run_id = ${args.runId}
      and (${args.after ?? null}::timestamptz is null or events.created_at > ${args.after ?? null}::timestamptz)
    order by events.created_at asc, events.id asc
    limit ${limit}
  `;

  // One event the schema can't read (an event type added on the worker side
  // before the shared list learned it) must not turn the whole history into a 500.
  return rows.flatMap((row) => {
    try {
      return [mapWorkspaceRunEvent(row)];
    } catch (error) {
      console.warn(`[runs] skipped unreadable run event ${row.id} (${row.event_type}):`, error instanceof Error ? error.message.slice(0, 200) : String(error));
      return [];
    }
  });
}

type StageResourceRow = { stage_name: string; metric: string; total: number | string; peak: number | string };

/**
 * Per-stage and run-wide worker resources from `performance_log`. CPU is
 * summed; `stage-rss-peak` is an absolute high-water mark, so the run peak is
 * the max across stages, never a sum.
 */
export function summarizeStageResources(rows: StageResourceRow[]) {
  const byStage: Record<string, { cpuMs: number; peakRssBytes: number }> = {};
  const totals = { cpuUserMs: 0, cpuSystemMs: 0, rssDeltaBytes: 0, peakRssBytes: 0 };
  for (const row of rows) {
    const total = Number(row.total) || 0;
    const peak = Number(row.peak) || 0;
    const stage = (byStage[row.stage_name] ??= { cpuMs: 0, peakRssBytes: 0 });
    if (row.metric === "stage-cpu-user") { totals.cpuUserMs += total; stage.cpuMs += total; }
    else if (row.metric === "stage-cpu-system") { totals.cpuSystemMs += total; stage.cpuMs += total; }
    else if (row.metric === "stage-rss-delta") totals.rssDeltaBytes = Math.max(totals.rssDeltaBytes, peak);
    else if (row.metric === "stage-rss-peak") {
      totals.peakRssBytes = Math.max(totals.peakRssBytes, peak);
      stage.peakRssBytes = Math.max(stage.peakRssBytes, peak);
    }
  }
  return { totals, byStage };
}

export async function buildRunProgressSnapshot(
  run: WorkspaceRun,
  options?: {
    recentEventLimit?: number;
  },
): Promise<WorkspaceRunProgressSnapshot> {
  const recentEventLimit = options?.recentEventLimit ?? 100;

  const temporal = await getPipelineTemporalSnapshot(run.id);
  const reconciledRun = await reconcileTemporalRunState(run, temporal);
  const [stages, recentEvents, perfRows, usageRows, pageProgressRows] = await Promise.all([
    listRunStageStatesForRunId(reconciledRun.id),
    recentEventLimit > 0
      ? listRunEventsForRunId({
          runId: reconciledRun.id,
          limit: recentEventLimit,
        })
      : Promise.resolve([]),
    sql<StageResourceRow[]>`
      select stage_name, metric, sum(value)::double precision as total, max(value)::double precision as peak
      from performance_log
      where run_id = ${reconciledRun.id}
        and metric in ('stage-cpu-user', 'stage-cpu-system', 'stage-rss-delta', 'stage-rss-peak')
      group by stage_name, metric
    `,
    runUsageCostTotals(reconciledRun.id),
    sql<{ document_id: string; stage_name: string; completed_pages: number }[]>`
      select
        document_id,
        stage_name,
        count(*)::int as completed_pages
      from page_stage_states
      where run_id = ${reconciledRun.id}
        and status = 'completed'
      group by document_id, stage_name
    `,
  ]);

  const resources = summarizeStageResources(perfRows);
  const { cpuUserMs, cpuSystemMs, rssDeltaBytes, peakRssBytes } = resources.totals;
  const cost = summarizeRunUsageCost(usageRows[0]);

  const pageProgress: Record<string, Record<string, number>> = {};
  for (const row of pageProgressRows) {
    pageProgress[row.document_id] ??= {};
    pageProgress[row.document_id]![row.stage_name] = row.completed_pages;
  }

  const stats: Record<string, unknown> = {
    ...(reconciledRun.stats ?? {}),
    cpuUserMs,
    cpuSystemMs,
    cpuTotalMs: cpuUserMs + cpuSystemMs,
    rssDeltaBytes,
    peakRssBytes,
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    costCents: cost.costCents,
    pageProgress,
  };
  const progress = buildProgressModule({
    run: reconciledRun,
    stages,
    temporal,
    pageProgress,
    cpuUserMs,
    cpuSystemMs,
    rssDeltaBytes,
    peakRssBytes,
    stageResources: resources.byStage,
    ...cost,
  });

  return workspaceRunProgressSnapshotSchema.parse({
    // One cost on every surface: the run record carries progress.usageTotals.costCents.
    run: { ...reconciledRun, costCents: cost.costCents, computeEstimated: cost.computeEstimated, billedCostCents: cost.billedCostCents },
    stages,
    recentEvents,
    temporal,
    progress,
    stats,
    artifacts: reconciledRun.artifacts ?? {},
  });
}

export async function getRunProgress(
  runId: string,
  userId: string,
  options?: {
    recentEventLimit?: number;
  },
): Promise<WorkspaceRunProgressSnapshot | null> {
  const run = await getRun(runId, userId, { cost: false });
  if (!run) {
    return null;
  }

  return await buildRunProgressSnapshot(run, options);
}

/**
 * Validates a partial (stage-subset) backfill of documents across source runs with the same checks reprocessRun applies, so an unseedable run fails the request (409/400) instead of failing in the worker: two queries in total (runs, documents)
 * instead of three per run. Throws the same rejections, for the first failing run in input order.
 */
export async function assertBackfillReusableMany(
  groups: Array<{ runId: string; documentIds: string[] }>,
  pipeline: PipelineFeatures,
): Promise<void> {
  if (groups.length === 0) return;
  const plan = compilePipelinePlan(pipeline);
  if (plan.stageOrder.length === 0) {
    throw new ReprocessRejectedError(
      "None of the requested stages is enabled in this workspace's pipeline.",
      400,
      "no_stages_to_run",
      { requested: pipeline.stageSubset ?? null },
    );
  }
  if (plan.reusedStages.length === 0) return;
  const runIds = groups.map((group) => group.runId);
  const runs = await sql<{ id: string; artifacts: Record<string, unknown> | null; artifacts_purged_at: Date | string | null }[]>`
    select id, artifacts, artifacts_purged_at from workspace_runs where id = any(${runIds})
  `;
  const documentIds = groups.flatMap((group) => group.documentIds);
  const docs = await sql<(ReuseSourceRow & { run_id: string })[]>`
    select id, run_id, status, purged_at from documents
    where id = any(${documentIds}) and run_id = any(${runIds})
    order by created_at, id
  `;
  const runById = new Map(runs.map((run) => [run.id, run]));
  for (const group of groups) {
    const run = runById.get(group.runId);
    if (!run) {
      throw new ReprocessRejectedError("The source run no longer exists.", 409, "source_not_reusable", { reason: "run_missing" });
    }
    const wanted = new Set(group.documentIds);
    const sources = docs.filter((doc) => doc.run_id === group.runId && wanted.has(doc.id));
    checkReusableSource({ id: run.id, artifacts: (run.artifacts ?? {}) as WorkspaceRun["artifacts"] }, run.artifacts_purged_at, sources, plan);
  }
}

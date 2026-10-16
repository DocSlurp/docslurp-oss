import { PUBLIC_ERROR_MESSAGES, publicDiagnostics, publicProcessingMessage } from "@docslurp/shared";
import {
  planRunControlUpdate,
  runLifecycle,
  type RunControlAction,
  type RunRetryOutcome,
} from "./run-lifecycle.js";
import { randomUUID } from "node:crypto";

import {
  parseStoredPipelineFeatures,
  createWorkspaceRunSchema,
  compilePipelinePlan,
  defaultPipelineFeatures,
  pageRouterModeSchema,
  withPlatformPageRouterMode,
  findMissingReuseInputs,
  stageSelectionKeys,
  withoutStageSelection,
  documentSchema,
  workspaceRunEventSchema,
  workspaceRunProgressSnapshotSchema,
  workspaceRunSchema,
  workspaceRunStageStateSchema,
  type CreateWorkspaceRunInput,
  type DocumentRecord,
  type PipelineFeatures,
  type WorkspaceRun,
  type WorkspaceRunEvent,
  type WorkspaceRunProgressSnapshot,
  type WorkspaceRunStageState,
} from "@docslurp/shared";

import { fileUrlForArtifact } from "../lib/file-urls.js";
import { completeRunCreation, lockRunCreation } from "./run-creation.js";
import { sql } from "../db.js";
import { RUN_EVENTS_CHANNEL, RunEventHub, type RunEventHubRow } from "./run-event-hub.js";
import { env as apiEnv } from "../config.js";
import { getPipelineTemporalSnapshot } from "../lib/temporal.js";
import { sanitizeUploadFilename } from "../lib/filenames.js";
import { currentRequestId } from "../lib/request-context.js";
import { buildProgressModule } from "./progress-snapshot.js";
import {
  buildRunProcessingPreview,
  getRunProcessingPreview,
} from "./run-processing-preview.js";
import { resolveSourceMetadata, UnreadableSourceError } from "./source-metadata.js";
import {
  canEditWorkspace,
  getWorkspaceAccess,
  listAccessibleWorkspaceIds,
} from "./organizations.js";
import { getAvailableCredits } from "./billing/credits.js";
import {
  admitRunSpend,
  assertCanSpend,
  SpendBlockedError,
  type SpendBlockedCode,
} from "./billing/spend-guard.js";
import { resumeSpendPausedRunOutcome } from "./spend-paused-runs.js";
import {
  attributedUsage,
  runUsageCostSummaries,
  runUsageCostTotals,
  summarizeRunUsageCost,
  type RunUsageCostSummary,
} from "./usage-attribution.js";
import { loadWithheldArtifactUrisForRun } from "./pii-artifact-guard.js";
import { processSingleton } from "../lib/process-singleton.js";

export { summarizeRunUsageCost };

// Minimum available credits (1 credit = 1 cent) required to start a run, on top
// of the always-on "must be positive" gate. Zero means no extra floor.
const MIN_CREDIT_BALANCE_CENTS = Number(
  process.env.MIN_CREDIT_BALANCE_CENTS ?? "0",
);
const SKIP_RUN_BUDGET_GUARDS_IN_DEV =
  process.env.SKIP_RUN_BUDGET_GUARDS_IN_DEV !== "false";

export { buildRunProcessingPreview, getRunProcessingPreview };

/** A run blocked by spend admission (402); see billing/spend-guard.ts. */
export class RunCreationBlockedError extends SpendBlockedError {
  constructor(
    message: string,
    _statusCode: 402 = 402,
    code: SpendBlockedCode = "credit_exhausted",
  ) {
    super(message, code);
    this.name = "RunCreationBlockedError";
  }
}

export function isRunCreationBlockedError(
  error: unknown,
): error is SpendBlockedError {
  return error instanceof SpendBlockedError;
}

async function enforceLiveBudgetCaps(
  workspaceId: string,
  orgId: string,
): Promise<void> {
  if (
    process.env.NODE_ENV === "development" &&
    SKIP_RUN_BUDGET_GUARDS_IN_DEV
  ) {
    return;
  }

  // Credits are checked atomically when the run row is inserted
  // (admitRunSpend). An admitted run is paused, not failed, once the org
  // balance goes negative mid-run (docs/pricing-and-credits.md, gotcha 7).

  // Budgets first: summing a month of attributed usage is the most expensive
  // statement on the ingest path (67% of app-database time at 576 slots in the
  // 2026-10-09 load-test re-run), so only sum spend for a cap that exists.
  const [limits] = await sql<
    { workspace_budget_cents: number | null; org_budget_cents: number | null }[]
  >`
    select
      w.monthly_budget_cents as workspace_budget_cents,
      o.monthly_budget_cents as org_budget_cents
    from workspaces w
    join organizations o on o.id = w.org_id
    where w.id = ${workspaceId}
    limit 1
  `;

  if (!limits) {
    throw new Error("Workspace not found");
  }

  const monthSpendCents = async (scope: "workspace" | "org"): Promise<number> => {
    const [row] = await sql<{ spend_cents: number }[]>`
      select coalesce(sum(au.cost_cents), 0)::double precision as spend_cents
      from ${attributedUsage("month")} au
      where ${scope === "workspace" ? sql`au.workspace_id = ${workspaceId}` : sql`au.org_id = ${orgId}`}
    `;
    return Number(row?.spend_cents ?? 0);
  };
  const budget = {
    workspace_budget_cents: limits.workspace_budget_cents,
    workspace_spend_cents: limits.workspace_budget_cents == null ? 0 : await monthSpendCents("workspace"),
    org_budget_cents: limits.org_budget_cents,
    org_spend_cents: limits.org_budget_cents == null ? 0 : await monthSpendCents("org"),
  };

  const workspacePaused =
    budget.workspace_budget_cents != null &&
    budget.workspace_spend_cents >= budget.workspace_budget_cents;
  const orgPaused =
    budget.org_budget_cents != null &&
    budget.org_spend_cents >= budget.org_budget_cents;

  // Write only on a change: every ingest runs this, and the org row is the
  // one every credit debit in the org locks.
  await sql`
    update workspaces
    set budget_paused = ${workspacePaused}, updated_at = now()
    where id = ${workspaceId} and budget_paused is distinct from ${workspacePaused}
  `;
  await sql`
    update organizations
    set budget_paused = ${orgPaused}, updated_at = now()
    where id = ${orgId} and budget_paused is distinct from ${orgPaused}
  `;

  if (workspacePaused) {
    throw new RunCreationBlockedError(
      "This workspace has reached its monthly budget cap and new runs are paused. " +
        "Increase the budget in workspace settings to resume processing.",
      402,
      "workspace_budget_paused",
    );
  }

  if (orgPaused) {
    throw new RunCreationBlockedError(
      "This organization has reached its monthly budget cap and new runs are paused. " +
        "Increase the org budget to resume processing.",
      402,
      "org_budget_paused",
    );
  }
}

type WorkspaceRunRow = {
  id: string;
  org_id: string;
  user_id: string;
  workspace_id: string;
  workspace_name: string | null;
  kind: string;
  status: string;
  priority: number;
  control_state: string | null;
  pause_reason?: string | null;
  control_requested_at: string | Date | null;
  last_heartbeat_at?: string | Date | null;
  lease_expires_at?: string | Date | null;
  failure_count?: number | null;
  dead_lettered_at?: string | Date | null;
  dead_letter_reason?: string | null;
  stage: string;
  total_documents: number;
  processed_documents: number;
  pages_total: number;
  pages_processed: number;
  pipeline: PipelineFeatures;
  stats: Record<string, unknown> | null;
  artifacts: Record<string, string> | null;
  error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type DocumentRow = {
  id: string;
  org_id: string;
  user_id: string;
  workspace_id: string;
  run_id: string | null;
  filename: string;
  mime_type: string;
  source_key: string;
  status: string;
  extraction_mode: string;
  page_count: number;
  source_sha256?: string | null;
  deduped_from_document_id?: string | null;
  dedup_scope?: "workspace" | "org" | null;
  version_number: number;
  previous_version_id: string | null;
  canonical_id?: string | null;
  superseded_at?: string | Date | null;
  superseded_by_document_id?: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type DedupScope = "workspace" | "org";

type DedupCandidateRow = {
  id: string;
  /** The document whose LanceDB rows the candidate's vectors are (itself unless it is a copy). */
  vector_owner_id: string;
  dedup_scope: DedupScope;
};

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

function serializeTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function serializeOptionalTimestamp(
  value: string | Date | null,
): string | null {
  if (value === null) {
    return null;
  }
  return serializeTimestamp(value);
}

/** Older rows stored some JSON columns as JSON text; read either form, else empty. */
function jsonRecord<T extends Record<string, unknown>>(value: unknown): T {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { parsed = null; }
  }
  return (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as T;
}

/**
 * `cost` comes from the usage ledger (usage_attribution). billedCostCents is
 * the figure the worker enforces the run cost cap against (it equals
 * workspace_runs.spent_cents); costCents adds the unbilled compute estimate.
 * Runs mapped without it (just created) have spent nothing; listed runs go
 * through withRunCosts.
 */
function mapWorkspaceRun(row: WorkspaceRunRow, cost?: Pick<RunUsageCostSummary, "costCents" | "computeEstimated" | "billedCostCents">): WorkspaceRun {
  return workspaceRunSchema.parse({
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    kind: row.kind,
    status: row.status,
    priority: row.priority ?? 0,
    controlState: row.control_state ?? null,
    pauseReason: row.pause_reason ? PUBLIC_ERROR_MESSAGES.paused : null,
    controlRequestedAt: serializeOptionalTimestamp(row.control_requested_at),
    stage: row.stage,
    totalDocuments: row.total_documents,
    processedDocuments: row.processed_documents,
    pagesTotal: row.pages_total,
    pagesProcessed: row.pages_processed,
    costCents: cost?.costCents ?? 0,
    computeEstimated: cost?.computeEstimated ?? false,
    billedCostCents: cost?.billedCostCents ?? 0,
    // Historical snapshots may predate the schema; never fail a run list on one row.
    pipeline: parseStoredPipelineFeatures(typeof row.pipeline === "string" ? jsonRecord(row.pipeline) : row.pipeline ?? defaultPipelineFeatures),
    stats: publicDiagnostics(jsonRecord(row.stats)),
    artifacts: jsonRecord(row.artifacts),
    error: row.error ? PUBLIC_ERROR_MESSAGES.processing : null,
    createdAt: serializeTimestamp(row.created_at),
    updatedAt: serializeTimestamp(row.updated_at),
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

function mapDocument(row: DocumentRow): DocumentRecord {
  return documentSchema.parse({
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sourceKey: row.source_key,
    status: row.status,
    extractionMode: row.extraction_mode,
    pageCount: row.page_count,
    sourceSha256: row.source_sha256 ?? null,
    dedupedFromDocumentId: row.deduped_from_document_id ?? null,
    dedupScope: row.dedup_scope ?? null,
    versionNumber: row.version_number ?? 1,
    previousVersionId: row.previous_version_id ?? null,
    canonicalId: row.canonical_id ?? null,
    supersededAt: row.superseded_at ? serializeTimestamp(row.superseded_at) : null,
    supersededByDocumentId: row.superseded_by_document_id ?? null,
    createdAt: serializeTimestamp(row.created_at),
    updatedAt: serializeTimestamp(row.updated_at),
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
    error: row.error ? PUBLIC_ERROR_MESSAGES.processing : null,
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

async function findDedupCandidate(
  client: typeof sql,
  args: {
    orgId: string;
    workspaceId: string;
    sourceSha256: string;
    runId: string;
  },
): Promise<DedupCandidateRow | null> {
  const [row] = await client<DedupCandidateRow[]>`
    select
      d.id,
      coalesce(d.deduped_from_document_id, d.id) as vector_owner_id,
      case
        when d.workspace_id = ${args.workspaceId} then 'workspace'
        else 'org'
      end as dedup_scope
    from documents d
    join workspace_runs runs on runs.id = d.run_id
    join workspace_runs target_run on target_run.id = ${args.runId}
    where d.org_id = ${args.orgId}
      and d.source_sha256 = ${args.sourceSha256}
      and d.status = 'completed'
      and d.superseded_at is null
      and d.purged_at is null
      and runs.status = 'completed'
      -- Partial-run documents carry full output; compare features, not stage selection.
      and (runs.pipeline - ${client.array([...stageSelectionKeys])}::text[])
        = (target_run.pipeline - ${client.array([...stageSelectionKeys])}::text[])
      and (
        d.workspace_id = ${args.workspaceId}
        or d.org_id = ${args.orgId}
      )
    order by
      case when d.workspace_id = ${args.workspaceId} then 0 else 1 end,
      d.updated_at desc,
      d.created_at desc
    limit 1
  `;

  return row ?? null;
}

async function seedDeduplicatedDocument(
  client: typeof sql,
  args: {
    sourceDocumentId: string;
    dedupScope: DedupScope;
    targetDocumentId: string;
    targetRunId: string;
    targetUserId: string;
  },
): Promise<void> {
  await client`
    insert into document_run_stage_states (
      run_id,
      document_id,
      stage_name,
      status,
      attempts,
      artifact_uri,
      stats,
      error,
      started_at,
      completed_at,
      updated_at
    )
    select
      ${args.targetRunId},
      ${args.targetDocumentId},
      drss.stage_name,
      'completed',
      greatest(drss.attempts, 1),
      drss.artifact_uri,
      coalesce(drss.stats, '{}'::jsonb) || jsonb_build_object(
        'deduplicated', true,
        'dedupScope', ${args.dedupScope}::text,
        'dedupedFromDocumentId', ${args.sourceDocumentId}::text
      ),
      null,
      now(),
      now(),
      now()
    from document_run_stage_states drss
    where drss.document_id = ${args.sourceDocumentId}
      and drss.status = 'completed'
      and drss.stage_name <> 'quarantine'
  `;

  await client`
    insert into document_pages (
      id,
      document_id,
      run_id,
      user_id,
      page_number,
      text,
      token_estimate
    )
    select
      gen_random_uuid()::text,
      ${args.targetDocumentId},
      ${args.targetRunId},
      ${args.targetUserId},
      page_number,
      text,
      token_estimate
    from document_pages
    where document_id = ${args.sourceDocumentId}
  `;

  await client`
    insert into document_chunks (
      id,
      document_id,
      run_id,
      user_id,
      chunk_index,
      text,
      heading_path,
      page_number,
      token_estimate,
      metadata,
      content_hash,
      pipeline_version,
      parent_page_id
    )
    select
      gen_random_uuid()::text,
      ${args.targetDocumentId},
      ${args.targetRunId},
      ${args.targetUserId},
      chunks.chunk_index,
      chunks.text,
      chunks.heading_path,
      chunks.page_number,
      chunks.token_estimate,
      chunks.metadata,
      chunks.content_hash,
      chunks.pipeline_version,
      target_pages.id
    from document_chunks chunks
    left join document_pages source_pages on source_pages.id = chunks.parent_page_id
    left join document_pages target_pages
      on target_pages.document_id = ${args.targetDocumentId}
     and target_pages.page_number = source_pages.page_number
    where chunks.document_id = ${args.sourceDocumentId}
  `;

  await client`
    insert into document_summaries (
      id,
      document_id,
      run_id,
      user_id,
      summary
    )
    select
      gen_random_uuid()::text,
      ${args.targetDocumentId},
      ${args.targetRunId},
      ${args.targetUserId},
      summary
    from document_summaries
    where document_id = ${args.sourceDocumentId}
  `;

  await client`
    insert into document_propositions (
      id,
      document_id,
      run_id,
      user_id,
      chunk_index,
      text,
      source_paragraph,
      token_estimate
    )
    select
      gen_random_uuid()::text,
      ${args.targetDocumentId},
      ${args.targetRunId},
      ${args.targetUserId},
      chunk_index,
      text,
      source_paragraph,
      token_estimate
    from document_propositions
    where document_id = ${args.sourceDocumentId}
  `;

  await client`
    insert into vector_indexes (
      id,
      document_id,
      backend,
      bucket,
      path,
      embedding_model,
      dimension
    )
    select
      gen_random_uuid()::text,
      ${args.targetDocumentId},
      backend,
      bucket,
      path,
      embedding_model,
      dimension
    from vector_indexes
    where document_id = ${args.sourceDocumentId}
  `;
}

/**
 * Stamps the deployment's PAGE_ROUTER_MODE default (shadow) onto a run snapshot whose workspace left
 * `pageRouter.mode` unset, so the stage plan every service compiles includes route-pages without per-workspace setup.
 */
function platformRunPipeline<T extends PipelineFeatures>(pipeline: T): T {
  const parsed = pageRouterModeSchema.safeParse(process.env.PAGE_ROUTER_MODE?.trim().toLowerCase());
  return withPlatformPageRouterMode(pipeline, parsed.success ? parsed.data : "off");
}

export async function createRun(
  input: CreateWorkspaceRunInput & { workspaceId: string },
  options: { sourceKeys?: string[] } = {},
): Promise<WorkspaceRun> {
  // Callers resolve the workspace reference first (requireActorWorkspace).
  const parsed = { ...createWorkspaceRunSchema.parse(input), workspaceId: input.workspaceId };
  const id = randomUUID();
  const requestId = currentRequestId();
  const access = await getWorkspaceAccess(parsed.workspaceId, parsed.userId);
  if (!access) {
    throw new Error("Workspace not found");
  }
  if (!canEditWorkspace(access, parsed.userId)) {
    throw new Error("Forbidden");
  }

  // Optional floor on available credits (MIN_CREDIT_BALANCE_CENTS).
  if (MIN_CREDIT_BALANCE_CENTS > 0) {
    const { available } = await getAvailableCredits(access.orgId);
    if (available < MIN_CREDIT_BALANCE_CENTS) {
      throw new RunCreationBlockedError(
        `Insufficient credits. Available: ${available.toFixed(2)} credits ($${(available / 100).toFixed(2)}). ` +
          "Buy credits at /app/billing to continue processing.",
        402,
        "minimum_credit_required",
      );
    }
  }

  await enforceLiveBudgetCaps(parsed.workspaceId, access.orgId);

  const [row] = await admitRunSpend(access.orgId, parsed.workspaceId, (tx) => tx<WorkspaceRunRow[]>`
    with inserted as (
      insert into workspace_runs (
        id,
        org_id,
        user_id,
        workspace_id,
        kind,
        status,
        priority,
        control_state,
        control_requested_at,
        stage,
        total_documents,
        processed_documents,
        pages_total,
        pages_processed,
        stats,
        creation_source_keys,
        pipeline
      )
      values (
        ${id},
        ${access.orgId},
        ${parsed.userId},
        ${parsed.workspaceId},
        ${parsed.kind},
        'queued',
        0,
        null,
        null,
        'queued',
        ${parsed.totalDocuments},
        0,
        0,
        0,
        ${sql.json({
          ...(requestId ? { requestId } : {}),
          ...(parsed.apiKeyId ? { apiKeyId: parsed.apiKeyId } : {}),
        })},
        ${sql.array(options.sourceKeys ?? [])}::text[],
        ${sql.json(JSON.parse(JSON.stringify(platformRunPipeline(withoutStageSelection(parsed.pipeline)))))}
      )
      returning *
    )
    select
      inserted.*,
      workspaces.name as workspace_name
    from inserted
    join workspaces on workspaces.id = inserted.workspace_id
  `, { leaseRunId: id });

  const run = mapWorkspaceRun(row);

  const preview = buildRunProcessingPreview({
    request: {
      workspaceId: parsed.workspaceId,
      pipeline: parsed.pipeline,
      files: Array.from({ length: parsed.totalDocuments }, (_, index) => ({
        filename: `document-${index + 1}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 900_000,
      })),
      urls: [],
    },
  });
  run.costForecast = preview.current.estimatedCost;

  return run;
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

export async function createDocumentBatch(args: {
  userId: string;
  workspaceId: string;
  runId: string;
  files: Array<{
    filename: string;
    mimeType: string;
    sourceKey: string;
    fileSize?: number;
    metadata?: Record<string, unknown>;
    canonicalId?: string | null;
  }>;
  /** When set, an unreadable file is skipped and reported here instead of failing the batch. */
  onUnreadable?: (file: { sourceKey: string; filename: string }, error: UnreadableSourceError) => void;
}): Promise<DocumentRecord[]> {
  const access = await getWorkspaceAccess(args.workspaceId, args.userId);
  if (!access) {
    throw new Error("Workspace not found");
  }
  if (!canEditWorkspace(access, args.userId)) {
    throw new Error("Forbidden");
  }

  const rows: DocumentRecord[] = [];
  let pagesTotal = 0;

  for (const file of args.files) {
    const filename = sanitizeUploadFilename(file.filename);
    const documentId = randomUUID();
    let metadata: Awaited<ReturnType<typeof resolveSourceMetadata>>;
    try {
      metadata = await resolveSourceMetadata({ ...file, filename });
    } catch (error) {
      if (error instanceof UnreadableSourceError && args.onUnreadable) {
        args.onUnreadable({ sourceKey: file.sourceKey, filename }, error);
        continue;
      }
      throw error;
    }

    const row = await sql.begin(async (tx) => {
      const client = tx as unknown as typeof sql;

      await lockRunCreation(args.runId, client);
      const canonicalId = file.canonicalId ?? null;
      if (canonicalId) {
        await client`select pg_advisory_xact_lock(hashtextextended(${`${args.workspaceId}:${canonicalId}`}, 0))`;
      }
      // Canonical documents version per workspace by logical source; others by filename.
      const [existing] = canonicalId
        ? await client<{ id: string; version_number: number }[]>`
            select id, version_number from documents
            where workspace_id = ${args.workspaceId} and canonical_id = ${canonicalId}
            order by version_number desc, created_at desc
            limit 1
          `
        : await client<{ id: string; version_number: number }[]>`
            select id, version_number from documents
            where org_id = ${access.orgId} and filename = ${filename}
            order by version_number desc
            limit 1
          `;

      const versionNumber = existing ? existing.version_number + 1 : 1;
      const previousVersionId = existing?.id ?? null;
      const dedupCandidate = await findDedupCandidate(client, {
        orgId: access.orgId,
        workspaceId: args.workspaceId,
        sourceSha256: metadata.sourceSha256,
        runId: args.runId,
      });

      const [inserted] = await client<DocumentRow[]>`
        insert into documents (
          id,
          org_id,
          user_id,
          workspace_id,
          run_id,
          filename,
          mime_type,
          source_key,
          status,
          extraction_mode,
          page_count,
          source_sha256,
          deduped_from_document_id,
          dedup_scope,
          version_number,
          previous_version_id,
          canonical_id,
          file_size,
          metadata
        )
        values (
          ${documentId},
          ${access.orgId},
          ${args.userId},
          ${args.workspaceId},
          ${args.runId},
          ${filename},
          ${file.mimeType},
          ${file.sourceKey},
          'queued',
          'hybrid',
          ${metadata.pageCount},
          ${metadata.sourceSha256},
          -- Point at the vector owner, not an intermediate copy, so purge keeps
          -- the owner's vectors while any copy still uses them.
          ${dedupCandidate?.vector_owner_id ?? null},
          ${dedupCandidate?.dedup_scope ?? null},
          ${versionNumber},
          ${previousVersionId},
          ${canonicalId},
          ${file.fileSize ?? 0},
          ${JSON.stringify({ ...file.metadata, sourceSizeMeasured: file.fileSize !== undefined })}::text::jsonb
        )
        returning *
      `;

      if (dedupCandidate) {
        await seedDeduplicatedDocument(client, {
          sourceDocumentId: dedupCandidate.id,
          dedupScope: dedupCandidate.dedup_scope,
          targetDocumentId: documentId,
          targetRunId: args.runId,
          targetUserId: args.userId,
        });
      }

      return inserted;
    });

    rows.push(mapDocument(row));
    pagesTotal += metadata.pageCount;
  }

  await sql`
    update workspace_runs
    set pages_total = ${pagesTotal},
        updated_at = now()
    where id = ${args.runId}
  `;

  return rows;
}

/**
 * A reprocessed document is a new version of the same source, so it must
 * replace the old one on completion. Documents uploaded without a canonical ID
 * get one derived from their own ID.
 */
export async function ensureReprocessCanonicalId(doc: { id: string; canonical_id?: string | null }): Promise<string> {
  if (doc.canonical_id) return doc.canonical_id;
  const canonicalId = `docslurp:document:${doc.id}`;
  const [row] = await sql<{ canonical_id: string }[]>`
    update documents set canonical_id = coalesce(canonical_id, ${canonicalId})
    where id = ${doc.id}
    returning canonical_id
  `;
  return row?.canonical_id ?? canonicalId;
}

/** A reprocess request the source run cannot satisfy (4xx, nothing created). */
export class ReprocessRejectedError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 409,
    readonly code: "no_stages_to_run" | "source_not_reusable" | "missing_stage_artifacts",
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ReprocessRejectedError";
  }
}

export function isReprocessRejectedError(error: unknown): error is ReprocessRejectedError {
  return error instanceof ReprocessRejectedError;
}

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
  original: WorkspaceRun,
  plan: ReturnType<typeof compilePipelinePlan>,
): Promise<void> {
  const [runRow] = await sql<{ artifacts_purged_at: Date | string | null }[]>`
    select artifacts_purged_at from workspace_runs where id = ${original.id}
  `;
  if (runRow?.artifacts_purged_at) {
    throw new ReprocessRejectedError(
      "The source run's artifacts were purged by retention; reprocess every stage instead.",
      409,
      "source_not_reusable",
      { reason: "artifacts_purged" },
    );
  }

  const sources = await sql<ReuseSourceRow[]>`
    select id, status, purged_at from documents where run_id = ${original.id} order by created_at, id
  `;
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
 */
export async function reprocessRun(
  runId: string,
  userId: string,
  options?: { stages?: string[]; stageFrom?: string },
): Promise<WorkspaceRun | null> {
  const original = await getRun(runId, userId);
  if (!original) return null;
  const access = await getWorkspaceAccess(original.workspaceId, userId);
  if (!access || !canEditWorkspace(access, userId)) {
    throw new Error("Forbidden");
  }

  // A reprocess of a partial run starts from that run's full feature set.
  const pipelineConfig: PipelineFeatures = {
    ...(JSON.parse(JSON.stringify(withoutStageSelection(original.pipeline))) as PipelineFeatures),
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

  const docs = await sql<DocumentRow[]>`
    select * from documents where run_id = ${runId}
  `;

  const newRunId = randomUUID();

  // Reprocessing spends like a new run: same admission and budget caps.
  await enforceLiveBudgetCaps(original.workspaceId, original.orgId);
  const [newRunRow] = await admitRunSpend(original.orgId, original.workspaceId, (tx) => tx<WorkspaceRunRow[]>`
    with inserted as (
      insert into workspace_runs (
        id, org_id, user_id, workspace_id, kind, status, priority, control_state, control_requested_at, stage,
        total_documents, processed_documents,
        pages_total, pages_processed, pipeline
      )
      values (
        ${newRunId},
        ${original.orgId},
        ${original.userId},
        ${original.workspaceId},
        ${original.kind},
        'queued',
        ${original.priority ?? 0},
        null,
        null,
        'queued',
        ${original.totalDocuments},
        0, 0, 0,
        ${sql.json(JSON.parse(JSON.stringify(pipelineConfig)))}
      )
      returning *
    )
    select
      inserted.*,
      workspaces.name as workspace_name
    from inserted
    join workspaces on workspaces.id = inserted.workspace_id
  `, { leaseRunId: newRunId });

  await completeRunCreation(newRunId, async () => {
    for (const doc of docs) {
      const canonicalId = await ensureReprocessCanonicalId(doc);
      await sql.begin(async (tx) => {
        await lockRunCreation(newRunId, tx as unknown as typeof sql);
        await tx`
          insert into documents (
            id, org_id, user_id, workspace_id, run_id, filename, mime_type,
            source_key, status, extraction_mode, page_count,
            canonical_id, version_number, previous_version_id, reused_from_document_id, source_sha256
          )
          values (
            ${randomUUID()},
            ${doc.org_id},
            ${doc.user_id},
            ${doc.workspace_id},
            ${newRunId},
            ${doc.filename},
            ${doc.mime_type},
            ${doc.source_key},
            'queued',
            ${doc.extraction_mode},
            ${doc.page_count},
            ${canonicalId},
            ${(doc.version_number ?? 1) + 1},
            ${doc.id},
            ${partial ? doc.id : null},
            ${doc.source_sha256 ?? null}
          )
        `;
      });
    }

    return { value: undefined, totalDocuments: docs.length };
  });

  return mapWorkspaceRun(newRunRow);
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
  if (!access || !canEditWorkspace(access, userId)) {
    throw new Error("Forbidden");
  }

  // A retried run spends again: admit it like a new one (no insert).
  await admitRunSpend(run.orgId, run.workspaceId, async () => undefined);
  const outcome = await runLifecycle.retry(run);
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
  if (!access || !canEditWorkspace(access, userId)) {
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
    if (outcome.status === "resumed") return getRun(run.id, userId);
    if (outcome.status === "blocked") {
      const code = (["workspace_budget_paused", "org_budget_paused", "plan_not_entitled"] as const)
        .find((candidate) => candidate === outcome.reason) ?? "credit_exhausted";
      throw new SpendBlockedError(
        code === "credit_exhausted"
          ? "Out of credits: other runs in this organization hold the remaining credits. " +
            "Buy credits, enable auto-recharge or upgrade your plan at /app/billing to continue."
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

async function listRunEventsForRunId(args: {
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

  return rows.map(mapWorkspaceRunEvent);
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

export interface RunExportManifest {
  runId: string;
  exportedAt: string;
  artifacts: Array<{ slot: string; uri: string; url: string }>;
}

export async function exportRun(
  runId: string,
  userId: string,
): Promise<RunExportManifest | null> {
  const run = await getRun(runId, userId);
  if (!run) return null;

  const artifacts: RunExportManifest["artifacts"] = [];
  const withheld = await loadWithheldArtifactUrisForRun(run.id);

  for (const [slot, uri] of Object.entries(run.artifacts)) {
    if (withheld.has(uri)) continue;
    // Session/key-bound proxy URL; the bucket is never exposed (lib/file-urls.ts).
    artifacts.push({ slot, uri, url: fileUrlForArtifact(uri).url });
  }

  return {
    runId,
    exportedAt: new Date().toISOString(),
    artifacts,
  };
}

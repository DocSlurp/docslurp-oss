import type { TransactionSql } from "postgres";
import {
  compilePipelinePlan,
  getPipelineStageOrder,
  isTemporalConnectionUnavailable,
  planRunFailure,
  resolvePoisonRunFailureThreshold,
  sanitizeStoredPipeline,
  type PipelineFeatures,
  type WorkspaceRun,
} from "@docslurp/shared";

import { sql as defaultSql, type SqlClient } from "../db.js";
import { RUN_EVENTS_CHANNEL } from "./run-event-hub.js";
import {
  signalPipelineCancel,
  signalPipelinePause,
  signalPipelineResume,
  startPipelineWorkflow,
} from "../lib/temporal.js";

/**
 * Run Lifecycle: the single owner of API-side Run status transitions.
 *
 * Starting (and deferring when Temporal is unavailable), restarting, retrying,
 * operator control, and failing a Run all go through this module so routes,
 * Workspace Intake, reconciliation, and the stale-run sweep share one set of
 * rules. Failure bookkeeping (failure_count, failure history, dead-letter)
 * matches the worker's terminal failure through `planRunFailure`.
 */

type RunStatus = WorkspaceRun["status"];

export type RunLifecycleRun = { id: string; pipeline: PipelineFeatures };

export type RunStartOutcome =
  | { status: "started" }
  | { status: "already-started" }
  | { status: "deferred"; reason: string };

export type RunRetryOutcome =
  | { status: "resumed"; start: RunStartOutcome }
  | { status: "restarted"; start: RunStartOutcome }
  | { status: "not-retryable" };

export type RunControlAction = "cancel" | "pause" | "resume" | "reprioritize" | "recover";

export type FailRunInput = {
  stage: string;
  message: string;
  /** Only fail when the Run is currently in one of these statuses. */
  fromStatuses: RunStatus[];
  /** Skip Runs whose control_state is one of these (e.g. paused by an operator). */
  skipControlStates?: string[];
  /** Extra stats merged into the Run stats before failure bookkeeping. */
  stats?: Record<string, unknown>;
  /** Extra run.failed event payload, merged with the failure bookkeeping. */
  payload?: Record<string, unknown>;
};

export type FailedRunRow = Record<string, unknown> & { id: string; user_id: string };

/** Category stored on a Run that start refused because its stored pipeline no longer validates. */
export const INVALID_PIPELINE_FAILURE_CATEGORY = "invalid_pipeline";

/**
 * A Run's stored pipeline fails validation even after stored extractor settings are dropped. Permanent: start
 * has already failed the Run (category `invalid_pipeline`), so recovery does not claim it again.
 */
export class RunPipelineInvalidError extends Error {
  readonly code = INVALID_PIPELINE_FAILURE_CATEGORY;
  constructor(readonly runId: string, cause: unknown) {
    super(`Run ${runId} has an invalid pipeline: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "RunPipelineInvalidError";
  }
}

export const TEMPORAL_DEFERRED_RUN_MESSAGE =
  "Run is queued, but processing has not started yet because Temporal is currently unavailable. Retry it after Temporal recovers.";

export interface RunLifecycleDeps {
  sql: SqlClient;
  startWorkflow: (
    runId: string,
    pipeline: PipelineFeatures,
    options?: { restartExisting?: boolean },
  ) => Promise<void>;
  signals?: {
    cancel(runId: string): Promise<void>;
    pause(runId: string): Promise<void>;
    resume(runId: string): Promise<void>;
  };
  failureThreshold: number;
  /** Backoff between run-start recovery attempts for a Run whose start failed. */
  startRetryBackoff?: { baseMs: number; maxMs: number };
}

/** Backoff for retrying a deferred workflow start: base * 2^(attempts-1), capped. */
export function resolveRunStartRetryBackoff(env: NodeJS.ProcessEnv = process.env): { baseMs: number; maxMs: number } {
  const baseMs = Math.max(250, Number(env.RUN_START_RETRY_BASE_MS ?? 2_000) || 2_000);
  const maxMs = Math.max(baseMs, Number(env.RUN_START_RETRY_MAX_MS ?? 60_000) || 60_000);
  return { baseMs, maxMs };
}

function clampPriority(priority: number): number {
  return Math.max(-100, Math.min(100, Math.round(priority)));
}

export function planRunControlUpdate(
  run: Pick<WorkspaceRun, "status" | "priority" | "controlState">,
  input: { action: RunControlAction; priority?: number },
): {
  status?: WorkspaceRun["status"];
  priority?: number;
  controlState?: string | null;
  controlRequestedAt: "now" | null;
  error?: string | null;
  immediate: boolean;
} {
  if (input.action === "reprioritize") {
    return {
      priority: clampPriority(input.priority ?? run.priority ?? 0),
      controlRequestedAt: null,
      immediate: true,
    };
  }

  if (input.action === "recover") {
    const canRecover = run.controlState === "dead-letter";
    return {
      status: canRecover ? "queued" : run.status,
      controlState: canRecover ? null : run.controlState,
      controlRequestedAt: null,
      error: canRecover ? null : undefined,
      immediate: true,
    };
  }

  if (input.action === "resume") {
    return {
      // A blocked run stays blocked: spend admission (the recovery sweeper) decides when it starts.
      status: run.controlState === "paused" && run.status !== "blocked" ? "queued" : run.status,
      controlState: null,
      controlRequestedAt: null,
      error: run.controlState === "paused" ? null : undefined,
      immediate: true,
    };
  }

  if (input.action === "pause") {
    const immediate = run.status === "queued" || run.status === "blocked" || run.controlState === "paused";
    return {
      status: run.status,
      controlState: immediate ? "paused" : "pause_requested",
      controlRequestedAt: "now",
      immediate,
    };
  }

  const immediate = run.status === "queued" || run.status === "blocked" || run.controlState === "paused";
  return {
    status: immediate ? "failed" : run.status,
    controlState: immediate ? "cancelled" : "cancel_requested",
    controlRequestedAt: "now",
    error: immediate ? "Cancelled by operator" : undefined,
    immediate,
  };
}

export function createRunLifecycle(deps: RunLifecycleDeps) {
  const { sql } = deps;
  const signals = deps.signals ?? {
    cancel: (runId: string) => signalPipelineCancel(runId),
    pause: (runId: string) => signalPipelinePause(runId),
    resume: (runId: string) => signalPipelineResume(runId),
  };

  const startRetryBackoff = deps.startRetryBackoff ?? resolveRunStartRetryBackoff();

  /**
   * Durable start marker: a confirmed start clears the pending state so the
   * run-start recovery loop leaves the Run alone. Best-effort: a failed write
   * only means recovery re-issues an idempotent start later.
   */
  async function markWorkflowStarted(runId: string): Promise<void> {
    try {
      await sql`
        update workspace_runs
        set workflow_started_at = now(), workflow_start_next_at = null
        where id = ${runId}
      `;
    } catch (error) {
      console.warn(`[run-start] could not record workflow start run=${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Mark the start unconfirmed and schedule the next recovery attempt with backoff. */
  async function markWorkflowStartPending(runId: string): Promise<void> {
    try {
      await sql`
        update workspace_runs
        set
          workflow_started_at = null,
          workflow_start_attempts = workflow_start_attempts + 1,
          workflow_start_next_at = now() + least(
            ${startRetryBackoff.maxMs}::double precision,
            ${startRetryBackoff.baseMs}::double precision * power(2, least(workflow_start_attempts, 16))
          ) * interval '1 millisecond'
        where id = ${runId}
          and status = 'queued'
      `;
    } catch (error) {
      console.warn(`[run-start] could not record deferred workflow start run=${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Start the Run's workflow. A Temporal outage defers the Run (it stays
   * queued with workflow_started_at null, and the run-start recovery loop
   * starts it as soon as Temporal is reachable); a workflow that is already
   * running is not an error unless a restart was requested. Workflow IDs are
   * run-scoped, so concurrent starts from several processes start one workflow.
   */
  async function start(
    run: RunLifecycleRun,
    options?: { restartExisting?: boolean },
  ): Promise<RunStartOutcome> {
    const [ready] = await sql<{ id: string }[]>`
      select id from workspace_runs where id = ${run.id} and creation_ready_at is not null
    `;
    if (!ready) return { status: "deferred", reason: "Run creation has not been published for processing." };
    // Recovery passes the raw stored row: drop extractor settings the strict schemas now reject, then validate.
    // A pipeline that still does not compile will never start, so the Run fails once instead of retrying forever.
    const pipeline = sanitizeStoredPipeline(run.pipeline, `run ${run.id}`);
    try {
      compilePipelinePlan(pipeline);
    } catch (cause) {
      const error = new RunPipelineInvalidError(run.id, cause);
      console.error(`[run-start] ${error.message}`);
      await fail(run.id, {
        stage: "queued",
        message: "The run's pipeline settings are invalid, so it cannot start. Reprocess the documents to run them again.",
        fromStatuses: ["queued"],
        stats: { startFailure: { category: INVALID_PIPELINE_FAILURE_CATEGORY, failedAt: new Date().toISOString() } },
        payload: { reason: INVALID_PIPELINE_FAILURE_CATEGORY },
      });
      throw error;
    }
    let outcome: RunStartOutcome;
    try {
      await deps.startWorkflow(run.id, pipeline, options);
      outcome = { status: "started" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!options?.restartExisting && message.toLowerCase().includes("already started")) {
        outcome = { status: "already-started" };
      } else if (isTemporalConnectionUnavailable(error)) {
        console.warn(`[temporal] deferred workflow start for run=${run.id}: ${message}`);
        await markWorkflowStartPending(run.id);
        return { status: "deferred", reason: TEMPORAL_DEFERRED_RUN_MESSAGE };
      } else {
        await markWorkflowStartPending(run.id);
        throw error;
      }
    }
    await markWorkflowStarted(run.id);
    return outcome;
  }

  /** Atomically move a failed Run back to queued, keeping completed checkpoints and paid work. */
  async function resumeFailed(runId: string, transaction?: TransactionSql): Promise<boolean> {
    const transition = async (tx: TransactionSql) => {
      const [locked] = await tx<{ status: string }[]>`
        select status from workspace_runs where id = ${runId} for update
      `;
      if (locked?.status !== "failed") return [];
      await tx`
        delete from document_run_stage_states
        where run_id = ${runId} and status <> 'completed'
          and document_id in (select id from documents where run_id = ${runId}
            and superseded_at is null and status <> 'cancelled')
      `;
      await tx`
        delete from workspace_run_stage_states
        where run_id = ${runId} and status <> 'completed'
      `;
      await tx`
        update documents d
        set status = 'queued', updated_at = now(),
            lexical_searchable_at = case
              when exists (
                select 1 from document_run_stage_states embed_state
                where embed_state.run_id = d.run_id and embed_state.document_id = d.id
                  and embed_state.stage_name = 'embed' and embed_state.status = 'completed'
              ) then d.lexical_searchable_at
              else null
            end
        where d.run_id = ${runId} and d.status not in ('completed', 'cancelled')
          and d.superseded_at is null
      `;
      return await tx<{ id: string }[]>`
        update workspace_runs
        set status = 'queued', control_state = null, control_requested_at = null,
            stage = 'queued', error = null, failure_count = 0,
            dead_lettered_at = null, dead_letter_reason = null,
            lease_expires_at = null, last_heartbeat_at = null, updated_at = now()
        where id = ${runId} and status = 'failed'
        returning id
      `;
    };
    const [row] = transaction ? await transition(transaction) : await sql.begin(transition);
    return Boolean(row);
  }

  /**
   * Atomically move a completed Run that skipped failed Documents back to
   * queued. Only the failed Documents (and their non-completed checkpoints)
   * reset; completed Documents keep their completed checkpoints, so the re-run
   * skips them and completed work is not billed again. Run-level stage
   * checkpoints from the earliest failed stage onward are cleared so stage
   * groups do not skip that work; earlier stages stay completed.
   */
  async function resumeCompletedWithFailures(run: RunLifecycleRun, transaction?: TransactionSql): Promise<boolean> {
    const stageOrder: readonly string[] = getPipelineStageOrder(run.pipeline);
    const transition = async (tx: TransactionSql) => {
      const [locked] = await tx<{ status: string; failed: number }[]>`
        select status,
               (select count(*)::int from documents d where d.run_id = ${run.id} and d.status = 'failed' and d.superseded_at is null) as failed
        from workspace_runs where id = ${run.id} for update
      `;
      if (locked?.status !== "completed" || !(locked.failed > 0)) return [];
      const failedStages = await tx<{ stage_name: string }[]>`
        select distinct s.stage_name from document_run_stage_states s
        join documents d on d.id = s.document_id
        where s.run_id = ${run.id} and s.status = 'failed'
          and d.superseded_at is null and d.status = 'failed'
      `;
      const earliest = Math.min(
        ...failedStages.map((stage) => stageOrder.indexOf(stage.stage_name)).filter((index) => index >= 0),
        stageOrder.length,
      );
      await tx`
        delete from document_run_stage_states
        where run_id = ${run.id} and status <> 'completed'
          and document_id in (select id from documents where run_id = ${run.id}
            and superseded_at is null and status = 'failed')
      `;
      const rerunStages = stageOrder.slice(earliest);
      if (rerunStages.length > 0) {
        await tx`
          delete from workspace_run_stage_states
          where run_id = ${run.id} and stage_name = any(${sql.array([...rerunStages])})
        `;
      }
      await tx`
        update documents d
        set status = 'queued', updated_at = now(),
            lexical_searchable_at = case
              when exists (
                select 1 from document_run_stage_states embed_state
                where embed_state.run_id = d.run_id and embed_state.document_id = d.id
                  and embed_state.stage_name = 'embed' and embed_state.status = 'completed'
              ) then d.lexical_searchable_at
              else null
            end
        where d.run_id = ${run.id} and d.status = 'failed' and d.superseded_at is null
      `;
      return await tx<{ id: string }[]>`
        update workspace_runs
        set status = 'queued', control_state = null, control_requested_at = null,
            stage = 'queued', error = null, failure_count = 0,
            processed_documents = greatest(0, total_documents - ${locked.failed}),
            stats = coalesce(stats, '{}'::jsonb) - 'failedDocuments' - 'failedDocumentStages',
            dead_lettered_at = null, dead_letter_reason = null,
            lease_expires_at = null, last_heartbeat_at = null, updated_at = now()
        where id = ${run.id} and status = 'completed'
        returning id
      `;
    };
    const [row] = transaction ? await transition(transaction) : await sql.begin(transition);
    return Boolean(row);
  }

  /** Prepare retry inside the caller's admission transaction; never start a workflow before commit. */
  async function prepareRetry(run: RunLifecycleRun & { status: RunStatus }, transaction: TransactionSql): Promise<"resumed" | "restarted" | "not-retryable"> {
    if (run.status === "failed") return await resumeFailed(run.id, transaction) ? "resumed" : "not-retryable";
    if (run.status === "completed") return await resumeCompletedWithFailures(run, transaction) ? "resumed" : "not-retryable";
    if (run.status === "queued") {
      const [current] = await transaction<{ status: string }[]>`select status from workspace_runs where id = ${run.id} for update`;
      return current?.status === "queued" ? "restarted" : "not-retryable";
    }
    return "not-retryable";
  }

  /**
   * Retry a Run. Failed Runs resume from durable checkpoints (provider usage
   * and credit debits are historical facts and are never re-charged); queued
   * Runs whose start was deferred get their workflow (re)started. Completed
   * Runs retry only their failed Documents; a clean completed Run, and a
   * processing Run, are left alone.
   */
  async function retry(run: RunLifecycleRun & { status: RunStatus }): Promise<RunRetryOutcome> {
    if (run.status === "failed") {
      const resumed = await resumeFailed(run.id);
      if (!resumed) return { status: "not-retryable" };
      return { status: "resumed", start: await start(run, { restartExisting: true }) };
    }
    if (run.status === "completed") {
      const resumed = await resumeCompletedWithFailures(run);
      if (!resumed) return { status: "not-retryable" };
      return { status: "resumed", start: await start(run, { restartExisting: true }) };
    }
    if (run.status === "queued") {
      return { status: "restarted", start: await start(run, { restartExisting: true }) };
    }
    return { status: "not-retryable" };
  }

  /**
   * Fail a Run with the same bookkeeping as the worker's terminal failure:
   * failure_count, bounded failure history, dead-letter at the poison
   * threshold, failed in-flight stage and unfinished documents, and a
   * notified run.failed event. Returns the updated row, or null when the Run
   * was not in an allowed status (or changed concurrently).
   */
  async function fail(runId: string, input: FailRunInput): Promise<FailedRunRow | null> {
    const skipControlStates = input.skipControlStates ?? [];
    const [current] = await sql<
      { status: string; control_state: string | null; stats: Record<string, unknown> | null; failure_count: number }[]
    >`
      select status, control_state, stats, coalesce(failure_count, 0)::int as failure_count
      from workspace_runs
      where id = ${runId}
      limit 1
    `;
    if (
      !current ||
      !input.fromStatuses.includes(current.status as RunStatus) ||
      skipControlStates.includes(current.control_state ?? "")
    ) {
      return null;
    }

    const plan = planRunFailure({
      failureCount: current.failure_count,
      stats: { ...(current.stats ?? {}), ...(input.stats ?? {}) },
      stage: input.stage,
      message: input.message,
      threshold: deps.failureThreshold,
    });
    const statsJson = sql.json(JSON.parse(JSON.stringify(plan.stats)));

    // Compare-and-set on status and failure_count so concurrent failures
    // (worker, sweep, reconciliation) cannot double count or clobber.
    const [row] = await sql<FailedRunRow[]>`
      update workspace_runs
      set
        status = 'failed',
        stage = ${input.stage},
        error = ${input.message},
        lease_expires_at = now(),
        failure_count = ${plan.failureCount},
        dead_lettered_at = case when ${plan.deadLettered} then now() else dead_lettered_at end,
        dead_letter_reason = case when ${plan.deadLettered} then ${input.message} else dead_letter_reason end,
        control_state = case when ${plan.deadLettered} then 'dead-letter' else control_state end,
        stats = ${statsJson}::jsonb,
        updated_at = now()
      where id = ${runId}
        and status = ${current.status}
        and coalesce(failure_count, 0) = ${current.failure_count}
      returning *
    `;
    if (!row) return null;

    await sql`select retire_replaced_pending_documents(${runId})`;
    await sql`
      update document_run_stage_states
      set status = 'failed', error = ${input.message}, updated_at = now()
      where run_id = ${runId} and stage_name = ${input.stage} and status = 'processing'
    `;
    await sql`
      update documents d
      set status = case
            when d.superseded_at is not null then 'cancelled'
            when exists (
              select 1 from document_run_stage_states s
              where s.document_id = d.id and s.run_id = d.run_id and s.status = 'failed'
            ) then 'failed'
            else 'queued'
          end,
          updated_at = now()
      where d.run_id = ${runId} and d.status not in ('completed', 'failed', 'pii_blocked', 'cancelled')
    `;

    const payload = sql.json(JSON.parse(JSON.stringify({ ...(input.payload ?? {}), ...plan.eventPayload })));
    // The row is the event; NOTIFY only hints listeners to read it (run-event-hub.ts).
    await sql`
      with inserted as (
        insert into workspace_run_events (
          id, user_id, run_id, document_id, stage_name, event_type, status,
          message, progress, stats, payload, created_at
        )
        values (
          gen_random_uuid()::text, ${row.user_id}, ${runId}, null, ${input.stage},
          'run.failed', 'failed', ${plan.eventMessage}, '{}'::jsonb,
          ${statsJson}::jsonb, ${payload}::jsonb, now()
        )
        returning run_id
      )
      select pg_notify(${RUN_EVENTS_CHANNEL}, json_build_object('runIds', json_build_array(inserted.run_id))::text)
      from inserted
    `;

    return row;
  }

  /**
   * Apply an operator control action (cancel, pause, resume, reprioritize,
   * recover). Returns the Run id when a row changed, or null.
   */
  async function control(
    run: Pick<WorkspaceRun, "id" | "status" | "priority" | "controlState" | "error">,
    input: { action: RunControlAction; priority?: number },
    transaction?: TransactionSql,
  ): Promise<string | null> {
    const query = transaction ?? sql;
    if (transaction && (input.action === "resume" || input.action === "recover")) {
      const [current] = await query<{ status: WorkspaceRun["status"]; control_state: string | null; priority: number; error: string | null }[]>`
        select status, control_state, priority, error from workspace_runs where id = ${run.id} for update
      `;
      if (!current || (input.action === "recover" ? current.control_state !== "dead-letter" :
        !["paused", "pause_requested"].includes(current.control_state ?? "") || ["blocked", "completed", "failed"].includes(current.status))) return null;
      run = { ...run, status: current.status, controlState: current.control_state, priority: current.priority, error: current.error };
    }
    const planned = planRunControlUpdate(run, input);

    if (input.action === "reprioritize") {
      const [row] = await query<{ id: string }[]>`
        update workspace_runs
        set priority = ${planned.priority ?? run.priority},
            updated_at = now()
        where id = ${run.id}
        returning id
      `;
      return row?.id ?? null;
    }

    if (input.action === "recover") {
      const [row] = await query<{ id: string }[]>`
        update workspace_runs
        set
          status = 'queued',
          stage = 'queued',
          control_state = null,
          control_requested_at = null,
          error = null,
          failure_count = 0,
          dead_lettered_at = null,
          dead_letter_reason = null,
          lease_expires_at = null,
          last_heartbeat_at = null,
          workflow_started_at = null,
          workflow_start_attempts = 0,
          workflow_start_next_at = null,
          updated_at = now(),
          stats = jsonb_set(coalesce(stats, '{}'::jsonb), '{deadLetterRecoveredAt}', to_jsonb(now()), true)
        where id = ${run.id}
          and coalesce(control_state, '') = 'dead-letter'
        returning id
      `;
      return row?.id ?? run.id;
    }

    if (input.action === "resume") {
      if (!transaction) await signals.resume(run.id).catch(() => {});
      const [row] = await query<{ id: string }[]>`
        update workspace_runs
        set control_state = ${planned.controlState ?? null},
            control_requested_at = null,
            status = ${planned.status ?? run.status},
            error = ${planned.error ?? run.error},
            lease_expires_at = case when control_state = 'paused' then null else lease_expires_at end,
            last_heartbeat_at = case when control_state = 'paused' then null else last_heartbeat_at end,
            updated_at = now()
        where id = ${run.id}
        returning id
      `;
      return row?.id ?? null;
    }

    if (input.action === "pause") {
      await signals.pause(run.id).catch(() => {});
      const [row] = await query<{ id: string }[]>`
        update workspace_runs
        set control_state = ${planned.controlState ?? null},
            control_requested_at = now(),
            status = ${planned.status ?? run.status},
            lease_expires_at = case when ${planned.immediate} then null else lease_expires_at end,
            last_heartbeat_at = case when ${planned.immediate} then null else last_heartbeat_at end,
            updated_at = now()
        where id = ${run.id}
        returning id
      `;
      return row?.id ?? null;
    }

    // Cancel: in-flight runs are cancelled through Temporal; queued or paused
    // runs fail immediately.
    if (!planned.immediate) await signals.cancel(run.id);
    const [row] = await query<{ id: string }[]>`
      update workspace_runs
      set control_state = ${planned.controlState ?? null},
          control_requested_at = now(),
          status = ${planned.status ?? run.status},
          error = ${planned.error ?? run.error},
          lease_expires_at = case when ${planned.immediate} then now() else lease_expires_at end,
          last_heartbeat_at = case when ${planned.immediate} then null else last_heartbeat_at end,
          updated_at = now()
      where id = ${run.id}
      returning id
    `;
    return row?.id ?? null;
  }

  return { start, retry, prepareRetry, fail, control, signalResume: signals.resume };
}

export type RunLifecycle = ReturnType<typeof createRunLifecycle>;

export const runLifecycle: RunLifecycle = createRunLifecycle({
  sql: defaultSql,
  startWorkflow: (runId, pipeline, options) =>
    options ? startPipelineWorkflow(runId, pipeline, options) : startPipelineWorkflow(runId, pipeline),
  failureThreshold: resolvePoisonRunFailureThreshold(process.env.POISON_RUN_FAILURE_THRESHOLD),
});

import { assertExecutionOwnership, assertPlanningOwnership, type ExecutionOwner, StaleExecutionError } from "./execution-ownership.js";
import { noteRunPageStage } from "../pipeline/run-milestones.js";
import { randomUUID } from "node:crypto";
import type { Sql, JSONValue } from "postgres";
import type { WorkflowState } from "../pipeline/pipeline.js";
import type { VisionPageTask } from "../temporal/shared.js";
import { consumeRunCreditLease, type LeaseObservation, type RunCreditLeases } from "./credit-lease.js";
import { enforceRunSpend, spendCounterSql } from "./spend-check.js";
import { retryTransaction } from "./transaction-retry.js";
import { persistRunUsageEvents, debitRunUsageCredits } from "./usage-event-store.js";

export class PageTaskStore {
  constructor(
    private readonly sql: Sql<Record<string, unknown>>,
    private readonly creditLeases?: RunCreditLeases,
  ) {}

  async enqueue(tasks: VisionPageTask[], owner?: ExecutionOwner) {
    if (owner) return this.sql.begin(async tx => {
      await assertPlanningOwnership(tx, owner);
      if (tasks.some(task => task.runId !== owner.runId)) throw new StaleExecutionError();
      await new PageTaskStore(tx as unknown as Sql<Record<string, unknown>>).enqueue(tasks);
    });
    if (!tasks.length) return;
    await this.sql`insert into page_work_tasks ${this.sql(tasks.map(task => ({
      run_id: task.runId, document_id: task.documentId, page_number: task.pageNumber,
    })), "run_id", "document_id", "page_number")} on conflict do nothing`;
  }

  /** Stores full tasks so child workflows can load bounded batches by offset. */
  async enqueueWithPayload(tasks: VisionPageTask[], progress?: (completed: number) => void, owner?: ExecutionOwner): Promise<number> {
    if (tasks.length) {
      const batchSize = progress ? 100 : 1_000;
      for (let index = 0; index < tasks.length; index += batchSize) {
        progress?.(index);
        const slice = tasks.slice(index, index + batchSize);
        if (owner) {
          await this.sql.begin(async tx => {
            await assertPlanningOwnership(tx, owner);
            if (slice.some(task => task.runId !== owner.runId)) throw new StaleExecutionError();
            await new PageTaskStore(tx as unknown as Sql<Record<string, unknown>>).enqueueWithPayload(slice);
          });
          continue;
        }
        await this.sql`insert into page_work_tasks ${this.sql(slice.map(task => ({
          run_id: task.runId, document_id: task.documentId, page_number: task.pageNumber,
          payload: this.sql.json(stripTaskFlags(task) as unknown as JSONValue),
        })), "run_id", "document_id", "page_number", "payload")}
          on conflict (run_id, document_id, page_number) do update set payload = excluded.payload
          where page_work_tasks.payload is null or
          (excluded.payload ? 'spendAdmissionGeneration'
            and page_work_tasks.payload->'spendAdmissionGeneration'
              is distinct from excluded.payload->'spendAdmissionGeneration')`;
      }
    }
    progress?.(tasks.length);
    const runId = tasks[0]?.runId;
    return runId ? this.countWithPayload(runId, tasks[0]?.spendAdmissionGeneration) : 0;
  }

  async countWithPayload(runId: string, generation?: string | null): Promise<number> {
    const [row] = await this.sql<{ total: number }[]>`
      select count(*)::int as total from page_work_tasks where run_id = ${runId} and payload is not null
        ${generation === undefined ? this.sql`` : this.sql`and payload->'spendAdmissionGeneration' = ${this.sql.json(generation)}::jsonb`}`;
    return Number(row?.total ?? 0);
  }

  /** Stable order (document, page) so offsets name the same batch on every replay and retry. */
  async loadBatch(runId: string, offset: number, limit: number, generation?: string | null): Promise<VisionPageTask[]> {
    const rows = await this.sql<{ payload: VisionPageTask }[]>`
      select payload from page_work_tasks where run_id = ${runId} and payload is not null
        ${generation === undefined ? this.sql`` : this.sql`and payload->'spendAdmissionGeneration' = ${this.sql.json(generation)}::jsonb`}
      order by document_id, page_number offset ${Math.max(0, offset)} limit ${Math.max(1, limit)}`;
    return rows.map(row => row.payload);
  }

  async completed(runId: string) {
    const rows = await this.sql`select document_id, page_number, result from page_work_tasks where run_id=${runId} and status='completed'`;
    return new Map<string, unknown>(rows.map(row => [`${row.document_id}:${row.page_number}`, row.result]));
  }

  private executionPredicate(task: VisionPageTask) {
    if (task.spendAdmissionGeneration === undefined) return this.sql``;
    return this.sql`and exists (select 1 from project_runs r where r.id = page_work_tasks.run_id
      and r.execution_generation is not distinct from ${task.spendAdmissionGeneration})`;
  }

  async release(task: VisionPageTask, lease: string): Promise<void> {
    await this.sql`update page_work_tasks set status='queued', lease_id=null, lease_expires_at=null
      where run_id=${task.runId} and document_id=${task.documentId} and page_number=${task.pageNumber}
        and lease_id=${lease} and status='processing'`;
  }

  async claim(task: VisionPageTask, workerId: string) {
    const lease = randomUUID();
    const rows = await this.sql`update page_work_tasks set status='processing', lease_id=${lease},
      lease_expires_at=now()+interval '3 minutes', worker_id=${workerId}, attempts=attempts+1, started_at=coalesce(started_at,now())
      where run_id=${task.runId} and document_id=${task.documentId} and page_number=${task.pageNumber}
        and status!='completed' and (lease_expires_at is null or lease_expires_at < now()) ${this.executionPredicate(task)} returning lease_id`;
    if (rows.length) return lease;
    const completed = await this.completed(task.runId);
    if (completed.has(`${task.documentId}:${task.pageNumber}`)) return null;
    return "busy";
  }

  async renew(task: VisionPageTask, lease: string) {
    const rows = await this.sql`update page_work_tasks set lease_expires_at=now()+interval '3 minutes'
      where run_id=${task.runId} and document_id=${task.documentId} and page_number=${task.pageNumber}
        and lease_id=${lease} and status='processing' ${this.executionPredicate(task)} returning lease_id`;
    if (!rows.length) throw new Error("Page task lease lost");
  }

  async finish(task: VisionPageTask, lease: string, state: WorkflowState, result: unknown, failed = false) {
    const usageBatch = state.usageLedger.checkpoint();
    const usageEvents = usageBatch.events;
    let spendCheckDue = false;
    // Credit leases (credit-lease.ts) replace the cadence counters when on.
    const leases = this.creditLeases ? await this.creditLeases.active() : false;
    let leaseConsumed = false;
    let leaseObservation: LeaseObservation | null = null;
    let spentCents = state.run.spentCents;
    await retryTransaction(`page-task run=${task.runId} page=${task.pageNumber}`, () => this.sql.begin(async tx => {
      spendCheckDue = false;
      leaseConsumed = false;
      leaseObservation = null;
      const client = tx as unknown as Sql<Record<string, unknown>>;
      if (task.spendAdmissionGeneration !== undefined) {
        await assertExecutionOwnership(tx, { runId: task.runId, orgId: state.run.orgId!, projectId: state.run.projectId!,
          executionGeneration: task.spendAdmissionGeneration ?? undefined });
      }
      const rows = await client`select lease_id, status from page_work_tasks
        where run_id=${task.runId} and document_id=${task.documentId} and page_number=${task.pageNumber} for update`;
      if (rows[0]?.lease_id !== lease || rows[0]?.status !== 'processing') throw new Error("Page task lease lost before checkpoint");
      // The usage_events trigger adds `cost` to spent_cents (0056).
      const cost = await persistRunUsageEvents({client, state, usageEvents});
      if (leases) {
        const [run] = await client<{ spent_cents: number | string }[]>`update project_runs set updated_at=now() where id=${task.runId}
          returning spent_cents`;
        spentCents = Number(run?.spent_cents ?? spentCents) || 0;
      } else {
        // Mid-run balance check cadence (spend-check.ts): every N pages or credits.
        const counter = spendCounterSql(client, task.runId, client`1`, cost);
        const [run] = await client<{ spend_check_due: boolean; spent_cents: number | string }[]>`update project_runs
          set ${counter.assignments}, updated_at=now()
          from ${counter.from} where project_runs.id = spend_prev.id
          returning ${counter.checkDue} as spend_check_due, project_runs.spent_cents`;
        spendCheckDue = run?.spend_check_due === true;
        spentCents = Number(run?.spent_cents ?? spentCents) || 0;
      }
      await client`update page_work_tasks set status=${failed ? 'queued' : 'completed'}, result=${client.json(result as JSONValue)},
        lease_id=null, lease_expires_at=null, completed_at=${failed ? null : new Date()}
        where run_id=${task.runId} and document_id=${task.documentId} and page_number=${task.pageNumber}`;
      if (!failed) await client`insert into page_stage_states(run_id,document_id,stage_name,page_number,status,completed_at)
        values(${task.runId},${task.documentId},'vision-extract',${task.pageNumber},'completed',now())
        on conflict(run_id,document_id,stage_name,page_number) do update set status='completed',completed_at=now()`;
      // Pending debit: no org row lock on the page-task path.
      await debitRunUsageCredits({client, state, costCents:cost});
      // Same transaction as the debit: available and the lease fall together.
      if (leases && cost > 0) {
        leaseConsumed = true;
        leaseObservation = await consumeRunCreditLease(client, { id: task.runId, orgId: state.run.orgId }, cost);
      }
    }));
    usageBatch.commit();
    state.run.spentCents = spentCents;
    if (!failed) await noteRunPageStage(state, "vision-extract");
    if (leaseConsumed) {
      await this.creditLeases!.afterConsume({
        id: task.runId, orgId: state.run.orgId, projectId: state.run.projectId ?? null, userId: state.run.userId,
      }, leaseObservation, "page-interval");
    }
    if (spendCheckDue) {
      await enforceRunSpend(this.sql, {
        id: task.runId, orgId: state.run.orgId, projectId: state.run.projectId ?? null, userId: state.run.userId,
      }, "page-interval");
    }
  }
}

function stripTaskFlags(task: VisionPageTask): VisionPageTask {
  const { slotGate: _slotGate, ...rest } = task;
  return rest;
}

/** At most this many queued tasks are counted: a capacity hint needs no exact count past it. */
export const RUN_BACKLOG_COUNT_LIMIT = 100_000;

/**
 * Queued (unclaimed) page tasks of one run, only when the run belongs to `orgId`; any other organization's run reads 0.
 * Served by page_work_tasks_pending_idx (run_id, status). Capped at RUN_BACKLOG_COUNT_LIMIT.
 */
export async function queuedRunPageTasks(sql: Sql<Record<string, unknown>>, scope: { orgId: string; runId: string }): Promise<number> {
  for (const value of [scope.orgId, scope.runId]) {
    if (!value || value.length > 200) throw new Error("Invalid run backlog scope");
  }
  // A hint must never hold a pool connection on a slow database: the read gives up after 2 s.
  const [row] = await sql.begin(async (tx) => {
    await tx`set local statement_timeout = '2s'`;
    return await tx<{ queued: number }[]>`
    select count(*)::int as queued from (
      select 1 from page_work_tasks t
      where t.run_id = ${scope.runId} and t.status = 'queued'
        and exists (select 1 from project_runs r where r.id = ${scope.runId} and r.org_id = ${scope.orgId})
      limit ${RUN_BACKLOG_COUNT_LIMIT}
    ) q`;
  });
  return Number(row?.queued ?? 0);
}

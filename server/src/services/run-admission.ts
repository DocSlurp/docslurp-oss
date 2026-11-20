import type { TransactionSql } from "postgres";

import { chatCreditReserve, speedBoostMultiplier } from "@docslurp/shared";

import { sql, type SqlClient } from "../db.js";
import { lockOrgAdmission } from "./billing/admission-lock.js";
import { creditLeaseConfig, creditLeasesEnabled, grantRunCreditLease } from "./billing/credit-leases.js";
import {
  assertCanSpend,
  loadSpendStatus,
  runAdmissionReserveCredits,
  spendBlockJobReason,
  spendBlockReason,
  SpendBlockedError,
  spendGuardsSkipped,
  type SpendBlockedCode,
} from "./billing/spend-guard.js";
import { fleetSupportsNow, taskQueueForOrgKey } from "./worker-fleet.js";

/**
 * Run admission: the one module through which a Run becomes spendable work. Every path that queues a run, or puts
 * an existing run back to work, takes its lock and its spend decision from one of the entry points here:
 *
 *  - `admitRunSpend`: a new run (run creation), or with `readmission` an existing run (retry, operator resume and
 *    recover), in a transaction this module owns.
 *  - `admitRunInTransaction`: a run created inside the caller's transaction (re-index and full-index batches).
 *  - `admitBlockedRun`: a re-index run saved as `blocked`, once its organization may spend again.
 *  - `pausedRunSpendBlock`: the spend decision for a run the worker paused mid-run. That path
 *    (spend-paused-runs.ts) clears the pause and grants the lease itself, because it keeps the lease's own refusal
 *    reason for the pause.
 *  - `admitOnDemandRun`: an on-demand page run started by a query, under the interactive rule.
 *
 * It owns the order of the steps in the server: the organization's admission lock (billing/admission-lock.ts) first, then the
 * run's own scope check, the spend decision with the per-run reservation, the caller's insert or transition, and the
 * run's first credit lease, all in one transaction, so concurrent admissions cannot pass on one balance and a
 * refusal leaves nothing behind. The spend rule itself is billing/spend-guard.ts over `org_spend_status()`.
 *
 * `run-admission-owners.test.ts` keeps run inserts, the lock key and the lease primitive from being used around it.
 */

export { lockOrgAdmission };

/** A queued run with mandatory leases must own usable credit in this transaction. */
export async function requireRunCreditLease(
  tx: TransactionSql,
  run: { runId: string; orgId: string; projectId: string },
): Promise<void> {
  const grant = await grantRunCreditLease(tx, run);
  if (!grant || grant.blockReason || !Number.isFinite(grant.remaining) || grant.remaining <= 0) {
    throw new SpendBlockedError("Run admission could not acquire a usable credit lease", "credit_exhausted");
  }
}

/**
 * Run admission: serialise the org's admissions on an advisory lock, check
 * spend with the per-run reservation, and call `admit` (which must insert the
 * run with the same client) inside that transaction. Readmission callbacks run
 * first under the org and scoped run locks: they must throw for an ineligible
 * no-op and must never publish external signals. Refusal rolls their writes back.
 */
export async function admitRunSpend<T>(
  orgId: string,
  projectId: string,
  admit: (client: TransactionSql) => Promise<T>,
  options: {
    leaseRunId?: string; speedBoost?: boolean; readmission?: boolean;
    /**
     * Runs first in the admission transaction, right after the organization's admission lock is held and before any
     * spend is read or reserved: re-validates the principal against rows it locks, so an authorization change that
     * committed while this admission waited for the lock refuses it. Throwing rolls everything back.
     */
    authorize?: (client: TransactionSql) => Promise<void>;
  } = {},
): Promise<T> {
  const multiplier = speedBoostMultiplier(options.speedBoost);
  const guarded = !spendGuardsSkipped();
  // Leases need every worker that may run the job to consume them
  // (services/worker-fleet.ts). Admission is a request path, so it reads the
  // cached fleet view; unknown keeps the per-run reservation, and the worker
  // grants the lease at its first checkpoint.
  const leases = guarded && creditLeasesEnabled()
    && fleetSupportsNow("billing.credit-leases", taskQueueForOrgKey(orgId).taskQueue);
  // With leases the lease is the run's reservation (`runReserveCredits` is 0 below), so an admission that names no
  // run holds nothing. Every caller in the server names its run (run-admission-owners.test.ts); a boosted one must.
  if (leases && multiplier > 1 && !options.leaseRunId?.trim()) {
    throw new Error("Boosted run admission requires a lease run ID");
  }
  return (await sql.begin(async (tx) => {
    if (guarded || options.readmission) {
      await lockOrgAdmission(tx, orgId);
    }
    if (options.authorize) await options.authorize(tx);
    // Verify the persisted tenant scope before allowing the transactional
    // lifecycle callback to touch an existing run.
    let admitted: T;
    let ownReservation = 0;
    if (options.readmission) {
      const [existing] = await tx`
        select pipeline from project_runs where id = ${options.leaseRunId ?? ""}
          and org_id = ${orgId} and project_id = ${projectId} for update
      `;
      if (!existing) throw new SpendBlockedError("Run does not belong to this project", "plan_not_entitled");
      if ((existing.pipeline?.speedBoost === true) !== (options.speedBoost === true)) {
        throw new SpendBlockedError("Run mode cannot change during readmission", "plan_not_entitled");
      }
      // Eligibility and its writes are atomic with admission; a no-op throws
      // before billing and a spend refusal rolls every write back.
      admitted = await admit(tx);
      const [reservation] = leases ? await tx`
        select coalesce(sum(greatest(granted-consumed,0)),0) as amount from credit_leases
        where holder_kind='run' and holder_id=${options.leaseRunId!}
          and org_id=${orgId} and project_id=${projectId}
          and status='active' and expires_at>now() and not credit_exempt
      ` : await tx`
        select case when pipeline->'speedBoost'='true'::jsonb
          then greatest(0, ${runAdmissionReserveCredits()} * 4 - spent_cents)
          else greatest(0, ${runAdmissionReserveCredits()} - (input_cost_cents+output_cost_cents)) end as amount
        from project_runs where id=${options.leaseRunId!}
          and org_id=${orgId} and project_id=${projectId} and status in ('queued','processing')
          and coalesce(control_state, '') not in ('paused', 'cancelled', 'cancel_requested', 'dead-letter')
      `;
      ownReservation = Number(reservation?.amount ?? 0);
    }
    if (guarded) {
      const status = await loadSpendStatus(orgId, projectId, {
        client: tx, reusingRunId: options.readmission ? options.leaseRunId : undefined,
        // Leases replace the per-run reservation: `reserved` holds them all.
        runReserveCredits: leases ? 0 : runAdmissionReserveCredits(),
      });
      // Existing runs reserve their own immutable multiplier in SQL. Reserve the
      // new boosted run before insertion; base admissions retain their prior rule.
      const requiredReserve = multiplier > 1
        ? (leases ? creditLeaseConfig().minCredits : runAdmissionReserveCredits()) * multiplier
        : 0;
      const checked = status ? {
        ...status,
        reserved: options.readmission
          // Lease acquisition below validates the existing lease or funds a new
          // one. Only this verified run's live reservation is reusable.
          ? Math.max(0, status.reserved - ownReservation) + (leases ? 0 : requiredReserve)
          : status.reserved + requiredReserve,
      } : null;
      const reason = spendBlockReason(checked);
      if (reason) throw new SpendBlockedError(reason.message, reason.code, status?.autoTopUpOn === true, { spendKind: "job",
        availableCredits: status?.available ?? 0, heldCredits: status?.reserved ?? 0,
        chatReserveCredits: status ? chatCreditReserve(status.funded) : 0 });
    }
    if (!options.readmission) admitted = await admit(tx);
    // Failure aborts this transaction, including the queued run and any partial
    // lease writes. A worker checkpoint cannot repair unreserved admission.
    if (leases && options.leaseRunId) {
      await requireRunCreditLease(tx, { runId: options.leaseRunId, orgId, projectId });
    }
    return admitted!;
  }).catch((error: unknown) => {
    const code = (error as { code?: string }).code;
    if (code === "P4021" || code === "P4022") throw new SpendBlockedError("Monthly budget capacity is reserved by pending work", code === "P4021" ? "org_budget_paused" : "project_budget_paused");
    throw error;
  })) as T;
}

/**
 * The admission decision for work created inside the caller's transaction: takes the org's admission lock and
 * reports why the org may not spend, or null. It never throws for a refusal.
 */
async function admissionBlock(
  tx: TransactionSql,
  orgId: string,
  projectId: string,
  options: { speedBoost?: boolean } = {},
): Promise<{ code: SpendBlockedCode; message: string } | null> {
  if (spendGuardsSkipped()) return null;
  await lockOrgAdmission(tx, orgId);
  const multiplier = speedBoostMultiplier(options.speedBoost);
  const leases = creditLeasesEnabled();
  const status = await loadSpendStatus(orgId, projectId, {
    client: tx, runReserveCredits: leases ? 0 : runAdmissionReserveCredits(),
  });
  return spendBlockReason(status && multiplier > 1 ? { ...status, reserved: status.reserved
    + (leases ? creditLeaseConfig().minCredits : runAdmissionReserveCredits()) * multiplier } : status);
}


/** Why a run created in the caller's transaction was not queued, or null when it was. */
export type RunBlockedReason = ReturnType<typeof spendBlockJobReason>;

/**
 * Admission for a run created inside the caller's transaction (re-index and full-index batches). Takes the
 * organization's admission lock, decides spend, calls `create` to insert the run and its documents, then takes the
 * run's first credit lease; each batch therefore holds its own reservation before the next one is checked.
 *
 * `refusal: "throw"` raises SpendBlockedError and expects the caller's transaction to roll back.
 * `refusal: "block"` never throws for a refusal: `create` receives the reason and inserts the run as `blocked`, and a
 * refused lease turns the queued run `blocked` (`credits`) so the caller's own change still commits. Pass
 * `blockedReason` when the whole job is already known to be blocked; no spend is read then.
 */
export async function admitRunInTransaction<T>(
  tx: TransactionSql,
  run: { runId: string; orgId: string; projectId: string; speedBoost?: boolean },
  create: (blockedReason: RunBlockedReason | null) => Promise<T>,
  options: { refusal: "throw" } | { refusal: "block"; blockedReason?: RunBlockedReason | null },
): Promise<{ value: T; blockedReason: RunBlockedReason | null }> {
  let blockedReason: RunBlockedReason | null = options.refusal === "block" ? options.blockedReason ?? null : null;
  if (!blockedReason) {
    const block = await admissionBlock(tx, run.orgId, run.projectId, { speedBoost: run.speedBoost });
    if (block && options.refusal === "throw") throw new SpendBlockedError(block.message, block.code);
    if (block) blockedReason = spendBlockJobReason(block.code);
  }
  const value = await create(blockedReason);
  // `create` is the caller's code: confirm it wrote this run, in this organization and project, in the state it was
  // told to. A queued run under another id would otherwise keep no lease, and a blocked one would start.
  const [written] = await tx<{ status: string }[]>`
    select status from project_runs where id = ${run.runId} and org_id = ${run.orgId} and project_id = ${run.projectId}`;
  if (written?.status !== (blockedReason ? "blocked" : "queued")) {
    throw new Error(`Run admission expected run ${run.runId} to be ${blockedReason ? "blocked" : "queued"} after its insert`);
  }
  if (blockedReason || !creditLeasesEnabled() || spendGuardsSkipped()) return { value, blockedReason };
  const lease = { runId: run.runId, orgId: run.orgId, projectId: run.projectId };
  // A queued run must hold its own validated lease before another batch can pass.
  if (options.refusal === "throw") {
    await requireRunCreditLease(tx, lease);
    return { value, blockedReason };
  }
  try {
    await tx.savepoint(async (sp) => {
      await requireRunCreditLease(sp, lease);
    });
  } catch (error) {
    // Keep the caller's change and the document manifest, but never publish queued work whose mandatory lease was
    // refused or uncertain.
    blockedReason = "credits";
    const [blocked] = await tx<{ id: string }[]>`update project_runs set status = 'blocked', blocked_reason = 'credits'
      where id = ${run.runId} and org_id = ${run.orgId} and project_id = ${run.projectId} returning id`;
    if (!blocked) throw error;
    console.warn(`[credit-leases] run=${run.runId} admission blocked: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { value, blockedReason };
}

/**
 * Queue a re-index run saved as `blocked`, in a transaction of its own: admitted only when the organization may
 * spend again and the run takes its first credit lease. False leaves it blocked, with nothing written.
 */
export async function admitBlockedRun(
  client: SqlClient,
  run: { id: string; orgId: string; projectId: string; speedBoost: boolean },
): Promise<boolean> {
  return await client.begin(async (tx) => {
    const block = await admissionBlock(tx, run.orgId, run.projectId, { speedBoost: run.speedBoost });
    if (block) return false;
    try {
      return await tx.savepoint(async (sp) => {
        const [updated] = await sp<{ id: string }[]>`
          update project_runs
          set status = 'queued', blocked_reason = null, workflow_started_at = null, workflow_start_next_at = null,
              updated_at = now()
          where id = ${run.id} and org_id = ${run.orgId} and project_id = ${run.projectId}
            and status = 'blocked' and control_state is null
          returning id
        `;
        if (!updated) return false;
        if (creditLeasesEnabled() && !spendGuardsSkipped()) {
          await requireRunCreditLease(sp, { runId: run.id, orgId: run.orgId, projectId: run.projectId });
        }
        return true;
      });
    } catch (error) {
      // Roll back both the queued transition and any partial lease write.
      console.warn(`[blocked-runs] run=${run.id} remains blocked: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }) as boolean;
}

/**
 * The spend decision for resuming a run the worker paused mid-run, read under the organization and run locks the
 * caller already holds. `owedCredits` are the run's measured pages no charge covers yet: they are held like credits
 * in-flight runs hold, so the run resumes only when what is left after them may spend. Null means it may resume.
 */
export async function pausedRunSpendBlock(
  tx: TransactionSql,
  run: { runId: string; orgId: string; projectId: string },
  options: { leases: boolean; owedCredits: number },
): Promise<{ code: SpendBlockedCode; message: string } | null> {
  const status = await loadSpendStatus(run.orgId, run.projectId, {
    client: tx, reusingRunId: run.runId, runReserveCredits: options.leases ? 0 : runAdmissionReserveCredits(),
  });
  return spendBlockReason(status && options.owedCredits > 0 ? { ...status, reserved: status.reserved + options.owedCredits } : status);
}

/**
 * Admission for an on-demand page run a query starts, inside the caller's transaction. These runs are part of an
 * interactive call, so they pass the interactive spend rule (no hold of their own). The organization's admission
 * lock is taken first; `prepare` then reads what the run will hold (its page plan, its pipeline) under that lock,
 * and `insert` writes the run only after the spend decision. Throws SpendBlockedError when the organization may not
 * spend, with nothing inserted.
 */
export async function admitOnDemandRun<P, T>(
  tx: TransactionSql,
  scope: { orgId: string; projectId: string },
  steps: { prepare: () => Promise<P>; insert: (prepared: P) => Promise<T> },
): Promise<T> {
  await lockOrgAdmission(tx, scope.orgId);
  const prepared = await steps.prepare();
  await assertCanSpend(scope.orgId, scope.projectId, { client: tx, kind: "interactive", hold: false });
  return await steps.insert(prepared);
}

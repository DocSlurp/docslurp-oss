import { PAGE_READ_METRICS, runMeasuredPagesCredits } from "@docslurp/shared";
import { withBackgroundSpan } from "@docslurp/shared/observability";
import { apiPool, sql as defaultSql, type SqlClient } from "../db.js";
import { signalPipelinePause, signalPipelineResume } from "../lib/temporal.js";
import { RUN_EVENTS_CHANNEL } from "./run-event-hub.js";
import { loadSpendStatus, runAdmissionReserveCredits, spendBlockReason, spendGuardsSkipped } from "./billing/spend-guard.js";
import { creditLeasesEnabled, grantRunCreditLease } from "./billing/credit-leases.js";
import { fleetSupports, taskQueueForOrgKey } from "./worker-fleet.js";
import { restoreRunMonthlyCapacity } from "./run-monthly-readmission.js";

/**
 * Runs the worker paused mid-run because their org could no longer spend
 * (pause_reason set, control_state 'paused'; worker/src/db/spend-check.ts).
 * They resume by themselves once the org may spend again: credits arrive,
 * auto-recharge succeeds, or a budget is raised. The maintenance sweep checks
 * them every interval; it also re-sends the pause signal to runs that are
 * still blocked, in case the worker's own signal was lost.
 *
 * With credit leases (migration 0052) a resume first takes the run's lease:
 * when a small top-up wakes many paused runs, only those that get credits
 * resume, the rest stay paused. `org_spend_changed` notifications (top-ups,
 * auto top-up, funding and budget changes, released or expired leases) sweep
 * the org at once; the maintenance sweep stays the fallback.
 */

export interface SpendPausedRunsDeps {
  sql?: SqlClient;
  signals?: { pause(runId: string): Promise<void>; resume(runId: string): Promise<void> };
}

type PausedRunRow = { id: string; org_id: string; project_id: string; user_id: string; pause_reason: string };

export const ORG_SPEND_CHANGED_CHANNEL = "org_spend_changed";

/** Credits the run owes for measured pages no charge covers yet, at its own speed boost (shared runMeasuredPagesCredits). */
export async function runMeasuredCredits(client: SqlClient, runId: string): Promise<number> {
  const [row] = await client<{ fast_pages: string | number; ocr_frames: string | number; speed_boost: boolean | null }[]>`
    select m.fast_pages, m.ocr_frames, (r.pipeline ->> 'speedBoost')::boolean as speed_boost
    from project_runs r cross join run_measured_pages(r.id, ${[...PAGE_READ_METRICS]}::text[], null) m
    where r.id = ${runId}
  `;
  if (!row) return 0;
  return runMeasuredPagesCredits({ fastPages: Number(row.fast_pages), ocrFrames: Number(row.ocr_frames) }, row.speed_boost === true);
}

/** Clear a spend pause and resume the workflow. Returns whether the run changed. */
export async function resumeSpendPausedRun(runId: string, deps: SpendPausedRunsDeps = {}): Promise<boolean> {
  return (await resumeSpendPausedRunOutcome(runId, deps)).status === "resumed";
}

export type SpendResumeOutcome =
  | { status: "resumed" }
  /** Signal delivery failed; the transaction rolls back and the next sweep retries. */
  | { status: "deferred" }
  /** The run is not paused for spend (an operator pause, or not paused at all). */
  | { status: "not-spend-paused" }
  /** Spend-paused and still no credits for it: the pause stays. */
  | { status: "blocked"; reason: string };

/**
 * Like resumeSpendPausedRun, but tells a refused lease apart from a run that
 * is not spend-paused, so a manual resume cannot fall through to the operator
 * resume path and bypass the refusal.
 */
export async function resumeSpendPausedRunOutcome(runId: string, deps: SpendPausedRunsDeps = {}): Promise<SpendResumeOutcome> {
  const sql = deps.sql ?? defaultSql;
  const signals = deps.signals ?? { pause: signalPipelinePause, resume: signalPipelineResume };
  // Resolve fleet capability before reserving a transaction connection: it may
  // query the same pool (including one-connection test/self-hosted pools).
  const [candidate] = await sql<PausedRunRow[]>`
    select id, org_id, project_id, user_id, pause_reason from project_runs
    where id = ${runId} and status = 'processing' and control_state = 'paused' and pause_reason is not null
  `;
  if (!candidate) return { status: "not-spend-paused" };
  const leases = !spendGuardsSkipped() && creditLeasesEnabled()
    && await fleetSupports("billing.credit-leases", taskQueueForOrgKey(candidate.org_id).taskQueue);
  let blockedReason: string | null = null;
  try {
    return await sql.begin(async tx => {
      const client = tx as unknown as SqlClient;
      // Admission always locks org before run. Serializing only the run lets
      // two paused runs reuse the same available capacity.
      await tx`select pg_advisory_xact_lock(spend_admission_lock_key(${candidate.org_id}))`;
      await tx`select pg_advisory_xact_lock(90105, hashtext(${runId}))`;
      const [row] = await tx<PausedRunRow[]>`
        select id, org_id, project_id, user_id, pause_reason from project_runs
        where id = ${runId} and org_id = ${candidate.org_id} and status = 'processing' and control_state = 'paused'
          and pause_reason in ('credit_exhausted', 'project_budget_paused', 'org_budget_paused', 'plan_not_entitled')
        for no key update
      `;
      if (!row) return { status: "not-spend-paused" } as const;
      await restoreRunMonthlyCapacity(tx, row.id);
      if (!spendGuardsSkipped()) {
        // The run already owes its measured pages no charge covers yet (run_measured_pages, migration 0190: Fast pages above
        // intake, uncharged image frames), the same sum the worker's page-basis check pauses on. Resuming before the balance
        // covers them would only re-pause the run at its next check, forever; it stays paused until it does. A failed read
        // throws: the transaction rolls back and the pause is kept.
        const owed = await runMeasuredCredits(client, row.id);
        const status = await loadSpendStatus(row.org_id, row.project_id, { client, reusingRunId: row.id, runReserveCredits: leases ? 0 : runAdmissionReserveCredits() });
        // The owed credits are held like credits in-flight runs hold: the run resumes only when what is left after them may spend.
        const reason = spendBlockReason(status && owed > 0 ? { ...status, reserved: status.reserved + owed } : status);
        if (reason) {
          blockedReason = reason.code;
          // Restoration must roll back together with the refused pause/lease.
          throw new Error("Resume spend refused");
        }
      }
      await tx`
        update project_runs set control_state = null, control_requested_at = null,
          pause_reason = null, spend_unchecked_pages = 0, spend_unchecked_credits = 0,
          last_heartbeat_at = now(), lease_expires_at = now() + interval '5 minutes', updated_at = now()
        where id = ${runId}
      `;
      if (leases) {
        // Fail closed on lease errors: retain the pause and retry the sweep.
        const grant = await grantRunCreditLease(client, { runId, orgId: row.org_id, projectId: row.project_id });
        if (!grant) throw new Error("Credit lease response missing");
        if (grant.blockReason || !Number.isFinite(grant.remaining) || grant.remaining <= 0) {
          blockedReason = grant.blockReason ?? row.pause_reason;
          throw new Error("Resume lease refused");
        }
      }

      // A failed signal rolls back the pause, lease and event together. The
      // listener/fallback sweep retries; no successful resume is claimed.
      await signals.resume(runId);
      await tx`
        with inserted as (
          insert into project_run_events (id, user_id, run_id, event_type, status, message, payload)
          values (gen_random_uuid()::text, ${row.user_id}, ${runId}, 'run.progress', 'processing',
            'Resumed: the organization can spend again.',
            ${JSON.stringify({ spendResume: { previousReason: row.pause_reason } })}::text::jsonb)
          returning run_id
        )
        select pg_notify(${RUN_EVENTS_CHANNEL}, json_build_object('runIds', json_build_array(inserted.run_id))::text) from inserted
      `;
      return { status: "resumed" } as const;
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "P4021" || code === "P4022") return { status: "blocked", reason: code === "P4021" ? "org_budget_paused" : "project_budget_paused" };
    if (blockedReason) return { status: "blocked", reason: blockedReason };
    console.error(`[spend-paused-runs] run=${runId} resume_delivery_deferred=true pause_preserved=true`);
    return { status: "deferred" };
  }
}

/** One sweep over spend-paused runs: resume those whose org may spend again. */
export async function sweepSpendPausedRuns(
  deps: SpendPausedRunsDeps & { orgId?: string } = {},
): Promise<{ resumed: number; stillBlocked: number }> {
  const sql = deps.sql ?? defaultSql;
  const signals = deps.signals ?? { pause: signalPipelinePause, resume: signalPipelineResume };
  const rows = await sql<PausedRunRow[]>`
    select id, org_id, project_id, user_id, pause_reason
    from project_runs
    where pause_reason is not null
      and control_state = 'paused'
      and status = 'processing'
      ${deps.orgId ? sql`and org_id = ${deps.orgId}` : sql``}
    order by updated_at asc
    limit 200
  `;
  let resumed = 0;
  let stillBlocked = 0;
  for (const row of rows) {
    const outcome = await resumeSpendPausedRunOutcome(row.id, { sql, signals });
    if (outcome.status === "resumed") resumed += 1;
    else {
      stillBlocked += 1;
      await signals.pause(row.id).catch(() => undefined);
    }
  }
  if (resumed > 0) console.log(`[spend-paused-runs] resumed=${resumed} still_blocked=${stillBlocked}`);
  return { resumed, stillBlocked };
}

let orgSpendListener: { unlisten(): Promise<void> } | null = null;
const pendingOrgSweeps = new Map<string, ReturnType<typeof setTimeout>>();
const runningOrgSweeps = new Set<string>();

/** Debounced per org: a burst of notifications (a grant touches several rows) sweeps once. */
export function requestOrgSpendSweep(orgId: string, deps: SpendPausedRunsDeps = {}, delayMs = 250): void {
  if (!orgId || pendingOrgSweeps.has(orgId)) return;
  const timer = setTimeout(() => {
    pendingOrgSweeps.delete(orgId);
    if (runningOrgSweeps.has(orgId)) {
      requestOrgSpendSweep(orgId, deps, delayMs);
      return;
    }
    runningOrgSweeps.add(orgId);
    withBackgroundSpan("api.spend-paused-runs", () => sweepSpendPausedRuns({ ...deps, orgId }))
      .catch((error: unknown) => {
        console.error(`[spend-paused-runs] org=${orgId} sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => runningOrgSweeps.delete(orgId));
  }, delayMs);
  timer.unref?.();
  pendingOrgSweeps.set(orgId, timer);
}

/** Parse an `org_spend_changed` payload: `{"orgId": "...", "reason": "..."}`. */
export function orgIdFromSpendChangedPayload(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { orgId?: unknown };
    return typeof parsed.orgId === "string" && parsed.orgId.length > 0 && parsed.orgId.length <= 200 ? parsed.orgId : null;
  } catch {
    return null;
  }
}

/** LISTEN org_spend_changed and resume the org's spend-paused runs as soon as it may spend. */
export async function startOrgSpendChangedListener(): Promise<void> {
  if (orgSpendListener) return;
  orgSpendListener = await apiPool.listen(ORG_SPEND_CHANGED_CHANNEL, (payload) => {
    const orgId = orgIdFromSpendChangedPayload(payload);
    if (orgId) requestOrgSpendSweep(orgId);
  }, () => {
    // Re-subscribed after a suspend/resume: sweep everything, since notifications may have been missed.
    void sweepSpendPausedRuns().catch((error: unknown) => {
      console.error(`[spend-paused-runs] catch-up sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
}

export async function stopOrgSpendChangedListener(): Promise<void> {
  const listener = orgSpendListener;
  orgSpendListener = null;
  for (const timer of pendingOrgSweeps.values()) clearTimeout(timer);
  pendingOrgSweeps.clear();
  await listener?.unlisten();
}

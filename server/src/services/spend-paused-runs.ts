import { sql as defaultSql, type SqlClient } from "../db.js";
import { signalPipelinePause, signalPipelineResume } from "../lib/temporal.js";
import { RUN_EVENTS_CHANNEL } from "./run-event-hub.js";
import { loadSpendStatus, spendBlockReason, spendGuardsSkipped } from "./billing/spend-guard.js";
import { creditLeasesEnabled, grantRunCreditLease } from "./billing/credit-leases.js";
import { fleetSupports, taskQueueForOrgKey } from "./worker-fleet.js";

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
 * auto-recharge, budget and plan changes, released or expired leases) sweep
 * the org at once; the maintenance sweep stays the fallback.
 */

export interface SpendPausedRunsDeps {
  sql?: SqlClient;
  signals?: { pause(runId: string): Promise<void>; resume(runId: string): Promise<void> };
}

type PausedRunRow = { id: string; org_id: string; workspace_id: string; user_id: string; pause_reason: string };

export const ORG_SPEND_CHANGED_CHANNEL = "org_spend_changed";

/** Clear a spend pause and resume the workflow. Returns whether the run changed. */
export async function resumeSpendPausedRun(runId: string, deps: SpendPausedRunsDeps = {}): Promise<boolean> {
  return (await resumeSpendPausedRunOutcome(runId, deps)).status === "resumed";
}

export type SpendResumeOutcome =
  | { status: "resumed" }
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
  const [row] = await sql<{ id: string; user_id: string; pause_reason: string; org_id?: string; workspace_id?: string }[]>`
    with prev as (select pause_reason from workspace_runs where id = ${runId})
    update workspace_runs
    set control_state = null,
        control_requested_at = null,
        pause_reason = null,
        spend_unchecked_pages = 0,
        spend_unchecked_credits = 0,
        -- Give the resumed workflow a fresh lease before its next heartbeat.
        last_heartbeat_at = now(),
        lease_expires_at = now() + interval '5 minutes',
        updated_at = now()
    where id = ${runId}
      and pause_reason is not null
      and control_state = 'paused'
    returning id, user_id, org_id, workspace_id, (select pause_reason from prev) as pause_reason
  `;
  if (!row) return { status: "not-spend-paused" };
  if (
    row.org_id && !spendGuardsSkipped() && creditLeasesEnabled()
    && await fleetSupports("billing.credit-leases", taskQueueForOrgKey(row.org_id).taskQueue)
  ) {
    const grant = await grantRunCreditLease(sql, { runId, orgId: row.org_id, workspaceId: row.workspace_id ?? null })
      .catch((error: unknown) => {
        // Fail open, like the worker: its first checkpoint grants the lease.
        console.warn(`[spend-paused-runs] run=${runId} lease grant failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
    if (grant && grant.remaining <= 0) {
      // Nothing left for this run: put the pause back and keep waiting.
      const reason = grant.blockReason ?? row.pause_reason ?? "credit_exhausted";
      await sql`
        update workspace_runs
        set control_state = 'paused', control_requested_at = now(),
            pause_reason = ${reason}, updated_at = now()
        where id = ${runId} and control_state is null and pause_reason is null and status = 'processing'
      `;
      return { status: "blocked", reason };
    }
  }
  await signals.resume(runId).catch((error) => {
    console.warn(`[spend-paused-runs] run=${runId} resume signal failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  await sql`
    with inserted as (
      insert into workspace_run_events (id, user_id, run_id, event_type, status, message, payload)
      values (
        gen_random_uuid()::text, ${row.user_id}, ${runId}, 'run.progress', 'processing',
        'Resumed: the organization can spend again.',
        ${JSON.stringify({ spendResume: { previousReason: row.pause_reason } })}::text::jsonb
      )
      returning run_id
    )
    select pg_notify(${RUN_EVENTS_CHANNEL}, json_build_object('runIds', json_build_array(inserted.run_id))::text)
    from inserted
  `;
  return { status: "resumed" };
}

/** One sweep over spend-paused runs: resume those whose org may spend again. */
export async function sweepSpendPausedRuns(
  deps: SpendPausedRunsDeps & { orgId?: string } = {},
): Promise<{ resumed: number; stillBlocked: number }> {
  const sql = deps.sql ?? defaultSql;
  const signals = deps.signals ?? { pause: signalPipelinePause, resume: signalPipelineResume };
  const rows = await sql<PausedRunRow[]>`
    select id, org_id, workspace_id, user_id, pause_reason
    from workspace_runs
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
    const allowed = spendGuardsSkipped()
      || spendBlockReason(await loadSpendStatus(row.org_id, row.workspace_id, { client: sql })) === null;
    if (allowed) {
      if (await resumeSpendPausedRun(row.id, { sql, signals })) resumed += 1;
    } else {
      stillBlocked += 1;
      // Idempotent: covers a pause signal the worker could not deliver.
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
    sweepSpendPausedRuns({ ...deps, orgId })
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
  orgSpendListener = await defaultSql.listen(ORG_SPEND_CHANGED_CHANNEL, (payload) => {
    const orgId = orgIdFromSpendChangedPayload(payload);
    if (orgId) requestOrgSpendSweep(orgId);
  });
}

export async function stopOrgSpendChangedListener(): Promise<void> {
  const listener = orgSpendListener;
  orgSpendListener = null;
  for (const timer of pendingOrgSweeps.values()) clearTimeout(timer);
  pendingOrgSweeps.clear();
  await listener?.unlisten();
}

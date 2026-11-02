import { withBackgroundSpan } from "@docslurp/shared/observability";
import { apiPool, sql as defaultSql, type SqlClient } from "../db.js";
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
 * auto top-up, funding and budget changes, released or expired leases) sweep
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
    select id, org_id, workspace_id, user_id, pause_reason from workspace_runs
    where id = ${runId} and status = 'processing' and control_state = 'paused' and pause_reason is not null
  `;
  if (!candidate) return { status: "not-spend-paused" };
  const leases = !spendGuardsSkipped() && creditLeasesEnabled()
    && await fleetSupports("billing.credit-leases", taskQueueForOrgKey(candidate.org_id).taskQueue);
  let blockedReason: string | null = null;
  try {
    return await sql.begin(async tx => {
      const client = tx as unknown as SqlClient;
      await tx`select pg_advisory_xact_lock(90105, hashtext(${runId}))`;
      const [row] = await tx<PausedRunRow[]>`
        select id, org_id, workspace_id, user_id, pause_reason from workspace_runs
        where id = ${runId} and status = 'processing' and control_state = 'paused'
          and pause_reason in ('credit_exhausted', 'workspace_budget_paused', 'org_budget_paused', 'plan_not_entitled')
        for no key update
      `;
      if (!row) return { status: "not-spend-paused" } as const;
      if (!spendGuardsSkipped()) {
        const reason = spendBlockReason(await loadSpendStatus(row.org_id, row.workspace_id, { client }));
        if (reason) return { status: "blocked", reason: reason.code } as const;
      }
      await tx`
        update workspace_runs set control_state = null, control_requested_at = null,
          pause_reason = null, spend_unchecked_pages = 0, spend_unchecked_credits = 0,
          last_heartbeat_at = now(), lease_expires_at = now() + interval '5 minutes', updated_at = now()
        where id = ${runId}
      `;
      if (leases) {
        // Fail closed on lease errors: retain the pause and retry the sweep.
        const grant = await grantRunCreditLease(client, { runId, orgId: row.org_id, workspaceId: row.workspace_id });
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
          insert into workspace_run_events (id, user_id, run_id, event_type, status, message, payload)
          values (gen_random_uuid()::text, ${row.user_id}, ${runId}, 'run.progress', 'processing',
            'Resumed: the organization can spend again.',
            ${JSON.stringify({ spendResume: { previousReason: row.pause_reason } })}::text::jsonb)
          returning run_id
        )
        select pg_notify(${RUN_EVENTS_CHANNEL}, json_build_object('runIds', json_build_array(inserted.run_id))::text) from inserted
      `;
      return { status: "resumed" } as const;
    });
  } catch {
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
      else stillBlocked += 1;
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

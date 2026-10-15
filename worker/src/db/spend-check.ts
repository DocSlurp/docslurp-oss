import { Context } from "@temporalio/activity";
import type { Sql } from "postgres";

import { isBillingExemptOrg } from "@docslurp/shared";

import { WORKFLOW_ID_PREFIX } from "../temporal/shared.js";
import { jobCreditReserve } from "./chat-reserve.js";
import { RUN_EVENTS_CHANNEL } from "./run-event-store.js";

/**
 * Mid-run balance check (operator gap OP-09).
 *
 * Runs are admitted while the org's available credits are above 0 (plus a
 * small per-run reservation, see app billing/spend-guard.ts). Instead of a
 * full upfront forecast, the worker re-checks the org with the shared
 * `org_spend_status()` rule (migration 0043):
 *  - at every stage boundary (Store.completeRunStage), and
 *  - from checkpoints, every WORKER_SPEND_CHECK_PAGES pages (default 25) or
 *    WORKER_SPEND_CHECK_CREDITS credits (default 10, about 10 cents) of
 *    unchecked spend, whichever comes first. The counters live on the run
 *    row (spend_unchecked_pages/credits), so the cadence holds across every
 *    worker that processes the run's pages.
 * When available credits fall below 0, or the workspace/org is paused by its
 * monthly budget, the run is paused, not failed: control_state = 'paused',
 * pause_reason = the block code, a run event with the reason, and the
 * existing Temporal `pause` signal (no workflow code change, so replay is
 * unaffected). Pages and stages already in flight finish; nothing new starts.
 * The app's maintenance sweep resumes the run once the org may spend again.
 *
 * Overdraft bound per run: the check interval (≤ 10 credits or 25 pages)
 * plus the work in flight when the pause lands.
 *
 * "Below 0" is measured above the chat reserve (migration 0053,
 * chat-reserve.ts): a run pauses once available credits fall below the
 * org's reserve, so the last few credits stay for chat and search.
 *
 * With WORKER_CREDIT_LEASES on, org-level credit leases (credit-lease.ts)
 * replace this cadence; pauseRunForSpend is shared by both.
 */

type Client = Sql<Record<string, unknown>>;

function readNumberEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface SpendCheckConfig {
  enabled: boolean;
  /** Pages of unchecked work before a check; <= 0 disables the page trigger. */
  pages: number;
  /** Credits of unchecked spend before a check; <= 0 disables the credit trigger. */
  credits: number;
}

export function resolveSpendCheckConfig(env: NodeJS.ProcessEnv = process.env): SpendCheckConfig {
  const devSkip = env.NODE_ENV === "development" && env.SKIP_RUN_BUDGET_GUARDS_IN_DEV !== "false";
  return {
    enabled: !devSkip && env.WORKER_SPEND_CHECK !== "off",
    pages: readNumberEnv("WORKER_SPEND_CHECK_PAGES", 25, env),
    credits: readNumberEnv("WORKER_SPEND_CHECK_CREDITS", 10, env),
  };
}

let cachedConfig: SpendCheckConfig | null = null;
export function spendCheckConfig(): SpendCheckConfig {
  cachedConfig ??= resolveSpendCheckConfig();
  return cachedConfig;
}

/** Test hook. */
export function setSpendCheckConfig(config: SpendCheckConfig | null): void {
  cachedConfig = config;
}

const NEVER = 1e15;

/**
 * Fragments for `update workspace_runs set ... from <from> where
 * workspace_runs.id = spend_prev.id returning <checkDue>`, adding `pages` (a
 * SQL expression; it may read `spend_prev.pages_processed`, the row before the
 * update) and `credits` to the run's unchecked counters and resetting both
 * once either crosses its threshold. `checkDue` is true exactly when this
 * update crossed it. `spend_prev` locks the row first, so concurrent page
 * checkpoints add up instead of overwriting each other.
 *
 * The lock is FOR NO KEY UPDATE, the mode a plain UPDATE of non-key columns
 * takes anyway: it serializes concurrent checkpoints of the run, but unlike
 * FOR UPDATE it does not conflict with the FOR KEY SHARE lock that every
 * foreign-key check on a child row (page_stage_states, usage_events,
 * performance_log, ...) takes on the run row. With FOR UPDATE, a shard's
 * checkpoint and another shard's multi-row page insert waited on each other
 * and Postgres aborted one as a deadlock (checkpoint-lock-order.test.ts).
 */
export function spendCounterSql(client: Client, runId: string, pages: ReturnType<Client>, credits: number) {
  const config = spendCheckConfig();
  const pageLimit = config.pages > 0 ? config.pages : NEVER;
  const creditLimit = config.credits > 0 ? config.credits : NEVER;
  const addCredits = Math.max(0, credits);
  const nextPages = () => client`(spend_prev.spend_unchecked_pages + ${pages})`;
  const nextCredits = () => client`(spend_prev.spend_unchecked_credits + ${addCredits}::numeric)`;
  const due = () => client`(${nextPages()} >= ${pageLimit}::numeric or ${nextCredits()} >= ${creditLimit}::numeric)`;
  return {
    assignments: client`
      spend_unchecked_pages = case when ${due()} then 0 else ${nextPages()} end,
      spend_unchecked_credits = case when ${due()} then 0 else ${nextCredits()} end
    `,
    from: client`(
      select id, spend_unchecked_pages, spend_unchecked_credits, pages_processed
      from workspace_runs where id = ${runId} for no key update
    ) spend_prev`,
    checkDue: due(),
  };
}

export interface SpendCheckResult {
  blocked: boolean;
  /** True when this call moved the run to paused. */
  paused: boolean;
  reason?: string;
  available?: number;
}

const BLOCK_MESSAGES: Record<string, string> = {
  credit_exhausted: "Paused: the organization is out of credits for processing. Add credits or enable auto-recharge and the run resumes automatically.",
  workspace_budget_paused: "Paused: this workspace reached its monthly budget cap. Raise the budget and the run resumes automatically.",
  org_budget_paused: "Paused: the organization reached its monthly budget cap. Raise the budget and the run resumes automatically.",
  plan_not_entitled: "Paused: this workspace has no billing organization.",
};

/**
 * The block code for a status row, mirroring app billing/spend-guard.ts
 * spendBlockReason (kind "job", minus reservations): blocked once available
 * falls below the chat reserve for the org's plan.
 */
export function spendBlockCode(row: {
  org_id?: string | null;
  plan_id?: string | null;
  available: number | string;
  workspace_budget_paused: boolean;
  org_budget_paused: boolean;
  workspace_in_org: boolean;
} | undefined): string | null {
  if (!row || !row.workspace_in_org) return "plan_not_entitled";
  if (row.workspace_budget_paused) return "workspace_budget_paused";
  if (row.org_budget_paused) return "org_budget_paused";
  // House orgs (BILLING_EXEMPT_ORG_IDS) are metered but never credit-gated.
  const reserve = row.plan_id === undefined ? 0 : jobCreditReserve(row.plan_id);
  return Number(row.available) < reserve && !isBillingExemptOrg(row.org_id) ? "credit_exhausted" : null;
}

/**
 * Check the run's org and pause the run when it may no longer spend. Mid-run
 * the rule is "available below 0" (admission already required > 0), so a run
 * finishing a page exactly at 0 continues. Never throws: a failed check is
 * logged and retried at the next trigger.
 */
export async function enforceRunSpend(
  client: Client,
  run: { id: string; orgId: string | null; workspaceId?: string | null; userId: string },
  trigger: "stage-boundary" | "page-interval" | "checkpoint-interval",
): Promise<SpendCheckResult> {
  if (!spendCheckConfig().enabled || !run.orgId) return { blocked: false, paused: false };
  try {
    const [row] = await client<{
      plan_id: string | null;
      available: string | number;
      workspace_budget_paused: boolean;
      org_budget_paused: boolean;
      workspace_in_org: boolean;
    }[]>`
      select plan_id, available, workspace_budget_paused, org_budget_paused, workspace_in_org
      from org_spend_status(${run.orgId}, ${run.workspaceId ?? null}::text, 0)
    `;
    const reason = spendBlockCode(row ? { ...row, org_id: run.orgId } : row);
    if (!reason) return { blocked: false, paused: false };
    return await pauseRunForSpend(client, run, reason, trigger, Number(row?.available ?? 0));
  } catch (error) {
    console.error(`[spend-check] run=${run.id} check failed: ${error instanceof Error ? error.message : String(error)}`);
    return { blocked: false, paused: false };
  }
}

/**
 * Pause a run its org may no longer spend for: control_state = 'paused',
 * pause_reason, a run event with the reason, and the Temporal `pause` signal.
 * Shared by the cadence check and credit leases (credit-lease.ts).
 */
export async function pauseRunForSpend(
  client: Client,
  run: { id: string; orgId: string | null; userId: string },
  reason: string,
  trigger: "stage-boundary" | "page-interval" | "checkpoint-interval",
  available: number,
): Promise<SpendCheckResult> {
  try {
    const message = BLOCK_MESSAGES[reason] ?? `Paused: ${reason}`;
    const updated = await client`
      update workspace_runs
      set control_state = 'paused',
          control_requested_at = now(),
          pause_reason = ${reason},
          updated_at = now()
      where id = ${run.id}
        and status = 'processing'
        and coalesce(control_state, '') not in ('paused', 'pause_requested', 'cancelled', 'cancel_requested', 'dead-letter')
      returning id
    `;
    if (updated.length === 0) return { blocked: true, paused: false, reason, available };
    console.warn(
      `[spend-check] run=${run.id} org=${run.orgId} trigger=${trigger} reason=${reason} available=${available.toFixed(4)} action=pause`,
    );
    await client`
      with inserted as (
        insert into workspace_run_events (id, user_id, run_id, event_type, status, message, progress, stats, payload)
        values (
          gen_random_uuid()::text, ${run.userId}, ${run.id}, 'run.progress', 'processing', ${message},
          '{}'::jsonb, '{}'::jsonb,
          ${JSON.stringify({ spendPause: { reason, trigger, availableCredits: available } })}::text::jsonb
        )
        returning run_id
      )
      select pg_notify(${RUN_EVENTS_CHANNEL}, json_build_object('runIds', json_build_array(inserted.run_id))::text)
      from inserted
    `.catch((error) => console.warn(`[spend-check] pause event: ${String(error)}`));
    await signalPause(run.id);
    return { blocked: true, paused: true, reason, available };
  } catch (error) {
    console.error(`[spend-check] run=${run.id} pause failed: ${error instanceof Error ? error.message : String(error)}`);
    return { blocked: true, paused: false, reason, available };
  }
}

/**
 * The existing `pause` signal, sent with the activity's own Temporal client.
 * Outside an activity (or if the signal fails) the app's maintenance sweep
 * re-sends it for every spend-paused run that is still blocked.
 */
async function signalPause(runId: string): Promise<void> {
  try {
    await Context.current().client.workflow.getHandle(`${WORKFLOW_ID_PREFIX}${runId}`).signal("pause");
  } catch (error) {
    console.warn(`[spend-check] run=${runId} pause signal deferred to sweep: ${error instanceof Error ? error.message : String(error)}`);
  }
}

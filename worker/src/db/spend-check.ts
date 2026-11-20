import { Context } from "@temporalio/activity";
import type { Sql } from "postgres";

import { isBillingExemptOrg, spendGuardsSkipped, spendRuleCode, type SpendRuleCode } from "@docslurp/shared";

import { WORKFLOW_ID_PREFIX } from "../temporal/shared.js";
import { chatReserveConfig, jobCreditReserve } from "./chat-reserve.js";
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
 * When available credits fall below 0, or the project/org is paused by its
 * monthly budget, the run is paused, not failed: control_state = 'paused',
 * pause_reason = the block code, a run event with the reason, and the
 * existing Temporal `pause` signal (no workflow code change, so replay is
 * unaffected). Pages and stages already in flight finish; nothing new starts.
 * The app's maintenance sweep resumes the run once the org may spend again.
 *
 * Overdraft bound per run: the check interval (≤ 10 credits or 25 pages)
 * plus the work in flight when the pause lands.
 *
 * "Below 0" is measured against the running-job floor (migration 0137,
 * chat-reserve.ts): an admitted run may use the chat reserve and finish up
 * to RUN_CREDIT_OVERDRAFT_CREDITS (default 25) below zero, then pauses.
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
  return {
    enabled: !spendGuardsSkipped(env) && env.WORKER_SPEND_CHECK !== "off",
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
 * Fragments for `update project_runs set ... from <from> where
 * project_runs.id = spend_prev.id returning <checkDue>`, adding `pages` (a
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
      from project_runs where id = ${runId} for no key update
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
  /** The run should pause but the pause write failed (pauseRunForSpend never throws). */
  pauseFailed?: boolean;
}

const BLOCK_MESSAGES: Record<string, string> = {
  credit_exhausted: "Paused: the organization is out of credits for processing. Add credits or enable auto-recharge and the run resumes automatically.",
  project_budget_paused: "Paused: this project reached its monthly budget cap. Raise the budget and the run resumes automatically.",
  org_budget_paused: "Paused: the organization reached its monthly budget cap. Raise the budget and the run resumes automatically.",
  plan_not_entitled: "Paused: this project has no billing organization.",
};

/** One `org_spend_status()` row, as the worker reads it. */
export interface OrgSpendRow {
  funded: boolean | null;
  available: string | number;
  project_budget_paused: boolean;
  org_budget_paused: boolean;
  project_in_org: boolean;
}

/**
 * The block code for a status row: the shared spend rule (`spendRuleCode`, packages/shared/src/spend-rule.ts) for
 * work that is already running, measured against the running-job floor (negative) instead of the chat reserve that
 * admission uses, and without other runs' reservations.
 */
export function spendBlockCode(row: (Omit<OrgSpendRow, "funded"> & { org_id?: string | null; funded?: boolean | null }) | undefined): SpendRuleCode | null {
  return spendRuleCode(row && {
    orgId: row.org_id,
    funded: row.funded,
    available: Number(row.available),
    projectInOrg: row.project_in_org,
    projectBudgetPaused: row.project_budget_paused,
    orgBudgetPaused: row.org_budget_paused,
  }, "running", chatReserveConfig());
}

/**
 * The organization's spend-admission lock, held to the end of the transaction: the same lock the API's run admission
 * takes, so worker-side admissions (media jobs, capacity leases, video) serialize with it. The only place the worker
 * names the lock key (spend-owners.test.ts).
 */
export async function lockOrgAdmission(tx: Client, orgId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(spend_admission_lock_key(${orgId}))`;
}

/** Reads the organization's spend status for a project. The only place the worker reads `org_spend_status()`. */
async function readOrgSpend(client: Client, scope: { orgId: string; projectId?: string | null }): Promise<OrgSpendRow | undefined> {
  const [row] = await client<OrgSpendRow[]>`
    select funded, available, project_budget_paused, org_budget_paused, project_in_org
    from org_spend_status(${scope.orgId}, ${scope.projectId ?? null}::text, 0)
  `;
  return row;
}

/**
 * Why the organization may not spend on running work for a project right now, or null when it may. Ungated and
 * read-only: callers that honour the spend-check switch use `orgSpendRefusal`. A failed read throws.
 */
export async function orgSpendBlock(client: Client, scope: { orgId: string; projectId?: string | null }): Promise<SpendRuleCode | null> {
  const row = await readOrgSpend(client, scope);
  return spendBlockCode(row ? { ...row, org_id: scope.orgId } : row);
}

/**
 * What a run may still reserve for paid side work (a media job, a capacity lease), read under the admission lock the
 * caller holds. `allowed` is entitlement and budgets; `headroom` is available credits minus the leases other runs
 * hold (this run's own lease is what its spend draws from) minus the running-job floor. A billing-exempt
 * organization is never refused for credits (`exempt`). Decide with `covers(needed)`: a headroom that is not a
 * number covers nothing.
 */
export async function runSpendHeadroom(
  client: Client,
  scope: { orgId: string; projectId: string; runId: string },
): Promise<{ allowed: boolean; headroom: number; exempt: boolean; covers(needed: number): boolean }> {
  const [status] = await client<{ funded: boolean | null; available: number; leased: number; project_in_org: boolean; org_budget_paused: boolean; project_budget_paused: boolean }[]>`
    select s.*, org_outstanding_credit_leases(${scope.orgId}, 'run', ${scope.runId}) as leased
    from org_spend_status(${scope.orgId}, ${scope.projectId}, 0) s`;
  // Entitlement and budgets come from the shared rule; only its credit test is replaced by the headroom below.
  const stop = spendBlockCode(status ? { ...status, org_id: scope.orgId } : status);
  const allowed = stop === null || stop === "credit_exhausted";
  const headroom = status ? Number(status.available) - Number(status.leased) - jobCreditReserve(status.funded) : Number.NaN;
  const exempt = isBillingExemptOrg(scope.orgId);
  return { allowed, headroom, exempt, covers: (needed) => allowed && (exempt || headroom >= needed) };
}

/**
 * Whether an org may spend on optional paid work for a project right now: the block code (`spendBlockCode`), or
 * null when it may. Read-only: nothing is paused. For work that is asked before it starts and simply not done when
 * refused (the summary tree). Fails closed: no organization is `plan_not_entitled`, and a failed read throws.
 */
export async function orgSpendRefusal(client: Client, scope: { orgId: string | null; projectId?: string | null }): Promise<string | null> {
  if (!spendCheckConfig().enabled) return null;
  if (!scope.orgId) return "plan_not_entitled";
  const row = await readOrgSpend(client, { orgId: scope.orgId, projectId: scope.projectId });
  return spendBlockCode(row ? { ...row, org_id: scope.orgId } : row);
}

/**
 * Check the run's org and pause the run when it may no longer spend. Mid-run
 * the rule is "available below 0" (admission already required > 0), so a run
 * finishing a page exactly at 0 continues. Never throws: a failed check is
 * logged and retried at the next trigger.
 */
export async function enforceRunSpend(
  client: Client,
  run: { id: string; orgId: string | null; projectId?: string | null; userId: string },
  trigger: "stage-boundary" | "page-interval" | "checkpoint-interval",
): Promise<SpendCheckResult> {
  if (!spendCheckConfig().enabled || !run.orgId) return { blocked: false, paused: false };
  try {
    const row = await readOrgSpend(client, { orgId: run.orgId, projectId: run.projectId });
    const reason = spendBlockCode(row ? { ...row, org_id: run.orgId } : row);
    if (!reason) return { blocked: false, paused: false };
    return await pauseRunForSpend(client, run, reason, trigger, Number(row?.available ?? 0));
  } catch (error) {
    console.error(`[spend-check] run=${run.id} check failed: ${error instanceof Error ? error.message : String(error)}`);
    return { blocked: false, paused: false };
  }
}

/**
 * The charge check could not decide: the balance read or the pause write failed, or the run has no organization to check. It
 * fails closed and is retryable: the stage leaves the document unfinished (an infrastructure error, document-failure.ts) and
 * Temporal retries the activity, which checks again before anything is charged.
 */
export class SpendCheckUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SpendCheckUnavailableError";
  }
}

/**
 * The same check with a charge the run is about to owe: the run pauses when `credits` more would take the org's available balance
 * below what a running job needs. For a charge admission could not see (a document measured at far more pages than intake
 * counted, a TIFF's counted frames). Fails closed: a failed balance read or pause write throws SpendCheckUnavailableError (retryable)
 * instead of letting the charge through. `blocked` without `paused` means the balance does not cover it and the run was already
 * paused or stopped by something else.
 */
export async function enforceRunSpendForCharge(
  client: Client,
  run: { id: string; orgId: string | null; projectId?: string | null; userId: string },
  credits: number,
  trigger: "stage-boundary" | "page-interval" | "checkpoint-interval" = "stage-boundary",
): Promise<SpendCheckResult> {
  // A charge that is not a finite number cannot be weighed: refused, never read as nothing owed.
  if (!Number.isFinite(credits)) throw new SpendCheckUnavailableError(`run ${run.id} charge check got a non-finite amount (${credits})`);
  if (!spendCheckConfig().enabled || !(credits > 0)) return { blocked: false, paused: false };
  if (!run.orgId) throw new SpendCheckUnavailableError(`run ${run.id} has no organization to check a ${credits.toFixed(2)}-credit charge against`);
  let result: SpendCheckResult;
  try {
    const row = await readOrgSpend(client, { orgId: run.orgId, projectId: run.projectId });
    const available = Number(row?.available ?? 0) - credits;
    const reason = spendBlockCode(row ? { ...row, available, org_id: run.orgId } : row);
    if (!reason) return { blocked: false, paused: false };
    result = await pauseRunForSpend(client, run, reason, trigger, available, credits);
  } catch (error) {
    console.error(`[spend-check] run=${run.id} charge check failed, refusing the charge: ${error instanceof Error ? error.message : String(error)}`);
    pushSpendCheckFailure(run, "check-failed");
    throw new SpendCheckUnavailableError(`spend check for a ${credits.toFixed(2)}-credit charge failed`, { cause: error });
  }
  if (result.pauseFailed) {
    pushSpendCheckFailure(run, "pause-failed");
    throw new SpendCheckUnavailableError(`spend check blocked a ${credits.toFixed(2)}-credit charge but could not pause run ${run.id}`);
  }
  return result;
}

/**
 * The largest n in 1..max whose charge (`creditsFor(n)`) the org's balance still covers, by the same rule as
 * enforceRunSpendForCharge, or 0 when not even one does. Read-only: nothing is paused. For bounding work before it is done (the
 * frames an image's OCR read may cover). Fails closed: a failed read throws SpendCheckUnavailableError (retryable).
 */
export async function largestFundedCharge(
  client: Client,
  run: { id: string; orgId: string | null; projectId?: string | null },
  max: number,
  creditsFor: (n: number) => number,
): Promise<number> {
  if (!spendCheckConfig().enabled) return max;
  if (!run.orgId) throw new SpendCheckUnavailableError(`run ${run.id} has no organization to size a charge against`);
  let row: OrgSpendRow | undefined;
  try {
    row = await readOrgSpend(client, { orgId: run.orgId, projectId: run.projectId });
  } catch (error) {
    pushSpendCheckFailure(run, "check-failed");
    throw new SpendCheckUnavailableError("balance read for sizing a charge failed", { cause: error });
  }
  for (let n = max; n >= 1; n -= 1) {
    const credits = creditsFor(n);
    // A size whose charge is not a finite number is never funded.
    if (!Number.isFinite(credits)) continue;
    const available = Number(row?.available ?? 0) - credits;
    if (!spendBlockCode(row ? { ...row, available, org_id: run.orgId } : row)) return n;
  }
  return 0;
}

function pushSpendCheckFailure(run: { id: string; orgId: string | null }, reason: string): void {
  console.error(`[spend-check] charge-refused run=${run.id} org=${run.orgId ?? "none"} reason=${reason} retryable=true`);
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
  /**
   * The charge this pause refused (enforceRunSpendForCharge), stored as project_runs.spend_pause_credits (migration 0190) so
   * the resume sweep holds what the worker will check again. A run already paused keeps the larger of the two.
   */
  refusedCredits?: number,
): Promise<SpendCheckResult> {
  const refused = refusedCredits !== undefined && Number.isFinite(refusedCredits) && refusedCredits > 0 ? refusedCredits : null;
  try {
    const message = BLOCK_MESSAGES[reason] ?? `Paused: ${reason}`;
    const updated = await client`
      update project_runs
      set control_state = 'paused',
          control_requested_at = now(),
          pause_reason = ${reason},
          spend_pause_credits = ${refused}::numeric,
          updated_at = now()
      where id = ${run.id}
        and status = 'processing'
        and coalesce(control_state, '') not in ('paused', 'pause_requested', 'cancelled', 'cancel_requested', 'dead-letter')
      returning id
    `;
    if (updated.length === 0) {
      // Already paused for funds by another check: the sweep must hold the larger of the refused charges.
      if (refused !== null) {
        await client`
          update project_runs set spend_pause_credits = greatest(coalesce(spend_pause_credits, 0), ${refused}::numeric)
          where id = ${run.id} and control_state = 'paused' and pause_reason is not null
        `;
      }
      return { blocked: true, paused: false, reason, available };
    }
    console.warn(
      `[spend-check] run=${run.id} org=${run.orgId} trigger=${trigger} reason=${reason} available=${available.toFixed(4)} action=pause`,
    );
    await client`
      with inserted as (
        insert into project_run_events (id, user_id, run_id, event_type, status, message, progress, stats, payload)
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
    return { blocked: true, paused: false, reason, available, pauseFailed: true };
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

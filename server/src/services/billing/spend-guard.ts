import { reportPublicError } from "../../lib/public-errors.js";
import { upgradeLinkHeader, upgradeLinksFor } from "../../lib/upgrade-links.js";
import { publicApiErrorDetails, publicErrorForStatus } from "@docslurp/shared";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { TransactionSql } from "postgres";

import {
  chatCreditOverdraft,
  chatCreditReserve,
  isBillingExemptOrg,
  resolveChatCreditReserveConfig,
  type ChatCreditReserveConfig,
} from "@docslurp/shared";

import { sql, type SqlClient } from "../../db.js";
import { creditLeasesEnabled, grantRunCreditLease } from "./credit-leases.js";
import { fleetSupportsNow, taskQueueForOrgKey } from "../worker-fleet.js";

/**
 * Spend admission (security gap G-08): the one check every model-calling path
 * runs before it spends: run creation, reprocess, retry and resume, chat,
 * chat completions, MCP answers and automation, and AI search strategies.
 *
 * An org may spend while
 *  - available credits (prepaid balance - pending debits) are above 0,
 *  - neither the workspace nor the org is paused by its monthly budget, and
 *  - the workspace belongs to the org (entitlement; see spendBlockReason).
 * The rule is the `org_spend_status()` SQL function (migration 0044), which the
 * worker's mid-run balance check reads too.
 *
 * Run admission additionally reserves a few credits per in-flight run
 * (`RUN_ADMISSION_RESERVE_CREDITS`, default 1) under a per-org advisory lock,
 * held until the run row is inserted in the same transaction. Concurrent run
 * creation therefore cannot all pass on one positive balance: with 0.5
 * credits left only one run is admitted until it has spent its reservation.
 *
 * With credit leases (WORKER_CREDIT_LEASES, credit-leases.ts) the per-run
 * reservation becomes the run's first lease, granted in the admission
 * transaction; `reserved` then counts every live lease in the org.
 *
 * Two kinds of spend (chat reserve and overdraft, migration 0053,
 * packages/shared/src/chat-reserve.ts):
 *  - "job" (run admission, resume, retry, automation): spendable =
 *    available - reserved - chat reserve > 0. Jobs never touch the last few
 *    credits, which stay for chat.
 *  - "interactive" (chat, search, chat completions, MCP chat/search): may
 *    carry a small negative balance, allowed while available - reserved >
 *    -overdraft. Leases never block a positive balance (grants keep them
 *    within available - chat reserve); they only count toward the overdraft
 *    floor once chat has spent credits running jobs still hold, so the jobs'
 *    remaining spend stays inside the allowance. Near or below zero,
 *    admit_interactive_spend serializes calls per org and holds a few
 *    credits each, so concurrent calls cannot overshoot the allowance.
 * Budget caps and entitlement block both kinds; billing-exempt orgs are never
 * credit-gated.
 */

export type SpendKind = "job" | "interactive";

export type SpendBlockedCode =
  | "credit_exhausted"
  | "workspace_budget_paused"
  | "org_budget_paused"
  | "minimum_credit_required"
  | "plan_not_entitled";

export class SpendBlockedError extends Error {
  readonly statusCode = 402 as const;

  constructor(
    message: string,
    readonly code: SpendBlockedCode,
    /** Whether the org's auto top-up is on, so the 402 omits the "turn on auto top-up" link. */
    readonly autoTopUpOn = false,
    readonly spendDetails: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SpendBlockedError";
  }
}

export function isSpendBlockedError(error: unknown): error is SpendBlockedError {
  return error instanceof SpendBlockedError;
}

export interface SpendStatus {
  orgId: string;
  /** Has ever had a paid grant (organizations.funded_at). */
  funded: boolean;
  /** Auto top-up is on for the org. */
  autoTopUpOn?: boolean;
  available: number;
  reserved: number;
  workspaceBudgetPaused: boolean;
  orgBudgetPaused: boolean;
  workspaceInOrg: boolean;
  /** The org received credits at least once (may overdraw interactively). */
  hasCreditGrants?: boolean;
}

type Client = SqlClient | TransactionSql;

function readNumberEnv(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Credits each in-flight run holds against run admission until it has spent them. */
export function runAdmissionReserveCredits(): number {
  return readNumberEnv("RUN_ADMISSION_RESERVE_CREDITS", 1);
}

/** Local development skips spend guards unless SKIP_RUN_BUDGET_GUARDS_IN_DEV=false. */
export function spendGuardsSkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "development" && env.SKIP_RUN_BUDGET_GUARDS_IN_DEV !== "false";
}

export async function loadSpendStatus(
  orgId: string | null | undefined,
  workspaceId: string | null | undefined,
  options: { client?: Client; runReserveCredits?: number } = {},
): Promise<SpendStatus | null> {
  const client = (options.client ?? sql) as SqlClient;
  const [row] = await client<{
    org_id: string;
    funded: boolean;
    auto_top_up_on: boolean | null;
    available: string | number;
    reserved: string | number;
    workspace_budget_paused: boolean;
    org_budget_paused: boolean;
    workspace_in_org: boolean;
    has_credit_grants: boolean | null;
  }[]>`
    select s.*, org_has_credit_grants(s.org_id) as has_credit_grants,
      (select o.auto_recharge_enabled from organizations o where o.id = s.org_id) as auto_top_up_on
    from org_spend_status(
      ${orgId ?? null}::text,
      ${workspaceId ?? null}::text,
      ${options.runReserveCredits ?? 0}::numeric
    ) s
  `;
  if (!row) return null;
  return {
    orgId: row.org_id,
    funded: row.funded === true,
    autoTopUpOn: row.auto_top_up_on === true,
    available: Number(row.available),
    reserved: Number(row.reserved),
    workspaceBudgetPaused: row.workspace_budget_paused,
    orgBudgetPaused: row.org_budget_paused,
    workspaceInOrg: row.workspace_in_org,
    hasCreditGrants: row.has_credit_grants === true,
  };
}

/** Why `status` may not spend, or null when it may. */
export function spendBlockReason(
  status: SpendStatus | null,
  kind: SpendKind = "job",
  config: ChatCreditReserveConfig = resolveChatCreditReserveConfig(),
): { code: SpendBlockedCode; message: string } | null {
  // Entitlement: a billing org that owns the workspace. Nothing else gates AI
  // features: starter orgs spend their starter credits like anyone else.
  if (!status || !status.workspaceInOrg) {
    return {
      code: "plan_not_entitled",
      message: "This workspace has no billing organization, so it cannot run AI processing.",
    };
  }
  if (status.workspaceBudgetPaused) {
    return {
      code: "workspace_budget_paused",
      message:
        "This workspace has reached its monthly budget cap and AI processing is paused. " +
        "Increase the budget in workspace settings to resume.",
    };
  }
  if (status.orgBudgetPaused) {
    return {
      code: "org_budget_paused",
      message:
        "This organization has reached its monthly budget cap and AI processing is paused. " +
        "Increase the org budget to resume.",
    };
  }
  // House orgs (BILLING_EXEMPT_ORG_IDS) are metered but never credit-gated.
  if (isBillingExemptOrg(status.orgId)) return null;
  if (kind === "interactive") {
    const overdraft = chatCreditOverdraft(status.funded, status.hasCreditGrants === true, config);
    if (status.available - status.reserved > -overdraft) return null;
    return {
      code: "credit_exhausted",
      message:
        `Out of credits (balance: ${status.available.toFixed(2)}` +
        (overdraft > 0 ? `, chat may go ${overdraft.toFixed(2)} below zero` : "") +
        "). Buy credits or turn on auto top-up at /app/billing to continue.",
    };
  }
  const reserve = chatCreditReserve(status.funded, config);
  const spendable = status.available - status.reserved - reserve;
  if (spendable > 0) return null;
  return {
    code: "credit_exhausted",
    message:
      `Out of credits for processing (available: ${status.available.toFixed(2)}` +
      (status.reserved > 0 ? `, held by in-flight runs: ${status.reserved.toFixed(2)}` : "") +
      (reserve > 0 ? `, kept for chat and search: ${reserve.toFixed(2)}` : "") +
      "). Buy credits or turn on auto top-up at /app/billing to continue.",
  };
}

/**
 * Interactive admission for an org already allowed by spendBlockReason's
 * fast check. Comfortably above zero (available > allowance + hold) it
 * passes without a lock; nearer zero it goes through
 * admit_interactive_spend, which serializes the org's calls and holds a few
 * credits per call, so concurrent chats cannot all pass on the last of the
 * allowance.
 */
async function admitInteractive(
  status: SpendStatus,
  workspaceId: string | null | undefined,
  options: { client?: Client; hold?: boolean },
  config: ChatCreditReserveConfig,
): Promise<{ code: SpendBlockedCode; message: string } | null> {
  if (isBillingExemptOrg(status.orgId)) return null;
  const allowance = chatCreditOverdraft(status.funded, status.hasCreditGrants === true, config);
  if (status.available - status.reserved > allowance + config.holdCredits) return null;
  const hold = options.hold === false ? 0 : config.holdCredits;
  const client = (options.client ?? sql) as SqlClient;
  const admit = async (tx: SqlClient) => {
    const [row] = await tx<{ admitted: boolean; available: string | number; held: string | number }[]>`
      select admitted, available, held from admit_interactive_spend(
        ${status.orgId}::text, ${workspaceId ?? null}::text,
        ${allowance}::numeric, ${hold}::numeric, ${config.holdTtlSeconds}::int
      )
    `;
    return row;
  };
  // The advisory lock is transaction-scoped: run in a transaction of our own
  // unless the caller already holds one.
  const row = options.client
    ? await admit(client)
    : await sql.begin((tx) => admit(tx as unknown as SqlClient));
  if (row?.admitted) return null;
  const available = Number(row?.available ?? status.available);
  return {
    code: "credit_exhausted",
    message:
      `Out of credits (balance: ${available.toFixed(2)}, held by runs and chats in progress: ${Number(row?.held ?? 0).toFixed(2)}` +
      (allowance > 0 ? `, chat may go ${allowance.toFixed(2)} below zero` : "") +
      "). Buy credits or turn on auto top-up at /app/billing to continue.",
  };
}

/**
 * Throw SpendBlockedError (HTTP 402) unless the org may spend. Pass
 * `workspaceId` whenever the spend belongs to one; `orgId` may be omitted then.
 * `kind` defaults to the strict "job" rule; user-facing chat and search pass
 * "interactive". `hold: false` checks without taking an interactive hold,
 * for pre-checks (a 402 before a stream opens) and cheap optional calls whose
 * turn already holds one.
 */
export interface SpendCheckOptions {
  client?: Client;
  kind?: SpendKind;
  hold?: boolean;
}

export async function assertCanSpend(
  orgId: string | null | undefined,
  workspaceId?: string | null,
  options: SpendCheckOptions = {},
): Promise<void> {
  if (spendGuardsSkipped()) return;
  const reason = await spendDecision(orgId, workspaceId, options);
  if (reason) throw new SpendBlockedError(reason.message, reason.code, reason.autoTopUpOn === true, reason.details);
}

/** Non-throwing form, for paths that degrade instead of failing (search strategies). */
export async function canSpend(
  orgId: string | null | undefined,
  workspaceId?: string | null,
  options: Omit<SpendCheckOptions, "client"> = {},
): Promise<boolean> {
  if (spendGuardsSkipped()) return true;
  return (await spendDecision(orgId, workspaceId, options)) === null;
}

async function spendDecision(
  orgId: string | null | undefined,
  workspaceId: string | null | undefined,
  options: SpendCheckOptions,
): Promise<{ code: SpendBlockedCode; message: string; autoTopUpOn?: boolean; details?: Record<string, unknown> } | null> {
  const kind = options.kind ?? "job";
  const config = resolveChatCreditReserveConfig();
  const status = await loadSpendStatus(orgId, workspaceId, { client: options.client });
  const reason = spendBlockReason(status, kind, config)
    ?? (kind === "interactive" && status ? await admitInteractive(status, workspaceId, { client: options.client, hold: options.hold }, config) : null);
  return reason ? { ...reason, autoTopUpOn: status?.autoTopUpOn === true,
    details: { account: status?.funded ? "funded" : "starter", spendKind: kind,
      availableCredits: status?.available ?? 0, heldCredits: status?.reserved ?? 0,
      chatReserveCredits: status ? chatCreditReserve(status.funded, config) : 0 } } : null;
}

/**
 * Run admission: serialise the org's admissions on an advisory lock, check
 * spend with the per-run reservation, and call `admit` (which must insert the
 * run with the same client) inside that transaction.
 */
export async function admitRunSpend<T>(
  orgId: string,
  workspaceId: string,
  admit: (client: TransactionSql) => Promise<T>,
  options: { leaseRunId?: string } = {},
): Promise<T> {
  const guarded = !spendGuardsSkipped();
  // Leases need every worker that may run the job to consume them
  // (services/worker-fleet.ts). Admission is a request path, so it reads the
  // cached fleet view; unknown keeps the per-run reservation, and the worker
  // grants the lease at its first checkpoint.
  const leases = guarded && creditLeasesEnabled()
    && fleetSupportsNow("billing.credit-leases", taskQueueForOrgKey(orgId).taskQueue);
  return (await sql.begin(async (tx) => {
    if (guarded) {
      await tx`select pg_advisory_xact_lock(spend_admission_lock_key(${orgId}))`;
      const status = await loadSpendStatus(orgId, workspaceId, {
        client: tx,
        // Leases replace the per-run reservation: `reserved` holds them all.
        runReserveCredits: leases ? 0 : runAdmissionReserveCredits(),
      });
      const reason = spendBlockReason(status);
      if (reason) throw new SpendBlockedError(reason.message, reason.code, status?.autoTopUpOn === true, { account: status?.funded ? "funded" : "starter", spendKind: "job",
        availableCredits: status?.available ?? 0, heldCredits: status?.reserved ?? 0,
        chatReserveCredits: status ? chatCreditReserve(status.funded) : 0 });
    }
    const admitted = await admit(tx);
    // The run's first lease, under the same advisory lock (re-entrant).
    // A failed grant never blocks admission: the savepoint keeps the
    // transaction usable and the worker grants the lease at its first checkpoint.
    if (leases && options.leaseRunId) {
      const runId = options.leaseRunId;
      try {
        await tx.savepoint((sp) => grantRunCreditLease(sp, { runId, orgId, workspaceId }));
      } catch (error) {
        console.warn(`[credit-leases] run=${runId} admission lease failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return admitted;
  })) as T;
}

/** Why a spend block should be shown to users: `credits`, `budget` or `policy`. */
export function spendBlockJobReason(code: SpendBlockedCode): "credits" | "budget" | "policy" {
  if (code === "workspace_budget_paused" || code === "org_budget_paused") return "budget";
  if (code === "plan_not_entitled") return "policy";
  return "credits";
}

/**
 * Admission check for work created inside the caller's transaction (config-change jobs): takes the
 * org's admission lock and reports why the org may not spend, or null. Unlike `admitRunSpend` it never
 * throws, so the caller can still save its own change and insert the work as `blocked`.
 */
export async function admissionBlock(
  tx: TransactionSql,
  orgId: string,
  workspaceId: string,
): Promise<{ code: SpendBlockedCode; message: string } | null> {
  if (spendGuardsSkipped()) return null;
  await tx`select pg_advisory_xact_lock(spend_admission_lock_key(${orgId}))`;
  return spendBlockReason(
    await loadSpendStatus(orgId, workspaceId, {
      client: tx,
      runReserveCredits: creditLeasesEnabled() ? 0 : runAdmissionReserveCredits(),
    }),
  );
}

/** JSON 402 body for a blocked spend, with billing links on hosted deployments. */
export function spendBlockedResponse(c: Context, error: SpendBlockedError) {
  reportPublicError(error, { status: 402 });
  const links = upgradeLinksFor(error.code, { autoTopUpOn: error.autoTopUpOn });
  const header = upgradeLinkHeader(links);
  if (header) c.header("Link", header);
  const details = publicApiErrorDetails(error.spendDetails);
  return c.json({ error: publicErrorForStatus(402), code: error.code, ...(details ? { details } : {}), ...(links ? { links } : {}) }, 402);
}

/** Hono onError: 402 for blocked spend, Hono's defaults otherwise. */
export function spendAwareErrorHandler(error: Error, c: Context) {
  if (isSpendBlockedError(error)) return spendBlockedResponse(c, error);
  reportPublicError(error, { requestId: c.get("requestId") ?? "", status: error instanceof HTTPException ? error.status : 500 });
  if (error instanceof HTTPException) return c.json({ error: publicErrorForStatus(error.status) }, error.status);
  return c.json({ error: publicErrorForStatus(500) }, 500);
}

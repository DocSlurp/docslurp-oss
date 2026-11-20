import { isBillingExemptOrg } from "./billing.js";
import {
  chatCreditOverdraft,
  chatCreditReserve,
  resolveChatCreditReserveConfig,
  runningJobCreditFloor,
  type ChatCreditReserveConfig,
} from "./chat-reserve.js";

/**
 * The spend rule: whether an organization may spend, decided from one `org_spend_status()` row. The SQL function
 * owns the numbers (available credits, live reservations, budget flags, entitlement); this is the one place that
 * turns them into a decision, for the API's admission checks and the worker's checks on running work alike.
 *
 * Order, the same for every kind: entitlement (a billing organization that owns the project), the project's monthly
 * budget, the organization's monthly budget, then credits. Budgets and entitlement are hard stops for everyone;
 * billing-exempt organizations are metered but never refused for credits.
 *
 * The credit test depends on what is being decided:
 *  - `job`: new work (run admission, resume, retry, automation). It must leave the chat reserve untouched:
 *    available - reserved - reserve > 0.
 *  - `interactive`: chat and search. It may carry a small negative balance: available - reserved > -overdraft.
 *  - `running`: work already admitted. It may use the chat reserve and finish below zero, down to the running-job
 *    floor, and ignores other runs' reservations: available >= floor.
 */
export type SpendRuleCode = "plan_not_entitled" | "project_budget_paused" | "org_budget_paused" | "credit_exhausted";

export type SpendRuleKind = "job" | "interactive" | "running";

export interface SpendRuleStatus {
  orgId?: string | null;
  /** Has ever had a paid grant. Unknown (a row read without it) puts the running-job floor at zero. */
  funded?: boolean | null;
  /** Received credits at least once; only such organizations may overdraw interactively. */
  hasCreditGrants?: boolean | null;
  available: number;
  /** Credits other in-flight work holds. Ignored for `running`. */
  reserved?: number;
  projectInOrg: boolean;
  projectBudgetPaused: boolean;
  orgBudgetPaused: boolean;
}

/** Why `status` may not spend, or null when it may. No status row is no entitlement. */
export function spendRuleCode(
  status: SpendRuleStatus | null | undefined,
  kind: SpendRuleKind,
  config: ChatCreditReserveConfig = resolveChatCreditReserveConfig(),
): SpendRuleCode | null {
  if (!status || !status.projectInOrg) return "plan_not_entitled";
  if (status.projectBudgetPaused) return "project_budget_paused";
  if (status.orgBudgetPaused) return "org_budget_paused";
  if (isBillingExemptOrg(status.orgId)) return null;
  const reserved = status.reserved ?? 0;
  if (kind === "running") {
    const floor = status.funded === undefined ? 0 : runningJobCreditFloor(config);
    return status.available < floor ? "credit_exhausted" : null;
  }
  if (kind === "interactive") {
    const overdraft = chatCreditOverdraft(status.funded === true, status.hasCreditGrants === true, config);
    return status.available - reserved > -overdraft ? null : "credit_exhausted";
  }
  return status.available - reserved - chatCreditReserve(status.funded === true, config) > 0 ? null : "credit_exhausted";
}

/**
 * The one switch that turns the spend rule off: local development, unless SKIP_RUN_BUDGET_GUARDS_IN_DEV=false.
 * Nothing else skips it; a deployment with no billing still checks entitlement and budgets.
 */
export function spendGuardsSkipped(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "development" && env.SKIP_RUN_BUDGET_GUARDS_IN_DEV !== "false";
}

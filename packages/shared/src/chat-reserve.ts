/**
 * Chat credit reserve and interactive overdraft (docs/pricing-and-credits.md,
 * "Chat reserve and overdraft"; migration 0053).
 *
 * Ingestion and automation (jobs) never spend an org's last few credits: run
 * admission, credit leases, the worker's mid-run check and media admission
 * all leave `reserve` credits untouched, so a small org whose uploads used up
 * its balance can still chat and search over what it uploaded.
 *
 * Interactive spend (chat, search, chat completions, MCP chat/search) is not
 * blocked by the credits running jobs hold while the balance is positive, and
 * may carry a small negative balance: it is allowed while available - live
 * leases > -overdraft (leases only count once chat has spent credits a job
 * still holds, so the job's remaining spend stays inside the allowance). The
 * next top-up, auto-recharge or plan grant pays the negative balance first.
 * Monthly budget caps and entitlement stay hard stops; billing-exempt orgs
 * are never credit-gated either way.
 *
 * 1 credit = 1 US cent. Defaults: $3 reserve and overdraft on paid plans, $1
 * on Free. Set the values to 0 to turn either part off. Only orgs that have
 * received credits at least once (starter, top-up, plan grant) may overdraw,
 * so creating extra empty orgs does not mint chat credit.
 */

export interface ChatCreditReserveConfig {
  /** Credits jobs leave untouched on paid plans. */
  paidReserveCredits: number;
  /** Credits jobs leave untouched on Free. */
  freeReserveCredits: number;
  /** How far below zero interactive spend may take a paid org. */
  paidOverdraftCredits: number;
  /** How far below zero interactive spend may take a Free org. */
  freeOverdraftCredits: number;
  /**
   * Near or below zero, each interactive call holds this many credits for
   * `holdTtlSeconds`, so concurrent calls cannot all pass on the last of the
   * allowance (see admit_interactive_spend, migration 0053).
   */
  holdCredits: number;
  holdTtlSeconds: number;
}

type Env = Record<string, string | undefined>;

/** Upper bound for every knob: $100. A typo must not hand out real credit. */
export const CHAT_CREDIT_RESERVE_MAX = 10_000;

export const DEFAULT_PAID_CHAT_RESERVE_CREDITS = 300;
export const DEFAULT_FREE_CHAT_RESERVE_CREDITS = 100;

function readCredits(env: Env, name: string, fallback: number, max = CHAT_CREDIT_RESERVE_MAX): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), max);
}

export function resolveChatCreditReserveConfig(env: Env = process.env): ChatCreditReserveConfig {
  const paidReserveCredits = readCredits(env, "CHAT_CREDIT_RESERVE_CREDITS", DEFAULT_PAID_CHAT_RESERVE_CREDITS);
  const freeReserveCredits = readCredits(env, "CHAT_CREDIT_RESERVE_FREE_CREDITS", DEFAULT_FREE_CHAT_RESERVE_CREDITS);
  return {
    paidReserveCredits,
    freeReserveCredits,
    paidOverdraftCredits: readCredits(env, "CHAT_CREDIT_OVERDRAFT_CREDITS", paidReserveCredits),
    freeOverdraftCredits: readCredits(env, "CHAT_CREDIT_OVERDRAFT_FREE_CREDITS", freeReserveCredits),
    holdCredits: readCredits(env, "CHAT_CREDIT_HOLD_CREDITS", 5, 1_000),
    holdTtlSeconds: Math.round(readCredits(env, "CHAT_CREDIT_HOLD_TTL_SECONDS", 120, 3_600)) || 1,
  };
}

/** Free (and anything that is not a paid plan) gets the Free values. */
function isFreePlan(planId: string | null | undefined): boolean {
  return planId !== "silver" && planId !== "gold" && planId !== "platinum";
}

/** Credits jobs must leave for chat in an org on `planId`. */
export function chatCreditReserve(planId: string | null | undefined, config: ChatCreditReserveConfig = resolveChatCreditReserveConfig()): number {
  return isFreePlan(planId) ? config.freeReserveCredits : config.paidReserveCredits;
}

/**
 * How far below zero interactive spend may go. 0 for orgs that never received
 * credits (`hasGrants` false), so an empty org cannot overdraw.
 */
export function chatCreditOverdraft(
  planId: string | null | undefined,
  hasGrants: boolean,
  config: ChatCreditReserveConfig = resolveChatCreditReserveConfig(),
): number {
  if (!hasGrants) return 0;
  return isFreePlan(planId) ? config.freeOverdraftCredits : config.paidOverdraftCredits;
}

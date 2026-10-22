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
 * next top-up or auto top-up pays the negative balance first.
 * Monthly budget caps and entitlement stay hard stops; billing-exempt orgs
 * are never credit-gated either way.
 *
 * 1 credit = 1 US cent. Defaults: $3 reserve and overdraft for funded orgs
 * (ever had a paid grant), $1 for starter orgs. Set the values to 0 to turn
 * either part off. Only orgs that have received credits at least once
 * (starter, top-up) may overdraw,
 * so creating extra empty orgs does not mint chat credit.
 */

export interface ChatCreditReserveConfig {
  /** Credits jobs leave untouched in funded orgs. */
  fundedReserveCredits: number;
  /** Credits jobs leave untouched in starter orgs. */
  starterReserveCredits: number;
  /** How far below zero interactive spend may take a funded org. */
  fundedOverdraftCredits: number;
  /** How far below zero interactive spend may take a starter org. */
  starterOverdraftCredits: number;
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

export const DEFAULT_FUNDED_CHAT_RESERVE_CREDITS = 300;
export const DEFAULT_STARTER_CHAT_RESERVE_CREDITS = 100;

function readCredits(env: Env, name: string, fallback: number, max = CHAT_CREDIT_RESERVE_MAX): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), max);
}

export function resolveChatCreditReserveConfig(env: Env = process.env): ChatCreditReserveConfig {
  const fundedReserveCredits = readCredits(env, "CHAT_CREDIT_RESERVE_CREDITS", DEFAULT_FUNDED_CHAT_RESERVE_CREDITS);
  const starterReserveCredits = readCredits(env, "CHAT_CREDIT_RESERVE_STARTER_CREDITS", DEFAULT_STARTER_CHAT_RESERVE_CREDITS);
  return {
    fundedReserveCredits,
    starterReserveCredits,
    fundedOverdraftCredits: readCredits(env, "CHAT_CREDIT_OVERDRAFT_CREDITS", fundedReserveCredits),
    starterOverdraftCredits: readCredits(env, "CHAT_CREDIT_OVERDRAFT_STARTER_CREDITS", starterReserveCredits),
    holdCredits: readCredits(env, "CHAT_CREDIT_HOLD_CREDITS", 5, 1_000),
    holdTtlSeconds: Math.round(readCredits(env, "CHAT_CREDIT_HOLD_TTL_SECONDS", 120, 3_600)) || 1,
  };
}

/** Credits jobs must leave for chat in a funded or starter org. */
export function chatCreditReserve(funded: boolean, config: ChatCreditReserveConfig = resolveChatCreditReserveConfig()): number {
  return funded ? config.fundedReserveCredits : config.starterReserveCredits;
}

/**
 * How far below zero interactive spend may go. 0 for orgs that never received
 * credits (`hasGrants` false), so an empty org cannot overdraw.
 */
export function chatCreditOverdraft(
  funded: boolean,
  hasGrants: boolean,
  config: ChatCreditReserveConfig = resolveChatCreditReserveConfig(),
): number {
  if (!hasGrants) return 0;
  return funded ? config.fundedOverdraftCredits : config.starterOverdraftCredits;
}

import { resolveChatCreditReserveConfig, runningJobCreditFloor, type ChatCreditReserveConfig } from "@docslurp/shared";

/**
 * Worker side of the credit floor for running jobs (packages/shared/src/chat-reserve.ts, migrations 0053 and 0137).
 * The worker only spends for runs that were already admitted (admission keeps the chat reserve), so a running job may
 * use the reserve and finish up to `runOverdraftCredits` below zero. Credit leases pass the floor to
 * grant_credit_lease(); the cadence check and media admission subtract jobCreditReserve() from available credits.
 */

let cachedConfig: ChatCreditReserveConfig | null = null;

export function chatReserveConfig(): ChatCreditReserveConfig {
  cachedConfig ??= resolveChatCreditReserveConfig();
  return cachedConfig;
}

/** Test hook. */
export function setChatReserveConfig(config: ChatCreditReserveConfig | null): void {
  cachedConfig = config;
}

/**
 * The balance a running job must stay above: negative (default -25 credits), the same for funded and starter orgs.
 * `funded` is kept so callers read the org's status the same way as admission does.
 */
export function jobCreditReserve(_funded?: boolean | null): number {
  return runningJobCreditFloor(chatReserveConfig());
}

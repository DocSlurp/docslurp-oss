import { chatCreditReserve, resolveChatCreditReserveConfig, type ChatCreditReserveConfig } from "@docslurp/shared";

/**
 * Worker side of the chat credit reserve (packages/shared/src/chat-reserve.ts,
 * migration 0053): ingestion never spends an org's last `reserve` credits,
 * which stay for chat and search. Credit leases pass the config to
 * grant_credit_lease(); the cadence check and media admission subtract
 * jobCreditReserve(funded) from available credits.
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

/** Credits jobs leave for chat in a funded or starter org. */
export function jobCreditReserve(funded: boolean | null | undefined): number {
  return chatCreditReserve(funded === true, chatReserveConfig());
}

import { describe, expect, it } from "vitest";

import { chatCreditOverdraft, chatCreditReserve, resolveChatCreditReserveConfig } from "../chat-reserve.js";

describe("chat credit reserve config", () => {
  it("defaults to $1 on Free and $3 on paid plans, overdraft equal to the reserve", () => {
    const config = resolveChatCreditReserveConfig({});
    expect(chatCreditReserve("free", config)).toBe(100);
    expect(chatCreditReserve("silver", config)).toBe(300);
    expect(chatCreditReserve("platinum", config)).toBe(300);
    expect(chatCreditReserve("unknown", config)).toBe(100);
    expect(chatCreditOverdraft("gold", true, config)).toBe(300);
    expect(chatCreditOverdraft("free", true, config)).toBe(100);
    expect(config).toMatchObject({ holdCredits: 5, holdTtlSeconds: 120 });
  });

  it("gives no overdraft to orgs that never received credits", () => {
    expect(chatCreditOverdraft("gold", false, resolveChatCreditReserveConfig({}))).toBe(0);
  });

  it("reads env overrides, follows the reserve for the overdraft, and clamps typos", () => {
    const config = resolveChatCreditReserveConfig({
      CHAT_CREDIT_RESERVE_CREDITS: "500",
      CHAT_CREDIT_RESERVE_FREE_CREDITS: "0",
      CHAT_CREDIT_OVERDRAFT_FREE_CREDITS: "-5",
      CHAT_CREDIT_HOLD_CREDITS: "abc",
    });
    expect(config.paidReserveCredits).toBe(500);
    expect(config.paidOverdraftCredits).toBe(500);
    expect(config.freeReserveCredits).toBe(0);
    expect(config.freeOverdraftCredits).toBe(0);
    expect(config.holdCredits).toBe(5);
    expect(resolveChatCreditReserveConfig({ CHAT_CREDIT_RESERVE_CREDITS: "99999999" }).paidReserveCredits).toBe(10_000);
  });
});

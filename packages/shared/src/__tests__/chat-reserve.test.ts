import { describe, expect, it } from "vitest";

import { chatCreditOverdraft, chatCreditReserve, resolveChatCreditReserveConfig, runningJobCreditFloor } from "../chat-reserve.js";

describe("chat credit reserve config", () => {
  it("defaults to $0.20 for starter orgs and $3 for funded orgs, overdraft equal to the reserve", () => {
    const config = resolveChatCreditReserveConfig({});
    expect(chatCreditReserve(false, config)).toBe(20);
    expect(chatCreditReserve(true, config)).toBe(300);
    expect(chatCreditOverdraft(true, true, config)).toBe(300);
    expect(chatCreditOverdraft(false, true, config)).toBe(20);
    expect(config).toMatchObject({ holdCredits: 5, holdTtlSeconds: 120, runOverdraftCredits: 25 });
    expect(runningJobCreditFloor(config)).toBe(-25);
    expect(resolveChatCreditReserveConfig({ RUN_CREDIT_OVERDRAFT_CREDITS: "999999" }).runOverdraftCredits).toBe(1_000);
  });

  it("gives no overdraft to orgs that never received credits", () => {
    expect(chatCreditOverdraft(true, false, resolveChatCreditReserveConfig({}))).toBe(0);
  });

  it("reads env overrides, follows the reserve for the overdraft, and clamps typos", () => {
    const config = resolveChatCreditReserveConfig({
      CHAT_CREDIT_RESERVE_CREDITS: "500",
      CHAT_CREDIT_RESERVE_STARTER_CREDITS: "0",
      CHAT_CREDIT_OVERDRAFT_STARTER_CREDITS: "-5",
      CHAT_CREDIT_HOLD_CREDITS: "abc",
    });
    expect(config.fundedReserveCredits).toBe(500);
    expect(config.fundedOverdraftCredits).toBe(500);
    expect(config.starterReserveCredits).toBe(0);
    expect(config.starterOverdraftCredits).toBe(0);
    expect(config.holdCredits).toBe(5);
    expect(resolveChatCreditReserveConfig({ CHAT_CREDIT_RESERVE_CREDITS: "99999999" }).fundedReserveCredits).toBe(10_000);
  });
});

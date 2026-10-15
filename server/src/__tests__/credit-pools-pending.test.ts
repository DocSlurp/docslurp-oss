import { describe, expect, it } from "vitest";

import { toCreditPools } from "../services/billing/credits.js";

/**
 * Pending debits (migration 0030) are subtracted from the pools the way
 * apply_pending_org_debits will apply them: included first, then prepaid.
 */
describe("toCreditPools with pending debits", () => {
  it("is the raw pools when nothing is pending", () => {
    expect(toCreditPools({ included_credits_remaining: 300, credit_balance_cents: 1000 }))
      .toEqual({ includedRemaining: 300, prepaid: 1000, pending: 0, available: 1300 });
  });

  it("spends pending from included first, then prepaid", () => {
    expect(toCreditPools({ included_credits_remaining: 300, credit_balance_cents: 1000, pending_debit_credits: 120 }))
      .toEqual({ includedRemaining: 180, prepaid: 1000, pending: 120, available: 1180 });
    expect(toCreditPools({ included_credits_remaining: 300, credit_balance_cents: 1000, pending_debit_credits: "450.5" }))
      .toEqual({ includedRemaining: 0, prepaid: 849.5, pending: 450.5, available: 849.5 });
  });

  it("can show an overdraft that only exists once pending debits land", () => {
    const pools = toCreditPools({ included_credits_remaining: 0, credit_balance_cents: 40, pending_debit_credits: 100 });
    expect(pools).toEqual({ includedRemaining: 0, prepaid: -60, pending: 100, available: -60 });
    // Admission blocks at available <= 0.
    expect(pools.available <= 0).toBe(true);
  });
});

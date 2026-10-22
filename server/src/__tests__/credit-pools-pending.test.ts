import { describe, expect, it } from "vitest";

import { toCreditBalance } from "../services/billing/credits.js";

/** Pending debits (migration 0030) are subtracted from the single prepaid balance. */
describe("toCreditBalance with pending debits", () => {
  it("is the raw balance when nothing is pending", () => {
    expect(toCreditBalance({ credit_balance_cents: 1000 })).toEqual({ balance: 1000, pending: 0, available: 1000 });
  });

  it("subtracts pending debits, numeric strings included", () => {
    expect(toCreditBalance({ credit_balance_cents: 1000, pending_debit_credits: "450.5" }))
      .toEqual({ balance: 1000, pending: 450.5, available: 549.5 });
  });

  it("can show an overdraft that only exists once pending debits land", () => {
    const balance = toCreditBalance({ credit_balance_cents: 40, pending_debit_credits: 100 });
    expect(balance).toEqual({ balance: 40, pending: 100, available: -60 });
    // Admission blocks at available <= 0.
    expect(balance.available <= 0).toBe(true);
  });
});

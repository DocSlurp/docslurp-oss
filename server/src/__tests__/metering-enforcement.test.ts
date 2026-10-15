import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: vi.fn() }));

const { isStorageBillingEnabled } = await import("../services/billing/storage-meter.js");
const { isMeteringEnforced, stripeMode } = await import("../services/billing/metering.js");

describe("metering enforcement", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("meters storage whenever Stripe is configured, even if the flag says false", () => {
    expect(isStorageBillingEnabled({})).toBe(false);
    expect(isStorageBillingEnabled({ DOCSLURP_BILL_STORAGE: "true" })).toBe(true);
    expect(isStorageBillingEnabled({ STRIPE_SECRET_KEY: "rk_test_x" })).toBe(true);
    expect(isStorageBillingEnabled({ STRIPE_SECRET_KEY: "rk_test_x", DOCSLURP_BILL_STORAGE: "false" })).toBe(true);
  });

  it("derives enforcement and mode from the Stripe key", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(isMeteringEnforced()).toBe(false);
    expect(stripeMode()).toBeNull();
    vi.stubEnv("STRIPE_SECRET_KEY", "rk_test_abc");
    expect(isMeteringEnforced()).toBe(true);
    expect(stripeMode()).toBe("test");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_abc");
    expect(stripeMode()).toBe("live");
  });
});

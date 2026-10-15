import { beforeEach, describe, expect, it, vi } from "vitest";

const stripe = {
  paymentMethods: { retrieve: vi.fn(), attach: vi.fn() },
  customers: { update: vi.fn(), retrieve: vi.fn(), create: vi.fn() },
};
const db = vi.hoisted(() => ({ storedCustomer: "cus_1" as string | null, writes: [] as unknown[][] }));

vi.mock("../db.js", () => {
  // ensureStripeCustomer: advisory lock, then the org row (already has a customer).
  const reserved = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("from organizations")) return [{ id: "org_1", name: "Org", stripe_customer_id: db.storedCustomer }];
      if (text.includes("update organizations")) db.writes.push(values);
      return [];
    }),
    { release: vi.fn() },
  );
  return { sql: Object.assign(vi.fn(async () => []), { reserve: vi.fn(async () => reserved) }) };
});
vi.mock("../services/billing/stripe-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/billing/stripe-client.js")>()),
  getStripe: () => stripe,
}));

const { attachPaymentMethod, ensureStripeCustomer } = await import("../services/billing/customers.js");

beforeEach(() => {
  vi.clearAllMocks();
  db.storedCustomer = "cus_1";
  db.writes = [];
  stripe.customers.retrieve.mockResolvedValue({ id: "cus_1", deleted: false });
});

describe("ensureStripeCustomer", () => {
  it("returns the stored customer while it exists", async () => {
    expect(await ensureStripeCustomer("org_1")).toBe("cus_1");
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it("creates the first customer with a per-org idempotency key", async () => {
    db.storedCustomer = null;
    stripe.customers.create.mockResolvedValue({ id: "cus_new" });
    expect(await ensureStripeCustomer("org_1")).toBe("cus_new");
    expect(stripe.customers.create.mock.calls[0]![1]).toEqual({ idempotencyKey: "customer:org_1" });
    expect(db.writes[0]).toContain("cus_new");
  });

  it.each([
    ["deleted in the Dashboard", () => stripe.customers.retrieve.mockResolvedValue({ id: "cus_1", deleted: true })],
    [
      "unknown to this account (keys switched)",
      () => stripe.customers.retrieve.mockRejectedValue(Object.assign(new Error("No such customer"), { code: "resource_missing" })),
    ],
  ])("replaces a stored customer that was %s", async (_label, arrange) => {
    arrange();
    stripe.customers.create.mockResolvedValue({ id: "cus_replacement" });
    expect(await ensureStripeCustomer("org_1")).toBe("cus_replacement");
    expect(stripe.customers.create.mock.calls[0]![1]).toEqual({ idempotencyKey: "customer:org_1:replaces:cus_1" });
    expect(db.writes[0]).toContain("cus_replacement");
  });

  it("does not replace the customer on other Stripe errors", async () => {
    stripe.customers.retrieve.mockRejectedValue(Object.assign(new Error("rate limited"), { code: "rate_limit" }));
    await expect(ensureStripeCustomer("org_1")).rejects.toThrow("rate limited");
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });
});

describe("attachPaymentMethod", () => {

  it("makes the attached payment method (as returned by Stripe) the customer default", async () => {
    // Test tokens such as pm_card_visa are cloned on attach: the returned id differs from the input.
    stripe.paymentMethods.retrieve.mockResolvedValue({ id: "pm_card_visa", customer: null });
    stripe.paymentMethods.attach.mockResolvedValue({ id: "pm_1Attached", customer: "cus_1", type: "card" });

    const pm = await attachPaymentMethod({ orgId: "org_1", paymentMethodId: "pm_card_visa" });

    expect(pm.id).toBe("pm_1Attached");
    expect(stripe.paymentMethods.attach).toHaveBeenCalledWith("pm_card_visa", { customer: "cus_1" });
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", {
      invoice_settings: { default_payment_method: "pm_1Attached" },
    });
  });

  it("re-uses a payment method already attached to the same customer", async () => {
    stripe.paymentMethods.retrieve.mockResolvedValue({ id: "pm_saved", customer: "cus_1", type: "card" });
    await attachPaymentMethod({ orgId: "org_1", paymentMethodId: "pm_saved" });
    expect(stripe.paymentMethods.attach).not.toHaveBeenCalled();
    expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", {
      invoice_settings: { default_payment_method: "pm_saved" },
    });
  });

  it("refuses a payment method that belongs to another customer", async () => {
    stripe.paymentMethods.retrieve.mockResolvedValue({ id: "pm_other", customer: "cus_2" });
    await expect(attachPaymentMethod({ orgId: "org_1", paymentMethodId: "pm_other" })).rejects.toThrow(/another customer/);
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });
});

import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: vi.fn() }));

const {
  dispatchStripeEvent,
  planFromSubscription,
  processStripeEvent,
  refundTargetCredits,
  subscriptionInvoiceGrant,
  subscriptionState,
} = await import("../services/billing/webhooks.js");
const { creditsForSubscriptionPayment } = await import("@docslurp/shared");

type Query = { text: string; values: unknown[] };

/** Tagged-template SQL double: records queries, answers by matching the query text. */
function fakeSql(responder: (query: Query) => unknown[] = () => []) {
  const queries: Query[] = [];
  const client = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join("?"), values };
    queries.push(query);
    return Promise.resolve(responder(query));
  }) as unknown as Parameters<typeof dispatchStripeEvent>[0];
  return { client, queries, find: (fragment: string) => queries.filter((q) => q.text.includes(fragment)) };
}

function price(lookupKey: string | null) {
  return { id: `price_${lookupKey}`, lookup_key: lookupKey } as Stripe.Price;
}

function subscription(overrides: Partial<Stripe.Subscription> & { lookupKey?: string } = {}): Stripe.Subscription {
  const { lookupKey = "docslurp_gold_monthly", ...rest } = overrides;
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    cancel_at: null,
    schedule: null,
    metadata: {},
    items: {
      data: [
        {
          price: price(lookupKey),
          current_period_start: 1_790_000_000,
          current_period_end: 1_792_592_000,
        },
      ],
    },
    ...rest,
  } as unknown as Stripe.Subscription;
}

function fakeStripe(sub: Stripe.Subscription = subscription()) {
  return {
    subscriptions: { retrieve: vi.fn(async () => sub) },
    subscriptionSchedules: { retrieve: vi.fn() },
    invoicePayments: { list: vi.fn(async () => ({ data: [] })) },
    charges: { retrieve: vi.fn() },
    customers: {
      retrieve: vi.fn(async () => ({ deleted: false, invoice_settings: { default_payment_method: "pm_existing" } })),
      update: vi.fn(),
    },
    paymentIntents: { retrieve: vi.fn() },
  } as unknown as Stripe;
}

function event<T>(type: string, object: T): Stripe.Event {
  return { id: `evt_${type}`, type, data: { object } } as unknown as Stripe.Event;
}

function invoice(overrides: Record<string, unknown> = {}): Stripe.Invoice {
  return {
    id: "in_1",
    customer: "cus_1",
    billing_reason: "subscription_cycle",
    amount_paid: 5_400,
    total_taxes: [{ amount: 400 }],
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
    lines: { data: [{ amount: 5_000, parent: { type: "subscription_item_details" }, subscription: "sub_1" }] },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

const orgRow = { id: "org-1", stripe_subscription_id: "sub_1", plan_id: "gold" };

describe("subscription invoice grants", () => {
  it("grants a renewal from the pre-tax amount paid and resets the included pool", () => {
    const grant = subscriptionInvoiceGrant(invoice());
    expect(grant).toEqual({ subscriptionId: "sub_1", baseCents: 5_000, resetIncluded: true, purchasedPriceId: null });
    expect(creditsForSubscriptionPayment("gold", grant!.baseCents)).toBe(5_500);
  });

  it("adds a prorated upgrade grant instead of resetting", () => {
    const grant = subscriptionInvoiceGrant(
      invoice({
        billing_reason: "subscription_update",
        amount_paid: 3_000,
        total_taxes: [],
        lines: {
          data: [
            { amount: -1_000, parent: { type: "subscription_item_details" }, pricing: { type: "price_details", price_details: { price: "price_silver" } } },
            { amount: 4_000, parent: { type: "subscription_item_details" }, pricing: { type: "price_details", price_details: { price: "price_gold" } } },
          ],
        },
      }),
    );
    // The purchased plan comes from the largest positive line, not the subscription's current price.
    expect(grant).toEqual({ subscriptionId: "sub_1", baseCents: 3_000, resetIncluded: false, purchasedPriceId: "price_gold" });
    expect(creditsForSubscriptionPayment("gold", 3_000)).toBe(3_300);
  });

  it("never grants more than was paid (credit balance or discounts)", () => {
    expect(subscriptionInvoiceGrant(invoice({ amount_paid: 1_000, total_taxes: [] }))?.baseCents).toBe(1_000);
    expect(subscriptionInvoiceGrant(invoice({ amount_paid: 0, total_taxes: [] }))?.baseCents).toBe(0);
  });

  it("ignores invoices that are not for a subscription", () => {
    expect(subscriptionInvoiceGrant(invoice({ parent: null }))).toBeNull();
  });
});

describe("subscription state", () => {
  it("maps a live subscription's lookup key to the plan's worker ceiling", () => {
    const state = subscriptionState(subscription());
    expect(state).toMatchObject({ planId: "gold", workerSlots: 250, status: "active", cancelAtPeriodEnd: false });
    expect(state.periodEnd?.toISOString()).toBe(new Date(1_792_592_000 * 1000).toISOString());
  });

  it("falls back to free for non-live or unknown-price subscriptions", () => {
    expect(subscriptionState(subscription({ status: "incomplete" }))).toMatchObject({ planId: "free", workerSlots: 50 });
    expect(subscriptionState(subscription({ lookupKey: "someone_elses_price" }))).toMatchObject({ planId: "free" });
    expect(planFromSubscription(subscription({ lookupKey: "docslurp_platinum_monthly" }))?.workers).toBe(1_000);
  });

  it("treats cancel_at as a pending cancellation", () => {
    expect(subscriptionState(subscription({ cancel_at: 1_792_592_000 })).cancelAtPeriodEnd).toBe(true);
  });
});

describe("refund clawback math", () => {
  it("reverses the refunded fraction of the grant, so tax does not inflate it", () => {
    expect(refundTargetCredits(1_000, 540, 1_080)).toBe(500);
    expect(refundTargetCredits(1_000, 5_000, 1_080)).toBe(1_000);
    expect(refundTargetCredits(1_000, 0, 1_080)).toBe(0);
  });
});

describe("dispatchStripeEvent", () => {
  it("invoice.paid grants included credits keyed by invoice and clears past-due", async () => {
    const db = fakeSql((q) => {
      if (q.text.includes("from organizations where stripe_customer_id")) return [orgRow];
      if (q.text.includes("grant_org_credits(")) return [{ granted: true }];
      return [];
    });
    const handled = await dispatchStripeEvent(db.client, fakeStripe(), event("invoice.paid", invoice()));
    expect(handled).toBe(true);
    const [grant] = db.find("grant_org_credits(");
    expect(grant!.values.slice(0, 6)).toEqual(["org-1", "subscription", "in_1", "included", 5_500, true]);
    expect(db.find("past_due_since = null")).toHaveLength(1);
    const [mirror] = db.find("plan_id =");
    expect(mirror!.values).toContain("gold");
  });

  it("checkout.session.completed for a top-up grants prepaid credits by PaymentIntent", async () => {
    const db = fakeSql((q) => (q.text.includes("grant_org_credits(") ? [{ granted: true }] : []));
    await dispatchStripeEvent(
      db.client,
      fakeStripe(),
      event("checkout.session.completed", {
        id: "cs_1",
        mode: "payment",
        payment_status: "paid",
        payment_intent: "pi_1",
        customer: "cus_1",
        amount_subtotal: 2_500,
        metadata: { orgId: "org-1", purpose: "credit_topup", credits: "2500" },
      }),
    );
    const [grant] = db.find("grant_org_credits(");
    expect(grant!.values.slice(0, 6)).toEqual(["org-1", "topup", "pi_1", "prepaid", 2_500, false]);
  });

  it("a Stripe credit grant adds its USD amount as prepaid credits, keyed by the grant id", async () => {
    const db = fakeSql((q) => {
      if (q.text.includes("from organizations where stripe_customer_id")) return [orgRow];
      if (q.text.includes("grant_org_credits(")) return [{ granted: true }];
      return [];
    });
    const grant = { id: "credgr_1", customer: "cus_1", category: "promotional", name: "DocSlurp credits", voided_at: null,
      amount: { type: "monetary", monetary: { currency: "usd", value: 100_000 } } };
    expect(await dispatchStripeEvent(db.client, fakeStripe(), event("billing.credit_grant.created", grant))).toBe(true);
    const [granted] = db.find("grant_org_credits(");
    expect(granted!.values.slice(0, 6)).toEqual(["org-1", "promo", "credgr_1", "prepaid", 100_000, false]);
  });

  it("a voided Stripe credit grant reverses it, and non-USD or unknown-customer grants grant nothing", async () => {
    const db = fakeSql((q) => {
      if (q.text.includes("from organizations where stripe_customer_id")) return q.values.includes("cus_1") ? [orgRow] : [];
      if (q.text.includes("from credit_grants")) return [{ id: "grant-9", credits: 100_000 }];
      return [];
    });
    const base = { id: "credgr_1", customer: "cus_1", category: "promotional", name: null,
      amount: { type: "monetary", monetary: { currency: "usd", value: 100_000 } } };
    await dispatchStripeEvent(db.client, fakeStripe(), event("billing.credit_grant.updated", { ...base, voided_at: 1_792_000_000 }));
    const [reversal] = db.find("reverse_credit_grant(");
    expect(reversal!.values.slice(0, 2)).toEqual(["grant-9", 100_000]);

    await dispatchStripeEvent(db.client, fakeStripe(), event("billing.credit_grant.created",
      { ...base, id: "credgr_eur", voided_at: null, amount: { type: "monetary", monetary: { currency: "eur", value: 5_000 } } }));
    await dispatchStripeEvent(db.client, fakeStripe(), event("billing.credit_grant.created", { ...base, id: "credgr_x", customer: "cus_other", voided_at: null }));
    expect(db.find("grant_org_credits(")).toHaveLength(0);
  });

  it("an unpaid top-up checkout grants nothing", async () => {
    const db = fakeSql();
    await dispatchStripeEvent(
      db.client,
      fakeStripe(),
      event("checkout.session.completed", {
        id: "cs_2",
        mode: "payment",
        payment_status: "unpaid",
        payment_intent: "pi_2",
        metadata: { orgId: "org-1", purpose: "credit_topup", credits: "2500" },
      }),
    );
    expect(db.find("grant_org_credits(")).toHaveLength(0);
  });

  it("payment_intent.succeeded for auto-recharge grants and resets the failure counter", async () => {
    const db = fakeSql((q) => (q.text.includes("grant_org_credits(") ? [{ granted: true }] : []));
    await dispatchStripeEvent(
      db.client,
      fakeStripe(),
      event("payment_intent.succeeded", {
        id: "pi_auto",
        amount: 2_000,
        metadata: { orgId: "org-1", purpose: "auto_recharge", credits: "2000" },
      }),
    );
    expect(db.find("grant_org_credits(")[0]!.values.slice(0, 5)).toEqual(["org-1", "auto_recharge", "pi_auto", "prepaid", 2_000]);
    expect(db.find("auto_recharge_consecutive_failures = 0")).toHaveLength(1);
  });

  it("payment_intent.succeeded backstops an agent card top-up under the same PaymentIntent key, never a stablecoin one", async () => {
    const db = fakeSql((q) => (q.text.includes("grant_org_credits(") ? [{ granted: false }] : []));
    const metadata = { orgId: "org-1", purpose: "agent_credit_topup", credits: "2500" };
    await dispatchStripeEvent(db.client, fakeStripe(), event("payment_intent.succeeded", { id: "pi_agent", amount: 2_500, payment_method_types: ["card", "link"], metadata }));
    expect(db.find("grant_org_credits(")[0]!.values.slice(0, 5)).toEqual(["org-1", "topup", "pi_agent", "prepaid", 2_500]);
    // Stablecoin grants are keyed by transaction hash at payment time; a PaymentIntent key would grant twice.
    await dispatchStripeEvent(db.client, fakeStripe(), event("payment_intent.succeeded", { id: "pi_crypto", amount: 2_500, payment_method_types: ["crypto"], metadata }));
    expect(db.find("grant_org_credits(")).toHaveLength(1);
  });

  it("payment_intent.payment_failed counts an auto-recharge failure once per intent", async () => {
    const db = fakeSql();
    await dispatchStripeEvent(
      db.client,
      fakeStripe(),
      event("payment_intent.payment_failed", {
        id: "pi_fail",
        metadata: { orgId: "org-1", purpose: "auto_recharge" },
        last_payment_error: { code: "card_declined" },
      }),
    );
    const [update] = db.find("auto_recharge_consecutive_failures + 1");
    expect(update!.text).toContain("is distinct from");
    expect(update!.values).toContain("pi_fail");
  });

  it("charge.refunded claws back the refunded fraction of a top-up", async () => {
    const db = fakeSql((q) => (q.text.includes("from credit_grants") ? [{ id: "grant-1", credits: 1_000 }] : []));
    await dispatchStripeEvent(
      db.client,
      fakeStripe(),
      event("charge.refunded", { id: "ch_1", payment_intent: "pi_1", amount: 1_080, amount_refunded: 540 }),
    );
    const [reverse] = db.find("reverse_credit_grant(");
    expect(reverse!.values.slice(0, 3)).toEqual(["grant-1", 500, "clawback:refund"]);
  });

  it("a lost dispute on a subscription charge claws back the invoice grant via its invoice payment", async () => {
    const db = fakeSql((q) => {
      if (q.text.includes("source = 'subscription' and external_id")) return [{ id: "grant-sub", credits: 5_500 }];
      return [];
    });
    const stripe = fakeStripe();
    (stripe.invoicePayments.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [{ invoice: "in_9" }] });
    await dispatchStripeEvent(
      db.client,
      stripe,
      event("charge.dispute.closed", { id: "dp_1", status: "lost", payment_intent: "pi_sub", charge: "ch_sub", amount: 5_000 }),
    );
    expect(db.find("source = 'subscription' and external_id")[0]!.values).toEqual(["in_9"]);
    expect(db.find("reverse_credit_grant(")[0]!.values.slice(0, 3)).toEqual(["grant-sub", 5_500, "clawback:dispute"]);
  });

  it("a won dispute changes nothing", async () => {
    const db = fakeSql();
    await dispatchStripeEvent(db.client, fakeStripe(), event("charge.dispute.closed", { id: "dp_2", status: "won" }));
    expect(db.queries).toHaveLength(0);
  });

  it("customer.subscription.deleted returns the org to free and expires included credits", async () => {
    const db = fakeSql((q) => (q.text.includes("from organizations where stripe_customer_id") ? [orgRow] : []));
    await dispatchStripeEvent(db.client, fakeStripe(), event("customer.subscription.deleted", subscription({ status: "canceled" })));
    const [update] = db.find("plan_id = 'free'");
    expect(update!.values).toContain(50);
    expect(db.find("expire_included_credits(")).toHaveLength(1);
  });

  it("customer.subscription.updated mirrors the latest subscription, including a scheduled downgrade", async () => {
    const sub = subscription({ schedule: "sub_sched_1" });
    const stripe = fakeStripe(sub);
    (stripe.subscriptionSchedules.retrieve as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      phases: [
        { start_date: 1_790_000_000, items: [{ price: price("docslurp_gold_monthly") }] },
        { start_date: 1_792_592_000, items: [{ price: price("docslurp_silver_monthly") }] },
      ],
    });
    const db = fakeSql((q) => (q.text.includes("from organizations where stripe_customer_id") ? [orgRow] : []));
    await dispatchStripeEvent(db.client, stripe, event("customer.subscription.updated", { id: "sub_1" }));
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_1");
    const [mirror] = db.find("scheduled_plan_id =");
    expect(mirror!.values).toEqual(expect.arrayContaining(["gold", "active", "silver", 250]));
  });

  it("invoice.payment_failed marks the org past due", async () => {
    const db = fakeSql((q) => (q.text.includes("from organizations where stripe_customer_id") ? [orgRow] : []));
    await dispatchStripeEvent(db.client, fakeStripe(), event("invoice.payment_failed", invoice()));
    expect(db.find("subscription_status = 'past_due'")).toHaveLength(1);
  });

  it("ignores unrelated event types", async () => {
    const db = fakeSql();
    expect(await dispatchStripeEvent(db.client, fakeStripe(), event("customer.created", {}))).toBe(false);
  });
});

describe("processStripeEvent", () => {
  it("skips an event id it has already processed", async () => {
    const db = fakeSql((q) => (q.text.includes("from stripe_webhook_events") ? [{ event_id: "evt_invoice.paid" }] : []));
    const begin = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db.client));
    const result = await processStripeEvent(event("invoice.paid", invoice()), {
      stripe: fakeStripe(),
      db: Object.assign(db.client, { begin }) as never,
    });
    expect(result).toEqual({ handled: true, event: "invoice.paid", duplicate: true });
    expect(db.find("grant_org_credits(")).toHaveLength(0);
    expect(db.find("pg_advisory_xact_lock")).toHaveLength(1);
  });

  it("records a processed event in the same transaction", async () => {
    const db = fakeSql();
    const begin = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db.client));
    const result = await processStripeEvent(event("customer.created", {}), {
      stripe: fakeStripe(),
      db: Object.assign(db.client, { begin }) as never,
    });
    expect(result).toEqual({ handled: false, event: "customer.created" });
    expect(db.find("insert into stripe_webhook_events")).toHaveLength(1);
  });
});

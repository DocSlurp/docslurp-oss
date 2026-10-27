import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: vi.fn() }));

const { dispatchStripeEvent, processStripeEvent, refundTargetCredits } = await import("../services/billing/webhooks.js");

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

function fakeStripe() {
  return {
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

const orgRow = { id: "org-1" };

describe("refund clawback math", () => {
  it("reverses the refunded fraction of the grant, so tax does not inflate it", () => {
    expect(refundTargetCredits(1_000, 540, 1_080)).toBe(500);
    expect(refundTargetCredits(1_000, 5_000, 1_080)).toBe(1_000);
    expect(refundTargetCredits(1_000, 0, 1_080)).toBe(0);
  });
});

describe("dispatchStripeEvent", () => {
  it("ignores subscription and invoice events: there are no plans", async () => {
    for (const type of ["invoice.paid", "invoice.payment_failed", "customer.subscription.updated", "customer.subscription.deleted"]) {
      const db = fakeSql((q) => (q.text.includes("from organizations where stripe_customer_id") ? [orgRow] : []));
      expect(await dispatchStripeEvent(db.client, fakeStripe(), event(type, invoice())), type).toBe(false);
      expect(db.find("grant_org_credits(")).toHaveLength(0);
    }
  });

  it("a subscription-mode checkout grants nothing", async () => {
    const db = fakeSql();
    await dispatchStripeEvent(db.client, fakeStripe(), event("checkout.session.completed", { id: "cs_sub", mode: "subscription", subscription: "sub_1", metadata: { orgId: "org-1" } }));
    expect(db.queries).toHaveLength(0);
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
    expect(grant!.values.slice(0, 4)).toEqual(["org-1", "topup", "pi_1", 2_500]);
  });

  it("a Stripe credit grant adds its USD amount as prepaid credits, keyed by the grant id", async () => {
    const db = fakeSql((q) => {
      if (q.text.includes("from organizations where stripe_customer_id")) return [orgRow];
      if (q.text.includes("reconcile_stripe_credit_grant(")) return [{ outcome: "granted" }];
      return [];
    });
    const grant = { id: "credgr_1", customer: "cus_1", category: "promotional", name: "DocSlurp credits", voided_at: null,
      amount: { type: "monetary", monetary: { currency: "usd", value: 100_000 } } };
    expect(await dispatchStripeEvent(db.client, fakeStripe(), event("billing.credit_grant.created", grant))).toBe(true);
    const [granted] = db.find("reconcile_stripe_credit_grant(");
    expect(granted!.values.slice(0, 4)).toEqual(["credgr_1", "org-1", 100_000, false]);
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
    const [reversal] = db.find("reconcile_stripe_credit_grant(");
    expect(reversal!.values.slice(0, 4)).toEqual(["credgr_1", "org-1", 100_000, true]);

    await dispatchStripeEvent(db.client, fakeStripe(), event("billing.credit_grant.created",
      { ...base, id: "credgr_eur", voided_at: null, amount: { type: "monetary", monetary: { currency: "eur", value: 5_000 } } }));
    await dispatchStripeEvent(db.client, fakeStripe(), event("billing.credit_grant.created", { ...base, id: "credgr_x", customer: "cus_other", voided_at: null }));
    expect(db.find("reconcile_stripe_credit_grant(").map(q => q.values.slice(0, 4))).toEqual([["credgr_1", "org-1", 100_000, true], ["credgr_x", null, 100_000, false]]);
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
    expect(db.find("grant_org_credits(")[0]!.values.slice(0, 4)).toEqual(["org-1", "auto_recharge", "pi_auto", 2_000]);
    expect(db.find("auto_recharge_consecutive_failures = 0")).toHaveLength(1);
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

  it("a lost dispute claws back the whole top-up grant", async () => {
    const db = fakeSql((q) => (q.text.includes("from credit_grants") ? [{ id: "grant-1", credits: 2_500 }] : []));
    await dispatchStripeEvent(
      db.client,
      fakeStripe(),
      event("charge.dispute.closed", { id: "dp_1", status: "lost", payment_intent: "pi_1", charge: "ch_1", amount: 2_500 }),
    );
    expect(db.find("reverse_credit_grant(")[0]!.values.slice(0, 3)).toEqual(["grant-1", 2_500, "clawback:dispute"]);
  });

  it("a won dispute changes nothing", async () => {
    const db = fakeSql();
    await dispatchStripeEvent(db.client, fakeStripe(), event("charge.dispute.closed", { id: "dp_2", status: "won" }));
    expect(db.queries).toHaveLength(0);
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

import type Stripe from "stripe";

import {
  creditsForSubscriptionPayment,
  getPlan,
  getPlanByLookupKey,
  type PlanId,
  type ServicePlan,
} from "@docslurp/shared";
import { sql, type SqlClient } from "../../db.js";
import { recordAutoRechargeFailure, recordAutoRechargeSuccess } from "./auto-recharge.js";
import { grantOrgCredits } from "./credits.js";
import { getStripe, stripeId } from "./stripe-client.js";

const STRIPE_WEBHOOK_LOCK_NAMESPACE = 90_102;
/** Past-due subscriptions keep their worker ceiling this long before dropping to the free level. */
export const PAST_DUE_GRACE_DAYS = 7;
const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);
const FREE_PLAN = getPlan("free");

export class StripeWebhookError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly exposeMessage: boolean,
  ) {
    super(message);
    this.name = "StripeWebhookError";
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export function planFromSubscription(sub: Pick<Stripe.Subscription, "items">): ServicePlan | null {
  for (const item of sub.items?.data ?? []) {
    const plan = getPlanByLookupKey(item.price?.lookup_key ?? null);
    if (plan) return plan;
  }
  return null;
}

export function subscriptionIdOfInvoice(invoice: Stripe.Invoice): string | null {
  return stripeId(invoice.parent?.subscription_details?.subscription ?? null);
}

/**
 * How a paid subscription invoice converts into included credits. The base is
 * the pre-tax amount actually paid for subscription lines (a proration
 * invoice pays only the difference, so its grant scales down; design gotcha
 * 5). Renewal and first invoices reset the included pool (unused credits
 * expire); anything else (upgrade prorations) adds to it.
 */
export function subscriptionInvoiceGrant(invoice: Stripe.Invoice): {
  subscriptionId: string;
  baseCents: number;
  resetIncluded: boolean;
  /** Price on the largest positive subscription line: the plan this invoice bought. */
  purchasedPriceId: string | null;
} | null {
  const subscriptionId = subscriptionIdOfInvoice(invoice);
  if (!subscriptionId) return null;
  let subscriptionLines = 0;
  let purchased: { amount: number; priceId: string | null } | null = null;
  for (const line of invoice.lines?.data ?? []) {
    const parentType = line.parent?.type;
    const fromSubscription =
      parentType === "subscription_item_details" ||
      (parentType === "invoice_item_details" && Boolean(line.parent?.invoice_item_details?.subscription)) ||
      Boolean(line.subscription);
    if (!fromSubscription) continue;
    subscriptionLines += line.amount;
    if (line.amount > 0 && (!purchased || line.amount > purchased.amount)) {
      purchased = { amount: line.amount, priceId: stripeId(line.pricing?.price_details?.price ?? null) };
    }
  }
  const taxes = (invoice.total_taxes ?? []).reduce((sum, tax) => sum + (tax.amount ?? 0), 0);
  const paidPreTax = Math.max(0, (invoice.amount_paid ?? 0) - taxes);
  const baseCents = Math.max(0, Math.min(subscriptionLines, paidPreTax));
  const resetIncluded = invoice.billing_reason === "subscription_cycle" || invoice.billing_reason === "subscription_create";
  return { subscriptionId, baseCents, resetIncluded, purchasedPriceId: purchased?.priceId ?? null };
}

/**
 * The plan an invoice paid for. A webhook can arrive after a later plan
 * change, so the subscription's current price would apply the wrong bonus.
 */
async function planForInvoice(stripe: Stripe, priceId: string | null, sub: Stripe.Subscription) {
  if (priceId) {
    try {
      const price = await stripe.prices.retrieve(priceId);
      const plan = getPlanByLookupKey(price.lookup_key);
      if (plan) return plan;
    } catch (error) {
      console.warn(`[billing] price lookup failed price=${priceId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return planFromSubscription(sub);
}

/** Cumulative credits to claw back for a (possibly partial) refund of a charge. */
export function refundTargetCredits(grantCredits: number, amountRefunded: number, amountCharged: number): number {
  if (!(amountCharged > 0) || !(amountRefunded > 0)) return 0;
  const fraction = Math.min(1, amountRefunded / amountCharged);
  return Math.round(grantCredits * fraction * 1e6) / 1e6;
}

export type SubscriptionState = {
  planId: PlanId;
  workerSlots: number;
  status: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
};

export function subscriptionState(sub: Stripe.Subscription): SubscriptionState {
  const plan = planFromSubscription(sub);
  const effective = LIVE_STATUSES.has(sub.status) && plan ? plan : FREE_PLAN;
  const item = sub.items?.data?.[0];
  return {
    planId: effective.id,
    workerSlots: effective.workers,
    status: sub.status,
    periodStart: item?.current_period_start ? new Date(item.current_period_start * 1000) : null,
    periodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end || sub.cancel_at),
  };
}

function numberMetadata(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Event processing
// ---------------------------------------------------------------------------

type OrgRef = { id: string; stripe_subscription_id: string | null; plan_id: PlanId };

async function findOrg(
  client: SqlClient,
  customerId: string | null,
  fallbackOrgId?: string | null,
): Promise<OrgRef | null> {
  if (customerId) {
    const [row] = await client<OrgRef[]>`
      select id, stripe_subscription_id, plan_id from organizations where stripe_customer_id = ${customerId} limit 1
    `;
    if (row) return row;
  }
  if (fallbackOrgId) {
    const [row] = await client<OrgRef[]>`
      select id, stripe_subscription_id, plan_id from organizations where id = ${fallbackOrgId} limit 1
    `;
    if (row) return row;
  }
  return null;
}

async function resolveScheduledPlan(stripe: Stripe, sub: Stripe.Subscription, periodEnd: Date | null): Promise<PlanId | null> {
  const scheduleId = stripeId(sub.schedule);
  if (!scheduleId) return null;
  try {
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId, { expand: ["phases.items.price"] });
    const boundary = periodEnd ? Math.floor(periodEnd.getTime() / 1000) : Math.floor(Date.now() / 1000);
    const next = schedule.phases.find((phase) => phase.start_date >= boundary);
    for (const item of next?.items ?? []) {
      const price = item.price;
      if (price && typeof price === "object" && "lookup_key" in price) {
        const plan = getPlanByLookupKey(price.lookup_key);
        if (plan) return plan.id;
      }
    }
  } catch (error) {
    console.warn(`[billing] schedule lookup failed subscription=${sub.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

/** Mirror a subscription into the org row: plan, worker ceiling, status, period, pending change. */
export async function applySubscription(
  client: SqlClient,
  stripe: Stripe,
  sub: Stripe.Subscription,
  fallbackOrgId?: string | null,
): Promise<string | null> {
  const org = await findOrg(client, stripeId(sub.customer), fallbackOrgId ?? sub.metadata?.orgId);
  if (!org) {
    console.warn(`[billing] subscription ${sub.id} has no matching organization`);
    return null;
  }
  // A stale, non-live subscription must not overwrite the org's current one.
  if (org.stripe_subscription_id && org.stripe_subscription_id !== sub.id && !LIVE_STATUSES.has(sub.status)) {
    return org.id;
  }
  const state = subscriptionState(sub);
  const scheduled = state.cancelAtPeriodEnd ? "free" : await resolveScheduledPlan(stripe, sub, state.periodEnd);
  await client`
    update organizations
    set
      stripe_subscription_id = ${sub.id},
      stripe_customer_id = coalesce(stripe_customer_id, ${stripeId(sub.customer)}),
      plan_id = ${state.planId},
      subscription_status = ${state.status},
      past_due_since = case
        when ${state.status} in ('active', 'trialing') then null
        when ${state.status} = 'past_due' then coalesce(past_due_since, now())
        else past_due_since
      end,
      worker_slots = case
        when ${state.status} = 'past_due'
          and coalesce(past_due_since, now()) < now() - make_interval(days => ${PAST_DUE_GRACE_DAYS})
          then ${FREE_PLAN.workers}::int
        else ${state.workerSlots}::int
      end,
      current_period_start = ${state.periodStart},
      current_period_end = ${state.periodEnd},
      cancel_at_period_end = ${state.cancelAtPeriodEnd},
      scheduled_plan_id = ${scheduled && scheduled !== state.planId ? scheduled : null},
      updated_at = now()
    where id = ${org.id}
  `;
  console.log(`[billing] subscription orgId=${org.id} subscription=${sub.id} plan=${state.planId} status=${state.status}`);
  return org.id;
}

async function endSubscription(client: SqlClient, sub: Stripe.Subscription): Promise<void> {
  const org = await findOrg(client, stripeId(sub.customer), sub.metadata?.orgId);
  if (!org) return;
  if (org.stripe_subscription_id && org.stripe_subscription_id !== sub.id) return;
  await client`
    update organizations
    set
      stripe_subscription_id = null,
      plan_id = 'free',
      worker_slots = ${FREE_PLAN.workers},
      subscription_status = 'canceled',
      cancel_at_period_end = false,
      scheduled_plan_id = null,
      past_due_since = null,
      current_period_start = null,
      current_period_end = null,
      included_credits_granted = 0,
      updated_at = now()
    where id = ${org.id}
  `;
  await client`select expire_included_credits(${org.id}, 'included_expired')`;
  console.log(`[billing] subscription ended orgId=${org.id} subscription=${sub.id}`);
}

async function grantTopUp(
  client: SqlClient,
  args: { orgId: string; paymentIntentId: string; credits: number; source: "topup" | "auto_recharge"; extra?: Record<string, unknown> },
): Promise<void> {
  const applied = await grantOrgCredits(client, {
    orgId: args.orgId,
    source: args.source,
    externalId: args.paymentIntentId,
    pool: "prepaid",
    credits: args.credits,
    metadata: { paymentIntentId: args.paymentIntentId, amountCents: args.credits, ...args.extra },
  });
  console.log(
    `[billing] ${applied ? "grant" : "duplicate-grant"} source=${args.source} orgId=${args.orgId} credits=${args.credits} paymentIntentId=${args.paymentIntentId}`,
  );
}

/** Save the card from a top-up Checkout as the default when the customer has none (auto-recharge reuses it). */
async function adoptDefaultPaymentMethod(stripe: Stripe, customerId: string | null, paymentIntentId: string): Promise<void> {
  if (!customerId) return;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted || customer.invoice_settings?.default_payment_method) return;
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    const paymentMethod = stripeId(intent.payment_method);
    if (paymentMethod) {
      await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethod } });
    }
  } catch (error) {
    console.warn(`[billing] default payment method update failed customer=${customerId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type GrantRow = { id: string; credits: number };

/** The grant a charge paid for: a top-up/auto-recharge by PaymentIntent, else a subscription invoice. */
async function findGrantForPaymentIntent(client: SqlClient, stripe: Stripe, paymentIntentId: string): Promise<GrantRow | null> {
  const [direct] = await client<GrantRow[]>`
    select id, credits from credit_grants
    where (source in ('topup', 'auto_recharge') and external_id = ${paymentIntentId})
       or (metadata ? 'paymentIntentId' and metadata ->> 'paymentIntentId' = ${paymentIntentId})
    limit 1
  `;
  if (direct) return direct;
  const payments = await stripe.invoicePayments.list({
    payment: { type: "payment_intent", payment_intent: paymentIntentId },
    limit: 1,
  });
  const invoiceId = stripeId(payments.data[0]?.invoice ?? null);
  if (!invoiceId) return null;
  const [byInvoice] = await client<GrantRow[]>`
    select id, credits from credit_grants where source = 'subscription' and external_id = ${invoiceId} limit 1
  `;
  return byInvoice ?? null;
}

async function clawBack(
  client: SqlClient,
  stripe: Stripe,
  args: { paymentIntentId: string | null; target: (grantCredits: number) => number; reason: string; metadata: Record<string, unknown> },
): Promise<void> {
  if (!args.paymentIntentId) return;
  const grant = await findGrantForPaymentIntent(client, stripe, args.paymentIntentId);
  if (!grant) {
    console.log(`[billing] ${args.reason} paymentIntentId=${args.paymentIntentId} has no credit grant; nothing to claw back`);
    return;
  }
  const [row] = await client<{ reversed: number }[]>`
    select reverse_credit_grant(
      ${grant.id},
      ${args.target(Number(grant.credits))},
      ${args.reason},
      ${JSON.stringify({ paymentIntentId: args.paymentIntentId, ...args.metadata })}::text::jsonb
    ) as reversed
  `;
  console.log(`[billing] ${args.reason} grant=${grant.id} reversedCredits=${row?.reversed ?? 0}`);
}

/**
 * Stripe Billing credit grants are how operators give an org dollar credit
 * from Stripe (Dashboard → customer → Credit grants, or
 * the credit grant script). A USD grant becomes DocSlurp prepaid
 * credits at 1 credit per cent, once per grant id; voiding it reverses what
 * it granted. The org is the one that owns the grant's Stripe customer.
 * DocSlurp sells no metered Stripe prices, so Stripe itself never applies
 * the grant to an invoice: DocSlurp's ledger is the only place it counts.
 */
export async function mirrorStripeCreditGrant(client: SqlClient, grant: Stripe.Billing.CreditGrant): Promise<void> {
  const monetary = grant.amount.type === "monetary" ? grant.amount.monetary : null;
  const cents = monetary?.currency === "usd" ? Math.trunc(Number(monetary.value)) : 0;
  if (!(cents > 0)) {
    console.warn(`[billing] credit grant ${grant.id} is not a positive USD amount; ignored`);
    return;
  }
  const org = await findOrg(client, stripeId(grant.customer));
  if (!org) {
    console.warn(`[billing] credit grant ${grant.id} customer=${stripeId(grant.customer)} matches no org; ignored`);
    return;
  }
  const metadata = { stripeCreditGrantId: grant.id, category: grant.category, name: grant.name, amountCents: cents };
  if (grant.voided_at) {
    const [granted] = await client<GrantRow[]>`
      select id, credits from credit_grants where source = 'promo' and external_id = ${grant.id} limit 1
    `;
    if (!granted) return;
    const [row] = await client<{ reversed: number }[]>`
      select reverse_credit_grant(${granted.id}, ${Number(granted.credits)}, 'stripe_credit_grant_voided',
        ${JSON.stringify(metadata)}::text::jsonb) as reversed
    `;
    console.log(`[billing] credit grant voided orgId=${org.id} grant=${grant.id} reversedCredits=${row?.reversed ?? 0}`);
    return;
  }
  const applied = await grantOrgCredits(client, {
    orgId: org.id,
    source: "promo",
    externalId: grant.id,
    pool: "prepaid",
    credits: cents,
    metadata,
  });
  console.log(`[billing] ${applied ? "grant" : "duplicate-grant"} source=stripe_credit_grant orgId=${org.id} credits=${cents} grant=${grant.id}`);
}

/** Apply one verified Stripe event. Returns false for event types we ignore. */
export async function dispatchStripeEvent(client: SqlClient, stripe: Stripe, event: Stripe.Event): Promise<boolean> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const orgId = session.metadata?.orgId ?? session.client_reference_id ?? null;
      if (session.mode === "payment" && session.metadata?.purpose === "credit_topup") {
        const paymentIntentId = stripeId(session.payment_intent);
        if (session.payment_status !== "paid" || !orgId || !paymentIntentId) return true;
        await grantTopUp(client, {
          orgId,
          paymentIntentId,
          credits: numberMetadata(session.metadata?.credits, session.amount_subtotal ?? 0),
          source: "topup",
          extra: { checkoutSessionId: session.id },
        });
        await adoptDefaultPaymentMethod(stripe, stripeId(session.customer), paymentIntentId);
        return true;
      }
      if (session.mode === "subscription") {
        const subscriptionId = stripeId(session.subscription);
        if (!subscriptionId) return true;
        if (orgId) {
          await client`
            update organizations
            set stripe_subscription_id = ${subscriptionId},
                stripe_customer_id = coalesce(stripe_customer_id, ${stripeId(session.customer)}),
                updated_at = now()
            where id = ${orgId}
          `;
        }
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        await applySubscription(client, stripe, sub, orgId);
        return true;
      }
      return true;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      // Events can arrive out of order: always mirror the subscription's current state.
      const sub = await stripe.subscriptions.retrieve(event.data.object.id);
      if (sub.status === "canceled" || sub.status === "incomplete_expired") {
        await endSubscription(client, sub);
      } else {
        await applySubscription(client, stripe, sub);
      }
      return true;
    }

    case "customer.subscription.deleted": {
      await endSubscription(client, event.data.object);
      return true;
    }

    case "invoice.paid": {
      const invoice = event.data.object;
      const grant = subscriptionInvoiceGrant(invoice);
      if (!grant || !invoice.id) return true;
      const sub = await stripe.subscriptions.retrieve(grant.subscriptionId);
      const orgId = await applySubscription(client, stripe, sub);
      if (!orgId) return true;
      const plan = await planForInvoice(stripe, grant.purchasedPriceId, sub);
      if (!plan) {
        console.warn(`[billing] invoice ${invoice.id} subscription ${sub.id} has no DocSlurp plan price`);
        return true;
      }
      const credits = creditsForSubscriptionPayment(plan.id, grant.baseCents);
      const applied = await grantOrgCredits(client, {
        orgId,
        source: "subscription",
        externalId: invoice.id,
        pool: "included",
        credits,
        resetIncluded: grant.resetIncluded,
        metadata: {
          invoiceId: invoice.id,
          subscriptionId: sub.id,
          planId: plan.id,
          billingReason: invoice.billing_reason,
          amountPaidCents: grant.baseCents,
        },
      });
      await client`
        update organizations
        set past_due_since = null,
            worker_slots = case when subscription_status in ('active', 'trialing') then ${plan.workers}::int else worker_slots end,
            updated_at = now()
        where id = ${orgId}
      `;
      console.log(
        `[billing] ${applied ? "grant" : "duplicate-grant"} source=subscription orgId=${orgId} invoice=${invoice.id} credits=${credits} reset=${grant.resetIncluded}`,
      );
      return true;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const subscriptionId = subscriptionIdOfInvoice(invoice);
      if (!subscriptionId) return true;
      const org = await findOrg(client, stripeId(invoice.customer));
      if (!org) return true;
      await client`
        update organizations
        set subscription_status = 'past_due',
            past_due_since = coalesce(past_due_since, now()),
            updated_at = now()
        where id = ${org.id}
      `;
      console.warn(`[billing] invoice payment failed orgId=${org.id} invoice=${invoice.id}`);
      return true;
    }

    case "payment_intent.succeeded": {
      const intent = event.data.object;
      const orgId = intent.metadata?.orgId;
      if (!orgId) return true;
      if (intent.metadata?.purpose === "credit_topup") {
        await grantTopUp(client, {
          orgId,
          paymentIntentId: intent.id,
          credits: numberMetadata(intent.metadata?.credits, intent.amount),
          source: "topup",
        });
      } else if (intent.metadata?.purpose === "auto_recharge") {
        await grantTopUp(client, {
          orgId,
          paymentIntentId: intent.id,
          credits: numberMetadata(intent.metadata?.credits, intent.amount),
          source: "auto_recharge",
        });
        await recordAutoRechargeSuccess(client, orgId);
      }
      return true;
    }

    case "payment_intent.payment_failed": {
      const intent = event.data.object;
      if (intent.metadata?.purpose === "auto_recharge" && intent.metadata?.orgId) {
        await recordAutoRechargeFailure(client, {
          orgId: intent.metadata.orgId,
          ref: intent.id,
          reason: intent.last_payment_error?.code ?? "payment_failed",
          intentCreatedAt: intent.created ? new Date(intent.created * 1000) : null,
        });
      }
      return true;
    }

    case "charge.refunded": {
      const charge = event.data.object;
      await clawBack(client, stripe, {
        paymentIntentId: stripeId(charge.payment_intent),
        target: (credits) => refundTargetCredits(credits, charge.amount_refunded, charge.amount),
        reason: "clawback:refund",
        metadata: { chargeId: charge.id, amountRefundedCents: charge.amount_refunded },
      });
      return true;
    }

    case "charge.dispute.closed": {
      const dispute = event.data.object;
      if (dispute.status !== "lost") return true;
      let paymentIntentId = stripeId(dispute.payment_intent);
      if (!paymentIntentId) {
        const chargeId = stripeId(dispute.charge);
        if (chargeId) {
          const charge = await stripe.charges.retrieve(chargeId);
          paymentIntentId = stripeId(charge.payment_intent);
        }
      }
      await clawBack(client, stripe, {
        paymentIntentId,
        target: (credits) => credits,
        reason: "clawback:dispute",
        metadata: { disputeId: dispute.id, chargeId: stripeId(dispute.charge) },
      });
      return true;
    }

    case "billing.credit_grant.created":
    case "billing.credit_grant.updated": {
      await mirrorStripeCreditGrant(client, event.data.object);
      return true;
    }

    default:
      return false;
  }
}

/**
 * Apply an event exactly once: an advisory lock on the event id serializes
 * concurrent deliveries, and stripe_webhook_events (written in the same
 * transaction) makes redeliveries no-ops. Any error rolls back and returns
 * 500 so Stripe retries.
 */
export async function processStripeEvent(
  event: Stripe.Event,
  deps: { stripe: Stripe; db?: SqlClient },
): Promise<{ handled: boolean; event: string; duplicate?: boolean }> {
  const db = deps.db ?? sql;
  return db.begin(async (tx) => {
    const client = tx as unknown as SqlClient;
    await client`select pg_advisory_xact_lock(${STRIPE_WEBHOOK_LOCK_NAMESPACE}, hashtext(${event.id}))`;
    const [existing] = await client<{ event_id: string }[]>`
      select event_id from stripe_webhook_events where event_id = ${event.id} limit 1
    `;
    if (existing) {
      return { handled: true, event: event.type, duplicate: true };
    }
    const handled = await dispatchStripeEvent(client, deps.stripe, event);
    await client`
      insert into stripe_webhook_events (event_id, event_type, payload, created_at, processed_at)
      values (${event.id}, ${event.type}, ${JSON.stringify(event)}::text::jsonb, now(), now())
      on conflict (event_id) do nothing
    `;
    return { handled, event: event.type };
  }) as Promise<{ handled: boolean; event: string; duplicate?: boolean }>;
}

export async function handleStripeWebhookEvent(
  rawBody: string,
  signature: string,
): Promise<{ handled: boolean; event: string; duplicate?: boolean }> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret || !process.env.STRIPE_SECRET_KEY) {
    throw new StripeWebhookError("Stripe webhook is not configured", 500, false);
  }
  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    throw new StripeWebhookError("Invalid Stripe webhook signature", 400, true);
  }
  return processStripeEvent(event, { stripe });
}

/** Sweeper: past-due orgs past the grace period drop to the free worker ceiling. */
export async function enforcePastDueGrace(): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    update organizations
    set worker_slots = ${FREE_PLAN.workers}, updated_at = now()
    where past_due_since is not null
      and past_due_since < now() - make_interval(days => ${PAST_DUE_GRACE_DAYS})
      and worker_slots > ${FREE_PLAN.workers}
    returning id
  `;
  for (const row of rows) {
    console.warn(`[billing] past-due grace expired orgId=${row.id}; worker slots reduced to ${FREE_PLAN.workers}`);
  }
  return rows.length;
}

import type Stripe from "stripe";

import { sql, type SqlClient } from "../../db.js";
import { recordAutoRechargeFailure, recordAutoRechargeSuccess } from "./auto-recharge.js";
import { grantOrgCredits } from "./credits.js";
import { getStripe, stripeId } from "./stripe-client.js";

/**
 * Stripe webhooks for prepaid credits. DocSlurp sells no subscriptions: credits
 * come from one-off Checkout top-ups (packs or custom amounts), off-session auto
 * top-ups and Stripe Billing credit grants; refunds and lost disputes claw them
 * back. Subscription and invoice events are ignored.
 */
const STRIPE_WEBHOOK_LOCK_NAMESPACE = 90_102;

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

/** Cumulative credits to claw back for a (possibly partial) refund of a charge. */
export function refundTargetCredits(grantCredits: number, amountRefunded: number, amountCharged: number): number {
  if (!(amountCharged > 0) || !(amountRefunded > 0)) return 0;
  const fraction = Math.min(1, amountRefunded / amountCharged);
  return Math.round(grantCredits * fraction * 1e6) / 1e6;
}

function numberMetadata(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Event processing
// ---------------------------------------------------------------------------

type OrgRef = { id: string };

async function findOrg(
  client: SqlClient,
  customerId: string | null,
  fallbackOrgId?: string | null,
): Promise<OrgRef | null> {
  if (customerId) {
    const [row] = await client<OrgRef[]>`
      select id from organizations where stripe_customer_id = ${customerId} limit 1
    `;
    if (row) return row;
  }
  if (fallbackOrgId) {
    const [row] = await client<OrgRef[]>`
      select id from organizations where id = ${fallbackOrgId} limit 1
    `;
    if (row) return row;
  }
  return null;
}

async function grantTopUp(
  client: SqlClient,
  args: { orgId: string; paymentIntentId: string; credits: number; source: "topup" | "auto_recharge"; extra?: Record<string, unknown> },
): Promise<void> {
  const applied = await grantOrgCredits(client, {
    orgId: args.orgId,
    source: args.source,
    externalId: args.paymentIntentId,
    credits: args.credits,
    metadata: { paymentIntentId: args.paymentIntentId, amountCents: args.credits, ...args.extra },
  });
  console.log(
    `[billing] ${applied ? "grant" : "duplicate-grant"} source=${args.source} orgId=${args.orgId} credits=${args.credits} paymentIntentId=${args.paymentIntentId}`,
  );
}

/** Save the card from a top-up Checkout as the default when the customer has none (auto top-up reuses it). */
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

/** The grant a charge paid for: a top-up or auto top-up, by PaymentIntent. */
async function findGrantForPaymentIntent(client: SqlClient, paymentIntentId: string): Promise<GrantRow | null> {
  const [direct] = await client<GrantRow[]>`
    select id, credits from credit_grants
    where (source in ('topup', 'auto_recharge') and external_id = ${paymentIntentId})
       or (metadata ? 'paymentIntentId' and metadata ->> 'paymentIntentId' = ${paymentIntentId})
    limit 1
  `;
  return direct ?? null;
}

async function clawBack(
  client: SqlClient,
  args: { paymentIntentId: string | null; target: (grantCredits: number) => number; reason: string; metadata: Record<string, unknown> },
): Promise<void> {
  if (!args.paymentIntentId) return;
  const grant = await findGrantForPaymentIntent(client, args.paymentIntentId);
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
      await clawBack(client, {
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
      await clawBack(client, {
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

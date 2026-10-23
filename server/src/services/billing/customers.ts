import type Stripe from "stripe";

import { sql } from "../../db.js";

import { getOrgBillingRow } from "./credits.js";
import { BillingRequestError, getStripe, stripeId } from "./stripe-client.js";

type ReservedConnection = Awaited<ReturnType<typeof sql.reserve>>;

const STRIPE_CUSTOMER_LOCK_NAMESPACE = 90_101;

function isMissingResource(error: unknown): boolean {
  return (error as { code?: string; statusCode?: number })?.code === "resource_missing";
}

/**
 * The stored customer if it still exists in this Stripe account. A customer
 * deleted in the Dashboard, or an id from another account/mode (keys
 * switched), would otherwise break every checkout for the org.
 */
async function liveCustomerId(stripe: ReturnType<typeof getStripe>, customerId: string): Promise<string | null> {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return customer.deleted ? null : customer.id;
  } catch (error) {
    if (isMissingResource(error)) return null;
    throw error;
  }
}

/**
 * One Stripe Customer per org, created under an advisory lock so concurrent
 * requests cannot fork it. A stored customer that no longer exists is
 * replaced (callers are user-initiated billing flows, so the extra retrieve is cheap).
 */
export async function ensureStripeCustomer(orgId: string, connection?: ReservedConnection): Promise<string> {
  const stripe = getStripe();
  const reserved = connection ?? await sql.reserve();
  let lockAcquired = false;

  try {
    await reserved`
      select pg_advisory_lock(${STRIPE_CUSTOMER_LOCK_NAMESPACE}, hashtext(${orgId}))
    `;
    lockAcquired = true;

    const [lockedOrg] = await reserved<{ id: string; name: string; stripe_customer_id: string | null }[]>`
      select id, name, stripe_customer_id
      from organizations
      where id = ${orgId}
      limit 1
    `;
    if (!lockedOrg) {
      throw new Error("Organization not found");
    }
    const stale = lockedOrg.stripe_customer_id;
    if (stale) {
      if (await liveCustomerId(stripe, stale)) {
        return stale;
      }
      console.warn(`[billing] stripe customer ${stale} for orgId=${orgId} no longer exists; creating a new one`);
    }

    const customer = await stripe.customers.create(
      { name: lockedOrg.name, metadata: { orgId } },
      // A replacement needs its own key: the original one would replay the deleted customer.
      { idempotencyKey: stale ? `customer:${orgId}:replaces:${stale}` : `customer:${orgId}` },
    );

    await reserved`
      update organizations
      set stripe_customer_id = ${customer.id}, updated_at = now()
      where id = ${orgId}
    `;
    return customer.id;
  } finally {
    try {
      if (lockAcquired) {
        await reserved`
          select pg_advisory_unlock(${STRIPE_CUSTOMER_LOCK_NAMESPACE}, hashtext(${orgId}))
        `;
      }
    } finally {
      if (!connection) reserved.release();
    }
  }
}

/** The card auto-recharge would charge: the invoice default, else the newest saved card. */
export async function getDefaultPaymentMethodId(customerId: string, stripe: Stripe = getStripe()): Promise<string | null> {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) {
    return null;
  }
  const preferred = stripeId(customer.invoice_settings?.default_payment_method ?? null);
  if (preferred) {
    return preferred;
  }
  const methods = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
  return methods.data[0]?.id ?? null;
}

export async function orgHasPaymentMethod(orgId: string): Promise<boolean> {
  const org = await getOrgBillingRow(orgId);
  if (!org?.stripe_customer_id) {
    return false;
  }
  return Boolean(await getDefaultPaymentMethodId(org.stripe_customer_id));
}

export async function listInvoices(orgId: string): Promise<Stripe.Invoice[]> {
  const org = await getOrgBillingRow(orgId);
  if (!org?.stripe_customer_id) {
    return [];
  }
  const list = await getStripe().invoices.list({ customer: org.stripe_customer_id, limit: 24 });
  return list.data;
}

export async function listPaymentMethods(orgId: string): Promise<Stripe.PaymentMethod[]> {
  const org = await getOrgBillingRow(orgId);
  if (!org?.stripe_customer_id) {
    return [];
  }
  const list = await getStripe().paymentMethods.list({ customer: org.stripe_customer_id, type: "card" });
  return list.data;
}

export async function createSetupIntent(args: {
  orgId: string;
  idempotencyKey?: string;
}): Promise<{ clientSecret: string; setupIntentId: string }> {
  const stripe = getStripe();
  const customerId = await ensureStripeCustomer(args.orgId);
  const intent = await stripe.setupIntents.create(
    {
      customer: customerId,
      usage: "off_session",
      automatic_payment_methods: { enabled: true },
      metadata: { orgId: args.orgId, purpose: "default_payment_method" },
    },
    args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : undefined,
  );
  if (!intent.client_secret) {
    throw new Error("Failed to create setup intent");
  }
  return { clientSecret: intent.client_secret, setupIntentId: intent.id };
}

export async function attachPaymentMethod(args: {
  orgId: string;
  paymentMethodId: string;
}): Promise<Stripe.PaymentMethod> {
  const stripe = getStripe();
  const customerId = await ensureStripeCustomer(args.orgId);
  const existing = await stripe.paymentMethods.retrieve(args.paymentMethodId);
  let pm: Stripe.PaymentMethod;
  if (!existing.customer) {
    pm = await stripe.paymentMethods.attach(args.paymentMethodId, { customer: customerId });
  } else if (stripeId(existing.customer) === customerId) {
    pm = existing;
  } else {
    throw new BillingRequestError("Payment method is already attached to another customer");
  }
  // Use the id Stripe returns: attaching can yield a different object than the
  // one passed in (e.g. test tokens such as pm_card_visa are cloned on attach).
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: pm.id },
  });
  return pm;
}

export async function detachPaymentMethod(args: {
  orgId: string;
  paymentMethodId: string;
}): Promise<void> {
  const org = await getOrgBillingRow(args.orgId);
  if (!org?.stripe_customer_id) {
    throw new BillingRequestError("No Stripe customer found for this organization");
  }
  const stripe = getStripe();
  const pm = await stripe.paymentMethods.retrieve(args.paymentMethodId);
  if (stripeId(pm.customer) !== org.stripe_customer_id) {
    throw new BillingRequestError("Payment method does not belong to this organization");
  }
  await stripe.paymentMethods.detach(args.paymentMethodId);
}

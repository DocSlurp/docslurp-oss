import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS, getPlan, type PaidPlanId } from "@docslurp/shared";

import { getOrgBillingRow } from "./credits.js";
import { ensureStripeCustomer } from "./customers.js";
import {
  BillingRequestError,
  appUrl,
  automaticTaxEnabled,
  getStripe,
  resolvePlanPriceId,
  resolvePortalConfigurationId,
  windowedIdempotencyKey,
} from "./stripe-client.js";

/** Subscription statuses that already hold a live Stripe subscription; plan changes go through the Portal. */
const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "paused", "incomplete"]);

export function billingPageUrl(query?: string): string {
  return `${appUrl()}/app/billing${query ? `?${query}` : ""}`;
}

export async function createPortalSession(args: { orgId: string; returnUrl?: string }): Promise<{ url: string }> {
  const stripe = getStripe();
  const [customerId, configuration] = await Promise.all([
    ensureStripeCustomer(args.orgId),
    resolvePortalConfigurationId(stripe),
  ]);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: args.returnUrl ?? billingPageUrl(),
    ...(configuration ? { configuration } : {}),
  });
  return { url: session.url };
}

/**
 * Subscribe to a paid plan via Stripe Checkout (price resolved by lookup key).
 * An org that already has a live subscription gets a Customer Portal URL
 * instead: upgrades, downgrades and cancellation are Portal flows so Stripe
 * owns proration and period-end scheduling.
 */
export async function createPlanCheckout(args: {
  orgId: string;
  planId: PaidPlanId;
  idempotencyKey?: string;
}): Promise<{ url: string; kind: "checkout" | "portal" }> {
  const stripe = getStripe();
  const org = await getOrgBillingRow(args.orgId);
  if (!org) {
    throw new BillingRequestError("Organization not found", "org_not_found");
  }
  if (org.stripe_subscription_id && LIVE_SUBSCRIPTION_STATUSES.has(org.subscription_status)) {
    const portal = await createPortalSession({ orgId: args.orgId });
    return { url: portal.url, kind: "portal" };
  }

  const plan = getPlan(args.planId);
  const [customerId, priceId] = await Promise.all([
    ensureStripeCustomer(args.orgId),
    resolvePlanPriceId(stripe, args.planId),
  ]);
  const taxEnabled = automaticTaxEnabled();
  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      customer: customerId,
      client_reference_id: args.orgId,
      line_items: [{ price: priceId, quantity: 1 }],
      automatic_tax: { enabled: taxEnabled },
      tax_id_collection: { enabled: true },
      billing_address_collection: "required",
      customer_update: { address: "auto", name: "auto" },
      subscription_data: { metadata: { orgId: args.orgId, planId: plan.id } },
      metadata: { orgId: args.orgId, planId: plan.id, purpose: "subscription" },
      success_url: billingPageUrl("checkout=success"),
      cancel_url: billingPageUrl("checkout=canceled"),
    },
    {
      idempotencyKey:
        args.idempotencyKey ?? windowedIdempotencyKey(["plan-checkout", args.orgId, plan.id, priceId], 10 * 60_000),
    },
  );
  if (!session.url) {
    throw new Error("Stripe did not return a Checkout URL");
  }
  return { url: session.url, kind: "checkout" };
}

/**
 * Buy prepaid credits via Checkout (1 credit per cent, before tax). The card
 * is saved for off-session use so auto-recharge can reuse it.
 */
export async function createTopUpCheckout(args: {
  orgId: string;
  amountCents: number;
  idempotencyKey?: string;
}): Promise<{ url: string }> {
  if (!Number.isInteger(args.amountCents) || args.amountCents < MIN_TOPUP_CENTS || args.amountCents > MAX_TOPUP_CENTS) {
    throw new BillingRequestError(
      `Top-ups must be between $${(MIN_TOPUP_CENTS / 100).toFixed(2)} and $${(MAX_TOPUP_CENTS / 100).toFixed(2)}`,
      "topup_amount_invalid",
    );
  }
  const stripe = getStripe();
  const customerId = await ensureStripeCustomer(args.orgId);
  const credits = String(args.amountCents);
  const metadata = { orgId: args.orgId, purpose: "credit_topup", credits };
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      customer: customerId,
      client_reference_id: args.orgId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: args.amountCents,
            tax_behavior: "exclusive",
            product_data: {
              name: "DocSlurp credits",
              description: `${args.amountCents.toLocaleString("en-US")} prepaid credits (1 credit = $0.01)`,
            },
          },
        },
      ],
      automatic_tax: { enabled: automaticTaxEnabled() },
      billing_address_collection: "required",
      customer_update: { address: "auto", name: "auto" },
      payment_intent_data: { setup_future_usage: "off_session", metadata },
      metadata,
      success_url: billingPageUrl("topup=success"),
      cancel_url: billingPageUrl("topup=canceled"),
    },
    {
      idempotencyKey:
        args.idempotencyKey ?? windowedIdempotencyKey(["topup-checkout", args.orgId, args.amountCents], 10 * 60_000),
    },
  );
  if (!session.url) {
    throw new Error("Stripe did not return a Checkout URL");
  }
  return { url: session.url };
}

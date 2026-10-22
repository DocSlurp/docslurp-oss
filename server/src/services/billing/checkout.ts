import { CREDIT_PACK_CENTS, MAX_TOPUP_CENTS, MIN_TOPUP_CENTS } from "@docslurp/shared";

import { ensureStripeCustomer } from "./customers.js";
import {
  BillingRequestError,
  appUrl,
  automaticTaxEnabled,
  getStripe,
  resolvePortalConfigurationId,
  windowedIdempotencyKey,
} from "./stripe-client.js";

export function billingPageUrl(query?: string): string {
  return `${appUrl()}/app/billing${query ? `?${query}` : ""}`;
}

/** Stripe Customer Portal for invoices and saved payment methods (no plans to manage). */
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
 * Buy prepaid credits via one-off Checkout (`mode: "payment"`, 1 credit per
 * cent, before tax): a pack (CREDIT_PACK_CENTS) or a custom amount between
 * MIN_TOPUP_CENTS and MAX_TOPUP_CENTS. Credits do not expire. The card is
 * saved for off-session use so auto top-up (off by default) can reuse it;
 * Stripe emails the receipt.
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
  const pack = (CREDIT_PACK_CENTS as readonly number[]).includes(args.amountCents);
  const metadata = { orgId: args.orgId, purpose: "credit_topup", credits, pack: pack ? "true" : "false" };
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

import Stripe from "stripe";

import { getPlan, type PaidPlanId } from "@docslurp/shared";

/** Thrown by Stripe-dependent operations when STRIPE_SECRET_KEY is unset. Routes map it to 503. */
export class BillingNotConfiguredError extends Error {
  constructor() {
    super("billing_not_configured");
    this.name = "BillingNotConfiguredError";
  }
}

/** A billing request the caller can fix (bad plan, missing payment method...). Routes map it to 400. */
export class BillingRequestError extends Error {
  constructor(
    message: string,
    readonly code: string = "billing_request_invalid",
  ) {
    super(message);
    this.name = "BillingRequestError";
  }
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

let cached: { key: string; client: Stripe } | null = null;

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    throw new BillingNotConfiguredError();
  }
  if (cached?.key !== key) {
    cached = { key, client: new Stripe(key, { apiVersion: "2026-08-26.dahlia" }) };
  }
  return cached.client;
}

/** Stripe Tax needs an origin address in the dashboard; local test accounts can opt out. */
export function automaticTaxEnabled(): boolean {
  return process.env.STRIPE_AUTOMATIC_TAX?.trim().toLowerCase() !== "false";
}

export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:4321").replace(/\/+$/, "");
}

const PRICE_CACHE_TTL_MS = 5 * 60_000;
const priceCache = new Map<string, { priceId: string; expiresAt: number }>();

/** Resolve a plan's Stripe Price by lookup key (synced by the plan sync script). */
export async function resolvePlanPriceId(stripe: Stripe, planId: PaidPlanId): Promise<string> {
  const plan = getPlan(planId);
  if (!plan.stripeLookupKey) {
    throw new BillingRequestError(`Plan ${planId} is not sold through Stripe`, "plan_not_purchasable");
  }
  const hit = priceCache.get(plan.stripeLookupKey);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.priceId;
  }
  const prices = await stripe.prices.list({ lookup_keys: [plan.stripeLookupKey], active: true, limit: 1 });
  const price = prices.data[0];
  if (!price) {
    throw new BillingRequestError(
      `No active Stripe price with lookup key ${plan.stripeLookupKey}; run the plan sync script`,
      "plan_price_missing",
    );
  }
  priceCache.set(plan.stripeLookupKey, { priceId: price.id, expiresAt: Date.now() + PRICE_CACHE_TTL_MS });
  return price.id;
}

/** Metadata tag the plan sync script puts on the Customer Portal configuration it manages. */
export const PORTAL_CONFIGURATION_METADATA_KEY = "docslurp_portal";
let portalConfigCache: { id: string | null; expiresAt: number } | null = null;

/**
 * The Customer Portal configuration for portal sessions: STRIPE_PORTAL_CONFIGURATION_ID,
 * else the active configuration tagged by the sync script. The account's
 * "default" configuration cannot be set through the API, so sessions name it
 * explicitly; null falls back to the Dashboard default.
 */
export async function resolvePortalConfigurationId(stripe: Stripe): Promise<string | null> {
  const fromEnv = process.env.STRIPE_PORTAL_CONFIGURATION_ID?.trim();
  if (fromEnv) return fromEnv;
  if (portalConfigCache && portalConfigCache.expiresAt > Date.now()) {
    return portalConfigCache.id;
  }
  let id: string | null = null;
  for await (const config of stripe.billingPortal.configurations.list({ active: true, limit: 100 })) {
    if (config.metadata?.[PORTAL_CONFIGURATION_METADATA_KEY]) {
      id = config.id;
      break;
    }
  }
  if (!id) {
    console.warn("[billing] no Customer Portal configuration tagged docslurp_portal; run the plan sync script");
  }
  portalConfigCache = { id, expiresAt: Date.now() + PRICE_CACHE_TTL_MS };
  return id;
}

/** Stable key for a short window, so double-clicks reuse one Stripe object but later retries do not. */
export function windowedIdempotencyKey(parts: Array<string | number>, windowMs: number, now = Date.now()): string {
  return [...parts, Math.floor(now / windowMs)].join(":");
}

export function stripeId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

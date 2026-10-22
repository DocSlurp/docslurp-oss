import type Stripe from "stripe";

import { autoTopUpSettingsSchema, resolveChatCreditReserveConfig, type AutoTopUpSettings } from "@docslurp/shared";
import { sql, type SqlClient } from "../../db.js";
import { getOrgBillingRow, grantOrgCredits } from "./credits.js";
import { getDefaultPaymentMethodId } from "./customers.js";
import { autoTopUpFromRow } from "./overview.js";
import { BillingRequestError, getStripe, isStripeConfigured, stripeId } from "./stripe-client.js";

/**
 * Auto top-up (stored as auto_recharge_* columns): off by default. The user
 * sets a threshold in credits, a refill amount (a pack or a custom amount within
 * the top-up limits) and a required monthly cap. Every charge is a Stripe
 * PaymentIntent with an emailed receipt and a `grant:auto_recharge` ledger row.
 */

/** Never more than one attempt per org in this window; also the PaymentIntent idempotency window. */
export const AUTO_RECHARGE_MIN_INTERVAL_MS = 10 * 60_000;
/** Auto top-up pauses after this many consecutive failures until the user re-saves settings. */
export const AUTO_RECHARGE_MAX_CONSECUTIVE_FAILURES = 2;

export async function getAutoRechargeSettings(orgId: string): Promise<AutoTopUpSettings | null> {
  const org = await getOrgBillingRow(orgId);
  return org ? autoTopUpFromRow(org) : null;
}

/**
 * Save auto top-up settings. Enabling records who authorized off-session
 * charges and when (design gotcha 14), requires a saved payment method, and
 * clears the failure counter so a paused recharge can resume.
 */
export async function updateAutoRechargeSettings(args: {
  orgId: string;
  userId: string;
  settings: AutoTopUpSettings;
}): Promise<AutoTopUpSettings> {
  const settings = autoTopUpSettingsSchema.parse(args.settings);
  const org = await getOrgBillingRow(args.orgId);
  if (!org) {
    throw new BillingRequestError("Organization not found", "org_not_found");
  }

  if (settings.enabled) {
    if (!isStripeConfigured()) {
      throw new BillingRequestError("Billing is not configured", "billing_not_configured");
    }
    const paymentMethod = org.stripe_customer_id ? await getDefaultPaymentMethodId(org.stripe_customer_id) : null;
    if (!paymentMethod) {
      throw new BillingRequestError(
        "Add a payment method before turning on auto top-up",
        "payment_method_required",
      );
    }
  }

  const [row] = await sql<
    { enabled: boolean; threshold: number; amount: number; monthly_limit: number }[]
  >`
    update organizations
    set
      auto_recharge_enabled = ${settings.enabled},
      auto_recharge_threshold_credits = ${settings.thresholdCredits},
      auto_recharge_amount_cents = ${settings.amountCents},
      auto_recharge_monthly_limit_cents = ${settings.monthlyLimitCents},
      auto_recharge_authorized_at = case when ${settings.enabled} then now() else auto_recharge_authorized_at end,
      auto_recharge_authorized_by_user_id = case when ${settings.enabled} then ${args.userId} else auto_recharge_authorized_by_user_id end,
      auto_recharge_consecutive_failures = case when ${settings.enabled} then 0 else auto_recharge_consecutive_failures end,
      auto_recharge_last_failure_ref = case when ${settings.enabled} then null else auto_recharge_last_failure_ref end,
      updated_at = now()
    where id = ${args.orgId}
    returning
      auto_recharge_enabled as enabled,
      auto_recharge_threshold_credits as threshold,
      auto_recharge_amount_cents as amount,
      auto_recharge_monthly_limit_cents as monthly_limit
  `;
  if (!row) {
    throw new BillingRequestError("Organization not found", "org_not_found");
  }
  return {
    enabled: row.enabled,
    thresholdCredits: Number(row.threshold),
    amountCents: Number(row.amount),
    monthlyLimitCents: Number(row.monthly_limit),
  };
}

/** Clock skew allowed between Stripe's PaymentIntent `created` and our attempt stamp (attempts are ≥10 min apart). */
const ATTEMPT_MATCH_SKEW_SECONDS = 5 * 60;

/**
 * Count one failed attempt, once per reference (PaymentIntent id or attempt key).
 * Webhooks pass the PaymentIntent's creation time: a failure only counts when
 * it belongs to the latest attempt, so a late or retried webhook for an older
 * PaymentIntent (already counted by the sweeper) cannot count twice.
 */
export async function recordAutoRechargeFailure(
  client: SqlClient,
  args: { orgId: string; ref: string; reason: string; intentCreatedAt?: Date | null },
): Promise<void> {
  const createdAt = args.intentCreatedAt ?? null;
  const rows = await client<{ failures: number }[]>`
    update organizations
    set
      auto_recharge_consecutive_failures = auto_recharge_consecutive_failures + 1,
      auto_recharge_last_failure_ref = ${args.ref},
      updated_at = now()
    where id = ${args.orgId}
      and auto_recharge_last_failure_ref is distinct from ${args.ref}
      and (
        ${createdAt}::timestamptz is null
        or auto_recharge_last_attempt_at is null
        or ${createdAt}::timestamptz >= auto_recharge_last_attempt_at - make_interval(secs => ${ATTEMPT_MATCH_SKEW_SECONDS})
      )
    returning auto_recharge_consecutive_failures as failures
  `;
  if (rows[0]) {
    console.warn(
      `[billing] auto-recharge failed orgId=${args.orgId} ref=${args.ref} failures=${rows[0].failures} reason=${args.reason}`,
    );
  }
}

export async function recordAutoRechargeSuccess(client: SqlClient, orgId: string): Promise<void> {
  await client`
    update organizations
    set auto_recharge_consecutive_failures = 0, auto_recharge_last_failure_ref = null, updated_at = now()
    where id = ${orgId}
  `;
}

type DueOrg = {
  id: string;
  stripe_customer_id: string;
  amount_cents: number;
  monthly_limit_cents: number;
  recharged_this_month: number;
};

/**
 * Sweep: charge the saved card of every org whose available credits fell
 * below its threshold. Each org is claimed by stamping last_attempt_at in the
 * same UPDATE that checks the 10-minute spacing, so concurrent API instances
 * cannot double-charge; the PaymentIntent idempotency key is per org and
 * window as a second fence. Respects the monthly ceiling and pauses after two
 * consecutive failures.
 */
export async function runAutoRecharge(options: { stripe?: Stripe; now?: Date } = {}): Promise<{ attempted: number; succeeded: number }> {
  if (!isStripeConfigured()) {
    return { attempted: 0, succeeded: 0 };
  }
  const stripe = options.stripe ?? getStripe();
  const now = options.now ?? new Date();
  const intervalSeconds = AUTO_RECHARGE_MIN_INTERVAL_MS / 1000;
  const reserve = resolveChatCreditReserveConfig();

  const due = await sql<DueOrg[]>`
    with candidates as (
      select o.id
      from organizations o
      where o.auto_recharge_enabled
        and o.stripe_customer_id is not null
        and o.auto_recharge_consecutive_failures < ${AUTO_RECHARGE_MAX_CONSECUTIVE_FAILURES}
        and o.auto_recharge_amount_cents is not null
        and o.auto_recharge_threshold_credits is not null
        -- Same available figure as admission: balance minus pending debits.
        -- Also top up once jobs reach the chat reserve (they stop there),
        -- even when the threshold is set below it.
        and o.credit_balance_cents - pending_org_debit_credits(o.id)
          < greatest(
            o.auto_recharge_threshold_credits,
            case when o.funded_at is null then ${reserve.starterReserveCredits}::numeric else ${reserve.fundedReserveCredits}::numeric end
          )
        and (o.auto_recharge_last_attempt_at is null
          or o.auto_recharge_last_attempt_at < ${now}::timestamptz - make_interval(secs => ${intervalSeconds}))
      order by o.auto_recharge_last_attempt_at nulls first
      limit 25
      for update skip locked
    )
    update organizations o
    set auto_recharge_last_attempt_at = ${now}, updated_at = now()
    from candidates
    where o.id = candidates.id
    returning
      o.id,
      o.stripe_customer_id,
      o.auto_recharge_amount_cents as amount_cents,
      coalesce(o.auto_recharge_monthly_limit_cents, o.auto_recharge_amount_cents) as monthly_limit_cents,
      (
        select coalesce(sum(g.credits), 0)::double precision
        from credit_grants g
        where g.org_id = o.id
          and g.source = 'auto_recharge'
          and g.created_at >= date_trunc('month', ${now}::timestamptz)
      ) as recharged_this_month
  `;

  let succeeded = 0;
  for (const org of due) {
    const ok = await rechargeOrg(stripe, org, now).catch((error: unknown) => {
      console.error(`[billing] auto-recharge orgId=${org.id} error=${error instanceof Error ? error.message : String(error)}`);
      return false;
    });
    if (ok) succeeded += 1;
  }
  return { attempted: due.length, succeeded };
}

async function rechargeOrg(stripe: Stripe, org: DueOrg, now: Date): Promise<boolean> {
  const amount = Number(org.amount_cents);
  if (Number(org.recharged_this_month) + amount > Number(org.monthly_limit_cents)) {
    console.log(
      `[billing] auto-recharge skipped orgId=${org.id} reason=monthly_limit rechargedThisMonth=${org.recharged_this_month} limit=${org.monthly_limit_cents}`,
    );
    return false;
  }

  const window = Math.floor(now.getTime() / AUTO_RECHARGE_MIN_INTERVAL_MS);
  const attemptRef = `auto-recharge:${org.id}:${window}`;
  const paymentMethod = await getDefaultPaymentMethodId(org.stripe_customer_id, stripe);
  if (!paymentMethod) {
    await recordAutoRechargeFailure(sql, { orgId: org.id, ref: attemptRef, reason: "no_payment_method" });
    return false;
  }

  // Every auto top-up emails a receipt to the billing contact on the Stripe customer.
  const receiptEmail = await stripe.customers.retrieve(org.stripe_customer_id)
    .then((customer) => ("deleted" in customer && customer.deleted ? null : customer.email ?? null))
    .catch(() => null);

  let intent: Stripe.PaymentIntent;
  try {
    intent = await stripe.paymentIntents.create(
      {
        amount,
        currency: "usd",
        customer: org.stripe_customer_id,
        payment_method: paymentMethod,
        off_session: true,
        confirm: true,
        description: "DocSlurp credits (auto top-up)",
        ...(receiptEmail ? { receipt_email: receiptEmail } : {}),
        metadata: { orgId: org.id, purpose: "auto_recharge", credits: String(amount) },
      },
      { idempotencyKey: attemptRef },
    );
  } catch (error) {
    const failedIntent = (error as { payment_intent?: { id?: string } | string }).payment_intent;
    const ref = stripeId(failedIntent as string | { id: string } | null | undefined) ?? attemptRef;
    await recordAutoRechargeFailure(sql, {
      orgId: org.id,
      ref,
      reason: (error as { code?: string }).code ?? (error instanceof Error ? error.message : "stripe_error"),
    });
    return false;
  }

  if (intent.status === "succeeded") {
    await sql.begin(async (tx) => {
      const client = tx as unknown as SqlClient;
      await grantOrgCredits(client, {
        orgId: org.id,
        source: "auto_recharge",
        externalId: intent.id,
        credits: amount,
        metadata: { paymentIntentId: intent.id, amountCents: amount },
      });
      await recordAutoRechargeSuccess(client, org.id);
    });
    console.log(`[billing] auto-recharge orgId=${org.id} amountCents=${amount} paymentIntentId=${intent.id}`);
    return true;
  }
  if (intent.status === "processing") {
    // payment_intent.succeeded grants the credits when the charge settles.
    return true;
  }
  // requires_action / requires_payment_method: an off-session charge cannot finish.
  await recordAutoRechargeFailure(sql, { orgId: org.id, ref: intent.id, reason: intent.status });
  return false;
}

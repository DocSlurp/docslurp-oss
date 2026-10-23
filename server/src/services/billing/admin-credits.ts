import { sql, type SqlClient } from "../../db.js";
import { appendAuditLog } from "../audit-log.js";
import { ensureStripeCustomer } from "./customers.js";
import { BillingRequestError, getStripe } from "./stripe-client.js";
import { mirrorStripeCreditGrant } from "./webhooks.js";

export interface AdminCreditRequest {
  requestId: string;
  orgId: string;
  amountCents: number;
  reason: string;
}
interface Receipt {
  request_id: string;
  org_id: string;
  actor_user_id: string;
  amount_cents: number;
  reason: string;
  stripe_customer_id: string;
  stripe_grant_id: string | null;
  completed_at: Date | null;
  created_at: Date;
}

export async function issueAdminCredit(input: AdminCreditRequest, actorUserId: string) {
  const stripe = getStripe();
  const reserved = await sql.reserve();
  const client = reserved as unknown as SqlClient;
  let locked = false;
  try {
    // Session lock spans the remote call; the receipt is committed before it.
    await reserved`select pg_advisory_lock(90103, hashtext(${input.requestId}))`;
    locked = true;
    let [receipt] = await reserved<Receipt[]>`select * from admin_credit_requests where request_id = ${input.requestId}`;
    const fresh = !receipt;
    if (!receipt) {
      const [org] = await reserved`select id from organizations where id = ${input.orgId}`;
      if (!org) throw new BillingRequestError("Organization not found", "organization_not_found");
      const customerId = await ensureStripeCustomer(input.orgId, reserved);
      [receipt] = await reserved<Receipt[]>`
        insert into admin_credit_requests (request_id, org_id, actor_user_id, amount_cents, reason, stripe_customer_id)
        values (${input.requestId}, ${input.orgId}, ${actorUserId}, ${input.amountCents}, ${input.reason}, ${customerId})
        returning *`;
    }
    if (!receipt) throw new Error("Credit request receipt was not persisted");
    if (receipt.org_id !== input.orgId || receipt.amount_cents !== input.amountCents || receipt.reason !== input.reason || receipt.actor_user_id !== actorUserId) {
      throw new BillingRequestError("Request ID already belongs to a different credit request", "idempotency_conflict");
    }
    if (receipt.completed_at) return { requestId: input.requestId, stripeGrantId: receipt.stripe_grant_id, completed: true };
    if (!receipt.stripe_grant_id && !fresh && Date.now() - new Date(receipt.created_at).getTime() > 20 * 60 * 60 * 1000) {
      // Stripe may prune keys after 24h. Never guess whether an old timeout created a grant.
      throw new BillingRequestError("Uncertain old request: reconcile its requestId in Stripe before retrying", "credit_reconciliation_required");
    }
    await appendAuditLog({ orgId: input.orgId, userId: actorUserId, action: "billing.admin_credit.requested", resourceType: "organization", resourceId: input.orgId, metadata: { creditRequestId: input.requestId, orgId: input.orgId, amountCents: input.amountCents, reason: input.reason } }, client);
    const grant = receipt.stripe_grant_id
      ? await stripe.billing.creditGrants.retrieve(receipt.stripe_grant_id)
      : await stripe.billing.creditGrants.create({
          customer: receipt.stripe_customer_id,
          amount: { type: "monetary", monetary: { currency: "usd", value: input.amountCents } },
          applicability_config: { scope: { price_type: "metered" } },
          category: "promotional",
          name: "DocSlurp administrator credit",
          metadata: { orgId: input.orgId, requestId: input.requestId, actorUserId, reason: input.reason },
        }, { idempotencyKey: `admin-credit:${input.requestId}` });
    // Persist the remote ID before mirroring. A webhook racing this is harmless.
    await reserved`update admin_credit_requests set stripe_grant_id = ${grant.id} where request_id = ${input.requestId}`;
    const [owner] = await reserved`select id from organizations where id = ${input.orgId} and stripe_customer_id = ${receipt.stripe_customer_id}`;
    if (!owner || grant.voided_at) {
      throw new BillingRequestError("Grant requires reconciliation: customer ownership changed or grant was voided", "credit_reconciliation_required");
    }
    const outcome = await mirrorStripeCreditGrant(client, grant);
    if (outcome === "voided") throw new BillingRequestError("Stripe grant was voided; reconcile this request", "credit_reconciliation_required");
    await appendAuditLog({ orgId: input.orgId, userId: actorUserId, action: "billing.admin_credit.completed", resourceType: "organization", resourceId: input.orgId, metadata: { creditRequestId: input.requestId, orgId: input.orgId, amountCents: input.amountCents, reason: input.reason, stripeGrantId: grant.id } }, client);
    await reserved`update admin_credit_requests set completed_at = now() where request_id = ${input.requestId}`;
    return { requestId: input.requestId, stripeGrantId: grant.id, completed: true };
  } finally {
    try { if (locked) await reserved`select pg_advisory_unlock(90103, hashtext(${input.requestId}))`; }
    finally { reserved.release(); }
  }
}

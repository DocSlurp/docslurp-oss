import { Hono } from "hono";
import { z } from "zod";
import { sql } from "../db.js";
import { getRequestActor } from "../lib/request-actor.js";
import { apiStatusError } from "../lib/api-error.js";
import { issueAdminCredit } from "../services/billing/admin-credits.js";
import { BillingNotConfiguredError, BillingRequestError } from "../services/billing/stripe-client.js";

export const adminCreditSchema = z.object({
  requestId: z.string().uuid().transform(value => value.toLowerCase()),
  orgId: z.string().min(1).max(200),
  amountCents: z.number().int().min(1).max(10000),
  reason: z.string().trim().min(3).max(500),
}).strict();

export const adminBillingRoutes = new Hono();
adminBillingRoutes.use("*", async (c, next) => {
  const actor = getRequestActor(c);
  if (actor.type !== "session" || actor.user.isAdmin !== true) return apiStatusError(c, 403, "Platform administrator required");
  c.header("Cache-Control", "private, no-store");
  await next();
});

adminBillingRoutes.get("/organizations", async (c) => {
  const query = (c.req.query("q") ?? "").trim().slice(0, 200);
  const organizations = await sql`
    select o.id, o.name, u.email as owner_email, o.credit_balance_cents as balance_cents,
      o.stripe_customer_id
    from organizations o join "user" u on u.id = o.created_by_user_id
    where ${query} = '' or o.name ilike ${"%" + query + "%"} or u.email ilike ${"%" + query + "%"} or o.id = ${query}
    order by o.created_at desc, o.id limit 50`;
  return c.json({ organizations });
});

adminBillingRoutes.post("/credits", async (c) => {
  const actor = getRequestActor(c);
  if (actor.type !== "session") return apiStatusError(c, 403, "Platform administrator required");
  const parsed = adminCreditSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return apiStatusError(c, 400, "Invalid credit request");
  try {
    return c.json(await issueAdminCredit(parsed.data, actor.userId));
  } catch (error) {
    if (error instanceof BillingNotConfiguredError) return apiStatusError(c, 503, "billing_not_configured");
    if (error instanceof BillingRequestError && error.code === "organization_not_found") return apiStatusError(c, 400, error.message, { code: "credit_request_rejected" });
    if (error instanceof BillingRequestError) return apiStatusError(c, error.code === "idempotency_conflict" ? 409 : 400, error.message, { code: error.code });
    console.error("[billing] admin credit failed", error);
    return apiStatusError(c, 502, "Credit request did not complete. Retry with the same request ID.");
  }
});

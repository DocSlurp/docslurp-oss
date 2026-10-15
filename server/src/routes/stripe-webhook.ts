import { reportPublicError } from "../lib/public-errors.js";
import { Hono } from "hono";

import { StripeWebhookError, handleStripeWebhookEvent } from "../services/billing.js";

// This route is intentionally registered before the sessionAuth middleware
// so Stripe can POST to it without a user session.
export const stripeWebhookRoutes = new Hono().post("/stripe", async (c) => {
  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return c.json({ error: "Missing stripe-signature header" }, 400);
  }

  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch {
    return c.json({ error: "Failed to read request body" }, 400);
  }

  try {
    const result = await handleStripeWebhookEvent(rawBody, signature);
    return c.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof StripeWebhookError) {
      console.error(`[stripe-webhook] status=${error.statusCode} error=${error.message}`);
      const status = error.statusCode === 400 ? 400 : 500;
      return c.json({ error: error.exposeMessage ? error.message : "Webhook processing failed" }, status);
    }

    const message = reportPublicError(error);
    console.error(`[stripe-webhook] status=500 error=${message}`);
    return c.json({ error: "Webhook processing failed" }, 500);
  }
});

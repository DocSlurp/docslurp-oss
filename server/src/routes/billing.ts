import { getRetainedVersionStorage } from "../services/billing/retained-storage.js";
import { reportPublicError } from "../lib/public-errors.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import {
  EXAMPLE_CORPORA,
  MAX_TOPUP_CENTS,
  MIN_TOPUP_CENTS,
  autoTopUpSettingsSchema,
  billingPrices,
} from "@docslurp/shared";
import { appendAuditLog } from "../services/audit-log.js";
import {
  BillingNotConfiguredError,
  BillingRequestError,
  attachPaymentMethod,
  createPortalSession,
  createSetupIntent,
  createTopUpCheckout,
  detachPaymentMethod,
  getAutoRechargeSettings,
  getAvailableCredits,
  getBillingOverview,
  getIngestJobCosts,
  getRunCostBreakdown,
  getUsageBreakdown,
  listCreditLedger,
  listInvoices,
  listPaymentMethods,
  updateAutoRechargeSettings,
} from "../services/billing.js";
import { listOrganizations } from "../services/organizations.js";
import { requestIp, requestUserAgent } from "../lib/request-context.js";
import { apiStatusError } from "../lib/api-error.js";
import { validationHook } from "../lib/validation.js";
import { authenticatedByRoute } from "../lib/route-auth.js";

const orgOnlySchema = z.object({ orgId: z.string().optional() });

const topUpCheckoutSchema = z.object({
  orgId: z.string().optional(),
  amountCents: z.number().int().min(MIN_TOPUP_CENTS).max(MAX_TOPUP_CENTS),
});

const autoRechargeUpdateSchema = z.intersection(
  z.object({ orgId: z.string().optional() }),
  autoTopUpSettingsSchema,
);

const attachPaymentMethodSchema = z.object({
  orgId: z.string().optional(),
  paymentMethodId: z.string().min(1),
});

const billingRoles = new Set(["owner", "admin", "billing"]);

type BillingOrg = NonNullable<Awaited<ReturnType<typeof resolveBillingOrganization>>>;

async function resolveBillingOrganization(userId: string, requestedOrgId?: string | null) {
  const orgs = await listOrganizations(userId);
  if (orgs.length === 0) {
    return null;
  }
  return requestedOrgId
    ? (orgs.find((org) => org.id === requestedOrgId) ?? null)
    : (orgs.find((org) => org.isPersonal) ?? orgs[0] ?? null);
}

/** Map billing errors to HTTP: 503 when Stripe is not configured, 400 for caller mistakes. */
function billingError(c: Context, error: unknown, fallback: string) {
  if (error instanceof BillingNotConfiguredError) {
    return apiStatusError(c, 503, "billing_not_configured");
  }
  if (error instanceof BillingRequestError) {
    if (error.code === "billing_not_configured") {
      return apiStatusError(c, 503, "billing_not_configured");
    }
    return apiStatusError(c, 400, error.message, { code: error.code });
  }
  console.error(`[billing] ${fallback}: ${error instanceof Error ? error.message : String(error)}`);
  return apiStatusError(c, 400, reportPublicError(error));
}

async function audit(
  c: Context,
  org: BillingOrg,
  userId: string,
  action: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await appendAuditLog({
    orgId: org.id,
    userId,
    action,
    resourceType: "organization",
    resourceId: org.id,
    ipAddress: requestIp(c),
    metadata: { ...metadata, userAgent: requestUserAgent(c) },
  });
}

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const billingRoutes = new Hono()
  // ---------------------------------------------------------------- catalog
  // Public price list (no auth, see authenticatedByRoute below): the per-unit
  // price card, credit packs, top-up limits, starter credits, worker ceilings,
  // chat model tiers and the reference corpora for the pricing page.
  .get("/prices", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json({ ...billingPrices(), examples: EXAMPLE_CORPORA });
  })

  // ---------------------------------------------------------------- reads
  .get("/overview", async (c) => {
    const userId = c.get("sessionUser").id;
    const org = await resolveBillingOrganization(userId, c.req.query("orgId"));
    if (!org) {
      return apiStatusError(c, 404, "No organization found");
    }
    const [overview, retainedVersionStorage] = await Promise.all([getBillingOverview(org.id), getRetainedVersionStorage(org.id)]);
    return c.json({ ...overview, retainedVersionStorage });
  })
  .get("/balance", async (c) => {
    const userId = c.get("sessionUser").id;
    const org = await resolveBillingOrganization(userId, c.req.query("orgId"));
    if (!org) {
      return c.json({ creditBalanceCents: 0 });
    }
    const credits = await getAvailableCredits(org.id);
    return c.json({ creditBalanceCents: credits.available, orgId: org.id });
  })
  .get("/ledger", async (c) => {
    const userId = c.get("sessionUser").id;
    const org = await resolveBillingOrganization(userId, c.req.query("orgId"));
    if (!org) {
      return apiStatusError(c, 404, "No organization found");
    }
    const entries = await listCreditLedger({
      orgId: org.id,
      limit: parseLimit(c.req.query("limit"), 50),
      before: c.req.query("before") ?? null,
    });
    return c.json({ entries });
  })
  // Auto top-up settings (off by default). `/auto-recharge` is the former name of the same route.
  .get("/:setting{auto-top-up|auto-recharge}", async (c) => {
    const userId = c.get("sessionUser").id;
    const org = await resolveBillingOrganization(userId, c.req.query("orgId"));
    if (!org) {
      return apiStatusError(c, 404, "No organization found");
    }
    return c.json(await getAutoRechargeSettings(org.id));
  })

  // ---------------------------------------------------------------- Stripe flows
  .post("/portal", zValidator("json", orgOnlySchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const { orgId } = c.req.valid("json");
    const org = await resolveBillingOrganization(userId, orgId);
    if (!org) {
      return apiStatusError(c, 404, "No organization found");
    }
    if (!billingRoles.has(org.memberRole)) {
      return apiStatusError(c, 403, "Forbidden");
    }
    try {
      // Invoices and saved payment methods only; there are no plans to manage.
      const result = await createPortalSession({ orgId: org.id });
      await audit(c, org, userId, "billing.portal.opened");
      return c.json(result);
    } catch (error) {
      return billingError(c, error, "Failed to open billing portal");
    }
  })
  .post("/topup/checkout", zValidator("json", topUpCheckoutSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const { orgId, amountCents } = c.req.valid("json");
    const org = await resolveBillingOrganization(userId, orgId);
    if (!org) {
      return apiStatusError(c, 404, "No organization found");
    }
    if (!billingRoles.has(org.memberRole)) {
      return apiStatusError(c, 403, "Forbidden");
    }
    try {
      const result = await createTopUpCheckout({
        orgId: org.id,
        amountCents,
        idempotencyKey: c.req.header("Idempotency-Key")?.trim() || undefined,
      });
      await audit(c, org, userId, "billing.topup.checkout_started", { amountCents });
      return c.json(result);
    } catch (error) {
      return billingError(c, error, "Failed to create top-up checkout");
    }
  })
  .put("/:setting{auto-top-up|auto-recharge}", zValidator("json", autoRechargeUpdateSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const { orgId, ...settings } = c.req.valid("json");
    const org = await resolveBillingOrganization(userId, orgId);
    if (!org) {
      return apiStatusError(c, 404, "No organization found");
    }
    if (!billingRoles.has(org.memberRole)) {
      return apiStatusError(c, 403, "Forbidden");
    }
    try {
      const saved = await updateAutoRechargeSettings({ orgId: org.id, userId, settings });
      await audit(c, org, userId, "billing.auto_top_up.updated", saved);
      return c.json(saved);
    } catch (error) {
      // Enabling without a payment method is a 400 even when Stripe is unconfigured locally.
      if (error instanceof BillingRequestError && error.code === "payment_method_required") {
        return apiStatusError(c, 400, error.message, { code: error.code });
      }
      return billingError(c, error, "Failed to update auto top-up");
    }
  })

  // ---------------------------------------------------------------- usage
  .get("/usage", async (c) => {
    const userId = c.get("sessionUser").id;
    const org = await resolveBillingOrganization(userId, c.req.query("orgId"));
    if (!org) {
      return apiStatusError(c, 404, "No organization found");
    }
    return c.json(await getUsageBreakdown(org.id));
  })
  .get("/usage/jobs", async (c) => {
    const userId = c.get("sessionUser").id;
    const org = await resolveBillingOrganization(userId, c.req.query("orgId"));
    if (!org) {
      return apiStatusError(c, 404, "No organization found");
    }
    const result = await getIngestJobCosts({
      orgId: org.id,
      runId: c.req.query("runId") ?? undefined,
      limit: parseLimit(c.req.query("limit"), 50),
      offset: c.req.query("offset") ? Number(c.req.query("offset")) : 0,
    });
    return c.json(result);
  })
  .get("/usage/run/:runId/cost-breakdown", async (c) => {
    const userId = c.get("sessionUser").id;
    const org = await resolveBillingOrganization(userId, c.req.query("orgId"));
    if (!org) {
      return apiStatusError(c, 404, "No organization found");
    }
    return c.json(await getRunCostBreakdown({ runId: c.req.param("runId"), orgId: org.id }));
  })

  // ---------------------------------------------------------------- invoices & payment methods
  .get("/invoices", async (c) => {
    const userId = c.get("sessionUser").id;
    const org = await resolveBillingOrganization(userId, c.req.query("orgId"));
    if (!org) {
      return c.json({ invoices: [] });
    }
    try {
      const invoices = await listInvoices(org.id);
      return c.json({
        invoices: invoices.map((inv) => ({
          id: inv.id,
          amountPaid: inv.amount_paid,
          amountDue: inv.amount_due,
          currency: inv.currency,
          status: inv.status,
          hostedInvoiceUrl: inv.hosted_invoice_url,
          invoicePdf: inv.invoice_pdf,
          createdAt: new Date(inv.created * 1000).toISOString(),
          periodStart: new Date(inv.period_start * 1000).toISOString(),
          periodEnd: new Date(inv.period_end * 1000).toISOString(),
        })),
      });
    } catch (error) {
      return billingError(c, error, "Failed to list invoices");
    }
  })
  .get("/payment-methods", async (c) => {
    const userId = c.get("sessionUser").id;
    const org = await resolveBillingOrganization(userId, c.req.query("orgId"));
    if (!org) {
      return c.json({ paymentMethods: [] });
    }
    try {
      const methods = await listPaymentMethods(org.id);
      return c.json({
        paymentMethods: methods.map((pm) => ({
          id: pm.id,
          type: pm.type,
          card: pm.card
            ? {
                brand: pm.card.brand,
                last4: pm.card.last4,
                expMonth: pm.card.exp_month,
                expYear: pm.card.exp_year,
              }
            : null,
          createdAt: new Date(pm.created * 1000).toISOString(),
        })),
      });
    } catch (error) {
      return billingError(c, error, "Failed to list payment methods");
    }
  })
  .post("/payment-methods/setup-intent", zValidator("json", orgOnlySchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const { orgId } = c.req.valid("json");
    const org = await resolveBillingOrganization(userId, orgId);
    if (!org) {
      return apiStatusError(c, 404, "No organization found");
    }
    if (!billingRoles.has(org.memberRole)) {
      return apiStatusError(c, 403, "Forbidden");
    }
    try {
      const result = await createSetupIntent({
        orgId: org.id,
        idempotencyKey: c.req.header("Idempotency-Key")?.trim() || undefined,
      });
      await audit(c, org, userId, "billing.payment_method.setup_intent_created", {
        setupIntentId: result.setupIntentId,
      });
      return c.json(result, 201);
    } catch (error) {
      return billingError(c, error, "Failed to create setup intent");
    }
  })
  .post("/payment-methods", zValidator("json", attachPaymentMethodSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const { orgId, paymentMethodId } = c.req.valid("json");
    const org = await resolveBillingOrganization(userId, orgId);
    if (!org) {
      return apiStatusError(c, 404, "No organization found");
    }
    if (!billingRoles.has(org.memberRole)) {
      return apiStatusError(c, 403, "Forbidden");
    }
    try {
      const pm = await attachPaymentMethod({ orgId: org.id, paymentMethodId });
      await audit(c, org, userId, "billing.payment_method.attached", { paymentMethodId: pm.id });
      return c.json({ id: pm.id, type: pm.type }, 201);
    } catch (error) {
      return billingError(c, error, "Failed to attach payment method");
    }
  })
  .delete("/payment-methods/:id", async (c) => {
    const userId = c.get("sessionUser").id;
    const paymentMethodId = c.req.param("id");
    const org = await resolveBillingOrganization(userId, c.req.query("orgId"));
    if (!org) {
      return apiStatusError(c, 404, "No organization found");
    }
    if (!billingRoles.has(org.memberRole)) {
      return apiStatusError(c, 403, "Forbidden");
    }
    try {
      await detachPaymentMethod({ orgId: org.id, paymentMethodId });
      await audit(c, org, userId, "billing.payment_method.detached", { paymentMethodId });
      return c.json({ ok: true });
    } catch (error) {
      return billingError(c, error, "Failed to detach payment method");
    }
  });

// The price list is public: anyone may read prices without signing in.
authenticatedByRoute(billingRoutes, ["GET /prices"]);

import { reportPublicError } from "../lib/public-errors.js";
import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { webhookEventCatalog } from "../lib/webhook-events.js";
import { requestIp, requestUserAgent } from "../lib/request-context.js";
import { appendAuditLog } from "../services/audit-log.js";
import {
  createWebhook,
  WebhookForbiddenError,
  WebhookScopeError,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  replayWebhookDelivery,
  rotateWebhookSecret,
  sendTestWebhook,
  updateWebhook
} from "../services/webhooks.js";
import { apiStatusError } from "../lib/api-error.js";
import { ensurePersonalOrganization } from "../services/organizations.js";
import { validationHook } from "../lib/validation.js";

const createWebhookSchema = z.object({
  url: z.string().url(),
  secret: z.string().min(16),
  events: z.array(z.string()).optional(),
  /** The organization to receive events for; omitted means the personal one. Owners and admins only. */
  orgId: z.string().min(1).optional()
}).strict();

const testWebhookSchema = z.object({
  event: z.string().default("run.completed")
});

const replayWebhookSchema = z.object({
  deliveryId: z.string()
});

const updateWebhookSchema = z.object({
  url: z.string().url().optional(),
  active: z.boolean().optional(),
  events: z.array(z.string()).optional()
});

/** Webhooks are an organization's: `orgId` names it, and an omitted one means the caller's personal organization. */
async function requestOrgId(userId: string, orgId: string | null | undefined): Promise<string> {
  return orgId?.trim() || (await ensurePersonalOrganization(userId)).id;
}

function webhookScopeResponse(c: Context, error: unknown): Response | null {
  if (error instanceof WebhookScopeError) return apiStatusError(c, 404, error.message);
  if (error instanceof WebhookForbiddenError) return apiStatusError(c, 403, error.message);
  return null;
}

export const webhooksRoutes = new Hono()
  .get("/catalog", async (c) => {
    return c.json({ events: webhookEventCatalog });
  })
  .get("/deliveries", async (c) => {
    const userId = c.get("sessionUser").id;
    const webhookId = c.req.query("webhookId") ?? undefined;
    const limit = c.req.query("limit");
    try {
      const deliveries = await listWebhookDeliveries({
        userId,
        orgId: await requestOrgId(userId, c.req.query("orgId")),
        webhookId,
        limit: limit ? Number(limit) : undefined
      });
      return c.json({ deliveries });
    } catch (error) {
      const scoped = webhookScopeResponse(c, error);
      if (scoped) return scoped;
      throw error;
    }
  })
  .get("/", async (c) => {
    const userId = c.get("sessionUser").id;
    try {
      const webhooks = await listWebhooks({ userId, orgId: await requestOrgId(userId, c.req.query("orgId")) });
      return c.json({ webhooks });
    } catch (error) {
      const scoped = webhookScopeResponse(c, error);
      if (scoped) return scoped;
      throw error;
    }
  })
  .post("/", zValidator("json", createWebhookSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    // Webhook routes are session-only (they do not accept API keys), so the caller is a signed-in user; the service checks that
    // user's membership and role in the organization it names.
    const orgId = await requestOrgId(userId, body.orgId);
    let webhook;
    try {
      webhook = await createWebhook({
        userId,
        orgId,
        url: body.url,
        secret: body.secret,
        events: body.events
      });
    } catch (error) {
      return webhookScopeResponse(c, error) ?? apiStatusError(c, 400, reportPublicError(error));
    }
    await appendAuditLog({
      orgId: webhook.orgId,
      userId,
      action: "webhook.created",
      resourceType: "webhook",
      resourceId: webhook.id,
      ipAddress: requestIp(c),
      metadata: {
        url: webhook.url,
        events: webhook.events,
        userAgent: requestUserAgent(c)
      }
    });
    return c.json(webhook, 201);
  })
  .post("/:id/test", zValidator("json", testWebhookSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const webhookId = c.req.param("id");
    const body = c.req.valid("json");
    const delivery = await sendTestWebhook(webhookId, userId, body.event);

    if (!delivery) {
      return apiStatusError(c, 404, "Webhook not found");
    }

    return c.json({ delivery });
  })
  .delete("/:id", async (c) => {
    const userId = c.get("sessionUser").id;
    const deletedOrgId = await deleteWebhook(c.req.param("id"), userId);

    if (!deletedOrgId) {
      return apiStatusError(c, 404, "Webhook not found");
    }

    await appendAuditLog({
      orgId: deletedOrgId,
      userId,
      action: "webhook.deleted",
      resourceType: "webhook",
      resourceId: c.req.param("id"),
      ipAddress: requestIp(c),
      metadata: {
        userAgent: requestUserAgent(c)
      }
    });

    return c.json({ ok: true });
  })
  .patch("/:id", zValidator("json", updateWebhookSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    let webhook;
    try {
      webhook = await updateWebhook({
        webhookId: c.req.param("id"),
        userId,
        url: body.url,
        active: body.active,
        events: body.events
      });
    } catch (error) {
      return apiStatusError(c, 400, reportPublicError(error));
    }

    if (!webhook) {
      return apiStatusError(c, 404, "Webhook not found");
    }

    await appendAuditLog({
      orgId: webhook.orgId,
      userId,
      action: "webhook.updated",
      resourceType: "webhook",
      resourceId: webhook.id,
      ipAddress: requestIp(c),
      metadata: {
        url: webhook.url,
        active: webhook.active,
        events: webhook.events,
        userAgent: requestUserAgent(c)
      }
    });

    return c.json({ webhook });
  })
  .post("/:id/rotate-secret", async (c) => {
    const userId = c.get("sessionUser").id;
    const result = await rotateWebhookSecret(c.req.param("id"), userId);

    if (!result) {
      return apiStatusError(c, 404, "Webhook not found");
    }

    await appendAuditLog({
      orgId: result.webhook.orgId,
      userId,
      action: "webhook.secret.rotated",
      resourceType: "webhook",
      resourceId: result.webhook.id,
      ipAddress: requestIp(c),
      metadata: {
        userAgent: requestUserAgent(c)
      }
    });

    return c.json(result);
  })
  .post("/deliveries/:deliveryId/replay", async (c) => {
    const userId = c.get("sessionUser").id;
    const delivery = await replayWebhookDelivery(c.req.param("deliveryId"), userId);

    if (!delivery) {
      return apiStatusError(c, 404, "Delivery not found");
    }

    await appendAuditLog({
      userId,
      action: "webhook.delivery.replayed",
      resourceType: "webhook-delivery",
      resourceId: delivery.id,
      ipAddress: requestIp(c),
      metadata: {
        webhookId: delivery.webhookId,
        eventType: delivery.eventType,
        replayOfDeliveryId: delivery.replayOfDeliveryId,
        userAgent: requestUserAgent(c)
      }
    });

    return c.json({ delivery });
  })
  .post("/:id/replay", zValidator("json", replayWebhookSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    const delivery = await replayWebhookDelivery(body.deliveryId, userId);

    if (!delivery || delivery.webhookId !== c.req.param("id")) {
      return apiStatusError(c, 404, "Delivery not found");
    }

    return c.json({ delivery });
  });

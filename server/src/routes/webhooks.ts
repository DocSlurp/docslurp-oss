import { reportPublicError } from "../lib/public-errors.js";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { webhookEventCatalog } from "../lib/webhook-events.js";
import { requestIp, requestUserAgent } from "../lib/request-context.js";
import { appendAuditLog } from "../services/audit-log.js";
import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  replayWebhookDelivery,
  rotateWebhookSecret,
  sendTestWebhook,
  updateWebhook
} from "../services/webhooks.js";

const createWebhookSchema = z.object({
  url: z.string().url(),
  secret: z.string().min(16),
  events: z.array(z.string()).optional()
});

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

export const webhooksRoutes = new Hono()
  .get("/catalog", async (c) => {
    return c.json({ events: webhookEventCatalog });
  })
  .get("/deliveries", async (c) => {
    const userId = c.get("sessionUser").id;
    const webhookId = c.req.query("webhookId") ?? undefined;
    const limit = c.req.query("limit");
    const deliveries = await listWebhookDeliveries({
      userId,
      webhookId,
      limit: limit ? Number(limit) : undefined
    });
    return c.json({ deliveries });
  })
  .get("/", async (c) => {
    const userId = c.get("sessionUser").id;
    const webhooks = await listWebhooks(userId);
    return c.json({ webhooks });
  })
  .post("/", zValidator("json", createWebhookSchema), async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    let webhook;
    try {
      webhook = await createWebhook({
        userId,
        url: body.url,
        secret: body.secret,
        events: body.events
      });
    } catch (error) {
      return c.json({ error: reportPublicError(error) }, 400);
    }
    await appendAuditLog({
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
  .post("/:id/test", zValidator("json", testWebhookSchema), async (c) => {
    const userId = c.get("sessionUser").id;
    const webhookId = c.req.param("id");
    const body = c.req.valid("json");
    const delivery = await sendTestWebhook(webhookId, userId, body.event);

    if (!delivery) {
      return c.json({ error: "Webhook not found" }, 404);
    }

    return c.json({ delivery });
  })
  .delete("/:id", async (c) => {
    const userId = c.get("sessionUser").id;
    const deleted = await deleteWebhook(c.req.param("id"), userId);

    if (!deleted) {
      return c.json({ error: "Webhook not found" }, 404);
    }

    await appendAuditLog({
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
  .patch("/:id", zValidator("json", updateWebhookSchema), async (c) => {
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
      return c.json({ error: reportPublicError(error) }, 400);
    }

    if (!webhook) {
      return c.json({ error: "Webhook not found" }, 404);
    }

    await appendAuditLog({
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
      return c.json({ error: "Webhook not found" }, 404);
    }

    await appendAuditLog({
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
      return c.json({ error: "Delivery not found" }, 404);
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
  .post("/:id/replay", zValidator("json", replayWebhookSchema), async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    const delivery = await replayWebhookDelivery(body.deliveryId, userId);

    if (!delivery || delivery.webhookId !== c.req.param("id")) {
      return c.json({ error: "Delivery not found" }, 404);
    }

    return c.json({ delivery });
  });

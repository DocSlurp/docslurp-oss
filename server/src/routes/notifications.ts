import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import { getRequestActor, resolveActorWorkspaceFilter } from "../lib/request-actor.js";
import {
  getNotificationPreferences,
  listNotificationInbox,
  markAllNotificationsRead,
  markNotificationRead,
  updateNotificationPreferences,
} from "../services/notifications.js";
import { apiStatusError } from "../lib/api-error.js";
import { validationHook } from "../lib/validation.js";

const updatePreferencesSchema = z.object({
  runCompleted: z.boolean().optional(),
  runFailed: z.boolean().optional(),
  plausibilityWarning: z.boolean().optional(),
  costAlert: z.boolean().optional(),
  workspaceInvite: z.boolean().optional()
});

const readAllSchema = z.object({
  workspaceId: z.string().optional()
});

export const notificationsRoutes = new Hono()
  .get("/inbox", async (c) => {
    const userId = c.get("sessionUser").id;
    const workspaceId = await resolveActorWorkspaceFilter(getRequestActor(c), c.req.query("workspaceId"));
    const event = c.req.query("event") as Parameters<typeof listNotificationInbox>[0]["event"];
    const limit = Number(c.req.query("limit") ?? "25");
    const inbox = await listNotificationInbox({
      userId,
      workspaceId,
      event,
      limit: Number.isFinite(limit) ? limit : 25,
    });
    return c.json(inbox);
  })
  .post("/inbox/:id/read", async (c) => {
    const userId = c.get("sessionUser").id;
    const delivery = await markNotificationRead({
      id: c.req.param("id"),
      userId
    });

    if (!delivery) {
      return apiStatusError(c, 404, "Notification not found");
    }

    return c.json({ delivery });
  })
  .post("/inbox/read-all", zValidator("json", readAllSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    const updatedCount = await markAllNotificationsRead({
      userId,
      workspaceId: await resolveActorWorkspaceFilter(getRequestActor(c), body.workspaceId)
    });

    return c.json({ updatedCount });
  })
  .get("/preferences", async (c) => {
    const userId = c.get("sessionUser").id;
    const preferences = await getNotificationPreferences(userId);
    return c.json(preferences);
  })
  .patch("/preferences", zValidator("json", updatePreferencesSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const preferences = await updateNotificationPreferences(userId, c.req.valid("json"));
    return c.json(preferences);
  });

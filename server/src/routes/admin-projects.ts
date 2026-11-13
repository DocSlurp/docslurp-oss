import { Hono } from "hono";

import { apiStatusError } from "../lib/api-error.js";
import { getRequestActor } from "../lib/request-actor.js";
import { ManagedModelError, managedModelsUpdateSchema, setProjectManagedModels } from "../services/managed-models.js";

/**
 * Platform-admin project settings that customers cannot set or read: the backend model behind each category
 * (managed-models.ts). Reachable only from a platform-admin browser session (ADMIN_EMAILS); API keys and OAuth
 * tokens are refused even for an admin, so no programmatic caller can choose a backend model.
 */
export const adminProjectsRoutes = new Hono();

adminProjectsRoutes.use("*", async (c, next) => {
  const actor = getRequestActor(c);
  if (actor.type !== "session" || actor.user.isAdmin !== true) return apiStatusError(c, 403, "Platform administrator required");
  await next();
});

adminProjectsRoutes.put("/:projectId/managed-models", async (c) => {
  const actor = getRequestActor(c);
  const parsed = managedModelsUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return apiStatusError(c, 400, "Invalid managed models", { details: { issues: parsed.error.issues } });
  try {
    const result = await setProjectManagedModels(String(c.req.param("projectId")), parsed.data, actor.userId);
    if (!result) return apiStatusError(c, 404, "Project not found");
    return c.json({ managedModels: result });
  } catch (error) {
    if (error instanceof ManagedModelError) return apiStatusError(c, 400, error.message);
    throw error;
  }
});

import { Hono } from "hono";

import { apiStatusError } from "../lib/api-error.js";
import { requestIp } from "../lib/request-context.js";
import { actorHasAnyApiKeyScope, getRequestActor, isPlatformAdminActor } from "../lib/request-actor.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { ManagedModelError, getProjectManagedModels, managedModelsUpdateSchema, setProjectManagedModels } from "../services/managed-models.js";

/**
 * Platform-admin project settings that customers cannot set or read: the backend model behind each category
 * (managed-models.ts). Reachable from a platform-admin browser session (ADMIN_EMAILS), or, for scripted self-hosted
 * setups, a platform admin's server API key holding the dedicated `admin:models` scope. Customer keys, OAuth tokens and
 * client keys are refused, so no customer programmatic caller can choose a backend model.
 */
export const adminProjectsRoutes = new Hono();

adminProjectsRoutes.use("*", async (c, next) => {
  const actor = getRequestActor(c);
  if (actor.type === "session") {
    if (actor.user.isAdmin !== true) return apiStatusError(c, 403, "Platform administrator required");
  } else if (actor.apiKey.keyType !== "server" || actor.apiKey.oauth || !actorHasAnyApiKeyScope(actor, ["admin:models"]) || !(await isPlatformAdminActor(actor))) {
    return apiStatusError(c, 403, "Platform administrator required (a session, or a platform admin's server key with the admin:models scope)");
  }
  await next();
});

adminProjectsRoutes.get("/:projectId/managed-models", async (c) => {
  const record = await getProjectManagedModels(String(c.req.param("projectId")));
  if (!record) return apiStatusError(c, 404, "Project not found");
  return c.json({ managedModels: record });
});

adminProjectsRoutes.put("/:projectId/managed-models", async (c) => {
  const actor = getRequestActor(c);
  const parsed = managedModelsUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return apiStatusError(c, 400, "Invalid managed models", { details: { issues: parsed.error.issues } });
  try {
    const result = await setProjectManagedModels(String(c.req.param("projectId")), parsed.data, {
      userId: actor.userId,
      apiKeyId: actor.type === "apiKey" ? actor.apiKey.keyId : null,
      ipAddress: requestIp(c),
    });
    if (!result) return apiStatusError(c, 404, "Project not found");
    return c.json({ managedModels: result });
  } catch (error) {
    if (error instanceof ManagedModelError) return apiStatusError(c, 400, error.message);
    throw error;
  }
});

acceptApiKeys(adminProjectsRoutes, ["GET /:projectId/managed-models", "PUT /:projectId/managed-models"]);

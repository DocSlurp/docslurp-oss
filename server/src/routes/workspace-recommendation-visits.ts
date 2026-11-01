import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getRequestActor } from "../lib/request-actor.js";
import { apiStatusError, nativeBodyLimit } from "../lib/api-error.js";
import { validationHook } from "../lib/validation.js";
import { getWorkspaceAccess } from "../services/organizations.js";
import { acknowledgeRecommendationVisit, getRecommendationVisit } from "../services/workspace-recommendation-visits.js";

const sessionOnly: MiddlewareHandler = async (c, next) => {
  if (getRequestActor(c).type !== "session") return apiStatusError(c, 403, "A user session is required");
  c.header("Cache-Control", "private, no-store");
  await next();
};
export const workspaceRecommendationVisitsRoutes = new Hono()
  .use("/:workspaceId/recommendation-visit", nativeBodyLimit(1024), sessionOnly)
  .use("/:workspaceId/recommendation-visit/*", nativeBodyLimit(1024), sessionOnly)
  .get("/:workspaceId/recommendation-visit", async c => {
    const actor = getRequestActor(c);
    const workspace = await getWorkspaceAccess(c.req.param("workspaceId"), actor.userId);
    if (!workspace) return apiStatusError(c, 404, "Workspace not found");
    return c.json(await getRecommendationVisit({ userId: actor.userId, orgId: workspace.orgId, workspaceId: workspace.workspaceId }));
  })
  .post("/:workspaceId/recommendation-visit/acknowledge",
    zValidator("json", z.object({ token: z.string().uuid() }).strict(), validationHook), async c => {
      const actor = getRequestActor(c);
      const workspace = await getWorkspaceAccess(c.req.param("workspaceId"), actor.userId);
      if (!workspace) return apiStatusError(c, 404, "Workspace not found");
      const accepted = await acknowledgeRecommendationVisit(
        { userId: actor.userId, orgId: workspace.orgId, workspaceId: workspace.workspaceId }, c.req.valid("json").token);
      if (!accepted) return apiStatusError(c, 409, "This snapshot was already acknowledged or is no longer current. Refresh to continue.");
      return c.json({ acknowledged: true });
    });

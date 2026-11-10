import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getRequestActor } from "../lib/request-actor.js";
import { apiStatusError, nativeBodyLimit } from "../lib/api-error.js";
import { validationHook } from "../lib/validation.js";
import { getProjectAccess } from "../services/organizations.js";
import { acknowledgeRecommendationVisit, getRecommendationVisit } from "../services/project-recommendation-visits.js";

const sessionOnly: MiddlewareHandler = async (c, next) => {
  if (getRequestActor(c).type !== "session") return apiStatusError(c, 403, "A user session is required");
  c.header("Cache-Control", "private, no-store");
  await next();
};
export const projectRecommendationVisitsRoutes = new Hono()
  .use("/:projectId/recommendation-visit", nativeBodyLimit(1024), sessionOnly)
  .use("/:projectId/recommendation-visit/*", nativeBodyLimit(1024), sessionOnly)
  .get("/:projectId/recommendation-visit", async c => {
    const actor = getRequestActor(c);
    const project = await getProjectAccess(c.req.param("projectId"), actor.userId);
    if (!project) return apiStatusError(c, 404, "Project not found");
    return c.json(await getRecommendationVisit({ userId: actor.userId, orgId: project.orgId, projectId: project.projectId }));
  })
  .post("/:projectId/recommendation-visit/acknowledge",
    zValidator("json", z.object({ token: z.string().uuid() }).strict(), validationHook), async c => {
      const actor = getRequestActor(c);
      const project = await getProjectAccess(c.req.param("projectId"), actor.userId);
      if (!project) return apiStatusError(c, 404, "Project not found");
      const accepted = await acknowledgeRecommendationVisit(
        { userId: actor.userId, orgId: project.orgId, projectId: project.projectId }, c.req.valid("json").token);
      if (!accepted) return apiStatusError(c, 409, "This snapshot was already acknowledged or is no longer current. Refresh to continue.");
      return c.json({ acknowledged: true });
    });

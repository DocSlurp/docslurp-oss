import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { updateProjectSummaryTreeSchema } from "@docslurp/shared";

import { SEARCH_SCOPES } from "../lib/search-tiers.js";
import { actorHasAnyApiKeyScope, getRequestActor, apiKeyCanUseProject } from "../lib/request-actor.js";
import { requestIp } from "../lib/request-context.js";
import { appendAuditLog } from "../services/audit-log.js";
import {
  getProjectSummaryTree,
  ProjectSummaryTreeError,
  updateProjectSummaryTree,
} from "../services/project-summary-tree.js";
import { getProject } from "../services/projects.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";
import { validationHook } from "../lib/validation.js";

/**
 * API keys may read the summary tree state with any project scope; turning the tree on or off needs a server key
 * with `projects:manage`. Keys are bound to their organization.
 */
async function authorizeApiKey(c: Context, projectRef: string, write: boolean): Promise<Response | null> {
  const actor = getRequestActor(c);
  if (actor.type !== "apiKey") return null;
  const allowed = write
    ? actor.apiKey.keyType === "server" && actorHasAnyApiKeyScope(actor, ["projects:manage"])
    : actor.apiKey.keyType === "server" && actorHasAnyApiKeyScope(actor, ["ingest", ...SEARCH_SCOPES, "artifacts", "projects:manage"]);
  if (!allowed) {
    return apiStatusError(c, 403, write
        ? "This endpoint requires a server API key with the projects:manage scope"
        : "Forbidden");
  }
  const project = await getProject(projectRef, actor.userId);
  if (!project || !apiKeyCanUseProject(actor.apiKey, project)) {
    return apiErrorResponse(c, 404, "project_not_found", "Project not found");
  }
  return null;
}

function treeError(c: Context, error: unknown) {
  if (error instanceof ProjectSummaryTreeError) {
    return apiStatusError(c, error.status, error.message, error.code ? { code: error.code } : {});
  }
  throw error;
}

export const projectSummaryTreeRoutes = new Hono()
  /** Stored setting, deployment switches, build status, document counts and the read-only server constants. */
  .get("/:projectId/summary-tree", async (c) => {
    const projectRef = c.req.param("projectId");
    const denied = await authorizeApiKey(c, projectRef, false);
    if (denied) return denied;
    try {
      return c.json(await getProjectSummaryTree(projectRef, c.get("sessionUser").id));
    } catch (error) {
      return treeError(c, error);
    }
  })
  /**
   * The only way to turn a project's summary tree on or off: `{ "enabled": true | false }`. A general project save
   * keeps the stored value. Nothing is queued: new uploads get a tree, existing documents do not change.
   */
  .patch("/:projectId/summary-tree", zValidator("json", updateProjectSummaryTreeSchema, validationHook), async (c) => {
    const projectRef = c.req.param("projectId");
    const denied = await authorizeApiKey(c, projectRef, true);
    if (denied) return denied;
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    try {
      const state = await updateProjectSummaryTree(projectRef, userId, body);
      const project = await getProject(projectRef, userId);
      if (project) {
        await appendAuditLog({
          orgId: project.orgId,
          userId,
          projectId: project.id,
          action: "project.summary_tree.updated",
          resourceType: "project-summary-tree",
          resourceId: project.id,
          ipAddress: requestIp(c),
          metadata: { enabled: state.enabled },
        });
      }
      return c.json(state);
    } catch (error) {
      return treeError(c, error);
    }
  });

acceptApiKeys(projectSummaryTreeRoutes);

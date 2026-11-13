import type { Context } from "hono";
import { apiKeyCanUseProject } from "./api-key-project-scope.js";
import { apiKeyCanUpdateContent } from "./content-update-access.js";
import { canEditProject, getProjectAccess } from "../services/organizations.js";

/**
 * Whether the caller may start a reprocess of a document in this project: a session that may edit the project, or a
 * server key with content-update scope that may use it. Only for `canReprocess` on a typed unavailable state, read after
 * the caller was already authorized to see the document; it never grants anything.
 */
export async function callerCanReprocess(c: Context, document: { orgId: string; projectId: string }): Promise<boolean> {
  const apiKey = c.get("apiKey");
  if (apiKey && (!apiKeyCanUpdateContent(apiKey) || !apiKeyCanUseProject(apiKey, document))) return false;
  const userId = c.get("sessionUser")?.id;
  if (!userId) return false;
  const access = await getProjectAccess(document.projectId, userId);
  return Boolean(access && access.orgId === document.orgId && canEditProject(access, userId));
}

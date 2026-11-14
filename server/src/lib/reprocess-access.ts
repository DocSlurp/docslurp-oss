import type { Context } from "hono";
import { apiKeyCanUseProject } from "./api-key-project-scope.js";
import { apiStatusError } from "./api-error.js";
import { apiKeyCanUpdateContent, CONTENT_UPDATE_SCOPE_MESSAGE } from "./content-update-access.js";
import { canEditProject, getProjectAccess } from "../services/organizations.js";

/**
 * Who may reprocess or spend credits on existing content (owner decision, council L3, 2026-11-13): a session that may
 * edit the project (canEditProject: org owners and admins, the project's owner, its admins and editors), or a server key
 * with content-update (`ingest`) scope that may use the project and whose user may edit it. Membership of the org's
 * default project alone does not qualify (it still allows uploads: canContributeToProject).
 *
 * The same rule decides `canReprocess` on typed unavailable states and refuses every reprocess and spend path:
 * single and bulk document reprocess, run reprocess and retry, correction re-index, document and project full index,
 * figure resume, and the chat proposal Apply routes.
 */
export async function callerCanReprocess(c: Context, document: { orgId: string; projectId: string }): Promise<boolean> {
  const apiKey = c.get("apiKey");
  if (apiKey && (!apiKeyCanUpdateContent(apiKey) || !apiKeyCanUseProject(apiKey, document))) return false;
  const userId = c.get("sessionUser")?.id;
  if (!userId) return false;
  const access = await getProjectAccess(document.projectId, userId);
  return Boolean(access && access.orgId === document.orgId && canEditProject(access, userId));
}

export const REPROCESS_FORBIDDEN_MESSAGE = "Reprocessing and other paid work need edit access to the project";

/**
 * Refuse a reprocess of projects the caller can already see: 403 for a key without content-update scope or a caller who
 * may not edit. Call only after the caller was shown to reach every target (anything else answers the same 404 as a
 * missing resource, before this).
 */
export async function denyReprocessOfVisible(c: Context, targets: ReadonlyArray<{ orgId: string; projectId: string }>): Promise<Response | null> {
  const apiKey = c.get("apiKey");
  if (apiKey && !apiKeyCanUpdateContent(apiKey)) return apiStatusError(c, 403, CONTENT_UPDATE_SCOPE_MESSAGE);
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.projectId)) continue;
    seen.add(target.projectId);
    if (!await callerCanReprocess(c, target)) return apiStatusError(c, 403, REPROCESS_FORBIDDEN_MESSAGE);
  }
  return null;
}

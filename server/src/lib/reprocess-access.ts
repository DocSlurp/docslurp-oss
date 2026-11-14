import type { Context } from "hono";
import { apiKeyCanUseProject } from "./api-key-project-scope.js";
import { actorHasAnyApiKeyScope, getRequestActor } from "./request-actor.js";
import { apiErrorResponse, apiStatusError } from "./api-error.js";
import { EDITOR_REQUIRED_CODE, EDITOR_REQUIRED_MESSAGE } from "@docslurp/shared";
import { apiKeyCanUpdateContent, CONTENT_UPDATE_SCOPE_MESSAGE } from "./content-update-access.js";
import { canEditProject, canManageProject, getProjectAccess, listManageableProjectIds, listReprocessableProjectIds } from "../services/organizations.js";

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

/** The one editor-only refusal (shared EDITOR_REQUIRED_CODE): 403 `editor_required` with its reviewed message. */
export function editorRequired(c: Context): Response {
  return apiErrorResponse(c, 403, EDITOR_REQUIRED_CODE, EDITOR_REQUIRED_MESSAGE);
}

/**
 * Refuse a change to a project the caller can already see when they may not edit it (session or key user; any key scope
 * gate runs before this): 403 `editor_required`, or null. A project they cannot see is the caller's 404, before this.
 */
export async function denyEditOfVisibleProject(c: Context, project: { id: string; orgId: string }): Promise<Response | null> {
  const userId = c.get("sessionUser")?.id;
  if (!userId) return editorRequired(c);
  // Access is read for this project's own id, so it is that project's (and organization's) access.
  const access = await getProjectAccess(project.id, userId);
  return access && canEditProject(access, userId) ? null : editorRequired(c);
}

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
    if (!await callerCanReprocess(c, target)) return editorRequired(c);
  }
  return null;
}

/** This request's project flags, so labelling several responses (or one project twice) costs one lookup. */
const requestFlags = new WeakMap<object, Map<string, { canEdit: boolean; canManage: boolean }>>();

/**
 * Project records with this caller's `canEdit` (the callerCanReprocess rule: an editor or admin of the project; a server
 * key also needs content-update scope and must be allowed the project) and `canManage` (archive, delete, members:
 * canManageProject; a key also needs projects:manage). A single project (upload, extract, session, create, detail) is
 * one indexed access lookup, never a scan of the caller's projects: the 10,000-file intake path stays O(1) per request.
 * A list uses two set queries. Results are cached for the request.
 */
export async function withCanEdit<T extends { id: string; orgId: string }>(c: Context, projects: T[]): Promise<Array<T & { canEdit: boolean; canManage: boolean }>> {
  const actor = getRequestActor(c);
  const userId = actor.userId as string | undefined;
  const apiKey = c.get("apiKey");
  let cache = requestFlags.get(c.req.raw);
  if (!cache) { cache = new Map(); requestFlags.set(c.req.raw, cache); }
  const missing = [...new Set(projects.map((project) => project.id))].filter((id) => !cache!.has(id));
  if (userId && missing.length === 1) {
    const access = await getProjectAccess(missing[0]!, userId);
    cache.set(missing[0]!, { canEdit: Boolean(access && canEditProject(access, userId)), canManage: Boolean(access && canManageProject(access, userId)) });
  } else if (userId && missing.length > 1) {
    const [editable, manageable] = await Promise.all([listReprocessableProjectIds(userId), listManageableProjectIds(userId)]);
    const edit = new Set(editable), manage = new Set(manageable);
    for (const id of missing) cache.set(id, { canEdit: edit.has(id), canManage: manage.has(id) });
  }
  const keyMayEdit = (project: T) => !apiKey || (apiKeyCanUpdateContent(apiKey) && apiKeyCanUseProject(apiKey, { orgId: project.orgId, projectId: project.id }));
  const keyMayManage = (project: T) => !apiKey || (actorHasAnyApiKeyScope(actor, ["projects:manage"]) && apiKeyCanUseProject(apiKey, { orgId: project.orgId, projectId: project.id }));
  return projects.map((project) => {
    const flags = userId ? cache!.get(project.id) : undefined;
    return { ...project, canEdit: Boolean(flags?.canEdit) && keyMayEdit(project), canManage: Boolean(flags?.canManage) && keyMayManage(project) };
  });
}

type MaybeProject = { id?: unknown; orgId?: unknown } | null | undefined;
/**
 * A response that carries a project record (`project`, or `result.project` on an upload session) with this caller's
 * `canEdit`, so a client that stores the record never loses the flag (upload, create and session responses).
 */
export async function withPayloadCanEdit<T>(c: Context, payload: T): Promise<T> {
  const flag = async (project: MaybeProject) => project && typeof project.id === "string" && typeof project.orgId === "string"
    ? (await withCanEdit(c, [project as { id: string; orgId: string }]))[0]
    : project;
  if (!payload || typeof payload !== "object") return payload;
  const body = payload as { project?: MaybeProject; result?: { project?: MaybeProject } | null };
  let next: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  if (body.project && typeof body.project === "object") next = { ...next, project: await flag(body.project) };
  if (body.result && typeof body.result === "object" && body.result.project) next = { ...next, result: { ...body.result, project: await flag(body.result.project) } };
  return next as T;
}

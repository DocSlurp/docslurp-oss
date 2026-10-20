import { addTraceMetadata } from "@docslurp/shared/observability";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

import { apiError, isDefaultWorkspaceAlias, isWorkspaceUuid, type WorkspaceRecord } from "@docslurp/shared";

import { apiErrorResponse } from "./api-error.js";
import { auth, appDbPool } from "./auth.js";
import { isConfiguredAdminUser } from "./admin-emails.js";
import { apiKeyAllowsWorkspace, apiKeyCanUseWorkspace } from "./api-key-workspace-scope.js";

export { apiKeyAllowsWorkspace, apiKeyCanUseWorkspace };
import { setCurrentRequestApiKeyId, setCurrentRequestApiKeyWorkspaceIds, setCurrentRequestSessionId, setCurrentRequestUserId } from "./request-context.js";
import { validateApiKey, type ValidatedKey } from "../services/api-keys.js";
import { ensureDefaultWorkspace, getWorkspace, resolveWorkspaceRef } from "../services/workspaces.js";
import { WorkspaceAccessError } from "../services/default-workspace.js";

export interface SessionUser {
  isAdmin?: boolean;
  id: string;
  email: string;
  name: string;
  image?: string | null;
}

export interface SessionRequestActor {
  type: "session";
  userId: string;
  sessionId: string;
  user: SessionUser;
}

export interface ApiKeyRequestActor {
  type: "apiKey";
  userId: string;
  apiKey: ValidatedKey;
}

export type RequestActor = SessionRequestActor | ApiKeyRequestActor;

declare module "hono" {
  interface ContextVariableMap {
    requestActor: RequestActor;
    sessionUser: SessionUser;
    apiKey: ValidatedKey;
    rateLimitActorChecked: boolean;
    requestId: string;
  }
}

export function syntheticApiKeySessionUser(apiKey: ValidatedKey): SessionUser {
  return {
    id: apiKey.userId,
    email: "",
    name: "API key"
  };
}

export async function resolveApiKeyActor(
  authorization: string | undefined,
  requestContext?: { origin?: string | null; referer?: string | null },
): Promise<ApiKeyRequestActor | null> {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const apiKey = await validateApiKey(authorization.slice(7), requestContext);
  return apiKey ? { type: "apiKey", userId: apiKey.userId, apiKey } : null;
}

export async function resolveBetterAuthSessionActor(headers: Headers): Promise<SessionRequestActor | null> {
  const session = await auth.api.getSession({ headers }) as {
    session: { id: string; userId: string };
    user: SessionUser;
  } | null;

  if (!session?.user) {
    return null;
  }

  session.user.isAdmin = await isConfiguredAdminUser(appDbPool, session.user.id);

  return {
    type: "session",
    userId: session.user.id,
    sessionId: session.session.id,
    user: session.user
  };
}

export function setRequestActor(c: Context, actor: RequestActor): void {
  c.set("requestActor", actor);
  setCurrentRequestUserId(actor.userId);
  setCurrentRequestApiKeyId(actor.type === "apiKey" ? actor.apiKey.keyId : null);
  setCurrentRequestApiKeyWorkspaceIds(actor.type === "apiKey" ? actor.apiKey.workspaceIds : null);
  setCurrentRequestSessionId(actor.type === "session" ? actor.sessionId : null);

  if (actor.type === "apiKey") {
    c.set("apiKey", actor.apiKey);
    c.set("sessionUser", syntheticApiKeySessionUser(actor.apiKey));
    return;
  }

  c.set("sessionUser", actor.user);
}

export function getRequestActor(c: Context): RequestActor {
  const actor = c.get("requestActor");
  if (actor) {
    return actor;
  }

  const apiKey = c.get("apiKey");
  if (apiKey) {
    return { type: "apiKey", userId: apiKey.userId, apiKey };
  }

  const sessionUser = c.get("sessionUser");
  if (sessionUser) {
    return {
      type: "session",
      userId: sessionUser.id,
      sessionId: "",
      user: sessionUser
    };
  }

  throw new Error("Missing authenticated request actor");
}

/**
 * Platform (operator) admin: a verified user listed in ADMIN_EMAILS. Sessions
 * carry the flag resolved at sign-in lookup; a server API key inherits it from
 * its owner. Client (browser-published) keys are never admin, since anyone
 * reading the page can use them. Organization roles do not make an admin.
 */
export async function isPlatformAdminActor(actor: RequestActor | undefined): Promise<boolean> {
  if (!actor) return false;
  if (actor.type === "session") return actor.user.isAdmin === true;
  if (actor.apiKey.keyType !== "server") return false;
  return await isConfiguredAdminUser(appDbPool, actor.apiKey.userId);
}

export function getRequestUserId(c: Context): string {
  return getRequestActor(c).userId;
}

export function getApiKeyActor(c: Context): ApiKeyRequestActor | null {
  const actor = c.get("requestActor");
  return actor?.type === "apiKey" ? actor : null;
}

export function getApiKey(c: Context): ValidatedKey | null {
  return getApiKeyActor(c)?.apiKey ?? c.get("apiKey") ?? null;
}

export function requireApiKey(c: Context): ValidatedKey {
  const apiKey = getApiKey(c);
  if (!apiKey) {
    throw new Error("API key actor is required");
  }
  return apiKey;
}

export function actorHasAnyApiKeyScope(actor: RequestActor | null | undefined, scopes: string[]): boolean {
  if (!actor || actor.type !== "apiKey") {
    return false;
  }
  return scopes.some((scope) => actor.apiKey.scopes.includes(scope));
}

export function assertActorApiKeyScopes(actor: RequestActor | null | undefined, scopes: string[]): void {
  if (!actor || actor.type !== "apiKey" || scopes.length === 0) {
    return;
  }

  if (!actorHasAnyApiKeyScope(actor, scopes)) {
    throw new Error(`API key is missing one of the required scopes: ${scopes.join(", ")}`);
  }
}

export function assertActorServerApiKey(actor: RequestActor | null | undefined): void {
  if (!actor || actor.type !== "apiKey") {
    return;
  }

  if (actor.apiKey.keyType !== "server") {
    throw new Error("This endpoint requires a server API key");
  }
}

export function assertActorWorkspaceOrgScope(
  actor: RequestActor | null | undefined,
  workspace: { id?: string; workspaceId?: string; orgId: string },
): void {
  if (!actor || actor.type !== "apiKey") {
    return;
  }

  if (!actor.apiKey.orgId || workspace.orgId !== actor.apiKey.orgId) {
    throw new Error("API key is not scoped to this workspace organization");
  }
  if (!apiKeyAllowsWorkspace(actor.apiKey, workspace.workspaceId ?? workspace.id)) {
    throw new Error("API key is not allowed to use this workspace");
  }
}

export async function loadActorScopedWorkspace(
  workspaceRef: string,
  actor: RequestActor,
): Promise<WorkspaceRecord | null> {
  const workspaceId = isWorkspaceUuid(workspaceRef)
    ? workspaceRef
    : isDefaultWorkspaceAlias(workspaceRef)
      ? await resolveActorWorkspaceId(actor, null)
      : (await resolveWorkspaceRef(workspaceRef))?.id ?? workspaceRef;
  const workspace = await getWorkspace(workspaceId, actor.userId);
  if (!workspace) {
    return null;
  }

  if (actor.type === "apiKey" && !apiKeyCanUseWorkspace(actor.apiKey, workspace)) {
    return null;
  }

  addTraceMetadata({ workspaceId: workspace.id, orgId: workspace.orgId });
  return workspace;
}

/**
 * Checks API key scope and workspace access for a given request.
 *
 * - If the actor is NOT an API key, returns null (session users pass through).
 * - If the actor IS an API key but lacks the required scope, returns a 403 response.
 * - If the actor IS an API key with the scope but the workspace is not accessible, returns a 404 response.
 * - Returns null when access is granted, so callers can do: `const denied = await assertApiKeyWorkspaceAccess(...); if (denied) return denied;`
 */
export async function assertApiKeyWorkspaceAccess(
  c: Context,
  workspaceId: string,
  scope: string,
): Promise<Response | null> {
  const actor = getRequestActor(c);
  if (actor.type !== "apiKey") {
    return null;
  }
  if (!actorHasAnyApiKeyScope(actor, [scope])) {
    return apiErrorResponse(c, 403, "forbidden", "Forbidden");
  }
  const workspace = await loadActorScopedWorkspace(workspaceId, actor);
  return workspace ? null : apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
}

/**
 * Resolves the workspace a request targets to its UUID. An explicit UUID, slug
 * or former slug wins; an omitted ID or the reserved "default" lands in the
 * organization's default workspace (the API key's org, the requested org, or
 * the user's personal org). Unknown references pass through so the caller's
 * access check answers 404.
 */
export async function resolveActorWorkspaceId(
  actor: RequestActor,
  workspaceId?: string | null,
  orgId?: string | null,
): Promise<string> {
  if (workspaceId && !isDefaultWorkspaceAlias(workspaceId)) {
    const resolved = isWorkspaceUuid(workspaceId) ? workspaceId : (await resolveWorkspaceRef(workspaceId))?.id ?? workspaceId;
    if (actor.type === "apiKey" && !apiKeyAllowsWorkspace(actor.apiKey, resolved)) {
      throw new ApiKeyWorkspaceNotAllowedError();
    }
    return resolved;
  }
  if (actor.type === "apiKey") {
    const allowlist = actor.apiKey.workspaceIds ?? [];
    const workspace = await ensureDefaultWorkspace({ userId: actor.userId, orgId: actor.apiKey.orgId });
    // A key bound to workspaces defaults to the org default only when it is
    // allowlisted; otherwise to the key's first allowlisted workspace.
    return allowlist.length === 0 || allowlist.includes(workspace.id) ? workspace.id : allowlist[0]!;
  }
  const workspace = await ensureDefaultWorkspace({ userId: actor.userId, orgId });
  return workspace.id;
}

/**
 * An explicit workspace outside the API key's allowlist. It answers 404 like
 * any other inaccessible workspace (Hono renders an HTTPException's response).
 */
export class ApiKeyWorkspaceNotAllowedError extends HTTPException {
  /** Same code the workspace-access errors use, so one condition never splits across two codes. */
  readonly code = "workspace_not_found";
  constructor() {
    super(404, { message: "Workspace not found", res: Response.json(apiError("workspace_not_found", "Workspace not found"), { status: 404 }) });
  }
}

/**
 * The workspace boundary for routes that act on one workspace: resolves a UUID,
 * slug, former slug, `default` or omitted reference (see
 * resolveActorWorkspaceId), then checks the actor can see it. Throws a 404
 * WorkspaceAccessError rather than handing an unknown ID to SQL.
 */
export async function requireActorWorkspace(
  actor: RequestActor,
  workspaceRef?: string | null,
  orgId?: string | null,
): Promise<WorkspaceRecord> {
  const workspaceId = await resolveActorWorkspaceId(actor, workspaceRef, orgId);
  const workspace = await loadActorScopedWorkspace(workspaceId, actor);
  if (!workspace) {
    throw new WorkspaceAccessError(404, "workspace_not_found", "Workspace not found");
  }
  return workspace;
}

/**
 * The workspace boundary for list and filter routes, where an omitted
 * reference means "every workspace the actor can see" rather than the default
 * workspace. Any given reference, including `default`, must resolve to an
 * accessible workspace and comes back as its UUID.
 */
export async function resolveActorWorkspaceFilter(
  actor: RequestActor,
  workspaceRef?: string | null,
  orgId?: string | null,
): Promise<string | undefined> {
  const ref = workspaceRef?.trim();
  if (!ref) return undefined;
  return (await requireActorWorkspace(actor, ref, orgId)).id;
}

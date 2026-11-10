import { addTraceMetadata } from "@docslurp/shared/observability";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

import { apiError, parseProjectInput, type ProjectInputRef, type ProjectRecord } from "@docslurp/shared";

import { apiErrorResponse } from "./api-error.js";
import { auth, appDbPool } from "./auth.js";
import { isConfiguredAdminUser } from "./admin-emails.js";
import { evaluateMfaPolicy } from "./auth-mfa.js";
import { apiKeyAllowsProject, apiKeyCanUseProject } from "./api-key-project-scope.js";

export { apiKeyAllowsProject, apiKeyCanUseProject };
export { isFirstPartyAppActor } from "./first-party-app.js";
import { setCurrentRequestApiKeyId, setCurrentRequestApiKeyProjectIds, setCurrentRequestOrgId, setCurrentRequestSessionId, setCurrentRequestUserId } from "./request-context.js";
import { ApiKeyPolicyError, ClientKeyProjectsRequiredError, validateApiKey, type ValidatedKey } from "../services/api-keys.js";

export { ApiKeyPolicyError, ClientKeyProjectsRequiredError };
import { validateOAuthApiToken } from "../services/mcp-oauth.js";
import { ensureDefaultProject, findProjectForInput, getProject, type ProjectInputScope } from "../services/projects.js";
import { invalidProjectInputError, ProjectAccessError, projectInputNotFoundError } from "../services/default-project.js";

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
  /** The session passed a second factor or a user-verified passkey (auth-mfa.ts). */
  mfaVerified?: boolean;
  /** An org this user belongs to requires MFA, the grace period is over, and this session hasn't passed it. */
  mfaPolicyBlocked?: boolean;
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
  requestContext?: { origin?: string | null; referer?: string | null; ip?: string | null },
): Promise<ApiKeyRequestActor | null> {
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const raw = authorization.slice(7).trim();
  // OAuth access tokens never fall through to API-key lookup. REST-audience
  // tokens (`dscli_`, the first-party CLI) resolve to their grant's mapped key
  // identity; MCP-audience tokens (`dsmcp…`) are bound to /v1/mcp and are
  // refused here (RFC 8707).
  if (raw.startsWith("dsmcp")) return null;
  if (raw.startsWith("dscli")) {
    const oauthKey = await validateOAuthApiToken(raw, requestContext);
    return oauthKey ? { type: "apiKey", userId: oauthKey.userId, apiKey: oauthKey } : null;
  }
  const apiKey = await validateApiKey(raw, requestContext);
  return apiKey ? { type: "apiKey", userId: apiKey.userId, apiKey } : null;
}

/**
 * Resolves a session, forwarding refreshed cookies when headers are supplied.
 * MFA policy fails closed unless the API middleware explicitly opts in.
 */
export async function resolveBetterAuthSessionActor(
  headers: Headers,
  refreshedHeadersOrOptions?: Headers | { allowMfaPolicyBlocked?: boolean; signal?: AbortSignal },
  options: { allowMfaPolicyBlocked?: boolean; signal?: AbortSignal } = {},
): Promise<SessionRequestActor | null> {
  const responseHeaders = refreshedHeadersOrOptions instanceof Headers ? refreshedHeadersOrOptions : undefined;
  if (!(refreshedHeadersOrOptions instanceof Headers)) options = refreshedHeadersOrOptions ?? options;
  options.signal?.throwIfAborted();
  const result = await auth.api.getSession({ headers, returnHeaders: true }) as {
    headers: Headers | null;
    response: { session: { id: string; userId: string; mfaVerified?: boolean | null }; user: SessionUser } | null;
  } | null;
  options.signal?.throwIfAborted();
  const session = result?.response ?? null;
  if (responseHeaders) {
    for (const cookie of result?.headers?.getSetCookie() ?? []) responseHeaders.append("set-cookie", cookie);
  }

  if (!session?.user) {
    return null;
  }

  const mfaVerified = session.session.mfaVerified === true;
  // Defense in depth behind auth-mfa's strip hook: a 2FA user's session that
  // never passed the second factor authorizes nothing here either.
  if ((session.user as SessionUser & { twoFactorEnabled?: boolean | null }).twoFactorEnabled === true && !mfaVerified) {
    console.warn(`[auth-mfa] refused an unverified session for a 2FA user user=${session.user.id} session=${session.session.id}`);
    return null;
  }
  const mfaPolicyBlocked = mfaVerified ? false : (await evaluateMfaPolicy(appDbPool, session.user.id, false)).enforced;
  options.signal?.throwIfAborted();
  if (mfaPolicyBlocked && !options.allowMfaPolicyBlocked) return null;

  session.user.isAdmin = await isConfiguredAdminUser(appDbPool, session.user.id);
  options.signal?.throwIfAborted();

  return {
    type: "session",
    userId: session.user.id,
    sessionId: session.session.id,
    user: session.user,
    mfaVerified,
    mfaPolicyBlocked
  };
}

export function setRequestActor(c: Context, actor: RequestActor): void {
  c.set("requestActor", actor);
  setCurrentRequestUserId(actor.userId);
  setCurrentRequestApiKeyId(actor.type === "apiKey" ? actor.apiKey.keyId : null);
  setCurrentRequestApiKeyProjectIds(actor.type === "apiKey" ? actor.apiKey.projectIds : null);
  setCurrentRequestSessionId(actor.type === "session" ? actor.sessionId : null);
  if (actor.type === "apiKey") setCurrentRequestOrgId(actor.apiKey.orgId);

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
  // A delegated OAuth token never carries its owner's operator privileges.
  if (actor.apiKey.oauth) return false;
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

export function assertActorProjectOrgScope(
  actor: RequestActor | null | undefined,
  project: { id?: string; projectId?: string; orgId: string },
): void {
  if (!actor || actor.type !== "apiKey") {
    return;
  }

  if (!actor.apiKey.orgId || project.orgId !== actor.apiKey.orgId) {
    throw new Error("API key is not scoped to this project organization");
  }
  if (!apiKeyAllowsProject(actor.apiKey, project.projectId ?? project.id)) {
    throw new Error("API key is not allowed to use this project");
  }
}

export async function loadActorScopedProject(
  projectRef: string,
  actor: RequestActor,
  options: { refineNames?: boolean } = {},
): Promise<ProjectRecord | null> {
  // A blank reference (e.g. a missing stored ID) is never the default project here.
  if (!projectRef?.trim()) return null;
  const ref = parseProjectInput(projectRef);
  const projectId = ref.kind === "id"
    ? ref.id
    : ref.kind === "default"
      ? await resolveActorProjectId(actor, null)
      : ref.kind === "slug"
        ? (await findProjectForInput(ref, actorProjectScope(actor)))?.id
        : undefined;
  if (!projectId) return null;
  const project = await getProject(projectId, actor.userId, options);
  if (!project) {
    return null;
  }

  if (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, project)) {
    return null;
  }

  addTraceMetadata({ projectId: project.id, orgId: project.orgId });
  setCurrentRequestOrgId(project.orgId);
  return project;
}

/**
 * Checks API key scope and project access for a given request.
 *
 * - If the actor is NOT an API key, returns null (session users pass through).
 * - If the actor IS an API key but lacks the required scope, returns a 403 response.
 * - If the actor IS an API key with the scope but the project is not accessible, returns a 404 response.
 * - Returns null when access is granted, so callers can do: `const denied = await assertApiKeyProjectAccess(...); if (denied) return denied;`
 */
export async function assertApiKeyProjectAccess(
  c: Context,
  projectId: string,
  scope: string,
): Promise<Response | null> {
  const actor = getRequestActor(c);
  if (actor.type !== "apiKey") {
    return null;
  }
  if (!actorHasAnyApiKeyScope(actor, [scope])) {
    return apiErrorResponse(c, 403, "forbidden", "Forbidden");
  }
  const project = await loadActorScopedProject(projectId, actor);
  return project ? null : apiErrorResponse(c, 404, "project_not_found", "Project not found");
}

/**
 * Where an actor's `project` values may resolve: an API key only inside its
 * organization and project allowlist; a session inside `orgId` when the
 * request names one, otherwise any project the user can reach.
 */
export function actorProjectScope(actor: RequestActor, orgId?: string | null): ProjectInputScope {
  if (actor.type === "apiKey") {
    return { userId: actor.userId, orgId: actor.apiKey.orgId ?? null, allowedProjectIds: actor.apiKey.projectIds ?? null };
  }
  return { userId: actor.userId, orgId: orgId?.trim() || null };
}

/**
 * Looks up a public `project` value (UUID, slug, former slug or name; see
 * parseProjectInput) among the projects the actor may use. Returns the
 * parsed reference with the match, or `project: null` when nothing matches,
 * so uploads can create the project. Omitted and "default" values come back
 * as `{ kind: "default" }` for the caller's default handling. Throws a 400 for
 * a value with no letters or digits.
 */
export async function lookupActorProject(
  actor: RequestActor,
  input: string | null | undefined,
  orgId?: string | null,
): Promise<
  | { ref: { kind: "default" } }
  | { ref: Extract<ProjectInputRef, { kind: "id" } | { kind: "slug" }>; project: { id: string; orgId: string } | null }
> {
  const ref = parseProjectInput(input);
  if (ref.kind === "invalid") throw invalidProjectInputError(ref.input);
  if (ref.kind === "default") return { ref };
  return { ref, project: await findProjectForInput(ref, actorProjectScope(actor, orgId)) };
}

/**
 * Resolves the project a request targets to its UUID. An explicit UUID,
 * slug, former slug or name wins and must name a project the actor can use
 * (404 `project_not_found` naming the slug otherwise); an omitted value or
 * the reserved "default" lands in the organization's default project (the
 * API key's org, the requested org, or the user's personal org).
 */
export async function resolveActorProjectId(
  actor: RequestActor,
  project?: string | null,
  orgId?: string | null,
): Promise<string> {
  const lookup = await lookupActorProject(actor, project, orgId);
  if (lookup.ref.kind !== "default") {
    const found = "project" in lookup ? lookup.project : null;
    if (!found) throw projectInputNotFoundError(lookup.ref.kind === "slug" ? { slug: lookup.ref.slug } : { id: lookup.ref.id });
    // The lookup is already scoped to the key's allowlist; checked again here as the request boundary.
    if (actor.type === "apiKey" && !apiKeyAllowsProject(actor.apiKey, found.id)) throw new ApiKeyProjectNotAllowedError();
    return found.id;
  }
  if (actor.type === "apiKey") {
    const allowlist = actor.apiKey.projectIds ?? [];
    const defaultProject = await ensureDefaultProject({ userId: actor.userId, orgId: actor.apiKey.orgId });
    // A key bound to projects defaults to the org default only when it is
    // allowlisted; otherwise to the key's first allowlisted project.
    return allowlist.length === 0 || allowlist.includes(defaultProject.id) ? defaultProject.id : allowlist[0]!;
  }
  const defaultProject = await ensureDefaultProject({ userId: actor.userId, orgId });
  return defaultProject.id;
}

/**
 * An explicit project outside the API key's allowlist. It answers 404 like
 * any other inaccessible project (Hono renders an HTTPException's response).
 */
export class ApiKeyProjectNotAllowedError extends HTTPException {
  /** Same code the project-access errors use, so one condition never splits across two codes. */
  readonly code = "project_not_found";
  constructor() {
    super(404, { message: "Project not found", res: Response.json(apiError("project_not_found", "Project not found"), { status: 404 }) });
  }
}

/**
 * The project boundary for routes that act on one project: resolves a UUID,
 * slug, former slug, name, `default` or omitted reference (see
 * resolveActorProjectId), then checks the actor can see it. Throws a 404
 * ProjectAccessError rather than handing an unknown ID to SQL.
 */
export async function requireActorProject(
  actor: RequestActor,
  projectRef?: string | null,
  orgId?: string | null,
): Promise<ProjectRecord> {
  const projectId = await resolveActorProjectId(actor, projectRef, orgId);
  const project = await loadActorScopedProject(projectId, actor);
  if (!project) {
    throw new ProjectAccessError(404, "project_not_found", "Project not found");
  }
  return project;
}

/**
 * The project boundary for list and filter routes, where an omitted
 * reference means "every project the actor can see" rather than the default
 * project. Any given reference, including `default`, must resolve to an
 * accessible project and comes back as its UUID.
 */
export async function resolveActorProjectFilter(
  actor: RequestActor,
  projectRef?: string | null,
  orgId?: string | null,
): Promise<string | undefined> {
  const ref = projectRef?.trim();
  if (!ref) return undefined;
  return (await requireActorProject(actor, ref, orgId)).id;
}

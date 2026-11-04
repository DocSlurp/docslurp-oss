import { Hono, type MiddlewareHandler } from "hono";
import { isDefaultProjectAlias, isProjectUuid, PROJECT_ROUTE_SEGMENTS } from "@docslurp/shared";

import { apiKeyAllowsProject, getRequestActor, resolveActorProjectId, setRequestActor } from "../lib/request-actor.js";
import { apiErrorResponse } from "../lib/api-error.js";
import { ensureDefaultProject, resolveProjectRef } from "../services/projects.js";
import { setCurrentRequestProjectId } from "../lib/request-context.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PROJECT_PATH = /^(.*?\/v1\/projects\/)([^/]+)(\/.*)?$/;

/**
 * Lets `/v1/projects/:ref/...` take a slug, a former slug (renamed projects
 * keep resolving, like GitHub repository redirects) or `default` (the caller's
 * organization default project) as well as the UUID. Hono matches routes
 * before middleware runs, so a resolved request is re-dispatched into the
 * project routers with the authenticated actor; auth and rate limiting are
 * not repeated. Responses carry `X-DocSlurp-Project-Id` and
 * `X-DocSlurp-Project-Slug`, plus `X-DocSlurp-Project-Renamed-From` when an
 * old slug was used, so clients can update stored links.
 */
export function projectRefPath(routers: Hono[]): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const match = PROJECT_PATH.exec(url.pathname);
    const ref = match ? decodeURIComponent(match[2]!) : null;
    if (!match || !ref || isProjectUuid(ref) || PROJECT_ROUTE_SEGMENTS.has(ref)) return next();

    const actor = getRequestActor(c);
    let projectId: string;
    let renamedFrom: string | null = null;
    if (isDefaultProjectAlias(ref) && actor.type === "apiKey" && !SAFE_METHODS.has(c.req.method.toUpperCase())) {
      // A key's change to `default` means its organization's default project,
      // never a stand-in from its allowlist: outside the allowlist it is not found.
      const defaultProject = await ensureDefaultProject({ userId: actor.userId, orgId: actor.apiKey.orgId });
      if (!apiKeyAllowsProject(actor.apiKey, defaultProject.id)) {
        return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      }
      projectId = defaultProject.id;
    } else if (isDefaultProjectAlias(ref)) {
      projectId = await resolveActorProjectId(actor, null, url.searchParams.get("orgId"));
    } else {
      const resolved = await resolveProjectRef(ref);
      if (!resolved) return next();
      projectId = resolved.id;
      renamedFrom = resolved.renamedFrom;
    }
    setCurrentRequestProjectId(projectId);
    url.pathname = `/v1/projects/${encodeURIComponent(projectId)}${match[3] ?? ""}`;

    const rateLimitChecked = c.get("rateLimitActorChecked");
    const resolvedApp = new Hono();
    resolvedApp.use("*", async (inner, innerNext) => {
      setRequestActor(inner, actor);
      if (rateLimitChecked) inner.set("rateLimitActorChecked", true);
      await innerNext();
    });
    for (const router of routers) resolvedApp.route("/v1/projects", router);
    const response = await resolvedApp.fetch(new Request(url, c.req.raw), c.env);

    // Identity headers only when the route granted access; a 401/403/404 must
    // not reveal which project (or org) a slug belongs to.
    if (response.status >= 400) return response;
    const current = await resolveProjectRef(projectId);
    const headers = new Headers(response.headers);
    headers.set("X-DocSlurp-Project-Id", projectId);
    if (current) headers.set("X-DocSlurp-Project-Slug", current.slug);
    if (renamedFrom) headers.set("X-DocSlurp-Project-Renamed-From", renamedFrom);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

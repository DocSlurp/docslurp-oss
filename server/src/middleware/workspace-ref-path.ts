import { Hono, type MiddlewareHandler } from "hono";
import { isDefaultWorkspaceAlias, isWorkspaceUuid, WORKSPACE_ROUTE_SEGMENTS } from "@docslurp/shared";

import { getRequestActor, resolveActorWorkspaceId, setRequestActor } from "../lib/request-actor.js";
import { resolveWorkspaceRef } from "../services/workspaces.js";
import { setCurrentRequestWorkspaceId } from "../lib/request-context.js";

const WORKSPACE_PATH = /^(.*?\/v1\/workspaces\/)([^/]+)(\/.*)?$/;

/**
 * Lets `/v1/workspaces/:ref/...` take a slug, a former slug (renamed workspaces
 * keep resolving, like GitHub repository redirects) or `default` (the caller's
 * organization default workspace) as well as the UUID. Hono matches routes
 * before middleware runs, so a resolved request is re-dispatched into the
 * workspace routers with the authenticated actor; auth and rate limiting are
 * not repeated. Responses carry `X-DocSlurp-Workspace-Id` and
 * `X-DocSlurp-Workspace-Slug`, plus `X-DocSlurp-Workspace-Renamed-From` when an
 * old slug was used, so clients can update stored links.
 */
export function workspaceRefPath(routers: Hono[]): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const match = WORKSPACE_PATH.exec(url.pathname);
    const ref = match ? decodeURIComponent(match[2]!) : null;
    if (!match || !ref || isWorkspaceUuid(ref) || WORKSPACE_ROUTE_SEGMENTS.has(ref)) return next();

    const actor = getRequestActor(c);
    let workspaceId: string;
    let renamedFrom: string | null = null;
    if (isDefaultWorkspaceAlias(ref)) {
      workspaceId = await resolveActorWorkspaceId(actor, null, url.searchParams.get("orgId"));
    } else {
      const resolved = await resolveWorkspaceRef(ref);
      if (!resolved) return next();
      workspaceId = resolved.id;
      renamedFrom = resolved.renamedFrom;
    }
    setCurrentRequestWorkspaceId(workspaceId);
    url.pathname = `/v1/workspaces/${encodeURIComponent(workspaceId)}${match[3] ?? ""}`;

    const rateLimitChecked = c.get("rateLimitActorChecked");
    const resolvedApp = new Hono();
    resolvedApp.use("*", async (inner, innerNext) => {
      setRequestActor(inner, actor);
      if (rateLimitChecked) inner.set("rateLimitActorChecked", true);
      await innerNext();
    });
    for (const router of routers) resolvedApp.route("/v1/workspaces", router);
    const response = await resolvedApp.fetch(new Request(url, c.req.raw), c.env);

    // Identity headers only when the route granted access; a 401/403/404 must
    // not reveal which workspace (or org) a slug belongs to.
    if (response.status >= 400) return response;
    const current = await resolveWorkspaceRef(workspaceId);
    const headers = new Headers(response.headers);
    headers.set("X-DocSlurp-Workspace-Id", workspaceId);
    if (current) headers.set("X-DocSlurp-Workspace-Slug", current.slug);
    if (renamedFrom) headers.set("X-DocSlurp-Workspace-Renamed-From", renamedFrom);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

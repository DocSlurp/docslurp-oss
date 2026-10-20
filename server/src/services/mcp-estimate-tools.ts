import { Hono } from "hono";

import { publicErrorMiddleware } from "../lib/public-errors.js";
import { setRequestActor, type RequestActor } from "../lib/request-actor.js";
import { documentsRoutes } from "../routes/documents.js";
import { jobsRoutes } from "../routes/jobs.js";
import { runsRoutes } from "../routes/runs.js";
import { uploadEstimateRoutes } from "../routes/uploads.js";
import { workspaceGraphRoutes } from "../routes/workspace-graph.js";
import { workspacesRoutes } from "../routes/workspaces.js";
import { spendAwareErrorHandler } from "./billing/spend-guard.js";

export * from "./mcp-estimate-catalog.js";

const ROUTE_MOUNTS: Array<{ prefix: string; routes: Hono }> = [
  { prefix: "/v1/workspaces", routes: workspacesRoutes },
  { prefix: "/v1/workspaces", routes: workspaceGraphRoutes },
  { prefix: "/v1/documents", routes: documentsRoutes },
  { prefix: "/v1/runs", routes: runsRoutes },
  { prefix: "/v1/uploads", routes: uploadEstimateRoutes },
  { prefix: "/v1/jobs", routes: jobsRoutes },
];

const actors = new WeakMap<Request, RequestActor>();
let forwardApp: Hono | undefined;

function buildForwardApp(): Hono {
  const app = new Hono().use("*", publicErrorMiddleware).use("*", async (c, next) => {
    const actor = actors.get(c.req.raw);
    if (actor) setRequestActor(c, actor);
    await next();
  });
  for (const { prefix, routes } of ROUTE_MOUNTS) app.route(prefix, routes);
  app.onError(spendAwareErrorHandler);
  return app;
}

/** Issues the request in-process against the owning route modules (built once), like workspace.search does. */
export async function forwardInProcess(actor: RequestActor, method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  forwardApp ??= buildForwardApp();
  const request = new Request(`http://mcp.internal${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  actors.set(request, actor);
  return forwardApp.fetch(request);
}

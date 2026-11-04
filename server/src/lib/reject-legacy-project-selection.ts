import type { MiddlewareHandler } from "hono";
import { middlewareErrorResponse } from "./api-error.js";

const legacyKeys = new Set(["workspace", "workspaces", "workspaceId", "workspaceIds", "workspaceName", "newWorkspace", "workspace_id", "workspace_ids"]);

export function hasLegacyProjectSelection(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).some((key) => legacyKeys.has(key));
}

/** Run after authentication and the actual-byte body limit. Never let an old
 * selector disappear during schema parsing and silently choose a default project.
 * Only inspect protocol-owned selection fields; customer metadata stays opaque.
 */
export const rejectLegacyProjectSelection: MiddlewareHandler = async (c, next) => {
  const reject = () => middlewareErrorResponse(c, 400, "invalid_request", "Workspace selection is no longer supported. Use project, projectId, projectIds, projectName or newProject.");
  if (hasLegacyProjectSelection(c.req.query())) return reject();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
    const contentType = c.req.header("content-type") ?? "";
    if (/\bjson\b/i.test(contentType)) {
      // Hono caches this read for the route. The preceding body limiter bounds it.
      const body: unknown = await c.req.json().catch(() => null);
      if (hasLegacyProjectSelection(body)) return reject();
      if (body && typeof body === "object" && "docslurp" in body && hasLegacyProjectSelection(body.docslurp)) return reject();
    } else if (/multipart\/form-data|application\/x-www-form-urlencoded/i.test(contentType)) {
      const body = await c.req.parseBody({ all: true }).catch(() => null);
      if (hasLegacyProjectSelection(body)) return reject();
    }
  }
  await next();
};

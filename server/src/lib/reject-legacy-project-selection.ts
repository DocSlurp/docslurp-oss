import type { Context, MiddlewareHandler } from "hono";
import { middlewareErrorResponse } from "./api-error.js";
import { observedBodyBytes } from "./bounded-body-limit.js";
import { BODY_METHODS, bodyMediaKind, framingDeclaresBody } from "./media-type.js";

const legacyKeys = new Set(["workspace", "workspaces", "workspaceId", "workspaceIds", "workspaceName", "newWorkspace", "workspace_id", "workspace_ids"]);

export function hasLegacyProjectSelection(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).some((key) => legacyKeys.has(key));
}

/** Run after authentication and the actual-byte body limit. Never let an old
 * selector disappear during schema parsing and silently choose a default project.
 * Only inspect protocol-owned selection fields; customer metadata stays opaque.
 */
/** The refusal for a body that is not JSON, form or multipart; shared with the /v1 body limit's early check. */
export function nonJsonBodyRefusal(c: Context): Response {
  return middlewareErrorResponse(c, 400, "invalid_request", "JSON API requests require application/json; legacy selection must not bypass validation through Content-Type.");
}

export const rejectLegacyProjectSelection: MiddlewareHandler = async (c, next) => {
  const reject = () => middlewareErrorResponse(c, 400, "invalid_request", "Workspace selection is no longer supported. Use project, projectId, projectIds, projectName or newProject.");
  if (hasLegacyProjectSelection(c.req.query())) return reject();
  if (BODY_METHODS.has(c.req.method)) {
    const kind = bodyMediaKind(c.req.header("content-type"));
    // A body-less POST (`fetch` with no body sends no Content-Type) is not content.
    if ((kind === "other" || kind === "none") && await carriesBytes(c.req.raw)) return nonJsonBodyRefusal(c);
    if (kind === "json") {
      // Clone preserves raw transport consumers such as MCP. Prior limits bound bytes.
      const body: unknown = await c.req.raw.clone().json().catch(() => null);
      if (hasLegacyProjectSelection(body)) return reject();
      if (body && typeof body === "object" && "docslurp" in body && hasLegacyProjectSelection(body.docslurp)) return reject();
      if (body && typeof body === "object" && "params" in body) {
        const params = body.params;
        if (params && typeof params === "object" && "arguments" in params && hasLegacyProjectSelection(params.arguments)) return reject();
      }
    } else if (kind === "form" || kind === "multipart") {
      const body = await c.req.parseBody({ all: true }).catch(() => null);
      if (hasLegacyProjectSelection(body)) return reject();
    }
  }
  await next();
};

/** How long to wait for the first chunk of a body no limiter counted and no header describes. */
export const BODY_PEEK_TIMEOUT_MS = 250;

/**
 * Whether the request carries content. Node hosts give every POST a body
 * stream, empty or not, so `request.body !== null` alone does not say so.
 * - Counted by a bounded body limit (every /v1 path): the observed bytes decide,
 *   whatever the headers claim.
 * - Otherwise, from the framing: a positive Content-Length or any
 *   Transfer-Encoding is content; `Content-Length: 0` is not. Decided without
 *   reading, so a client that declares a body and sends nothing cannot hold the
 *   connection here.
 * - Neither (an in-process Request): peek a clone for the first non-empty
 *   chunk, for at most BODY_PEEK_TIMEOUT_MS; silence counts as content.
 */
async function carriesBytes(request: Request): Promise<boolean> {
  if (!request.body) return false;
  const observed = observedBodyBytes(request);
  if (observed !== undefined) return observed > 0;
  if (framingDeclaresBody(request.headers)) return true;
  if (request.headers.has("content-length")) return false;
  const reader = request.clone().body?.getReader();
  if (!reader) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<true>(resolve => { timer = setTimeout(() => resolve(true), BODY_PEEK_TIMEOUT_MS); });
  const peek = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      if (value.byteLength > 0) return true;
    }
  })();
  try {
    return await Promise.race([peek, timeout]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    peek.catch(() => {});
  }
}

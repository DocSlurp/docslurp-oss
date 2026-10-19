import type { MiddlewareHandler } from "hono";
import { middlewareErrorResponse } from "./api-error.js";

/** JSON bodies larger than this are not scanned (uploads and streams do not go through here). */
const MAX_SCANNED_BODY_BYTES = 2 * 1024 * 1024;

/** A `\\u0000` escape that is not itself escaped (an even number of preceding backslashes). */
const JSON_NUL_ESCAPE = /(?<!\\)(?:\\\\)*\\u0000/i;

/**
 * Postgres text values cannot contain NUL, so one in any string a client sends
 * ends as a 22021 error and an HTTP 500 wherever it is stored or used as a
 * query parameter (search filters, document ids, workspace names, ...). JSON
 * allows it, so answer with a clear 400 at the edge instead of fixing each
 * field. File uploads and non-JSON bodies are not inspected.
 */
export const rejectNulBytes: MiddlewareHandler = async (c, next) => {
  const reject = () => middlewareErrorResponse(c, 400, "invalid_request", "Request contains a NUL (\\u0000) character, which is not supported.");

  if (/%00/i.test(c.req.url)) return reject();

  const contentType = c.req.header("content-type") ?? "";
  const length = Number(c.req.header("content-length") ?? "0");
  if (/\bjson\b/i.test(contentType) && length <= MAX_SCANNED_BODY_BYTES && ["POST", "PUT", "PATCH"].includes(c.req.method)) {
    // Inspect a clone: Hono caches c.req.text(), but raw Request consumers
    // (MCP transport and body-limit middleware) cannot use that cache.
    const body = await c.req.raw.clone().text().catch(() => "");
    if (JSON_NUL_ESCAPE.test(body)) return reject();
  }
  await next();
};

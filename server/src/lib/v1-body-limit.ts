import type { MiddlewareHandler } from "hono";
import { nativeBodyLimit } from "./api-error.js";
import { multipartBodyLimit } from "./upload-policy.js";

/** Largest JSON body accepted before validation on non-upload `/v1/*` routes. */
export const JSON_BODY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The `/v1/*` body cap. It bounds the actual bytes before NUL inspection or any
 * route reader, whatever Content-Length says, and picks the smallest applicable
 * cap first, so a JSON request to an upload path cannot buffer the file cap.
 * `/v1/mcp` has its own protocol-specific cap.
 */
export function v1BodyLimit(limits: { maxUploadBytes: number; maxMultipartUploadBytes: number }): MiddlewareHandler {
  const multipart = multipartBodyLimit(limits.maxMultipartUploadBytes);
  const upload = nativeBodyLimit(limits.maxUploadBytes);
  const json = nativeBodyLimit(JSON_BODY_MAX_BYTES);
  return async (c, next) => {
    if (c.req.path === "/v1/mcp") return next();
    const uploadPath = /^\/v1\/(?:uploads|ingest|extracts)(?:\/|$)/.test(c.req.path);
    const jsonType = /\bjson\b/i.test(c.req.header("content-type") ?? "");
    if (uploadPath && !jsonType) return (/\/bulk\/?$/.test(c.req.path) ? multipart : upload)(c, next);
    return json(c, next);
  };
}

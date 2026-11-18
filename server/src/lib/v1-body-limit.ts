import type { MiddlewareHandler } from "hono";
import { nativeBodyLimit } from "./api-error.js";
import { multipartBodyLimit } from "./upload-policy.js";
import { BODY_METHODS, bodyMediaKind, framingDeclaresBody } from "./media-type.js";
import { nonJsonBodyRefusal } from "./reject-legacy-project-selection.js";

/** Largest JSON body accepted before validation on non-upload `/v1/*` routes. */
export const JSON_BODY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The `/v1/*` body cap. It bounds the actual bytes before NUL inspection or any
 * route reader, whatever Content-Length says, and picks the smallest applicable
 * cap first, so a JSON request to an upload path cannot buffer the file cap.
 * - A body the content-type guard would refuse anyway (not JSON, form or
 *   multipart) whose framing declares bytes is refused before any byte is read.
 * - The bulk multipart route never exceeds the multipart cap, whatever the
 *   content-type parameters say (a JSON body there gets the smaller of the two).
 * - `/v1/mcp` has its own protocol-specific cap.
 */
export function v1BodyLimit(limits: { maxUploadBytes: number; maxMultipartUploadBytes: number }): MiddlewareHandler {
  const multipart = multipartBodyLimit(limits.maxMultipartUploadBytes);
  const upload = nativeBodyLimit(limits.maxUploadBytes);
  const json = nativeBodyLimit(JSON_BODY_MAX_BYTES);
  const bulkJson = JSON_BODY_MAX_BYTES < limits.maxMultipartUploadBytes ? json : multipart;
  return async (c, next) => {
    const kind = bodyMediaKind(c.req.header("content-type"));
    if (BODY_METHODS.has(c.req.method) && (kind === "other" || kind === "none") && framingDeclaresBody(c.req.raw.headers)) {
      return nonJsonBodyRefusal(c);
    }
    if (c.req.path === "/v1/mcp") return next();
    const uploadPath = /^\/v1\/(?:uploads|ingest|extracts)(?:\/|$)/.test(c.req.path);
    if (uploadPath && /\/bulk\/?$/.test(c.req.path)) return (kind === "json" ? bulkJson : multipart)(c, next);
    if (uploadPath && kind !== "json") return upload(c, next);
    return json(c, next);
  };
}

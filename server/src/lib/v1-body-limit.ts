import type { Context, MiddlewareHandler } from "hono";
import { CHAT_VOICE_MAX_BYTES } from "@docslurp/shared/chat-voice";
import { middlewareErrorResponse, nativeBodyLimit } from "./api-error.js";
import { multipartBodyLimit } from "./upload-policy.js";
import { BODY_METHODS, bodyMediaKind, framingDeclaresBody, type BodyMediaKind } from "./media-type.js";

/** Largest JSON body accepted before validation on `/v1/*` routes. */
export const JSON_BODY_MAX_BYTES = 8 * 1024 * 1024;

type BodyCap = "json" | "multipart" | "voice";

/**
 * Which request bodies each `/v1/*` endpoint accepts, and its cap. Every
 * endpoint takes JSON only (JSON cap) unless listed here. No `/v1` route takes
 * a raw file body: files arrive as multipart on the bulk routes, or go
 * straight to storage through direct upload sessions.
 */
const V1_BODY_ROUTES: ReadonlyArray<{ pattern: RegExp; kinds: readonly BodyMediaKind[]; cap: BodyCap }> = [
  { pattern: /^\/v1\/(?:uploads|ingest|extracts)\/bulk\/?$/, kinds: ["multipart"], cap: "multipart" },
  { pattern: /^\/v1\/projects\/[^/]+\/chat\/transcribe\/?$/, kinds: ["multipart"], cap: "voice" },
  // The identity provider posts the SAML response as a browser form.
  { pattern: /^\/v1\/auth\/saml\/[^/]+\/callback\/?$/, kinds: ["form"], cap: "json" },
];
const JSON_ONLY = { kinds: ["json"] as readonly BodyMediaKind[], cap: "json" as BodyCap };

function v1BodyRoute(path: string) {
  return V1_BODY_ROUTES.find((route) => route.pattern.test(path)) ?? JSON_ONLY;
}

/** The body media kinds `path` accepts (`none` is always allowed for a body-less request). */
export function acceptedBodyKinds(path: string): readonly BodyMediaKind[] {
  return v1BodyRoute(path).kinds;
}

/**
 * A body of a media type the endpoint does not take: 415, in the caller's error
 * shape. `details.policy` names the expected type, so the public envelope gets
 * its reviewed copy ("Send the request body as application/json.").
 */
export function unsupportedBodyResponse(c: Context): Response {
  const kinds = acceptedBodyKinds(c.req.path);
  const accepted = kinds.map((kind) =>
    kind === "json" ? "application/json" : kind === "multipart" ? "multipart/form-data" : "application/x-www-form-urlencoded");
  return middlewareErrorResponse(c, 415, "unsupported_type", `This endpoint accepts ${accepted.join(" or ")} request bodies.`, { policy: `request_body:${kinds[0]}` });
}

/**
 * The `/v1/*` body cap, chosen per endpoint from V1_BODY_ROUTES. It bounds the
 * actual bytes before NUL inspection or any route reader, whatever
 * Content-Length says.
 * - A body of a media type the endpoint does not accept, whose framing declares
 *   bytes, is refused (415) before any byte is read.
 * - Without reliable framing (an in-process Request) such a body is read under
 *   the JSON cap only; the content-type guard then refuses it on the bytes counted.
 * - `/v1/mcp` has its own protocol-specific cap.
 */
export function v1BodyLimit(limits: { maxMultipartUploadBytes: number }): MiddlewareHandler {
  const caps: Record<BodyCap, MiddlewareHandler> = {
    json: nativeBodyLimit(JSON_BODY_MAX_BYTES),
    multipart: multipartBodyLimit(limits.maxMultipartUploadBytes),
    // The recording plus its multipart framing (chat-voice.ts applies the exact limit).
    voice: nativeBodyLimit(CHAT_VOICE_MAX_BYTES + 16 * 1024),
  };
  return async (c, next) => {
    if (c.req.path === "/v1/mcp") return next();
    const route = v1BodyRoute(c.req.path);
    const kind = bodyMediaKind(c.req.header("content-type"));
    const accepted = route.kinds.includes(kind);
    // A declared body this endpoint does not read is refused unread. A chunked body with no
    // Content-Type may be empty, so it is read (under the JSON cap) and decided on the bytes counted.
    const declaredLength = Number(c.req.header("content-length") ?? "0");
    const chunkedWithoutType = kind === "none" && c.req.raw.headers.has("transfer-encoding") && !(declaredLength > 0);
    if (BODY_METHODS.has(c.req.method) && !accepted && !chunkedWithoutType && framingDeclaresBody(c.req.raw.headers)) return unsupportedBodyResponse(c);
    return caps[accepted ? route.cap : "json"](c, next);
  };
}

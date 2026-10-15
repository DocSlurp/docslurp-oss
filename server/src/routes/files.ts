import { Hono, type Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

import { openArtifactObject } from "../lib/artifacts.js";
import { openFileToken } from "../lib/file-tokens.js";
import { actorHasAnyApiKeyScope, getRequestActor } from "../lib/request-actor.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { userCanAccessArtifactUri } from "../services/documents.js";

/**
 * The file proxy: the only way a client reads a stored document or artifact.
 *
 * `GET /v1/files/:token/:name` streams one object from private storage after:
 * 1. authenticating the caller (cookie session or API key; see sessionAuth),
 * 2. opening the sealed token (lib/file-tokens.ts): genuine, unexpired,
 * 3. matching the token's user and credential to the caller's,
 * 4. re-checking document access now (membership, key workspace allowlist,
 *    key org, PII withholding), so revocations apply to URLs already issued.
 * Every failure answers the same 404 and reveals nothing about why.
 *
 * Storage stays private: no presigned URLs, no bucket CORS for reads, no
 * storage origins in the CSP. Responses are never stored (private, no-store),
 * never sniffed, sandboxed when opened directly, and same-origin only for
 * browsers. ETag/If-None-Match still let API clients revalidate cheaply.
 */

/** Rendered inline; everything else downloads as an opaque attachment. */
const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json"
]);

const EXTENSION_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json"
};

const SANDBOX_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox";
/**
 * Browser PDF viewers refuse to run in a sandboxed document and run PDF script
 * in their own sandbox; only framing is restricted (same-origin inspector).
 */
const PDF_CSP = "frame-ancestors 'self'";

function notFound(c: Context) {
  c.header("Cache-Control", "no-store");
  return c.json({ error: "Not found" }, 404);
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function responseType(stored: string | undefined, name: string): { type: string; inline: boolean } {
  const declared = (stored ?? "").split(";")[0]!.trim().toLowerCase();
  const fromName = EXTENSION_TYPES[name.split(".").pop()?.toLowerCase() ?? ""];
  const base = declared && declared !== "application/octet-stream" && declared !== "binary/octet-stream" ? declared : fromName ?? "application/octet-stream";
  if (INLINE_TYPES.has(base)) {
    return { type: base.startsWith("text/") || base === "application/json" ? `${base}; charset=utf-8` : base, inline: true };
  }
  if (base.startsWith("audio/") || base.startsWith("video/")) {
    return { type: base, inline: true };
  }
  // HTML, SVG, XML and unknown types never render on our origin.
  return { type: "application/octet-stream", inline: false };
}

function contentDisposition(inline: boolean, name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function storageStatus(error: unknown): number | undefined {
  const meta = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata;
  return meta?.httpStatusCode;
}

export const filesRoutes = new Hono()
  .get("/:token/:name", async (c) => {
    const claims = openFileToken(c.req.param("token"));
    if (!claims) return notFound(c);

    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["artifacts"])) return notFound(c);
    const binding = actor.type === "apiKey" ? `k:${actor.apiKey.keyId}` : actor.sessionId ? `s:${actor.sessionId}` : "";
    if (!binding || !sameSecret(claims.sub, actor.userId) || !sameSecret(claims.bind, binding)) return notFound(c);

    let name: string;
    try {
      name = decodeURIComponent(c.req.param("name"));
    } catch {
      return notFound(c);
    }
    if (name !== claims.name) return notFound(c);

    const orgId = actor.type === "apiKey" ? actor.apiKey.orgId : undefined;
    if (!(await userCanAccessArtifactUri(claims.uri, actor.userId, orgId))) return notFound(c);

    const range = c.req.header("range");
    let object: Awaited<ReturnType<typeof openArtifactObject>>;
    try {
      object = await openArtifactObject(claims.uri, {
        range: range && /^bytes=\d*-\d*$/.test(range) ? range : undefined,
        ifNoneMatch: c.req.header("if-none-match") || undefined,
        signal: c.req.raw.signal
      });
    } catch (error) {
      const status = storageStatus(error);
      if (status === 304) {
        c.header("Cache-Control", "private, no-store");
        c.header("Vary", "Cookie, Authorization");
        const etag = c.req.header("if-none-match");
        if (etag) c.header("ETag", etag);
        return c.body(null, 304);
      }
      if (status === 416) {
        c.header("Cache-Control", "no-store");
        return c.body(null, 416);
      }
      if (status === 404 || status === 403) return notFound(c);
      throw error;
    }

    const { type, inline } = responseType(object.ContentType, claims.name);
    const headers = new Headers({
      "Content-Type": type,
      "Content-Disposition": contentDisposition(inline, claims.name),
      // Sensitive bytes never land in a browser or proxy disk cache.
      "Cache-Control": "private, no-store",
      Vary: "Cookie, Authorization",
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": type === "application/pdf" ? PDF_CSP : SANDBOX_CSP,
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "SAMEORIGIN"
    });
    if (object.ContentLength !== undefined) headers.set("Content-Length", String(object.ContentLength));
    if (object.ContentRange) headers.set("Content-Range", object.ContentRange);
    if (object.ETag) headers.set("ETag", object.ETag);
    if (object.LastModified) headers.set("Last-Modified", object.LastModified.toUTCString());

    const body = object.Body as Readable | undefined;
    if (c.req.method === "HEAD" || !body) {
      body?.destroy?.();
      return new Response(null, { status: object.ContentRange ? 206 : 200, headers });
    }
    return new Response(Readable.toWeb(body) as ReadableStream, { status: object.ContentRange ? 206 : 200, headers });
  });

acceptApiKeys(filesRoutes);

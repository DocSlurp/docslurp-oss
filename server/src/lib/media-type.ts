/**
 * The one request media-type classification, shared by the `/v1/*` body-cap
 * selection, the content-type guard (reject-legacy-project-selection), the NUL
 * scan and the bulk multipart reader, so header parameters (`; x=json`) or
 * case cannot make one of them see a different kind than another. The media
 * type is the part before the first `;`, trimmed and lowercased: the same
 * rule Hono's parseBody uses.
 */
export type BodyMediaKind = "none" | "json" | "form" | "multipart" | "other";

export function mediaTypeOf(header: string | null | undefined): string | null {
  const type = header?.split(";")[0]?.trim().toLowerCase();
  return type ? type : null;
}

/**
 * JSON exactly as Hono's validator("json") accepts it (the whole header,
 * parameters included), so the content-type guard never inspects a body the
 * route's validator would ignore: `application/json`, `application/*+json`.
 */
const HONO_JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

export function bodyMediaKind(header: string | null | undefined): BodyMediaKind {
  const type = mediaTypeOf(header);
  if (!type) return "none";
  if (type === "multipart/form-data") return "multipart";
  if (type === "application/x-www-form-urlencoded") return "form";
  if (HONO_JSON_CONTENT_TYPE.test(header!.trim())) return "json";
  return "other";
}

/** Methods whose request body the API reads. */
export const BODY_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Whether the request's framing declares body bytes: a positive Content-Length
 * or any Transfer-Encoding. For a request from the network the framing is
 * what the HTTP parser read; an in-process Request's headers can disagree with
 * its stream, so callers that need certainty count the bytes instead.
 */
export function framingDeclaresBody(headers: Headers): boolean {
  if (headers.has("transfer-encoding")) return true;
  const declared = headers.get("content-length");
  return declared !== null && declared.trim() !== "0";
}

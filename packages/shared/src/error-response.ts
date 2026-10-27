import { friendlyErrorMessage, publicErrorForStatus, PUBLIC_ERROR_MESSAGES } from "./public-errors.js";
import { reportException } from "./error-reporting.js";
import { apiErrorCodeForStatus, isApiErrorCode, publicApiErrorDetails, publicApiErrorEnvelope, publicApiErrorLinks, publicApiErrorMessage } from "./api-error.js";

export type PublicErrorReporter = (error: unknown, context?: Record<string, string | number | boolean>) => string;

/** Reports an exception to telemetry and returns the only copy safe to show a browser. */
export const reportPublicError: PublicErrorReporter = (error, context = {}) => {
  reportException(error, context);
  return PUBLIC_ERROR_MESSAGES.unexpected;
};

/**
 * Last line of defence for handled errors, including third-party auth responses.
 * With `native`, every error body leaves as the native envelope, whatever
 * shape the handler produced; protocol surfaces pass `native: false` and keep
 * the shape their clients speak.
 */
export async function safeErrorResponse(response: Response, requestId?: string, report: PublicErrorReporter = reportPublicError, native = false): Promise<Response> {
  if (response.status < 400) return response;
  const message = publicErrorForStatus(response.status);
  let body: Record<string, unknown> = { error: message };
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      const original = await response.clone().json();
      // Retain protocol envelopes and machine codes, but never arbitrary details.
      if (original && typeof original === "object") {
        // The native envelope is already closed vocabulary: code, reviewed copy and field paths.
        const envelope = publicApiErrorEnvelope(original, response.status, requestId);
        if (envelope) return jsonErrorResponse(response, envelope);
        const diagnostic = original.error ?? original.message;
        if (diagnostic && !(typeof diagnostic === "string" && Object.values(PUBLIC_ERROR_MESSAGES).some(value => value === diagnostic))) {
          report(new Error(typeof diagnostic === "string" ? diagnostic : JSON.stringify(diagnostic)), { requestId: requestId ?? "", status: response.status, surface: "http-response" });
        }
        if (native) return jsonErrorResponse(response, nativeEnvelopeFor(original, response.status, requestId));
        const code = typeof original.code === "string" && /^[a-zA-Z0-9_:-]{1,80}$/.test(original.code) ? original.code : undefined;
        if (code) body.code = code;
        if (typeof original.message === "string") body.message = code === "EMAIL_ALREADY_REGISTERED"
          ? "This email is already registered. Sign in or reset your password."
          : code === "SSO_REQUIRED" ? "Your organization requires company sign-in (SSO)." : message;
        // Where to start company sign-in: the same domain-only answer as the public /api/sso-lookup.
        if (code === "SSO_REQUIRED" && typeof original.ssoUrl === "string" && /^https?:\/\/[^\s]+$/.test(original.ssoUrl)) body.ssoUrl = original.ssoUrl;
        // Upgrade and billing links (402/429) survive with copy composed from the closed code.
        const nestedError = typeof original.error === "object" && original.error !== null ? original.error as Record<string, unknown> : null;
        const links = publicApiErrorLinks(original.links ?? nestedError?.links);
        const linkedCode = isApiErrorCode(original.code) ? original.code : isApiErrorCode(nestedError?.code) ? nestedError.code : undefined;
        const linked = links && linkedCode ? { code: linkedCode, links, message: publicApiErrorMessage(linkedCode, { links, plan: original.plan }) } : null;
        if (nestedError && "message" in nestedError) {
          body.error = linked
            ? { message: linked.message, type: response.status >= 500 ? "server_error" : "invalid_request_error", code: linked.code, param: null, links: linked.links }
            : { message, type: response.status >= 500 ? "server_error" : "invalid_request_error", code: null, param: null };
        } else if (typeof original.error === "string") {
          body.error = linked ? linked.message : friendlyErrorMessage(original.error, message);
          if (linked) body.links = linked.links;
        }
        if (original.jsonrpc === "2.0" && original.error && typeof original.error.code === "number") {
          body = { jsonrpc: "2.0", id: typeof original.id === "string" || typeof original.id === "number" ? original.id : null,
            error: { code: original.error.code, message } };
        }
        const oauthErrors = new Set(["invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope", "access_denied", "server_error", "temporarily_unavailable", "unsupported_response_type"]);
        if (typeof original.error === "string" && oauthErrors.has(original.error)) {
          body = { error: original.error, error_description: message };
        }
        if (Array.isArray(original.issues)) {
          // Zod reports `path` as an array; keep the field names (never the messages) so clients can fix the request.
          body.issues = original.issues.map((issue: { path?: unknown }) => ({
            path: Array.isArray(issue.path) ? issue.path.map(String).join(".") : typeof issue.path === "string" ? issue.path : "",
            message: PUBLIC_ERROR_MESSAGES.invalid,
            code: "invalid_value",
          }));
        }
      }
    } catch { /* proxies and malformed response bodies receive safe copy too */ }
  }
  if (native) return jsonErrorResponse(response, nativeEnvelopeFor(null, response.status, requestId));
  if (requestId) body.requestId = requestId;
  return jsonErrorResponse(response, body);
}

function jsonErrorResponse(response: Response, body: unknown): Response {
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json; charset=UTF-8");
  headers.set("cache-control", "no-store");
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify(body), { status: response.status, headers });
}

/** A handler body that is not the envelope: keep a closed `code` and field paths, never its text. */
function nativeEnvelopeFor(original: Record<string, unknown> | null, status: number, requestId?: string) {
  const nested = original && typeof original.error === "object" && original.error !== null ? original.error as Record<string, unknown> : null;
  const named = original?.code ?? nested?.code;
  const code = isApiErrorCode(named) ? named : apiErrorCodeForStatus(status);
  const details = publicApiErrorDetails(original?.details ?? nested?.details ?? (Array.isArray(original?.issues) ? original : nested));
  return { error: { code, message: publicApiErrorMessage(code, details), ...(details ? { details } : {}), ...(requestId ? { requestId } : {}) } };
}

import { friendlyErrorMessage, publicErrorForStatus, PUBLIC_ERROR_MESSAGES } from "./public-errors.js";
import { reportException } from "./error-reporting.js";

export type PublicErrorReporter = (error: unknown, context?: Record<string, string | number | boolean>) => string;

/** Reports an exception to telemetry and returns the only copy safe to show a browser. */
export const reportPublicError: PublicErrorReporter = (error, context = {}) => {
  reportException(error, context);
  return PUBLIC_ERROR_MESSAGES.unexpected;
};

/** Last line of defence for handled errors, including third-party auth responses. */
export async function safeErrorResponse(response: Response, requestId?: string, report: PublicErrorReporter = reportPublicError): Promise<Response> {
  if (response.status < 400) return response;
  const message = publicErrorForStatus(response.status);
  let body: Record<string, unknown> = { error: message };
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      const original = await response.clone().json();
      // Retain protocol envelopes and machine codes, but never arbitrary details.
      if (original && typeof original === "object") {
        const diagnostic = original.error ?? original.message;
        if (diagnostic && !(typeof diagnostic === "string" && Object.values(PUBLIC_ERROR_MESSAGES).some(value => value === diagnostic))) {
          report(new Error(typeof diagnostic === "string" ? diagnostic : JSON.stringify(diagnostic)), { requestId: requestId ?? "", status: response.status, surface: "http-response" });
        }
        const code = typeof original.code === "string" && /^[a-zA-Z0-9_:-]{1,80}$/.test(original.code) ? original.code : undefined;
        if (code) body.code = code;
        if (typeof original.message === "string") body.message = message;
        if (typeof original.error === "object" && original.error !== null && "message" in original.error) {
          body.error = { message, type: response.status >= 500 ? "server_error" : "invalid_request_error", code: null, param: null };
        } else if (typeof original.error === "string") {
          body.error = friendlyErrorMessage(original.error, message);
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
  if (requestId) body.requestId = requestId;
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json; charset=UTF-8");
  headers.set("cache-control", "no-store");
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify(body), { status: response.status, headers });
}

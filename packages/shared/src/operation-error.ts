import { redactExceptionText } from "./error-reporting.js";

/**
 * Provider statuses whose error message describes routing, auth or quota
 * (OpenRouter 404: "No allowed providers are available…"). Gateway 5xx
 * messages are kept to a short prefix. 400, 403, 409, 413 and 422 bodies can
 * echo or describe the request, which holds document content, so their
 * messages are withheld; the status and type still go to telemetry.
 */
const DESCRIPTIVE_STATUSES = new Set([401, 402, 404, 408, 429]);
const GATEWAY_STATUSES = new Set([500, 502, 503, 504]);
/** Errors raised by our own code whose messages never carry document content. */
const DESCRIPTIVE_ERROR_NAMES = new Set(["ProviderRegionRefusedError", "TimeoutError", "AbortError"]);
const MESSAGE_LIMIT = 500;
const GATEWAY_MESSAGE_LIMIT = 200;
const CAUSE_DEPTH = 4;

type ErrorFields = Error & { statusCode?: unknown; isRetryable?: unknown; code?: unknown; lastError?: unknown; errors?: unknown };

/**
 * What a failed operation (an AI or provider call) reports to telemetry: its
 * type, HTTP status, whether it was retryable, attempts made by the SDK, and a
 * redacted message when it cannot hold document content. The AI SDK's
 * RetryError (retries exhausted) is described by its last attempt.
 */
export function operationErrorAttributes(error: unknown): Record<string, string | number | boolean> {
  if (!(error instanceof Error)) return { "exception.type": typeof error };
  const outer = error as ErrorFields;
  const attempts = Array.isArray(outer.errors) ? outer.errors.length : undefined;
  const last = providerCause(outer);
  const status = typeof last.statusCode === "number" ? last.statusCode : undefined;
  const attributes: Record<string, string | number | boolean> = { "exception.type": redactExceptionText(last.name).slice(0, 200) };
  if (last !== outer) attributes["docslurp.error.wrapper"] = redactExceptionText(outer.name).slice(0, 200);
  if (status !== undefined) attributes["http.response.status_code"] = status;
  if (typeof last.isRetryable === "boolean") attributes["docslurp.error.retryable"] = last.isRetryable;
  if (attempts !== undefined) attributes["docslurp.error.attempts"] = attempts;
  if (typeof last.code === "string") attributes["docslurp.error.code"] = redactExceptionText(last.code).slice(0, 200);
  const limit = status === undefined ? (DESCRIPTIVE_ERROR_NAMES.has(last.name) ? MESSAGE_LIMIT : 0)
    : DESCRIPTIVE_STATUSES.has(status) ? MESSAGE_LIMIT : GATEWAY_STATUSES.has(status) ? GATEWAY_MESSAGE_LIMIT : 0;
  if (limit && last.message) attributes["exception.message"] = redactExceptionText(last.message).slice(0, limit);
  return attributes;
}

/**
 * The error that describes the failure: a RetryError's last attempt, else the
 * first error in a short `cause` chain that carries an HTTP status (our own
 * wrappers keep the provider's APICallError as their cause), else the error.
 */
function providerCause(error: ErrorFields): ErrorFields {
  if (error.lastError instanceof Error) return error.lastError as ErrorFields;
  let current: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH && current instanceof Error; depth++) {
    if (typeof (current as ErrorFields).statusCode === "number") return current as ErrorFields;
    current = (current as Error).cause;
  }
  return error;
}

/**
 * The attributes safe on a span. Observation spans export to Langfuse, whose
 * content policy (LANGFUSE_CAPTURE_CONTENT) withholds provider messages, so
 * the message goes only on the SigNoz log record.
 */
export function spanSafeErrorAttributes(attributes: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const { "exception.message": _message, ...rest } = attributes;
  return rest;
}

/**
 * A refusal no later request for the same model and route can get past: auth,
 * credit, an unservable model or route (404), or our region policy. Statuses
 * that can depend on one request's content (400, 403, 413, 422) are not.
 */
export function isRouteLevelProviderFailure(attributes: Record<string, string | number | boolean>): boolean {
  const status = attributes["http.response.status_code"];
  return status === 401 || status === 402 || status === 404 || attributes["exception.type"] === "ProviderRegionRefusedError";
}

/** A short suffix for log lines: "(HTTP 404, not retryable)". */
export function operationErrorSummary(attributes: Record<string, string | number | boolean>): string {
  const parts = [
    typeof attributes["http.response.status_code"] === "number" ? `HTTP ${attributes["http.response.status_code"]}` : String(attributes["exception.type"] ?? "error"),
    typeof attributes["docslurp.error.retryable"] === "boolean" ? (attributes["docslurp.error.retryable"] ? "retryable" : "not retryable") : null,
    typeof attributes["docslurp.error.attempts"] === "number" ? `${attributes["docslurp.error.attempts"]} attempts` : null,
  ].filter(Boolean);
  return `(${parts.join(", ")})`;
}

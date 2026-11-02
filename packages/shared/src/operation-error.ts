import { redactExceptionText } from "./error-reporting.js";

/**
 * Provider statuses whose error message describes routing, auth, quota or the
 * provider itself (OpenRouter 404: "No allowed providers are available…").
 * 400 and 422 bodies can echo the request, which holds document content, so
 * their messages are withheld; the status and type still go to telemetry.
 */
const DESCRIPTIVE_STATUSES = new Set([401, 402, 403, 404, 408, 409, 429]);
/** Errors raised by our own code whose messages never carry document content. */
const DESCRIPTIVE_ERROR_NAMES = new Set(["ProviderRegionRefusedError", "TimeoutError", "AbortError"]);
const MESSAGE_LIMIT = 500;

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
  const last = outer.lastError instanceof Error ? (outer.lastError as ErrorFields) : outer;
  const status = typeof last.statusCode === "number" ? last.statusCode : undefined;
  const attributes: Record<string, string | number | boolean> = { "exception.type": redactExceptionText(last.name).slice(0, 200) };
  if (last !== outer) attributes["docslurp.error.wrapper"] = redactExceptionText(outer.name).slice(0, 200);
  if (status !== undefined) attributes["http.response.status_code"] = status;
  if (typeof last.isRetryable === "boolean") attributes["docslurp.error.retryable"] = last.isRetryable;
  if (attempts !== undefined) attributes["docslurp.error.attempts"] = attempts;
  if (typeof last.code === "string") attributes["docslurp.error.code"] = redactExceptionText(last.code).slice(0, 200);
  const descriptive = status !== undefined ? DESCRIPTIVE_STATUSES.has(status) || status >= 500 : DESCRIPTIVE_ERROR_NAMES.has(last.name);
  if (descriptive && last.message) attributes["exception.message"] = redactExceptionText(last.message).slice(0, MESSAGE_LIMIT);
  return attributes;
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

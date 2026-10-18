import { z } from "zod";
import { PUBLIC_ERROR_MESSAGES } from "./public-errors.js";

/**
 * The native API error envelope: `{ error: { code, message, details?, requestId } }`.
 * `code` is a closed, machine-readable vocabulary; clients branch on it, never
 * on `message`. The OpenAI-compatible, OAuth and JSON-RPC surfaces keep their
 * own protocol shapes.
 */
export const API_ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "workspace_not_found",
  "conflict",
  "payload_too_large",
  "rate_limited",
  "payment_required",
  "credit_exhausted",
  "workspace_budget_paused",
  "org_budget_paused",
  "minimum_credit_required",
  "plan_not_entitled",
  "chat_disabled",
  "invalid_search_scope",
  "unavailable",
  "internal",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && (API_ERROR_CODES as readonly string[]).includes(value);
}

/** Optional structured context. The boundary only forwards `issues` (validation field paths). */
export type ApiErrorDetails = Record<string, unknown>;

export type ApiErrorBody = { error: { code: ApiErrorCode; message: string; details?: ApiErrorDetails } };
export type ApiErrorEnvelope = { error: { code: ApiErrorCode; message: string; details?: ApiErrorDetails; requestId: string } };

/** Builds the body a route returns; the HTTP error boundary stamps `requestId`. */
export function apiError(code: ApiErrorCode, message: string, details?: ApiErrorDetails): ApiErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export const apiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string(),
  }),
});

/** Reviewed copy per code. The boundary sends this instead of route-authored text. */
export const API_ERROR_PUBLIC_MESSAGES: Record<ApiErrorCode, string> = {
  invalid_request: PUBLIC_ERROR_MESSAGES.invalid,
  unauthorized: PUBLIC_ERROR_MESSAGES.unauthorized,
  forbidden: PUBLIC_ERROR_MESSAGES.forbidden,
  not_found: PUBLIC_ERROR_MESSAGES.missing,
  workspace_not_found: PUBLIC_ERROR_MESSAGES.workspaceMissing,
  conflict: PUBLIC_ERROR_MESSAGES.conflict,
  payload_too_large: PUBLIC_ERROR_MESSAGES.tooLarge,
  rate_limited: PUBLIC_ERROR_MESSAGES.rateLimit,
  payment_required: PUBLIC_ERROR_MESSAGES.unavailable,
  credit_exhausted: PUBLIC_ERROR_MESSAGES.unavailable,
  workspace_budget_paused: PUBLIC_ERROR_MESSAGES.unavailable,
  org_budget_paused: PUBLIC_ERROR_MESSAGES.unavailable,
  minimum_credit_required: PUBLIC_ERROR_MESSAGES.unavailable,
  plan_not_entitled: PUBLIC_ERROR_MESSAGES.unavailable,
  chat_disabled: PUBLIC_ERROR_MESSAGES.chatDisabled,
  invalid_search_scope: PUBLIC_ERROR_MESSAGES.searchScope,
  unavailable: PUBLIC_ERROR_MESSAGES.unavailable,
  internal: PUBLIC_ERROR_MESSAGES.unexpected,
};

export function apiErrorCodeForStatus(status: number): ApiErrorCode {
  if (status === 400) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 402) return "payment_required";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "payload_too_large";
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  if (status >= 400 && status < 500) return "invalid_request";
  return "internal";
}

/** Validation paths only: field names help a client fix the request, issue text may echo input. */
export function publicApiErrorDetails(details: unknown): ApiErrorDetails | undefined {
  if (!details || typeof details !== "object" || !("issues" in details) || !Array.isArray(details.issues)) return undefined;
  return {
    issues: details.issues.map((issue: { path?: unknown }) => ({
      path: Array.isArray(issue?.path) ? issue.path.map(String).join(".") : typeof issue?.path === "string" ? issue.path : "",
      message: PUBLIC_ERROR_MESSAGES.invalid,
      code: "invalid_value",
    })),
  };
}

/**
 * Normalizes a route-authored error body into the public envelope, or returns
 * null when the body is not one (legacy shapes, OpenAI and protocol errors).
 */
export function publicApiErrorEnvelope(original: unknown, status: number, requestId?: string): { error: ApiErrorBody["error"] & { requestId?: string } } | null {
  if (!original || typeof original !== "object") return null;
  const error = (original as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const candidate = error as Record<string, unknown>;
  // OpenAI-compatible errors carry `type`/`param`; they are never rewritten here.
  if (typeof candidate.code !== "string" || typeof candidate.message !== "string" || "type" in candidate || "param" in candidate) return null;
  const code = isApiErrorCode(candidate.code) ? candidate.code : apiErrorCodeForStatus(status);
  const details = publicApiErrorDetails(candidate.details);
  return { error: { code, message: API_ERROR_PUBLIC_MESSAGES[code], ...(details ? { details } : {}), ...(requestId ? { requestId } : {}) } };
}

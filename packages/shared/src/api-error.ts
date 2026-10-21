import { z } from "zod";
import { PUBLIC_ERROR_MESSAGES } from "./public-errors.js";

/**
 * The native API error envelope: `{ error: { code, message, details?, requestId } }`.
 * `code` is a closed, machine-readable vocabulary; clients branch on it, never
 * on `message`. It is the only error shape of the native JSON API. Protocol
 * surfaces (OpenAI-compatible chat, OAuth, MCP JSON-RPC, search compat adapters
 * and the Stripe webhook) keep the shapes their clients already speak.
 */
export const API_ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "workspace_not_found",
  "organization_not_found",
  "organization_forbidden",
  "organization_conflict",
  "personal_organization",
  "membership_exists",
  "membership_forbidden",
  "membership_not_found",
  "last_owner",
  "ownership_transfer_required",
  "user_not_found",
  "conflict",
  "payload_too_large",
  "rate_limited",
  "spend_limit_exceeded",
  "daily_page_limit",
  "ip_temporarily_blocked",
  "session_required",
  "unsupported_type",
  "file_too_large",
  "unreadable_source",
  "payment_required",
  "credit_exhausted",
  "workspace_budget_paused",
  "org_budget_paused",
  "minimum_credit_required",
  "plan_not_entitled",
  "chat_disabled",
  "model_not_allowed",
  "chat_deadline_exceeded",
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
  organization_not_found: PUBLIC_ERROR_MESSAGES.organizationMissing,
  organization_forbidden: PUBLIC_ERROR_MESSAGES.forbidden,
  organization_conflict: PUBLIC_ERROR_MESSAGES.conflict,
  personal_organization: PUBLIC_ERROR_MESSAGES.personalOrganization,
  membership_exists: PUBLIC_ERROR_MESSAGES.conflict,
  membership_forbidden: PUBLIC_ERROR_MESSAGES.forbidden,
  membership_not_found: PUBLIC_ERROR_MESSAGES.missing,
  last_owner: PUBLIC_ERROR_MESSAGES.lastOwner,
  ownership_transfer_required: PUBLIC_ERROR_MESSAGES.ownershipTransfer,
  user_not_found: PUBLIC_ERROR_MESSAGES.missing,
  conflict: PUBLIC_ERROR_MESSAGES.conflict,
  payload_too_large: PUBLIC_ERROR_MESSAGES.tooLarge,
  rate_limited: PUBLIC_ERROR_MESSAGES.rateLimit,
  spend_limit_exceeded: PUBLIC_ERROR_MESSAGES.spendLimit,
  daily_page_limit: PUBLIC_ERROR_MESSAGES.dailyPageLimit,
  ip_temporarily_blocked: PUBLIC_ERROR_MESSAGES.ipBlocked,
  session_required: PUBLIC_ERROR_MESSAGES.sessionRequired,
  unsupported_type: PUBLIC_ERROR_MESSAGES.unsupportedType,
  file_too_large: PUBLIC_ERROR_MESSAGES.tooLarge,
  unreadable_source: PUBLIC_ERROR_MESSAGES.unreadableSource,
  payment_required: PUBLIC_ERROR_MESSAGES.unavailable,
  credit_exhausted: PUBLIC_ERROR_MESSAGES.unavailable,
  workspace_budget_paused: PUBLIC_ERROR_MESSAGES.unavailable,
  org_budget_paused: PUBLIC_ERROR_MESSAGES.unavailable,
  minimum_credit_required: PUBLIC_ERROR_MESSAGES.unavailable,
  plan_not_entitled: PUBLIC_ERROR_MESSAGES.unavailable,
  chat_disabled: PUBLIC_ERROR_MESSAGES.chatDisabled,
  model_not_allowed: PUBLIC_ERROR_MESSAGES.modelNotAllowed,
  chat_deadline_exceeded: PUBLIC_ERROR_MESSAGES.chatDeadline,
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

const SAFE_DETAIL_NUMBERS = ["retryAfterSeconds", "limitCents", "spentCents", "maxBytes"] as const;
const SAFE_DETAIL_LABELS = ["category", "policy"] as const;

/**
 * The only details that cross the boundary: validation field paths (issue text
 * may echo input), server-authored limit metadata and a failed chat turn's
 * usage. Anything else is dropped.
 */
export function publicApiErrorDetails(details: unknown): ApiErrorDetails | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const source = details as Record<string, unknown>;
  const safe: ApiErrorDetails = {};
  if (Array.isArray(source.issues)) {
    safe.issues = source.issues.map((issue: { path?: unknown }) => ({
      path: Array.isArray(issue?.path) ? issue.path.map(String).join(".") : typeof issue?.path === "string" ? issue.path : "",
      message: PUBLIC_ERROR_MESSAGES.invalid,
      code: "invalid_value",
    }));
  }
  for (const key of SAFE_DETAIL_NUMBERS) {
    if (typeof source[key] === "number" && Number.isFinite(source[key])) safe[key] = source[key];
  }
  for (const key of SAFE_DETAIL_LABELS) {
    if (typeof source[key] === "string" && /^[\w:.-]{1,80}$/.test(source[key])) safe[key] = source[key];
  }
  const usage = publicChatTurnUsage(source.usage);
  if (usage) safe.usage = usage;
  const direct = source.directUpload;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const { createSession, maxFileBytes } = direct as Record<string, unknown>;
    if (typeof createSession === "string" && /^\/[\w/{}.-]{1,120}$/.test(createSession) && typeof maxFileBytes === "number" && Number.isFinite(maxFileBytes)) {
      safe.directUpload = { createSession, maxFileBytes };
    }
  }
  return Object.keys(safe).length ? safe : undefined;
}

const CHAT_TURN_USAGE_NUMBERS = ["providerCostCents", "creditCents", "refundedCreditCents", "chargedCreditCents"] as const;

/**
 * A failed chat turn's usage (`details.usage`): server-computed cost and
 * credits, and whether the credits were refunded. Dropped unless every field
 * has the expected type.
 */
function publicChatTurnUsage(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  if (typeof usage.turnId !== "string" || !/^[\w-]{1,80}$/.test(usage.turnId)) return undefined;
  if (usage.outcome !== "open" && usage.outcome !== "delivered" && usage.outcome !== "failed") return undefined;
  if (typeof usage.refunded !== "boolean") return undefined;
  const safe: Record<string, unknown> = { turnId: usage.turnId, outcome: usage.outcome, refunded: usage.refunded };
  for (const key of CHAT_TURN_USAGE_NUMBERS) {
    const number = usage[key];
    if (typeof number !== "number" || !Number.isFinite(number)) return undefined;
    safe[key] = number;
  }
  return safe;
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

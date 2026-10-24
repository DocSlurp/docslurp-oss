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
  "credit_request_rejected",
  "credit_reconciliation_required",
  "idempotency_conflict",
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
  "remote_format_disabled",
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
  "chat_tool_failed",
  "invalid_search_scope",
  "web_disabled",
  "url_blocked",
  "privacy_mode_blocked",
  "unavailable",
  "internal",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && (API_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Optional structured context. The boundary only forwards validation `issues`
 * (field paths), limit metadata (`retryAfterSeconds`, `category`, `policy`,
 * `account` (`starter` | `funded`), ...), `links` and a failed chat turn's `usage`.
 */
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
  credit_request_rejected: "Credit request rejected before issuance. Correct the recipient or request and try again.",
  credit_reconciliation_required: "Credit outcome requires operator reconciliation. Preserve this request ID; do not create a replacement.",
  idempotency_conflict: "This credit request ID belongs to different parameters or an administrator. Reconcile the original request.",
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
  remote_format_disabled: "This remote file requires complex-format parsing, which is disabled on this deployment. Upload the file directly, or ask an administrator to enable complex remote formats.",
  file_too_large: PUBLIC_ERROR_MESSAGES.tooLarge,
  unreadable_source: PUBLIC_ERROR_MESSAGES.unreadableSource,
  payment_required: PUBLIC_ERROR_MESSAGES.creditExhausted,
  credit_exhausted: PUBLIC_ERROR_MESSAGES.creditExhausted,
  workspace_budget_paused: PUBLIC_ERROR_MESSAGES.budgetPaused,
  org_budget_paused: PUBLIC_ERROR_MESSAGES.budgetPaused,
  minimum_credit_required: PUBLIC_ERROR_MESSAGES.creditExhausted,
  plan_not_entitled: PUBLIC_ERROR_MESSAGES.planRequired,
  chat_disabled: PUBLIC_ERROR_MESSAGES.chatDisabled,
  model_not_allowed: PUBLIC_ERROR_MESSAGES.modelNotAllowed,
  chat_deadline_exceeded: PUBLIC_ERROR_MESSAGES.chatDeadline,
  chat_tool_failed: PUBLIC_ERROR_MESSAGES.chatToolFailed,
  invalid_search_scope: PUBLIC_ERROR_MESSAGES.searchScope,
  web_disabled: "Web tools are turned off for this server or workspace.",
  url_blocked: "This URL can't be fetched. Use a public HTTP or HTTPS address.",
  privacy_mode_blocked: "This workspace's privacy mode doesn't allow web tools.",
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
  if (status === 415) return "unsupported_type";
  if (status === 413) return "payload_too_large";
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  if (status >= 400 && status < 500) return "invalid_request";
  return "internal";
}

const SAFE_DETAIL_NUMBERS = ["retryAfterSeconds", "limitCents", "spentCents", "maxBytes", "availableCredits", "heldCredits", "chatReserveCredits"] as const;
const SAFE_DETAIL_LABELS = ["category", "policy", "account", "spendKind"] as const;

/**
 * Where a caller can lift a limit (`details.links` on 402 and 429 responses):
 * the billing page, its credit top-up section, its auto top-up section (only
 * while auto top-up is off), the API key's own limits and the docs for the
 * limit. There is no plan to upgrade: limits rise once an org buys credits. Hosted deployments only; self-hosted
 * servers have no billing and send none.
 */
export const API_ERROR_LINK_KEYS = ["billing", "buyCredits", "autoTopUp", "apiKeys", "docs"] as const;
export type ApiErrorLinkName = (typeof API_ERROR_LINK_KEYS)[number];
export type ApiErrorLinks = Partial<Record<ApiErrorLinkName, string>>;

/** Server-authored absolute http(s) URLs only; anything else is dropped. */
export function publicApiErrorLinks(value: unknown): ApiErrorLinks | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const links: ApiErrorLinks = {};
  for (const key of API_ERROR_LINK_KEYS) {
    const url = source[key];
    if (typeof url !== "string" || url.length > 300 || !/^https?:\/\/[^\s"'<>\\]+$/.test(url)) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") links[key] = url;
    } catch { /* not a URL */ }
  }
  return Object.keys(links).length ? links : undefined;
}

/**
 * Public copy for `code`, plus where to go next when the details carry links:
 * a starter-account rate limit points at buying credits, credit errors at
 * buying credits and auto top-up, budget errors at billing, API key limits at the key settings. Without links (self-hosted, or
 * no billing) it is the reviewed copy alone.
 */
export function publicApiErrorMessage(code: ApiErrorCode, details?: ApiErrorDetails): string {
  const base = API_ERROR_PUBLIC_MESSAGES[code];
  if (code === "workspace_not_found" && typeof details?.workspaceSlug === "string") {
    return `No workspace matching "${details.workspaceSlug}" was found. Pass a workspace ID, slug or name from this organization, or omit workspace to use the default workspace.`;
  }
  const links = publicApiErrorLinks(details?.links);
  if (!links) return base;
  const account = typeof details?.account === "string" ? details.account : undefined;
  switch (code) {
    case "rate_limited":
      if (account === "starter" && links.buyCredits) {
        return `Starter rate limit reached. Accounts that have bought credits get higher limits: buy credits at ${links.buyCredits}, or wait for Retry-After and try again.`;
      }
      return links.docs ? `${base} Rate limits: ${links.docs}` : base;
    case "ip_temporarily_blocked":
      return links.docs ? `${base} Rate limits: ${links.docs}` : base;
    case "spend_limit_exceeded":
    case "daily_page_limit":
      return links.apiKeys ? `${base} Change the key's limits at ${links.apiKeys}.` : base;
    case "credit_exhausted":
    case "minimum_credit_required":
    case "payment_required":
      if (!links.buyCredits && !links.billing) return base;
      return `Your organization is out of credits. Buy credits at ${links.buyCredits ?? links.billing}`
        + (links.autoTopUp ? `, or turn on auto top-up at ${links.autoTopUp}.` : ".");
    case "workspace_budget_paused":
    case "org_budget_paused":
      return links.billing ? `${base} Review spend and budgets at ${links.billing}.` : base;
    default:
      return base;
  }
}

/**
 * The only details that cross the boundary: validation field paths (issue text
 * may echo input), server-authored limit metadata, upgrade/billing `links` and
 * a failed chat turn's usage. Anything else is dropped.
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
  // The slug a `workspace` value was looked up by (lowercase letters, digits and hyphens only).
  if (typeof source.workspaceSlug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(source.workspaceSlug) && source.workspaceSlug.length <= 63) {
    safe.workspaceSlug = source.workspaceSlug;
  }
  const links = publicApiErrorLinks(source.links);
  if (links) safe.links = links;
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
  return { error: { code, message: publicApiErrorMessage(code, details), ...(details ? { details } : {}), ...(requestId ? { requestId } : {}) } };
}

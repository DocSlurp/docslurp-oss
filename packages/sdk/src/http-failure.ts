/** Reviewed recovery copy; response text and unknown codes never become display text. */
const RECOVERY_MESSAGES: Record<string, string> = {
  mfa_required: "Set up an authenticator app or passkey in Settings, Security, then try again.",
  unauthorized: "Please sign in again or check your API key.",
  session_required: "Please sign in again to continue.",
  credit_exhausted: "Your organization is out of credits. Add credits before trying again.",
  payment_required: "Your organization needs credits before this action can continue.",
  minimum_credit_required: "Add credits before trying this action again.",
  workspace_budget_paused: "This workspace budget is paused. Review its budget before continuing.",
  org_budget_paused: "Your organization budget is paused. Review its budget before continuing.",
  plan_not_entitled: "This feature is not available for this account. Review your account capabilities.",
  rate_limited: "Wait for the retry delay before trying again.",
  spend_limit_exceeded: "This API key has reached its spending limit. Review the key limits.",
  daily_page_limit: "This API key has reached its daily page limit. Review the key limits.",
  chat_disabled: "Chat is disabled for this workspace. Enable chat in workspace settings.",
  invalid_search_scope: "Choose a valid search scope in this workspace and try again.",
  workspace_scope_forbidden: "Choose a workspace this API key can access.",
  model_not_allowed: "Choose a model allowed by this workspace.",
  unavailable: "The service is temporarily unavailable. Try again later.",
};

export function safeHttpFailure(status: number, body: unknown): { code?: string; requestId?: string; message: string; retryAfterSeconds?: number } {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const candidate = error && typeof error === "object" && !Array.isArray(error) ? error as Record<string, unknown> : {};
  const code = typeof candidate.code === "string" && Object.hasOwn(RECOVERY_MESSAGES, candidate.code) ? candidate.code : undefined;
  const requestId = typeof candidate.requestId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(candidate.requestId) ? candidate.requestId : undefined;
  const details = candidate.details && typeof candidate.details === "object" ? candidate.details as Record<string, unknown> : {};
  const retryAfterSeconds = typeof details.retryAfterSeconds === "number" && Number.isFinite(details.retryAfterSeconds) && details.retryAfterSeconds >= 0 ? details.retryAfterSeconds : undefined;
  const fallback = status === 401 ? RECOVERY_MESSAGES.unauthorized
    : status === 402 ? RECOVERY_MESSAGES.payment_required
    : status === 403 ? "You don’t have access to this action. Ask your workspace administrator for help."
    : status === 429 ? RECOVERY_MESSAGES.rate_limited
    : status === 404 ? "This resource is unavailable. Check its identifier and your access."
    : status === 413 ? "This file is too large. Choose a smaller file."
    : status >= 400 && status < 500 ? "Check your request and try again."
    : "The service is temporarily unavailable. Try again later.";
  return { ...(code ? { code } : {}), ...(requestId ? { requestId } : {}), message: code ? RECOVERY_MESSAGES[code]! : fallback, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) };
}

/** Retry-After supports delta-seconds and HTTP dates; malformed values supply no timing. */
export function retryAfterSeconds(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const number = Number(value);
  const seconds = Number.isFinite(number) ? number : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

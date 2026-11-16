import { HTTPException } from "hono/http-exception";
import { apiError, PUBLIC_ERROR_MESSAGES, type ApiKeyRateLimitRule, type SearchMode } from "@docslurp/shared";

import { withApiErrorDetails } from "../lib/api-error.js";
import { currentChatTurn } from "../lib/chat-turn-context.js";
import { currentRequestSearchLimits } from "../lib/request-context.js";
import { consumeFeatureRateLimits } from "../middleware/rate-limit.js";

/** A key's `searches` limit for the mode a search would run in refused it. Answers 429 on every surface. */
export class SearchModeLimitError extends HTTPException {
  readonly code = "search_limit_exceeded";

  constructor(readonly mode: SearchMode, readonly rule: ApiKeyRateLimitRule, readonly retryAfterSeconds: number) {
    const body = apiError("search_limit_exceeded", PUBLIC_ERROR_MESSAGES.searchLimit, {
      mode, limit: rule.limit, windowSeconds: rule.windowSeconds, retryAfterSeconds,
    });
    super(429, {
      message: `search limit for ${mode} reached`,
      res: new Response(JSON.stringify(body), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSeconds) } }),
    });
    this.name = "SearchModeLimitError";
    // The native error envelope reads thrown details from here (lib/api-error.ts).
    withApiErrorDetails(this, { mode, limit: rule.limit, windowSeconds: rule.windowSeconds, retryAfterSeconds });
  }
}

/**
 * Counts a root search in `mode` against the request key's `searches` limits for that mode, refusing with
 * {@link SearchModeLimitError} when one is reached. A keyword fan-out of N queries counts N searches, all or none: one
 * atomic store call checks every window has room for N and only then counts them, so a refused fan-out consumes
 * nothing. Fixed windows, shared across processes when Redis is configured (per process otherwise, like the other
 * per-key limits). Chat turns are governed by the chat limits instead.
 */
export async function consumeSearchModeLimit(mode: SearchMode, searches = 1): Promise<void> {
  if (currentChatTurn()) return;
  const limits = currentRequestSearchLimits();
  if (!limits) return;
  const rules = limits.rules.filter((rule) => rule.metric === "searches" && rule.mode === mode);
  if (rules.length === 0) return;
  const refused = await consumeFeatureRateLimits({
    subject: limits.keyId,
    windows: rules.map((rule) => ({ feature: `key-searches-${mode}-${rule.windowSeconds}`, limit: rule.limit, windowMs: rule.windowSeconds * 1000 })),
    weight: Math.max(1, Math.floor(searches)),
  });
  if (refused) throw new SearchModeLimitError(mode, rules[refused.index]!, refused.retryAfterSeconds);
}

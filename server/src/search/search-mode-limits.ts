import { HTTPException } from "hono/http-exception";
import { apiError, PUBLIC_ERROR_MESSAGES, type ApiKeyRateLimitRule, type SearchMode } from "@docslurp/shared";

import { withApiErrorDetails } from "../lib/api-error.js";
import { currentChatTurn } from "../lib/chat-turn-context.js";
import { currentRequestSearchLimits } from "../lib/request-context.js";
import { consumeFeatureRateLimit } from "../middleware/rate-limit.js";

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
 * Counts one root search in `mode` against the request key's `searches` limits for that mode, refusing with
 * {@link SearchModeLimitError} when one is reached. Fixed windows, shared across processes when Redis is configured
 * (per process otherwise, like the other per-key limits). Chat turns are governed by the chat limits instead.
 */
export async function consumeSearchModeLimit(mode: SearchMode, searches = 1): Promise<void> {
  if (currentChatTurn()) return;
  const limits = currentRequestSearchLimits();
  if (!limits) return;
  for (const rule of limits.rules) {
    if (rule.metric !== "searches" || rule.mode !== mode) continue;
    // A keyword fan-out counts each of its queries; the first refusal stops it.
    for (let count = 0; count < Math.max(1, Math.floor(searches)); count++) {
      const retry = await consumeFeatureRateLimit({
        feature: `key-searches-${mode}-${rule.windowSeconds}`,
        subject: limits.keyId,
        limit: rule.limit,
        windowMs: rule.windowSeconds * 1000,
      });
      if (retry !== null) throw new SearchModeLimitError(mode, rule, retry);
    }
  }
}

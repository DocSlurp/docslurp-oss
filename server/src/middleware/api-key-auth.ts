import type { MiddlewareHandler } from "hono";
import { middlewareErrorResponse } from "../lib/api-error.js";

import { type ApiKeyPolicyError, setRequestActor } from "../lib/request-actor.js";
import { recordResolvedApiKeyUsage, resolveRequestApiKey } from "../lib/route-credentials.js";

declare module "hono" {
  interface ContextVariableMap {
    /** A browser key refused for a fixable reason (project allowlist, website); protocol surfaces re-shape it. */
    apiKeyPolicyRefusal: ApiKeyPolicyError;
  }
}
import { enforceAuthenticatedApiRateLimit } from "./rate-limit.js";

export const apiKeyAuth: MiddlewareHandler = async (c, next) => {
  const existing = c.get("requestActor");
  if (existing?.type === "apiKey") {
    const limited = await enforceAuthenticatedApiRateLimit(c);
    if (limited) return limited;
    await next();
    return;
  }

  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return middlewareErrorResponse(c, 401, "unauthorized", "Missing or invalid Authorization header");
  }

  // Shared with the request body budget (lib/route-credentials.ts): one lookup per request. The lookup is
  // bounded (lib/bounded-lookup.ts): one round trip on the dedicated lookup pool (lib/auth-lookup-pool.ts),
  // a connection within 5 s, the statement within 3 s by its startup statement_timeout, and at most 64
  // lookups admitted at once. A full admission limit, an exhausted pool or a timed-out statement makes
  // verification unavailable, answered below as 503 with Retry-After (retryable), never as an invalid key.
  const resolution = await resolveRequestApiKey(c, header);
  // Verification unavailable (the lookup failed or timed out): fail closed, and say it is retryable.
  if (resolution.unavailable) {
    c.header("Retry-After", "2");
    return middlewareErrorResponse(c, 503, "unavailable", "API key verification is temporarily unavailable");
  }
  if (resolution.policyError) {
    c.set("apiKeyPolicyRefusal", resolution.policyError);
    return middlewareErrorResponse(c, 403, resolution.policyError.code, resolution.policyError.message);
  }
  const actor = resolution.actor;
  if (!actor) {
    // Repeated refusals from one IP look like key guessing: the IP limiter jails it.
    c.set("apiKeyRejected", true);
    // An OAuth access token that no longer validates (expired, revoked) is a
    // 401 invalid_token (RFC 6750 §3.1), so a client refreshes it instead of
    // treating it as a permission error.
    if (/^Bearer\s+ds(cli|mcp)/.test(header)) {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token", error_description="The access token is invalid, expired or revoked"');
      return middlewareErrorResponse(c, 401, "unauthorized", "Invalid or expired access token");
    }
    return middlewareErrorResponse(c, 403, "forbidden", "Invalid API key or rate limit exceeded");
  }

  setRequestActor(c, actor);
  recordResolvedApiKeyUsage(c, resolution);
  const limited = await enforceAuthenticatedApiRateLimit(c);
  if (limited) return limited;
  await next();
};

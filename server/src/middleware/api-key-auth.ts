import type { MiddlewareHandler } from "hono";
import { middlewareErrorResponse } from "../lib/api-error.js";

import { resolveApiKeyActor, setRequestActor } from "../lib/request-actor.js";
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

  const actor = await resolveApiKeyActor(header, {
    origin: c.req.header("origin"),
    referer: c.req.header("referer") ?? c.req.header("referrer")
  });
  if (!actor) {
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
  const limited = await enforceAuthenticatedApiRateLimit(c);
  if (limited) return limited;
  await next();
};

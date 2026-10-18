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
    return middlewareErrorResponse(c, 403, "forbidden", "Invalid API key or rate limit exceeded");
  }

  setRequestActor(c, actor);
  const limited = await enforceAuthenticatedApiRateLimit(c);
  if (limited) return limited;
  await next();
};

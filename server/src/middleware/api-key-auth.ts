import type { MiddlewareHandler } from "hono";
import { middlewareErrorResponse } from "../lib/api-error.js";

import { ApiKeyPolicyError, resolveApiKeyActor, setRequestActor } from "../lib/request-actor.js";

declare module "hono" {
  interface ContextVariableMap {
    /** A browser key refused for a fixable reason (workspace allowlist, website); protocol surfaces re-shape it. */
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

  let actor;
  try {
    actor = await resolveApiKeyActor(header, {
      origin: c.req.header("origin"),
      referer: c.req.header("referer") ?? c.req.header("referrer")
    });
  } catch (error) {
    if (!(error instanceof ApiKeyPolicyError)) throw error;
    c.set("apiKeyPolicyRefusal", error);
    return middlewareErrorResponse(c, 403, error.code, error.message);
  }
  if (!actor) {
    // Repeated refusals from one IP look like key guessing: the IP limiter jails it.
    c.set("apiKeyRejected", true);
    return middlewareErrorResponse(c, 403, "forbidden", "Invalid API key or rate limit exceeded");
  }

  setRequestActor(c, actor);
  const limited = await enforceAuthenticatedApiRateLimit(c);
  if (limited) return limited;
  await next();
};

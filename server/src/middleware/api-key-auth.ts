import type { MiddlewareHandler } from "hono";

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
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const actor = await resolveApiKeyActor(header, {
    origin: c.req.header("origin"),
    referer: c.req.header("referer") ?? c.req.header("referrer")
  });
  if (!actor) {
    return c.json({ error: "Invalid API key or rate limit exceeded" }, 403);
  }

  setRequestActor(c, actor);
  const limited = await enforceAuthenticatedApiRateLimit(c);
  if (limited) return limited;
  await next();
};

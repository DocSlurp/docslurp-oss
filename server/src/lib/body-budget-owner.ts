import type { Context } from "hono";
import type {} from "./request-actor.js";
import type { BodyBudgetOwner } from "./bounded-body-limit.js";
import { clientIpFromHeaders, isInProcessEnv } from "./client-ip.js";

/**
 * Who a buffered request body is charged to. Authentication runs before the
 * body limits, so an API key's request is its org's and a session's is its
 * user's (one organization per user); anything else is public, by client IP.
 */
export function bodyBudgetOwner(c: Context): BodyBudgetOwner {
  const apiKey = c.get("apiKey");
  if (apiKey) return { pool: "authenticated", key: apiKey.orgId ? `org:${apiKey.orgId}` : `key:${apiKey.keyId}` };
  const user = c.get("sessionUser");
  if (user?.id) return { pool: "authenticated", key: `user:${user.id}` };
  const ip = clientIpFromHeaders((name) => c.req.header(name), { trustedInternal: isInProcessEnv(c.env) });
  return { pool: "public", key: `ip:${ip ?? "unknown"}` };
}

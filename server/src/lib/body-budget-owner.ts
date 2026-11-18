import type { Context } from "hono";
import type {} from "./request-actor.js";
import type { BodyBudgetOwner } from "./bounded-body-limit.js";
import { clientIpFromHeaders, isInProcessEnv } from "./client-ip.js";

/**
 * Verifies a request's credential for budget accounting only, on routes that
 * authenticate inside their handler (`/v1/chat/completions`, `/v1/mcp`,
 * `/compat/*`, ...): the org of a verified key, or null. It never sets the
 * request's actor or decides authorization; the route's own auth still runs.
 * Registered by the server (body-budget-credentials.ts), so this module stays
 * free of database imports.
 */
export type BodyBudgetCredentialResolver = (c: Context) => Promise<{ orgId: string | null; keyId: string } | null>;

let credentialResolver: BodyBudgetCredentialResolver | null = null;

export function registerBodyBudgetCredentialResolver(resolver: BodyBudgetCredentialResolver | null): void {
  credentialResolver = resolver;
}

function publicOwner(c: Context): BodyBudgetOwner {
  const ip = clientIpFromHeaders((name) => c.req.header(name), { trustedInternal: isInProcessEnv(c.env) });
  return { pool: "public", key: `ip:${ip ?? "unknown"}` };
}

/**
 * Who a buffered request body is charged to: the actor authentication already
 * set (an API key's org, a session's user, one organization per user), else a
 * credential verified here for routes that authenticate later (its org), else
 * the client IP in the public pool. A missing or invalid credential is public.
 */
export async function bodyBudgetOwner(c: Context): Promise<BodyBudgetOwner> {
  const apiKey = c.get("apiKey");
  if (apiKey) return { pool: "authenticated", key: apiKey.orgId ? `org:${apiKey.orgId}` : `key:${apiKey.keyId}` };
  const user = c.get("sessionUser");
  if (user?.id) return { pool: "authenticated", key: `user:${user.id}` };
  // The resolver checks only its own exact routes (body-budget-credentials.ts) and returns null elsewhere.
  const verified = credentialResolver ? await credentialResolver(c).catch(() => null) : null;
  if (verified) return { pool: "authenticated", key: verified.orgId ? `org:${verified.orgId}` : `key:${verified.keyId}` };
  return publicOwner(c);
}

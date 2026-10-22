import type { Context, MiddlewareHandler } from "hono";

import {
  resolveApiKeyActor,
  resolveBetterAuthSessionActor,
  setRequestActor
} from "../lib/request-actor.js";
import { routeAuthMode } from "../lib/route-auth.js";
import { middlewareErrorResponse } from "../lib/api-error.js";
import { env } from "../config.js";

/**
 * CSRF guard for cookie-authenticated, state-changing requests (SEC-2026-10-02).
 *
 * The session cookie is the only ambient credential on `/v1/*`. A browser
 * cross-site POST carries `Sec-Fetch-Site: cross-site`; reject it. When the
 * header is absent, fall back to `Origin` against the CORS allowlist and the
 * request origin. Non-browser clients send neither header and are not CSRFable,
 * so they pass. Safe methods are always allowed.
 */
function isCookieMutationFromTrustedOrigin(c: Context): boolean {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;

  const fetchSite = c.req.header("sec-fetch-site");
  if (fetchSite) {
    return fetchSite === "same-origin" || fetchSite === "same-site" || fetchSite === "none";
  }

  const origin = c.req.header("origin");
  if (!origin) return true;
  if (env.corsAllowedOrigins.includes(origin)) return true;
  try {
    return new URL(c.req.url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Resolves the active Better Auth session from the incoming request cookies and
 * stores the authenticated user on the Hono context as `sessionUser`.
 *
 * Returns 401 if no valid session is present so that downstream handlers never
 * receive an unauthenticated request. Routes declared with `acceptApiKeys`
 * also accept an API key bearer token; `authenticatedByRoute` routes pass
 * through (see lib/route-auth.ts).
 */
export const sessionAuth: MiddlewareHandler = async (c, next) => {
  // MCP resolves resource-bound OAuth tokens and API keys itself. Never fall
  // back to a browser cookie when its bearer token is missing or invalid.
  if (c.req.path === "/v1/mcp" || c.req.path.startsWith("/v1/mcp/")) {
    await next();
    return;
  }
  if (c.get("requestActor")) {
    await next();
    return;
  }

  // Each route declares whether it accepts API keys or authenticates callers
  // itself (lib/route-auth.ts); undeclared routes are session-only.
  const mode = routeAuthMode(c);
  if (mode === "route") {
    await next();
    return;
  }

  const authorization = c.req.header("Authorization");
  if (mode === "apiKey" && authorization?.startsWith("Bearer ")) {
    const actor = await resolveApiKeyActor(authorization, {
      origin: c.req.header("origin"),
      referer: c.req.header("referer") ?? c.req.header("referrer")
    });
    if (actor) {
      setRequestActor(c, actor);
      await next();
      return;
    }
    // A supplied bearer credential is authoritative. Never turn an invalid
    // token into a more privileged cookie-session request.
    return middlewareErrorResponse(c, 401, "unauthorized", "Unauthorized");
  }

  const actor = await resolveBetterAuthSessionActor(c.req.raw.headers);
  if (!actor) {
    return middlewareErrorResponse(c, 401, "unauthorized", "Unauthorized");
  }

  if (!isCookieMutationFromTrustedOrigin(c)) {
    return middlewareErrorResponse(c, 403, "forbidden", "Cross-site request rejected");
  }

  setRequestActor(c, actor);
  await next();
};

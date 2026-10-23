import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { middlewareErrorResponse } from "../lib/api-error.js";

/** Preflight carries no key. Authorize the actual request against its key's domains. */
export function serviceCors(trustedOrigins: string[]): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("Origin");
    // The app's own pages are first-party on every hostname it serves (custom
    // domain, fly.dev, tailnet dev host), not only those in CORS_ALLOWED_ORIGINS.
    const trusted = !origin || trustedOrigins.includes(origin) || isSameOrigin(origin, c.req.url);
    const compatKeyRoute = /^\/compat\/algolia\/1\/indexes\//.test(c.req.path);
    const searchCompatRoute = /^\/compat\/(?:meilisearch\/indexes\/[^/]+\/search|typesense\/(?:collections\/[^/]+\/documents\/search|multi_search)|pagefind\/[^/]+\/search)$/.test(c.req.path);
    const publicKeyRoute = /^\/v1\/chat\/?$/.test(c.req.path) || compatKeyRoute || searchCompatRoute || /^\/v1\/(?:search(?:\/|$)|ingest(?:\/|$)|documents(?:\/|$)|models$|chat\/completions$|runs\/[^/]+\/progress$)/.test(c.req.path);
    let validOrigin = false;
    try {
      validOrigin = Boolean(origin && /^https?:\/\/[^/]+$/.test(origin) && new URL(origin).origin === origin);
    } catch { /* Invalid origins never receive widget CORS headers. */ }
    const widget = !trusted && publicKeyRoute && validOrigin;
    const hasKey = c.req.header("Authorization")?.startsWith("Bearer ") || (compatKeyRoute && Boolean(c.req.header("X-Algolia-API-Key"))) || (searchCompatRoute && c.req.path.startsWith("/compat/typesense/") && Boolean(c.req.header("X-TYPESENSE-API-KEY")));
    if (widget && c.req.method !== "OPTIONS" && !hasKey) {
      return middlewareErrorResponse(c, 403, "forbidden", "Browser integrations require an API key");
    }
    const response = await cors({
      origin: widget ? origin : trustedOrigins,
      credentials: trusted,
      allowMethods: widget ? ["GET", "POST", "OPTIONS"] : ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "MCP-Protocol-Version", "MCP-Session-Id", "Last-Event-ID", "X-Algolia-API-Key", "X-Algolia-Application-Id", "X-TYPESENSE-API-KEY", "Idempotency-Key", "X-Request-ID", "X-POSTHOG-DISTINCT-ID", "X-POSTHOG-SESSION-ID"],
      exposeHeaders: ["WWW-Authenticate", "MCP-Protocol-Version", "MCP-Session-Id", "Idempotency-Replayed", "Retry-After", "X-Request-ID", "traceparent", "RateLimit", "RateLimit-Policy", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "X-DocSlurp-Spend"],
      maxAge: 600,
    })(c, next);
    // A reflected origin is only useful after the actual keyed request passes auth.
    if (widget && c.req.method !== "OPTIONS" && c.res.status >= 400) {
      c.res.headers.delete("Access-Control-Allow-Origin");
      c.res.headers.delete("Access-Control-Allow-Credentials");
    }
    return response;
  };
}

function isSameOrigin(origin: string, requestUrl: string): boolean {
  try {
    return new URL(requestUrl).origin === origin;
  } catch {
    return false;
  }
}

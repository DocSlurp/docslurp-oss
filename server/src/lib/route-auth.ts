import type { Context, Hono } from "hono";
import { matchedRoutes } from "hono/route";

/**
 * Per-route authentication declarations (architecture gap A12).
 *
 * - "session" (the default for every route): a Better Auth cookie session.
 * - "apiKey": an API key bearer token, or a session. The route still checks
 *   the key's scopes, type and workspace itself.
 * - "route": the route authenticates the caller itself (OpenAI-compatible
 *   chat, SSO init/callback). `sessionAuth` resolves nothing.
 *
 * Routers declare their modes next to their route definitions with
 * `acceptApiKeys(router, [...])` / `authenticatedByRoute(router, [...])`.
 * `sessionAuth` reads the mode of the route that will actually answer the
 * request, so there is no separate path allowlist to drift out of sync.
 */
export type RouteAuthMode = "session" | "apiKey" | "route";

const ROUTE_AUTH = Symbol.for("docslurp.routeAuth");
/** Hono's marker for a handler wrapped by `app.route()` when the sub-app has its own onError. */
const COMPOSED_HANDLER = "__COMPOSED_HANDLER";

type MarkedHandler = ((...args: never[]) => unknown) & {
  [ROUTE_AUTH]?: RouteAuthMode;
  [COMPOSED_HANDLER]?: MarkedHandler;
};

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/** The endpoint handler (last handler) of every method route in a router. */
function endpointHandlers(router: Hono<any, any, any>): Map<string, MarkedHandler> {
  const handlers = new Map<string, MarkedHandler>();
  for (const route of router.routes) {
    if (route.method === "ALL") continue;
    handlers.set(routeKey(route.method, route.path), route.handler as MarkedHandler);
  }
  return handlers;
}

function declareRouteAuth<T extends Hono<any, any, any>>(router: T, mode: RouteAuthMode, selectors?: string[]): T {
  const handlers = endpointHandlers(router);
  const keys = new Set((selectors ?? [...handlers.keys()]).map((selector) => {
    const [method = "", path = ""] = selector.trim().split(/\s+/, 2);
    return routeKey(method, path);
  }));
  const selected = new Set<MarkedHandler>();
  for (const key of keys) {
    const handler = handlers.get(key);
    if (!handler) throw new Error(`route-auth: "${key}" does not match a route in this router`);
    handler[ROUTE_AUTH] = mode;
    selected.add(handler);
  }
  // The mark lives on the handler function, so a handler reused by an
  // undeclared route would silently widen that route too.
  for (const [key, handler] of handlers) {
    if (selected.has(handler) && !keys.has(key)) {
      throw new Error(`route-auth: "${key}" shares its handler with a ${mode} route; give it its own handler`);
    }
  }
  return router;
}

/** Let API keys reach these routes (all of the router's routes when `selectors` is omitted), e.g. `["GET /", "PATCH /:id"]`. */
export function acceptApiKeys<T extends Hono<any, any, any>>(router: T, selectors?: string[]): T {
  return declareRouteAuth(router, "apiKey", selectors);
}

/** These routes authenticate callers themselves; `sessionAuth` passes them through. */
export function authenticatedByRoute<T extends Hono<any, any, any>>(router: T, selectors?: string[]): T {
  return declareRouteAuth(router, "route", selectors);
}

function declaredMode(handler: MarkedHandler | undefined): RouteAuthMode | null {
  for (let current = handler; current; current = current[COMPOSED_HANDLER]) {
    const mode = current[ROUTE_AUTH];
    if (mode) return mode;
  }
  return null;
}

/**
 * The declared mode of the route that will answer this request: the first
 * matched method route (app-level `use()` middleware is registered as ALL),
 * read from its endpoint handler. Unmatched requests are session-only.
 */
export function routeAuthMode(c: Context): RouteAuthMode {
  const routes = matchedRoutes(c);
  const target = routes.find((route) => route.method !== "ALL");
  if (!target) return "session";
  let endpoint: MarkedHandler | undefined;
  for (const route of routes) {
    if (route.method === target.method && route.path === target.path) endpoint = route.handler as MarkedHandler;
  }
  return declaredMode(endpoint) ?? "session";
}

/** Every method route of an app with its declared mode (for tests and docs). */
export function listRouteAuthModes(app: Hono<any, any, any>): Array<{ method: string; path: string; mode: RouteAuthMode }> {
  return [...endpointHandlers(app)].map(([key, handler]) => {
    const [method = "", path = ""] = key.split(" ", 2);
    return { method, path, mode: declaredMode(handler) ?? "session" };
  });
}

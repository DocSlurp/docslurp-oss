import type { Context } from "hono";
import type { BodyBudgetCredentialResolver } from "./body-budget-owner.js";
import {
  algoliaAuthorization,
  algoliaManageAdmits,
  algoliaSearchAdmits,
  chatCompletionsAdmits,
  mcpAdmits,
  resolveRequestApiKey,
  resolveRequestMcpCredential,
  type CredentialResolution,
  CREDENTIAL_LOOKUP_MAX_CONCURRENT,
  credentialLookupsInFlight,
} from "./route-credentials.js";

type Route = {
  method: string;
  path: RegExp;
  resolve: (c: Context) => Promise<CredentialResolution>;
  admits: (resolution: CredentialResolution) => boolean;
};

const ALGOLIA = "^\\/compat\\/algolia\\/1";
const algoliaKey = (c: Context) => resolveRequestApiKey(c, algoliaAuthorization(c));
const algoliaSearch = { resolve: algoliaKey, admits: (r: CredentialResolution) => algoliaSearchAdmits(r.actor) };
const algoliaManage = { resolve: algoliaKey, admits: (r: CredentialResolution) => algoliaManageAdmits(r.actor) };

/**
 * The routes that authenticate a credential inside their handler, by exact
 * method and path, each with the verifier and admission rule its own auth uses
 * (lib/route-credentials.ts): no MCP token on chat, no `X-Algolia-API-Key`
 * outside the Algolia shim, no browser key on MCP, no key without `chat` on
 * chat completions, a search scope on Algolia search routes and a server key
 * with `projects:manage` on Algolia admin routes. Every other route resolves no
 * credential here.
 */
const PREVERIFIED_ROUTES: readonly Route[] = [
  {
    method: "POST", path: /^\/v1\/chat\/completions$/,
    resolve: (c) => resolveRequestApiKey(c, c.req.header("Authorization")),
    admits: (r) => chatCompletionsAdmits(r.actor),
  },
  { method: "POST", path: /^\/v1\/mcp$/, resolve: resolveRequestMcpCredential, admits: (r) => mcpAdmits(r.actor) },
  // Algolia search: one index's query, the multi-index `queries` batch (sent as `*/queries`), facet query, events.
  { method: "POST", path: new RegExp(`${ALGOLIA}\\/indexes\\/[^/]+\\/(?:query|queries|facets\\/[^/]+\\/query|analytics\\/(?:click|conversion))$`), ...algoliaSearch },
  // Algolia admin: settings, synonyms and rules writes, and import.
  { method: "PUT", path: new RegExp(`${ALGOLIA}\\/indexes\\/[^/]+\\/settings$`), ...algoliaManage },
  { method: "POST", path: new RegExp(`${ALGOLIA}\\/indexes\\/[^/]+\\/(?:synonyms|rules)\\/batch$`), ...algoliaManage },
  { method: "POST", path: new RegExp(`${ALGOLIA}\\/import$`), ...algoliaManage },
];

/**
 * Lookups share one admission limit with the routes' own auth
 * (route-credentials.ts: CREDENTIAL_LOOKUP_MAX_CONCURRENT, a slot held until
 * its lookup settles); the pre-check waits for its lookup at most
 * PREVERIFY_TIMEOUT_MS.
 */
export const PREVERIFY_MAX_CONCURRENT = CREDENTIAL_LOOKUP_MAX_CONCURRENT;
export const PREVERIFY_TIMEOUT_MS = 2_000;

/** Why a pre-check charged a request to the public pool, counted (and sampled into the logs). */
export type BodyBudgetFallback = "busy" | "timeout" | "unavailable" | "not-admitted" | "no-credential";
const fallbacks: Record<BodyBudgetFallback, number> = { busy: 0, timeout: 0, unavailable: 0, "not-admitted": 0, "no-credential": 0 };

/** Counts of public-pool fallbacks since start (operational visibility). */
export function bodyBudgetFallbackCounts(): Readonly<Record<BodyBudgetFallback, number>> {
  return { ...fallbacks };
}

/** The number of credential lookups in flight, pre-checks and route auth together (tests and diagnostics). */
export function bodyBudgetPreverifyInFlight(): number {
  return credentialLookupsInFlight();
}

function fallBack(reason: BodyBudgetFallback, c: Context): null {
  const count = ++fallbacks[reason];
  // Degraded verification (busy, slow or failing lookups) is logged, sampled; credential outcomes are only counted.
  if ((reason === "busy" || reason === "timeout" || reason === "unavailable") && (count === 1 || count % 100 === 0)) {
    console.warn(`[body-budget] public_fallback reason=${reason} count=${count} method=${c.req.method} path=${c.req.path}`);
  }
  return null;
}

/**
 * The production credential check for body budgets. A credential the route
 * would admit charges its key's org; anything else (none, unknown, refused,
 * wrong scope, audience or key type, or a check that is busy, slow or
 * unavailable) is public, so the budget's answer never says more about a
 * credential than the route's own. The resolution is memoized for the route's
 * auth to reuse.
 */
/** The preverified route for a request, by the router's exact method and path (no trailing-slash leniency). */
export function preverifiedRoute(method: string, path: string): Route | undefined {
  return PREVERIFIED_ROUTES.find((entry) => entry.method === method && entry.path.test(path));
}

export const verifyBodyBudgetCredential: BodyBudgetCredentialResolver = async (c: Context) => {
  const route = preverifiedRoute(c.req.method, c.req.path);
  if (!route) return null;
  // A synchronous throw in resolve still becomes a rejected lookup (and the shared limit frees its slot).
  const lookup = Promise.resolve().then(() => route.resolve(c));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    lookup.then((resolution) => resolution, () => null),
    new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), PREVERIFY_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  if (outcome === "timeout") return fallBack("timeout", c);
  if (outcome?.busy) return fallBack("busy", c);
  if (outcome === null || outcome.unavailable) return fallBack("unavailable", c);
  if (!outcome.token) return fallBack("no-credential", c);
  if (!route.admits(outcome) || !outcome.actor) return fallBack("not-admitted", c);
  return { orgId: outcome.actor.apiKey.orgId ?? null, keyId: outcome.actor.apiKey.keyId };
};

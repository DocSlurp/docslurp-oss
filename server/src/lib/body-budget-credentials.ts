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
    method: "POST", path: /^\/v1\/chat\/completions\/?$/,
    resolve: (c) => resolveRequestApiKey(c, c.req.header("Authorization")),
    admits: (r) => chatCompletionsAdmits(r.actor),
  },
  { method: "POST", path: /^\/v1\/mcp\/?$/, resolve: resolveRequestMcpCredential, admits: (r) => mcpAdmits(r.actor) },
  // Algolia search: one index's query, the multi-index `queries` batch (sent as `*/queries`), facet query, events.
  { method: "POST", path: new RegExp(`${ALGOLIA}\\/indexes\\/[^/]+\\/(?:query|queries|facets\\/[^/]+\\/query|analytics\\/(?:click|conversion))\\/?$`), ...algoliaSearch },
  // Algolia admin: settings, synonyms and rules writes, and import.
  { method: "PUT", path: new RegExp(`${ALGOLIA}\\/indexes\\/[^/]+\\/settings\\/?$`), ...algoliaManage },
  { method: "POST", path: new RegExp(`${ALGOLIA}\\/indexes\\/[^/]+\\/(?:synonyms|rules)\\/batch\\/?$`), ...algoliaManage },
  { method: "POST", path: new RegExp(`${ALGOLIA}\\/import\\/?$`), ...algoliaManage },
];

/**
 * At most PREVERIFY_MAX_CONCURRENT lookups at once: a slot is held until its
 * lookup settles (which the lookup's own timeout bounds), not merely while the
 * caller waits. The caller waits at most PREVERIFY_TIMEOUT_MS.
 */
export const PREVERIFY_MAX_CONCURRENT = 64;
export const PREVERIFY_TIMEOUT_MS = 2_000;
let inFlight = 0;

/** Why a pre-check charged a request to the public pool, counted (and sampled into the logs). */
export type BodyBudgetFallback = "busy" | "timeout" | "unavailable" | "not-admitted" | "no-credential";
const fallbacks: Record<BodyBudgetFallback, number> = { busy: 0, timeout: 0, unavailable: 0, "not-admitted": 0, "no-credential": 0 };

/** Counts of public-pool fallbacks since start (operational visibility). */
export function bodyBudgetFallbackCounts(): Readonly<Record<BodyBudgetFallback, number>> {
  return { ...fallbacks };
}

/** The number of pre-check lookups in flight (tests and diagnostics). */
export function bodyBudgetPreverifyInFlight(): number {
  return inFlight;
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
export const verifyBodyBudgetCredential: BodyBudgetCredentialResolver = async (c: Context) => {
  const route = PREVERIFIED_ROUTES.find((entry) => entry.method === c.req.method && entry.path.test(c.req.path));
  if (!route) return null;
  if (inFlight >= PREVERIFY_MAX_CONCURRENT) return fallBack("busy", c);
  inFlight++;
  const lookup = route.resolve(c);
  // The slot is released when the lookup settles, however long the caller waited.
  void lookup.finally(() => { inFlight--; }).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    lookup.then((resolution) => resolution, () => null),
    new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), PREVERIFY_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  if (outcome === "timeout") return fallBack("timeout", c);
  if (outcome === null || outcome.unavailable) return fallBack("unavailable", c);
  if (!outcome.token) return fallBack("no-credential", c);
  if (!route.admits(outcome) || !outcome.actor) return fallBack("not-admitted", c);
  return { orgId: outcome.actor.apiKey.orgId ?? null, keyId: outcome.actor.apiKey.keyId };
};

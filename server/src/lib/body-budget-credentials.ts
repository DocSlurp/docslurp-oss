import type { Context } from "hono";
import type { ApiKeyRequestActor } from "./request-actor.js";
import type { BodyBudgetCredentialResolver } from "./body-budget-owner.js";
import {
  algoliaAdmits,
  algoliaAuthorization,
  chatCompletionsAdmits,
  mcpAdmits,
  resolveRequestApiKey,
  resolveRequestMcpCredential,
} from "./route-credentials.js";

/**
 * The routes that authenticate a credential inside their handler, by exact
 * method and path, each with the verifier and admission rule its own auth uses
 * (lib/route-credentials.ts): no MCP token on chat, no `X-Algolia-API-Key`
 * outside the Algolia shim, no browser key on MCP, no key without `chat` on
 * chat completions. Every other route resolves no credential here.
 */
const PREVERIFIED_ROUTES: ReadonlyArray<{ method: string; path: RegExp; verify: (c: Context) => Promise<ApiKeyRequestActor | null> }> = [
  {
    method: "POST", path: /^\/v1\/chat\/completions\/?$/,
    verify: async (c) => {
      const { actor } = await resolveRequestApiKey(c, c.req.header("Authorization"));
      return chatCompletionsAdmits(actor) ? actor : null;
    },
  },
  {
    method: "POST", path: /^\/v1\/mcp\/?$/,
    verify: async (c) => {
      const { actor } = await resolveRequestMcpCredential(c);
      return mcpAdmits(actor) ? actor : null;
    },
  },
  {
    method: "POST", path: /^\/compat\/algolia\/1\/indexes\/(?:[^/]+\/query|\*\/queries|[^/]+\/facets\/[^/]+\/query)\/?$/,
    verify: async (c) => {
      const { actor } = await resolveRequestApiKey(c, algoliaAuthorization(c));
      return algoliaAdmits(actor) ? actor : null;
    },
  },
  {
    method: "PUT", path: /^\/compat\/algolia\/1\/indexes\/[^/]+\/settings\/?$/,
    verify: async (c) => {
      const { actor } = await resolveRequestApiKey(c, algoliaAuthorization(c));
      return algoliaAdmits(actor) ? actor : null;
    },
  },
];

/** At most this many pre-checks at once, each waited on for at most PREVERIFY_TIMEOUT_MS; past either, public. */
export const PREVERIFY_MAX_CONCURRENT = 64;
export const PREVERIFY_TIMEOUT_MS = 2_000;
let inFlight = 0;

/**
 * The production credential check for body budgets. A credential the route
 * would admit charges its key's org; anything else (none, unknown, refused,
 * wrong scope, audience or key type, or a check that is busy or slow) is
 * public, so the budget's answer never says more about a credential than the
 * route's own. The resolution is memoized for the route's auth to reuse.
 */
export const verifyBodyBudgetCredential: BodyBudgetCredentialResolver = async (c: Context) => {
  const route = PREVERIFIED_ROUTES.find((entry) => entry.method === c.req.method && entry.path.test(c.req.path));
  if (!route || inFlight >= PREVERIFY_MAX_CONCURRENT) return null;
  inFlight++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verified = route.verify(c).catch(() => null);
    const actor = await Promise.race([verified, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PREVERIFY_TIMEOUT_MS); })]);
    return actor ? { orgId: actor.apiKey.orgId ?? null, keyId: actor.apiKey.keyId } : null;
  } finally {
    clearTimeout(timer);
    inFlight--;
  }
};

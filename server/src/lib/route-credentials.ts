import type { Context } from "hono";
import { ApiKeyPolicyError, actorHasAnyApiKeyScope, resolveApiKeyActor, type ApiKeyRequestActor, type RequestActor } from "./request-actor.js";
import { requestIp } from "./request-context.js";
import { mcpResource, validateMcpToken } from "../services/mcp-oauth.js";
import { recordApiKeyRequest } from "../services/api-key-usage.js";
import { reportException } from "@docslurp/shared/error-reporting";
import { apiKeyHasAnyScope } from "./api-key-authorization.js";
import { SEARCH_SCOPES } from "./search-tiers.js";

/**
 * Credential parsing and route admission for routes that authenticate a key
 * or bearer themselves (`/v1/chat/completions`, `/v1/mcp`, the Algolia shim).
 * One implementation serves both the route's auth middleware and the request
 * body budget's pre-check (body-budget-credentials.ts), so the budget charges
 * a credential to its org only when the route itself would admit it.
 *
 * Resolution is memoized per request (by its Hono context: the limiter
 * replaces `c.req.raw`, the context stays), so a body-bearing request makes
 * one key lookup. Resolving never records key usage; the route's auth records
 * it once (recordResolvedApiKeyUsage), so a request the budget refuses first
 * leaves no usage record.
 */
export type CredentialResolution = {
  actor: ApiKeyRequestActor | null;
  policyError: ApiKeyPolicyError | null;
  /** The bearer the request presented ("" when none). */
  token: string;
  /** The lookup failed or timed out: the credential could not be verified either way (fail closed, retryable). */
  unavailable?: boolean;
  /** Unavailable because the lookup admission limit was full (no lookup ran). */
  busy?: boolean;
};

/**
 * One admission limit for every credential lookup on these routes, the route's
 * own auth and the body budget's pre-check alike: at most
 * CREDENTIAL_LOOKUP_MAX_CONCURRENT at once, each slot held until its lookup
 * settles (the lookup's own bounds limit how long). Past it a lookup is
 * unavailable without running: route auth answers 503 with Retry-After.
 */
export const CREDENTIAL_LOOKUP_MAX_CONCURRENT = 64;
let lookupsInFlight = 0;

export function credentialLookupsInFlight(): number {
  return lookupsInFlight;
}

function admitted(token: string, lookup: () => Promise<CredentialResolution>): Promise<CredentialResolution> {
  if (lookupsInFlight >= CREDENTIAL_LOOKUP_MAX_CONCURRENT) {
    return Promise.resolve({ actor: null, policyError: null, token, unavailable: true, busy: true });
  }
  lookupsInFlight++;
  // Promise.resolve().then: a lookup that throws synchronously still settles here and frees its slot.
  return Promise.resolve().then(lookup).finally(() => { lookupsInFlight--; });
}

/** The database lookup behind one credential check is cancelled after this long. */
export const CREDENTIAL_LOOKUP_TIMEOUT_MS = 3_000;

function unavailable(error: unknown, token: string, surface: string): CredentialResolution {
  // The raw cause goes to telemetry; callers answer 503 (route auth) or fall back to public (body budget).
  reportException(error, { surface: `credential-lookup:${surface}` });
  return { actor: null, policyError: null, token, unavailable: true };
}

const resolutions = new WeakMap<Context, Map<string, Promise<CredentialResolution>>>();
const usageRecorded = new WeakSet<Context>();

function memoized(c: Context, key: string, resolve: () => Promise<CredentialResolution>): Promise<CredentialResolution> {
  let byKey = resolutions.get(c);
  if (!byKey) resolutions.set(c, (byKey = new Map()));
  let pending = byKey.get(key);
  if (!pending) byKey.set(key, (pending = resolve()));
  return pending;
}

/** RFC 6750 §2.1: the auth scheme is case-insensitive. */
export function bearerToken(header: string | undefined): string {
  const match = header?.match(/^Bearer[ ]+([^\s]+)\s*$/i);
  return match?.[1] ?? "";
}

/** An API key or CLI token from an `Authorization: Bearer` header (MCP-audience tokens resolve to none). */
export function resolveRequestApiKey(c: Context, authorization: string | undefined): Promise<CredentialResolution> {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) return memoized(c, "api:", async () => ({ actor: null, policyError: null, token }));
  return memoized(c, `api:${authorization}`, () => admitted(token, async () => {
    try {
      const actor = await resolveApiKeyActor(authorization, {
        origin: c.req.header("origin"),
        referer: c.req.header("referer") ?? c.req.header("referrer"),
        ip: requestIp(c),
      }, { recordUsage: false, timeoutMs: CREDENTIAL_LOOKUP_TIMEOUT_MS });
      return { actor, policyError: null, token };
    } catch (error) {
      if (error instanceof ApiKeyPolicyError) return { actor: null, policyError: error, token };
      return unavailable(error, token, "api-key");
    }
  }));
}

/** The MCP credential exactly as mcp-auth reads it: an MCP-audience token for this resource, else an API key. */
export function resolveRequestMcpCredential(c: Context): Promise<CredentialResolution> {
  const token = bearerToken(c.req.header("Authorization"));
  return memoized(c, `mcp:${token}`, async () => {
    if (token.startsWith("dsmcp_")) {
      return admitted(token, async () => {
        try {
          const key = await validateMcpToken(token, mcpResource(c.req.url), { ip: requestIp(c) }, { timeoutMs: CREDENTIAL_LOOKUP_TIMEOUT_MS });
          return { actor: key ? { type: "apiKey", userId: key.userId, apiKey: key } : null, policyError: null, token };
        } catch (error) {
          return unavailable(error, token, "mcp-token");
        }
      });
    }
    if (!token || token.startsWith("dsmcp")) return { actor: null, policyError: null, token };
    return resolveRequestApiKey(c, `Bearer ${token}`);
  });
}

/** The Algolia shim's credential: `Authorization`, else `X-Algolia-API-Key` as a bearer. Algolia routes only. */
export function algoliaAuthorization(c: Context): string | undefined {
  const header = c.req.header("Authorization");
  const algoliaKey = c.req.header("X-Algolia-API-Key");
  return !header && algoliaKey ? `Bearer ${algoliaKey}` : header;
}

/** Records one API-key request for this request's resolved key (API keys only; OAuth tokens are not counted). */
export function recordResolvedApiKeyUsage(c: Context, resolution: CredentialResolution): void {
  const actor = resolution.actor;
  if (!actor || usageRecorded.has(c) || /^ds(cli|mcp)/.test(resolution.token)) return;
  usageRecorded.add(c);
  recordApiKeyRequest(actor.apiKey.keyId, Date.now(), requestIp(c));
}

/** `/v1/chat/completions` admits an API key with the `chat` scope. */
export function chatCompletionsAdmits(actor: RequestActor | null | undefined): boolean {
  return actorHasAnyApiKeyScope(actor, ["chat"]);
}

/** `/v1/mcp` admits only a server key (an MCP token resolves to one). */
export function mcpAdmits(actor: ApiKeyRequestActor | null): actor is ApiKeyRequestActor {
  return actor !== null && actor.apiKey.keyType === "server";
}

/**
 * Algolia search routes (query, queries, facet query, click and conversion
 * events) admit a key with a search scope, browser keys included; the handler
 * applies the same rule (requireSearchKey) and then the per-index scope.
 */
export function algoliaSearchAdmits(actor: ApiKeyRequestActor | null): actor is ApiKeyRequestActor {
  return actor !== null && apiKeyHasAnyScope(actor.apiKey, [...SEARCH_SCOPES]);
}

/**
 * Algolia admin routes (settings, synonyms and rules writes, import) admit only
 * a server key with `projects:manage`; the handler applies the same rule
 * (requireServerManageKey) and then project edit access.
 */
export function algoliaManageAdmits(actor: ApiKeyRequestActor | null): actor is ApiKeyRequestActor {
  return actor !== null && actor.apiKey.keyType === "server" && apiKeyHasAnyScope(actor.apiKey, ["projects:manage"]);
}

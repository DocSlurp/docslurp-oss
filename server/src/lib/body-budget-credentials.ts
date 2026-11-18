import type { Context } from "hono";
import { resolveApiKeyActor } from "./request-actor.js";
import { requestIp } from "./request-context.js";
import { mcpResource, validateMcpToken } from "../services/mcp-oauth.js";
import type { BodyBudgetCredentialResolver } from "./body-budget-owner.js";

/**
 * The production credential check for body budgets: the bearer token (or an
 * Algolia compat `X-Algolia-API-Key`) verified the way the route's own auth
 * verifies it. MCP-audience tokens against the MCP resource, any other bearer
 * as an API key or CLI token. A policy refusal or unknown credential is null.
 */
export const verifyBodyBudgetCredential: BodyBudgetCredentialResolver = async (c: Context) => {
  const authorization = c.req.header("Authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : c.req.header("X-Algolia-API-Key")?.trim();
  if (!bearer) return null;
  try {
    if (bearer.startsWith("dsmcp_")) {
      const key = await validateMcpToken(bearer, mcpResource(c.req.url), { ip: requestIp(c) });
      return key ? { orgId: key.orgId ?? null, keyId: key.keyId } : null;
    }
    const actor = await resolveApiKeyActor(`Bearer ${bearer}`, {
      origin: c.req.header("origin"),
      referer: c.req.header("referer") ?? c.req.header("referrer"),
      ip: requestIp(c),
    });
    return actor ? { orgId: actor.apiKey.orgId ?? null, keyId: actor.apiKey.keyId } : null;
  } catch {
    return null;
  }
};

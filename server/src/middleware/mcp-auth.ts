import type { MiddlewareHandler } from "hono";
import { setRequestActor } from "../lib/request-actor.js";
import { MCP_DEFAULT_SCOPES, mcpOrigin } from "../services/mcp-oauth.js";
import { bearerToken, mcpAdmits, recordResolvedApiKeyUsage, resolveRequestMcpCredential } from "../lib/route-credentials.js";
import { enforceAuthenticatedApiRateLimit } from "./rate-limit.js";

export { bearerToken };

/**
 * RFC 6750 §3 / RFC 9728 §5.1 challenge. `invalid_token` tells a client that its
 * token was refused (expired, revoked or for another audience), as opposed to
 * missing, and `scope` is the MCP-recommended scope hint for (re)authorization.
 */
export function mcpBearerChallenge(requestUrl: string, presented: boolean): string {
  const params = [
    `resource_metadata="${mcpOrigin(requestUrl)}/.well-known/oauth-protected-resource/v1/mcp"`,
    `scope="${MCP_DEFAULT_SCOPES.join(" ")}"`,
  ];
  if (presented) params.unshift(`error="invalid_token"`, `error_description="The access token is invalid, expired or revoked"`);
  return `Bearer ${params.join(", ")}`;
}

export const mcpAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("Authorization");
  // Shared with the request body budget (lib/route-credentials.ts): one lookup per request.
  const resolution = await resolveRequestMcpCredential(c);
  // Verification unavailable (the lookup failed or timed out): fail closed, and say it is retryable.
  if (resolution.unavailable) {
    c.header("Retry-After", "2");
    return c.json({ error: "Credential verification is temporarily unavailable" }, 503);
  }
  if (resolution.policyError) {
    // Browser keys never reach MCP; a legacy one without projects is refused like any browser key.
    const error = resolution.policyError;
    if (error.code === "api_key_ip_not_allowed") return c.json({ error: error.message, code: error.code }, 403);
    return c.json({ error: "A server API key is required" }, 403);
  }
  const actor = resolution.actor;
  if (!actor) {
    c.header("WWW-Authenticate", mcpBearerChallenge(c.req.url, Boolean(header)));
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!mcpAdmits(actor))
    return c.json({ error: "A server API key is required" }, 403);
  setRequestActor(c, actor);
  recordResolvedApiKeyUsage(c, resolution);
  const limited = await enforceAuthenticatedApiRateLimit(c);
  if (limited)
    return limited;
  await next();
};

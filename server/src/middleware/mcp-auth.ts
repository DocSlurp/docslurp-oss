import type { MiddlewareHandler } from "hono";
import { resolveApiKeyActor, setRequestActor } from "../lib/request-actor.js";
import { MCP_SCOPES, mcpOrigin, mcpResource, validateMcpToken } from "../services/mcp-oauth.js";
import { enforceAuthenticatedApiRateLimit } from "./rate-limit.js";

/** RFC 6750 §2.1: the auth scheme is case-insensitive. */
export function bearerToken(header: string | undefined): string {
  const match = header?.match(/^Bearer[ ]+([^\s]+)\s*$/i);
  return match?.[1] ?? "";
}

/**
 * RFC 6750 §3 / RFC 9728 §5.1 challenge. `invalid_token` tells a client that its
 * token was refused (expired, revoked or for another audience), as opposed to
 * missing, and `scope` is the MCP-recommended scope hint for (re)authorization.
 */
export function mcpBearerChallenge(requestUrl: string, presented: boolean): string {
  const params = [
    `resource_metadata="${mcpOrigin(requestUrl)}/.well-known/oauth-protected-resource/v1/mcp"`,
    `scope="${MCP_SCOPES.join(" ")}"`,
  ];
  if (presented) params.unshift(`error="invalid_token"`, `error_description="The access token is invalid, expired or revoked"`);
  return `Bearer ${params.join(", ")}`;
}

export const mcpAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("Authorization");
  const token = bearerToken(header);
  const key = token.startsWith("dsmcp_") ? await validateMcpToken(token, mcpResource(c.req.url)) : null;
  const actor = key ? { type: "apiKey" as const, userId: key.userId, apiKey: key } : token && !token.startsWith("dsmcp") ? await resolveApiKeyActor(`Bearer ${token}`, { origin: c.req.header("origin"), referer: c.req.header("referer") }) : null;
  if (!actor) {
    c.header("WWW-Authenticate", mcpBearerChallenge(c.req.url, Boolean(header)));
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (actor.apiKey.keyType !== "server")
    return c.json({ error: "A server API key is required" }, 403);
  setRequestActor(c, actor);
  const limited = await enforceAuthenticatedApiRateLimit(c);
  if (limited)
    return limited;
  await next();
};

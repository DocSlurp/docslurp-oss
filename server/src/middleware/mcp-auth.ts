import type { MiddlewareHandler } from "hono";
import { resolveApiKeyActor, setRequestActor } from "../lib/request-actor.js";
import { mcpOrigin, mcpResource, validateMcpToken } from "../services/mcp-oauth.js";
import { enforceAuthenticatedApiRateLimit } from "./rate-limit.js";
export const mcpAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const key = token.startsWith("dsmcp_") ? await validateMcpToken(token, mcpResource(c.req.url)) : null;
  const actor = key ? { type: "apiKey" as const, userId: key.userId, apiKey: key } : token && !token.startsWith("dsmcp") ? await resolveApiKeyActor(header, { origin: c.req.header("origin"), referer: c.req.header("referer") }) : null;
  if (!actor) {
    c.header("WWW-Authenticate", `Bearer resource_metadata="${mcpOrigin(c.req.url)}/.well-known/oauth-protected-resource/v1/mcp"`);
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

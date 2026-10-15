import { Hono } from "hono";
import { env } from "../config.js";
import { mcpAuth } from "../middleware/mcp-auth.js";
import { handleMcpHttp } from "../lib/mcp-http.js";
import { mcpOrigin } from "../lib/mcp-origin.js";
import { createMcpDispatcher, mcpAdapterRoutes, mcpManifest } from "../services/mcp-tools.js";

export const mcpRoutes = new Hono()
  .use("*", mcpAuth)
  .all("/", async (c) => {
    const canonical = new URL(mcpOrigin(c.req.url));
    const origins = new Set([canonical.origin, new URL(env.apiUrl).origin, new URL(env.appUrl).origin, ...env.corsAllowedOrigins]);
    const origin = c.req.header("Origin");
    // Origin is optional for native clients; any supplied origin must be trusted.
    // Never derive the allowlist from incoming Host or forwarded headers.
    if (origin && !origins.has(origin)) return c.json({ error: "Invalid MCP origin" }, 403);
    const host = c.req.header("Host");
    const hosts = new Set([canonical.host, new URL(env.apiUrl).host, new URL(env.appUrl).host]);
    if (host && !hosts.has(host)) return c.json({ error: "Invalid MCP host" }, 403);
    const actor = c.get("requestActor");
    const dispatch = createMcpDispatcher(actor);
    const manifest = mcpManifest(canonical.origin, c.get("apiKey").scopes);
    return handleMcpHttp(c.req.raw, manifest, async (path, init) => {
      // Paths are fixed by protocol handlers, not client-controlled URLs.
      return dispatch(path, init);
    });
  })
  .route("/", mcpAdapterRoutes);

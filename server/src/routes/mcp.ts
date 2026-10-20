import { Hono, type MiddlewareHandler } from "hono";
import { env } from "../config.js";
import { mcpAuth } from "../middleware/mcp-auth.js";
import { handleMcpHttp } from "../lib/mcp-http.js";
import { mcpOrigin } from "../lib/mcp-origin.js";
import { createMcpDispatcher, mcpAdapterRoutes, mcpManifest } from "../services/mcp-tools.js";

/**
 * Transport checks that need no credentials. They run before authentication so
 * an unsupported method or an untrusted browser origin never starts an OAuth flow.
 */
const mcpEndpointGuard: MiddlewareHandler = async (c, next) => {
  // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
  // Streamable HTTP requires 405 here; answering 401 instead makes clients re-run
  // OAuth on every background SSE reconnect.
  if (c.req.method !== "POST") return c.body("Method not allowed", 405, { Allow: "POST" });
  const canonical = new URL(mcpOrigin(c.req.url));
  const origins = new Set([canonical.origin, new URL(env.apiUrl).origin, new URL(env.appUrl).origin, ...env.corsAllowedOrigins]);
  const origin = c.req.header("Origin");
  // Origin is optional for native clients; any supplied origin must be trusted.
  // Never derive the allowlist from incoming Host or forwarded headers.
  if (origin && !origins.has(origin)) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid MCP origin" } }, 403);
  const host = c.req.header("Host");
  const hosts = new Set([canonical.host, new URL(env.apiUrl).host, new URL(env.appUrl).host]);
  if (host && !hosts.has(host)) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid MCP host" } }, 403);
  await next();
};

export const mcpRoutes = new Hono()
  .use("/", mcpEndpointGuard)
  .use("*", mcpAuth)
  .post("/", async (c) => {
    const actor = c.get("requestActor");
    const dispatch = createMcpDispatcher(actor);
    const manifest = mcpManifest(new URL(mcpOrigin(c.req.url)).origin, c.get("apiKey").scopes, c.get("apiKey").keyType);
    return handleMcpHttp(c.req.raw, manifest, async (path, init) => {
      // Paths are fixed by protocol handlers, not client-controlled URLs.
      return dispatch(path, init);
    });
  })
  .route("/", mcpAdapterRoutes);

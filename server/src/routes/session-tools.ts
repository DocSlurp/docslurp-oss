import { Hono } from "hono";
import { env } from "../config.js";
import { getRequestActor } from "../lib/request-actor.js";
import { mcpAdapterRoutes } from "../services/mcp-tools.js";
import { apiStatusError, nativeBodyLimit } from "../lib/api-error.js";

/** Cookie-authenticated adapter. Remote MCP remains bearer-only. */
export const sessionToolRoutes = new Hono()
  .use("*", nativeBodyLimit(1024 * 1024))
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!env.webMcpEnabled) return apiStatusError(c, 404, "WebMCP is disabled");
    if (c.req.header("Authorization") || getRequestActor(c).type !== "session") {
      return apiStatusError(c, 401, "A signed-in browser session is required");
    }
    // Reject cross-site cookie execution, including non-browser clients that omit Origin.
    if (c.req.method !== "GET") {
      if (c.req.header("Origin") !== new URL(env.appUrl).origin) {
        return apiStatusError(c, 403, "Invalid tool origin");
      }
      if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("Content-Type") ?? "")) {
        return apiStatusError(c, 415, "Expected application/json");
      }
    }
    await next();
  })
  .route("/", mcpAdapterRoutes);

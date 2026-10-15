import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { env } from "../config.js";
import { getRequestActor } from "../lib/request-actor.js";
import { mcpAdapterRoutes } from "../services/mcp-tools.js";

/** Cookie-authenticated adapter. Remote MCP remains bearer-only. */
export const sessionToolRoutes = new Hono()
  .use("*", bodyLimit({ maxSize: 1024 * 1024 }))
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!env.webMcpEnabled) return c.json({ error: "WebMCP is disabled" }, 404);
    if (c.req.header("Authorization") || getRequestActor(c).type !== "session") {
      return c.json({ error: "A signed-in browser session is required" }, 401);
    }
    // Reject cross-site cookie execution, including non-browser clients that omit Origin.
    if (c.req.method !== "GET") {
      if (c.req.header("Origin") !== new URL(env.appUrl).origin) {
        return c.json({ error: "Invalid tool origin" }, 403);
      }
      if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("Content-Type") ?? "")) {
        return c.json({ error: "Expected application/json" }, 415);
      }
    }
    await next();
  })
  .route("/", mcpAdapterRoutes);

import { Hono } from "hono";
import { env } from "../config.js";
import { getRequestActor } from "../lib/request-actor.js";
import { markSessionToolsSurface, mcpAdapterRoutes } from "../services/mcp-tools.js";
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
    const appOrigin = new URL(env.appUrl).origin;
    const origin = c.req.header("Origin");
    if (c.req.method === "GET" || c.req.method === "HEAD") {
      // Browsers omit Origin on same-origin GETs, so reads accept a missing
      // Origin unless Fetch Metadata says the request came from another site.
      // Any Origin that is sent must still be the app's.
      const fetchSite = c.req.header("Sec-Fetch-Site");
      if (origin ? origin !== appOrigin : fetchSite === "cross-site" || fetchSite === "same-site") {
        return apiStatusError(c, 403, "Invalid tool origin");
      }
    } else {
      // Reject cross-site cookie execution, including non-browser clients that omit Origin.
      if (origin !== appOrigin) {
        return apiStatusError(c, 403, "Invalid tool origin");
      }
      if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("Content-Type") ?? "")) {
        return apiStatusError(c, 415, "Expected application/json");
      }
    }
    await next();
  })
  .use("*", markSessionToolsSurface)
  .route("/", mcpAdapterRoutes);

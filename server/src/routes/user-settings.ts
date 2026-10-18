import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";

import {
  createMcpServiceConnection,
  createMcpServiceSchema,
  deleteMcpServiceConnection,
  getUserSettings,
  listMcpServiceConnections,
  refreshMcpServiceConnection,
  updateGeneralSettingsSchema,
  updateMcpServiceConnection,
  updateMcpServiceSchema,
  updateUserSettings,
} from "../services/user-settings.js";
import { apiStatusError } from "../lib/api-error.js";
import { validationHook } from "../lib/validation.js";

export const userSettingsRoutes = new Hono()
  .get("/", async (c) => {
    const userId = c.get("sessionUser").id;
    const settings = await getUserSettings(userId);
    return c.json(settings);
  })
  .patch("/", zValidator("json", updateGeneralSettingsSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const settings = await updateUserSettings(userId, c.req.valid("json"));
    return c.json(settings);
  })
  .get("/mcp-services", async (c) => {
    const userId = c.get("sessionUser").id;
    const services = await listMcpServiceConnections(userId);
    return c.json({ services });
  })
  .post("/mcp-services", zValidator("json", createMcpServiceSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const service = await createMcpServiceConnection(userId, c.req.valid("json"));
    return c.json({ service }, 201);
  })
  .patch("/mcp-services/:id", zValidator("json", updateMcpServiceSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const service = await updateMcpServiceConnection(
      userId,
      c.req.param("id"),
      c.req.valid("json"),
    );

    if (!service) {
      return apiStatusError(c, 404, "MCP service not found");
    }

    return c.json({ service });
  })
  .post("/mcp-services/:id/refresh", async (c) => {
    const userId = c.get("sessionUser").id;
    const service = await refreshMcpServiceConnection(userId, c.req.param("id"));
    if (!service) {
      return apiStatusError(c, 404, "MCP service not found");
    }

    return c.json({
      service,
      reauthUrl:
        service.authType === "oauth2.1" && service.status === "needs_auth"
          ? `/v1/user-settings/mcp-services/${service.id}/oauth/start`
          : null,
    });
  })
  .post("/mcp-services/:id/oauth/start", async (c) => {
    const userId = c.get("sessionUser").id;
    const service = await updateMcpServiceConnection(userId, c.req.param("id"), {
      status: "needs_auth",
    });
    if (!service) {
      return apiStatusError(c, 404, "MCP service not found");
    }

    return c.json({
      service,
      auth: {
        oauthVersion: "2.1",
        resource: service.url,
        issuer: service.oauthIssuer,
        scopes: service.scopes,
        status: "reauth_required",
      },
    });
  })
  .delete("/mcp-services/:id", async (c) => {
    const userId = c.get("sessionUser").id;
    const deleted = await deleteMcpServiceConnection(userId, c.req.param("id"));
    if (!deleted) {
      return apiStatusError(c, 404, "MCP service not found");
    }

    return c.json({ deleted: true });
  });

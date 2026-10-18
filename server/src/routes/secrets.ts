import { reportPublicError } from "../lib/public-errors.js";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import { appendAuditLog } from "../services/audit-log.js";
import {
  authorizeWorkspaceSecretAccess,
  createWorkspaceSecret,
  deleteWorkspaceSecret,
  listWorkspaceSecrets,
  rotateWorkspaceSecret
} from "../services/secrets.js";
import { requestIp, requestUserAgent } from "../lib/request-context.js";
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";
import { validationHook } from "../lib/validation.js";

const createSecretSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(["api_key", "webhook_secret", "connector_credential", "token", "other"]),
  value: z.string().min(1).max(65536),
  expiresAt: z.string().nullable().optional()
});

const rotateSecretSchema = z.object({
  value: z.string().min(1).max(65536)
});

export const secretsRoutes = new Hono()
  .get("/:workspaceId/secrets", async (c) => {
    const userId = c.get("sessionUser").id;
    const workspaceId = c.req.param("workspaceId");

    const authorization = await authorizeWorkspaceSecretAccess({ workspaceId, userId });
    if (!authorization.ok) {
      return apiErrorResponse(c, authorization.status, authorization.code, authorization.message);
    }

    const secrets = await listWorkspaceSecrets({ access: authorization.grant });
    return c.json({ secrets });
  })
  .post("/:workspaceId/secrets", zValidator("json", createSecretSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const workspaceId = c.req.param("workspaceId");
    const body = c.req.valid("json");

    const authorization = await authorizeWorkspaceSecretAccess({ workspaceId, userId });
    if (!authorization.ok) {
      return apiErrorResponse(c, authorization.status, authorization.code, authorization.message);
    }

    try {
      const secret = await createWorkspaceSecret({
        access: authorization.grant,
        workspaceId,
        name: body.name,
        type: body.type,
        value: body.value,
        expiresAt: body.expiresAt ?? null
      });

      await appendAuditLog({
        orgId: authorization.grant.orgId,
        userId,
        workspaceId,
        action: "workspace.secret.created",
        resourceType: "workspace-secret",
        resourceId: secret.id,
        ipAddress: requestIp(c),
        metadata: {
          secretName: secret.name,
          secretType: secret.type,
          userAgent: requestUserAgent(c)
        }
      });

      return c.json({ secret }, 201);
    } catch (error) {
      return apiStatusError(c, 400, reportPublicError(error));
    }
  })
  .post("/:workspaceId/secrets/:secretId/rotate", zValidator("json", rotateSecretSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const workspaceId = c.req.param("workspaceId");
    const secretId = c.req.param("secretId");
    const body = c.req.valid("json");

    const authorization = await authorizeWorkspaceSecretAccess({ workspaceId, userId });
    if (!authorization.ok) {
      return apiErrorResponse(c, authorization.status, authorization.code, authorization.message);
    }

    const secret = await rotateWorkspaceSecret({
      access: authorization.grant,
      workspaceId,
      secretId,
      newValue: body.value
    });

    if (!secret) {
      return apiStatusError(c, 404, "Secret not found");
    }

    await appendAuditLog({
      orgId: authorization.grant.orgId,
      userId,
      workspaceId,
      action: "workspace.secret.rotated",
      resourceType: "workspace-secret",
      resourceId: secret.id,
      ipAddress: requestIp(c),
      metadata: {
        secretName: secret.name,
        secretType: secret.type,
        userAgent: requestUserAgent(c)
      }
    });

    return c.json({ secret });
  })
  .delete("/:workspaceId/secrets/:secretId", async (c) => {
    const userId = c.get("sessionUser").id;
    const workspaceId = c.req.param("workspaceId");
    const secretId = c.req.param("secretId");

    const authorization = await authorizeWorkspaceSecretAccess({ workspaceId, userId });
    if (!authorization.ok) {
      return apiErrorResponse(c, authorization.status, authorization.code, authorization.message);
    }

    const deleted = await deleteWorkspaceSecret({
      access: authorization.grant,
      workspaceId,
      secretId
    });

    if (!deleted) {
      return apiStatusError(c, 404, "Secret not found");
    }

    await appendAuditLog({
      orgId: authorization.grant.orgId,
      userId,
      workspaceId,
      action: "workspace.secret.deleted",
      resourceType: "workspace-secret",
      resourceId: secretId,
      ipAddress: requestIp(c),
      metadata: { userAgent: requestUserAgent(c) }
    });

    return c.json({ ok: true });
  });

import { reportPublicError } from "../lib/public-errors.js";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import { appendAuditLog } from "../services/audit-log.js";
import {
  authorizeProjectSecretAccess,
  createProjectSecret,
  deleteProjectSecret,
  listProjectSecrets,
  rotateProjectSecret
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
  .get("/:projectId/secrets", async (c) => {
    const userId = c.get("sessionUser").id;
    const projectId = c.req.param("projectId");

    const authorization = await authorizeProjectSecretAccess({ projectId, userId });
    if (!authorization.ok) {
      return apiErrorResponse(c, authorization.status, authorization.code, authorization.message);
    }

    const secrets = await listProjectSecrets({ access: authorization.grant });
    return c.json({ secrets });
  })
  .post("/:projectId/secrets", zValidator("json", createSecretSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const projectId = c.req.param("projectId");
    const body = c.req.valid("json");

    const authorization = await authorizeProjectSecretAccess({ projectId, userId });
    if (!authorization.ok) {
      return apiErrorResponse(c, authorization.status, authorization.code, authorization.message);
    }

    try {
      const secret = await createProjectSecret({
        access: authorization.grant,
        projectId,
        name: body.name,
        type: body.type,
        value: body.value,
        expiresAt: body.expiresAt ?? null
      });

      await appendAuditLog({
        orgId: authorization.grant.orgId,
        userId,
        projectId,
        action: "project.secret.created",
        resourceType: "project-secret",
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
  .post("/:projectId/secrets/:secretId/rotate", zValidator("json", rotateSecretSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const projectId = c.req.param("projectId");
    const secretId = c.req.param("secretId");
    const body = c.req.valid("json");

    const authorization = await authorizeProjectSecretAccess({ projectId, userId });
    if (!authorization.ok) {
      return apiErrorResponse(c, authorization.status, authorization.code, authorization.message);
    }

    const secret = await rotateProjectSecret({
      access: authorization.grant,
      projectId,
      secretId,
      newValue: body.value
    });

    if (!secret) {
      return apiStatusError(c, 404, "Secret not found");
    }

    await appendAuditLog({
      orgId: authorization.grant.orgId,
      userId,
      projectId,
      action: "project.secret.rotated",
      resourceType: "project-secret",
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
  .delete("/:projectId/secrets/:secretId", async (c) => {
    const userId = c.get("sessionUser").id;
    const projectId = c.req.param("projectId");
    const secretId = c.req.param("secretId");

    const authorization = await authorizeProjectSecretAccess({ projectId, userId });
    if (!authorization.ok) {
      return apiErrorResponse(c, authorization.status, authorization.code, authorization.message);
    }

    const deleted = await deleteProjectSecret({
      access: authorization.grant,
      projectId,
      secretId
    });

    if (!deleted) {
      return apiStatusError(c, 404, "Secret not found");
    }

    await appendAuditLog({
      orgId: authorization.grant.orgId,
      userId,
      projectId,
      action: "project.secret.deleted",
      resourceType: "project-secret",
      resourceId: secretId,
      ipAddress: requestIp(c),
      metadata: { userAgent: requestUserAgent(c) }
    });

    return c.json({ ok: true });
  });

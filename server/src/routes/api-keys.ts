import { reportPublicError } from "../lib/public-errors.js";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { apiKeyRateLimitRulesSchema } from "@docslurp/shared";

import { OrganizationError } from "../services/organizations.js";
import { requestIp, requestUserAgent } from "../lib/request-context.js";
import { appendAuditLog } from "../services/audit-log.js";
import { ApiKeyTypeChangeError, apiKeyTypes, createApiKey, supportedApiKeyScopes, listApiKeys, revokeApiKey, rotateApiKey, updateApiKey } from "../services/api-keys.js";

const apiKeyScopeSchema = z.enum(supportedApiKeyScopes);
const apiKeyTypeSchema = z.enum(apiKeyTypes);
const allowedDomainSchema = z.string().min(1).max(255);
const workspaceIdsSchema = z.array(z.string().min(1).max(200)).max(100);

const createApiKeySchema = z.object({
  orgId: z.string().optional(),
  name: z.string().min(1).max(120),
  keyType: apiKeyTypeSchema.optional(),
  allowedDomains: z.array(allowedDomainSchema).optional(),
  scopes: z.array(apiKeyScopeSchema).min(1).optional(),
  rateLimitRpm: z.number().int().positive().optional(),
  rateLimitPpd: z.number().int().positive().optional(),
  rateLimits: apiKeyRateLimitRulesSchema.optional(),
  /** Limit the key to these workspaces (IDs in the key's org). Omitted/empty: all of them. */
  workspaceIds: workspaceIdsSchema.optional(),
  /** Client keys only: acknowledge granting ingest/artifacts to a public key (needs workspaceIds). */
  allowClientSensitiveScopes: z.boolean().optional(),
});

const updateApiKeySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  keyType: apiKeyTypeSchema.optional(),
  allowedDomains: z.array(allowedDomainSchema).optional(),
  scopes: z.array(apiKeyScopeSchema).min(1).optional(),
  rateLimitRpm: z.number().int().positive().optional(),
  rateLimitPpd: z.number().int().positive().optional(),
  rateLimits: apiKeyRateLimitRulesSchema.optional(),
  workspaceIds: workspaceIdsSchema.optional(),
  allowClientSensitiveScopes: z.boolean().optional(),
});

export const apiKeysRoutes = new Hono()
  .post("/", zValidator("json", createApiKeySchema), async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    let result;
    try {
      result = await createApiKey(userId, body.name, {
        orgId: body.orgId,
        keyType: body.keyType,
        allowedDomains: body.allowedDomains,
        scopes: body.scopes,
        rpm: body.rateLimitRpm,
        ppd: body.rateLimitPpd,
        rateLimits: body.rateLimits,
        workspaceIds: body.workspaceIds,
        allowClientSensitiveScopes: body.allowClientSensitiveScopes,
      });
    } catch (error) {
      if (error instanceof OrganizationError) return c.json({ error: error.message, code: error.code }, error.status);
      return c.json({ error: reportPublicError(error) }, 400);
    }
    await appendAuditLog({
      userId,
      apiKeyId: result.key.id,
      action: "api_key.created",
      resourceType: "api-key",
      resourceId: result.key.id,
      ipAddress: requestIp(c),
      metadata: {
        orgId: result.key.orgId,
        name: result.key.name,
        keyType: result.key.keyType,
        allowedDomains: result.key.allowedDomains,
        scopes: result.key.scopes,
        rateLimitRpm: result.key.rateLimitRpm,
        rateLimitPpd: result.key.rateLimitPpd,
        rateLimits: result.key.rateLimits,
        workspaceIds: result.key.workspaceIds,
        userAgent: requestUserAgent(c)
      }
    });
    return c.json({ key: result.key, rawKey: result.rawKey }, 201);
  })
  .get("/", async (c) => {
    const userId = c.get("sessionUser").id;
    const keys = await listApiKeys(userId);
    return c.json({ keys });
  })
  .patch("/:id", zValidator("json", updateApiKeySchema), async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    let key;
    try {
      key = await updateApiKey(c.req.param("id"), userId, {
        name: body.name,
        keyType: body.keyType,
        allowedDomains: body.allowedDomains,
        scopes: body.scopes,
        rateLimitRpm: body.rateLimitRpm,
        rateLimitPpd: body.rateLimitPpd,
        rateLimits: body.rateLimits,
        workspaceIds: body.workspaceIds,
        allowClientSensitiveScopes: body.allowClientSensitiveScopes,
      });
    } catch (error) {
      if (error instanceof OrganizationError) return c.json({ error: error.message, code: error.code }, error.status);
      if (error instanceof ApiKeyTypeChangeError) return c.json({ error: error.message, code: error.code }, error.status);
      return c.json({ error: reportPublicError(error) }, 400);
    }

    if (!key) {
      return c.json({ error: "API key not found or already revoked" }, 404);
    }

    await appendAuditLog({
      userId,
      apiKeyId: key.id,
      action: "api_key.updated",
      resourceType: "api-key",
      resourceId: key.id,
      ipAddress: requestIp(c),
      metadata: {
        name: key.name,
        keyType: key.keyType,
        allowedDomains: key.allowedDomains,
        scopes: key.scopes,
        rateLimitRpm: key.rateLimitRpm,
        rateLimitPpd: key.rateLimitPpd,
        rateLimits: key.rateLimits,
        workspaceIds: key.workspaceIds,
        userAgent: requestUserAgent(c)
      }
    });

    return c.json({ key });
  })
  .post("/:id/rotate", async (c) => {
    const userId = c.get("sessionUser").id;
    const result = await rotateApiKey(c.req.param("id"), userId);

    if (!result) {
      return c.json({ error: "API key not found or already revoked" }, 404);
    }

    await appendAuditLog({
      userId,
      apiKeyId: result.key.id,
      action: "api_key.rotated",
      resourceType: "api-key",
      resourceId: result.key.id,
      ipAddress: requestIp(c),
      metadata: {
        name: result.key.name,
        userAgent: requestUserAgent(c)
      }
    });

    return c.json({ key: result.key, rawKey: result.rawKey });
  })
  .delete("/:id", async (c) => {
    const userId = c.get("sessionUser").id;
    const key = await revokeApiKey(c.req.param("id"), userId);
    if (!key) {
      return c.json({ error: "API key not found or already revoked" }, 404);
    }
    await appendAuditLog({
      userId,
      apiKeyId: key.id,
      action: "api_key.revoked",
      resourceType: "api-key",
      resourceId: key.id,
      ipAddress: requestIp(c),
      metadata: {
        name: key.name,
        userAgent: requestUserAgent(c)
      }
    });
    return c.json({ key });
  });

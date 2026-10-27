import { reportPublicError } from "../lib/public-errors.js";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { apiKeyRateLimitRulesSchema, materializationPolicyOverridesSchema } from "@docslurp/shared";

import { OrganizationError } from "../services/organizations.js";
import { requestIp, requestUserAgent } from "../lib/request-context.js";
import { appendAuditLog } from "../services/audit-log.js";
import { ApiKeyTypeChangeError, apiKeyTypes, createApiKey, supportedApiKeyScopes, listApiKeys, revokeApiKey, rotateApiKey, updateApiKey } from "../services/api-keys.js";
import { apiStatusError } from "../lib/api-error.js";
import { validationHook } from "../lib/validation.js";

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
  /** Optional requests-per-minute cap below the plan's limits. Omitted or null: the plan's limits apply. */
  rateLimitRpm: z.number().int().positive().nullable().optional(),
  rateLimitPpd: z.number().int().positive().optional(),
  rateLimits: apiKeyRateLimitRulesSchema.optional(),
  /** Limit the key to these workspaces (IDs in the key's org). Required for browser keys; omitted/empty on a server key: all of them. */
  workspaceIds: workspaceIdsSchema.optional(),
  /** Deprecated, ignored: browser keys can only search and chat. */
  allowClientSensitiveScopes: z.boolean().optional(),
  /** Caps on query-time page parsing for this key; narrower than workspace/server defaults only. */
  materializationPolicy: materializationPolicyOverridesSchema.optional(),
  /** ISO date-time the key stops working (at most 365 days ahead); null for no expiry. */
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  /** Server keys only: IP addresses or CIDR ranges the key may be used from. */
  ipAllowlist: z.array(z.string().min(1).max(64)).max(50).optional(),
  /** Chat answer output cap: browser keys 500/1000/2000 (default 1000); server keys 500/1000/2000/4000 or null for none. */
  maxOutputTokens: z.union([z.literal(500), z.literal(1000), z.literal(2000), z.literal(4000)]).nullable().optional(),
});

const updateApiKeySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  keyType: apiKeyTypeSchema.optional(),
  allowedDomains: z.array(allowedDomainSchema).optional(),
  scopes: z.array(apiKeyScopeSchema).min(1).optional(),
  /** A number sets the key's requests-per-minute cap; null removes it (plan limits); omitted keeps it. */
  rateLimitRpm: z.number().int().positive().nullable().optional(),
  rateLimitPpd: z.number().int().positive().optional(),
  rateLimits: apiKeyRateLimitRulesSchema.optional(),
  workspaceIds: workspaceIdsSchema.optional(),
  allowClientSensitiveScopes: z.boolean().optional(),
  /** Caps on query-time page parsing for this key; narrower than workspace/server defaults only. */
  materializationPolicy: materializationPolicyOverridesSchema.optional(),
  /** ISO date-time the key stops working (at most 365 days ahead); null for no expiry. */
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  /** Server keys only: IP addresses or CIDR ranges the key may be used from. */
  ipAllowlist: z.array(z.string().min(1).max(64)).max(50).optional(),
  /** Chat answer output cap: browser keys 500/1000/2000 (default 1000); server keys 500/1000/2000/4000 or null for none. */
  maxOutputTokens: z.union([z.literal(500), z.literal(1000), z.literal(2000), z.literal(4000)]).nullable().optional(),
});

/**
 * Rotation. `overlapSeconds` (up to 7 days) creates a new key and keeps the old
 * one working until the overlap ends; omitted or 0 replaces the secret at once.
 * An empty body is allowed.
 */
const rotateApiKeySchema = z.object({
  overlapSeconds: z.number().int().min(0).max(7 * 24 * 60 * 60).optional(),
}).strict().default({});

export const apiKeysRoutes = new Hono()
  .post("/", zValidator("json", createApiKeySchema, validationHook), async (c) => {
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
        materializationPolicy: body.materializationPolicy,
        expiresAt: body.expiresAt,
        ipAllowlist: body.ipAllowlist,
        maxOutputTokens: body.maxOutputTokens,
      });
    } catch (error) {
      if (error instanceof OrganizationError) return apiStatusError(c, error.status, error.message, { code: error.code });
      return apiStatusError(c, 400, reportPublicError(error));
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
  .patch("/:id", zValidator("json", updateApiKeySchema, validationHook), async (c) => {
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
        materializationPolicy: body.materializationPolicy,
        expiresAt: body.expiresAt,
        ipAllowlist: body.ipAllowlist,
        maxOutputTokens: body.maxOutputTokens,
      });
    } catch (error) {
      if (error instanceof OrganizationError) return apiStatusError(c, error.status, error.message, { code: error.code });
      if (error instanceof ApiKeyTypeChangeError) return apiStatusError(c, error.status, error.message, { code: error.code });
      return apiStatusError(c, 400, reportPublicError(error));
    }

    if (!key) {
      return apiStatusError(c, 404, "API key not found or already revoked");
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
    // An empty body (older clients) rotates in place.
    const raw = c.req.header("content-length") === "0" ? {} : await c.req.json().catch(() => ({}));
    const parsed = rotateApiKeySchema.safeParse(raw ?? {});
    if (!parsed.success) return apiStatusError(c, 400, "Invalid rotation request", { code: "invalid_request" });
    let result;
    try {
      result = await rotateApiKey(c.req.param("id"), userId, { overlapSeconds: parsed.data.overlapSeconds });
    } catch (error) {
      if (error instanceof OrganizationError) return apiStatusError(c, error.status, error.message, { code: error.code });
      throw error;
    }

    if (!result) {
      return apiStatusError(c, 404, "API key not found or already revoked");
    }

    await appendAuditLog({
      userId,
      apiKeyId: result.key.id,
      action: "api_key.rotated",
      resourceType: "api-key",
      resourceId: result.key.id,
      ipAddress: requestIp(c),
      metadata: {
        overlapSeconds: parsed.data.overlapSeconds ?? 0,
        ...(result.previous ? { previousKeyId: result.previous.id, previousExpiresAt: result.previous.expiresAt } : {}),
        name: result.key.name,
        userAgent: requestUserAgent(c)
      }
    });

    return c.json({ key: result.key, rawKey: result.rawKey, ...(result.previous ? { previous: result.previous } : {}) });
  })
  .delete("/:id", async (c) => {
    const userId = c.get("sessionUser").id;
    const key = await revokeApiKey(c.req.param("id"), userId);
    if (!key) {
      return apiStatusError(c, 404, "API key not found or already revoked");
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

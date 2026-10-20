import { randomUUID } from "node:crypto";

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  DEFAULT_SERVER_MATERIALIZATION_POLICY,
  deferredProfilesEnabled,
  materializationPolicyOverridesSchema,
  narrowMaterializationPolicy,
} from "@docslurp/shared";

import { CAPABILITY_MAX_TOKEN_CHARS, CAPABILITY_MAX_TTL_SECONDS, sealCapabilityToken } from "../lib/capability-tokens.js";
import { actorHasAnyApiKeyScope, apiKeyCanUseWorkspace, getRequestActor } from "../lib/request-actor.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { ensureDefaultWorkspace, getWorkspace } from "../services/workspaces.js";

const bodySchema = z.object({
  workspaceIds: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
  policy: materializationPolicyOverridesSchema.optional(),
  ttlSeconds: z.number().int().min(1).max(CAPABILITY_MAX_TTL_SECONDS).optional(),
  boundClientKeyId: z.string().min(1).max(200).optional(),
  allowedOrigins: z.array(z.string().min(1).max(300)).max(20).optional(),
});

/**
 * POST /v1/capabilities mints a sealed search capability a browser can send as
 * `X-DocSlurp-Capability`. Server keys and dashboard sessions only: a public
 * client key must never mint, or widen, what it may do. The token's policy is
 * narrowed against the issuer's own at mint time and again at use time.
 */
export const capabilitiesRoutes = new Hono().post("/", zValidator("json", bodySchema), async (c) => {
  if (!deferredProfilesEnabled()) return c.json({ error: "Not found", code: "not_found" }, 404);
  const actor = getRequestActor(c);
  if (actor.type === "apiKey") {
    if (actor.apiKey.keyType !== "server") {
      return c.json({ error: "Client keys cannot mint search capabilities", code: "capability_forbidden" }, 403);
    }
    if (!actorHasAnyApiKeyScope(actor, ["search"])) {
      return c.json({ error: "API key needs the search scope", code: "capability_forbidden" }, 403);
    }
  }
  const body = c.req.valid("json");

  const orgId = actor.type === "apiKey" ? actor.apiKey.orgId : null;
  let requested = body.workspaceIds;
  if (!requested) {
    const allowlist = actor.type === "apiKey" ? actor.apiKey.workspaceIds : [];
    requested = allowlist.length > 0
      ? allowlist
      : [(await ensureDefaultWorkspace({ userId: actor.userId, orgId })).id];
  }

  let tokenOrgId: string | null = orgId;
  for (const workspaceId of requested) {
    const workspace = await getWorkspace(workspaceId, actor.userId);
    const allowed = workspace && (actor.type !== "apiKey" || apiKeyCanUseWorkspace(actor.apiKey, workspace));
    if (!workspace || !allowed) return c.json({ error: "Workspace not found", code: "workspace_not_found" }, 404);
    if (tokenOrgId && workspace.orgId !== tokenOrgId) {
      return c.json({ error: "A capability covers one organization", code: "capability_scope" }, 400);
    }
    tokenOrgId = workspace.orgId;
  }

  const issuerPolicy = actor.type === "apiKey" ? actor.apiKey.materializationPolicy : undefined;
  const policy = narrowMaterializationPolicy(DEFAULT_SERVER_MATERIALIZATION_POLICY, issuerPolicy, body.policy);
  if (!tokenOrgId) return c.json({ error: "Workspace not found", code: "workspace_not_found" }, 404);
  const exp = Math.floor(Date.now() / 1000) + (body.ttlSeconds ?? CAPABILITY_MAX_TTL_SECONDS);
  const token = sealCapabilityToken({
    v: 1,
    orgId: tokenOrgId,
    workspaceIds: requested,
    // Only the requested narrowing; defaults and the issuer's caps are re-applied at use time.
    policy: body.policy ?? {},
    issuedByKeyId: actor.type === "apiKey" ? actor.apiKey.keyId : `session:${actor.userId}`,
    ...(body.boundClientKeyId ? { boundClientKeyId: body.boundClientKeyId } : {}),
    ...(body.allowedOrigins?.length ? { allowedOrigins: body.allowedOrigins } : {}),
    exp,
    jti: randomUUID(),
  });
  if (token.length > CAPABILITY_MAX_TOKEN_CHARS) {
    return c.json({ error: "Capability is too large; list fewer workspaces or origins", code: "capability_too_large" }, 400);
  }
  return c.json({ token, expiresAt: new Date(exp * 1000).toISOString(), policy });
});

acceptApiKeys(capabilitiesRoutes);

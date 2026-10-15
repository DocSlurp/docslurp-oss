import type { MiddlewareHandler } from "hono";

import type { WorkspaceRecord } from "@docslurp/shared";

import {
  actorHasAnyApiKeyScope,
  assertActorApiKeyScopes,
  assertActorServerApiKey,
  assertActorWorkspaceOrgScope,
  loadActorScopedWorkspace
} from "./request-actor.js";
import type { ValidatedKey } from "../services/api-keys.js";

export function apiKeyHasAnyScope(apiKey: ValidatedKey, scopes: string[]): boolean {
  return actorHasAnyApiKeyScope({ type: "apiKey", userId: apiKey.userId, apiKey }, scopes);
}

export function assertApiKeyScopes(apiKey: ValidatedKey | null | undefined, scopes: string[]): void {
  assertActorApiKeyScopes(apiKey ? { type: "apiKey", userId: apiKey.userId, apiKey } : null, scopes);
}

export function assertServerApiKey(apiKey: ValidatedKey | null | undefined): void {
  assertActorServerApiKey(apiKey ? { type: "apiKey", userId: apiKey.userId, apiKey } : null);
}

export function assertApiKeyWorkspaceScope(apiKey: ValidatedKey | null | undefined, workspace: { id?: string; workspaceId?: string; orgId: string }): void {
  assertActorWorkspaceOrgScope(apiKey ? { type: "apiKey", userId: apiKey.userId, apiKey } : null, workspace);
}

export async function loadApiKeyScopedWorkspace(
  workspaceId: string,
  apiKey: ValidatedKey,
): Promise<WorkspaceRecord | null> {
  return await loadActorScopedWorkspace(workspaceId, { type: "apiKey", userId: apiKey.userId, apiKey });
}

export function apiKeyScopeMiddleware(scopes: string[]): MiddlewareHandler {
  return async (c, next) => {
    try {
      assertApiKeyScopes(c.get("apiKey"), scopes);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Forbidden" }, 403);
    }

    await next();
  };
}

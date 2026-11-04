import type { MiddlewareHandler } from "hono";

import type { ProjectRecord } from "@docslurp/shared";

import {
  actorHasAnyApiKeyScope,
  assertActorApiKeyScopes,
  assertActorServerApiKey,
  assertActorProjectOrgScope,
  loadActorScopedProject
} from "./request-actor.js";
import type { ValidatedKey } from "../services/api-keys.js";
import { apiErrorResponse } from "./api-error.js";

export function apiKeyHasAnyScope(apiKey: ValidatedKey, scopes: string[]): boolean {
  return actorHasAnyApiKeyScope({ type: "apiKey", userId: apiKey.userId, apiKey }, scopes);
}

export function assertApiKeyScopes(apiKey: ValidatedKey | null | undefined, scopes: string[]): void {
  assertActorApiKeyScopes(apiKey ? { type: "apiKey", userId: apiKey.userId, apiKey } : null, scopes);
}

export function assertServerApiKey(apiKey: ValidatedKey | null | undefined): void {
  assertActorServerApiKey(apiKey ? { type: "apiKey", userId: apiKey.userId, apiKey } : null);
}

export function assertApiKeyProjectScope(apiKey: ValidatedKey | null | undefined, project: { id?: string; projectId?: string; orgId: string }): void {
  assertActorProjectOrgScope(apiKey ? { type: "apiKey", userId: apiKey.userId, apiKey } : null, project);
}

export async function loadApiKeyScopedProject(
  projectId: string,
  apiKey: ValidatedKey,
): Promise<ProjectRecord | null> {
  return await loadActorScopedProject(projectId, { type: "apiKey", userId: apiKey.userId, apiKey });
}

export function apiKeyScopeMiddleware(scopes: string[]): MiddlewareHandler {
  return async (c, next) => {
    try {
      assertApiKeyScopes(c.get("apiKey"), scopes);
    } catch (error) {
      return apiErrorResponse(c, 403, "forbidden", error instanceof Error ? error.message : "Forbidden");
    }

    await next();
  };
}

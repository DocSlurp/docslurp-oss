/**
 * API key project scoping (security gap G-03). A key reaches a project
 * only in its own organization and, when the key has a project allowlist
 * (`api_keys.project_ids`), only inside it. For a server key an empty
 * allowlist means every project the key's owner can reach in the key's
 * organization; a browser (client) key with an empty allowlist reaches none.
 */
export interface ApiKeyProjectScope {
  orgId: string | null;
  projectIds?: readonly string[];
  keyType?: string;
}

/** Whether an API key's project allowlist admits a project (empty = unrestricted for server keys only). */
export function apiKeyAllowsProject(apiKey: Pick<ApiKeyProjectScope, "projectIds" | "keyType">, projectId: string | null | undefined): boolean {
  const allowlist = apiKey.projectIds ?? [];
  // Fail closed: a browser key is public, so it never inherits its owner's whole org.
  if (allowlist.length === 0) return apiKey.keyType !== "client";
  return !!projectId && allowlist.includes(projectId);
}

/** Org match plus allowlist. */
export function apiKeyCanUseProject(apiKey: ApiKeyProjectScope, project: { id?: string; projectId?: string; orgId: string }): boolean {
  return !!apiKey.orgId && project.orgId === apiKey.orgId && apiKeyAllowsProject(apiKey, project.projectId ?? project.id);
}

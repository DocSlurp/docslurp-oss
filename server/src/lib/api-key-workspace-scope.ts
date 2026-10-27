/**
 * API key workspace scoping (security gap G-03). A key reaches a workspace
 * only in its own organization and, when the key has a workspace allowlist
 * (`api_keys.workspace_ids`), only inside it. For a server key an empty
 * allowlist means every workspace the key's owner can reach in the key's
 * organization; a browser (client) key with an empty allowlist reaches none.
 */
export interface ApiKeyWorkspaceScope {
  orgId: string | null;
  workspaceIds?: readonly string[];
  keyType?: string;
}

/** Whether an API key's workspace allowlist admits a workspace (empty = unrestricted for server keys only). */
export function apiKeyAllowsWorkspace(apiKey: Pick<ApiKeyWorkspaceScope, "workspaceIds" | "keyType">, workspaceId: string | null | undefined): boolean {
  const allowlist = apiKey.workspaceIds ?? [];
  // Fail closed: a browser key is public, so it never inherits its owner's whole org.
  if (allowlist.length === 0) return apiKey.keyType !== "client";
  return !!workspaceId && allowlist.includes(workspaceId);
}

/** Org match plus allowlist. */
export function apiKeyCanUseWorkspace(apiKey: ApiKeyWorkspaceScope, workspace: { id?: string; workspaceId?: string; orgId: string }): boolean {
  return !!apiKey.orgId && workspace.orgId === apiKey.orgId && apiKeyAllowsWorkspace(apiKey, workspace.workspaceId ?? workspace.id);
}

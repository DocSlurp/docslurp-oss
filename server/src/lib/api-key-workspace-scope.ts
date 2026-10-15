/**
 * API key workspace scoping (security gap G-03). A key reaches a workspace
 * only in its own organization and, when the key has a workspace allowlist
 * (`api_keys.workspace_ids`), only inside it. An empty allowlist means every
 * workspace the key's owner can reach in the key's organization.
 */
export interface ApiKeyWorkspaceScope {
  orgId: string | null;
  workspaceIds?: readonly string[];
}

/** Whether an API key's workspace allowlist (empty = unrestricted) admits a workspace. */
export function apiKeyAllowsWorkspace(apiKey: Pick<ApiKeyWorkspaceScope, "workspaceIds">, workspaceId: string | null | undefined): boolean {
  const allowlist = apiKey.workspaceIds ?? [];
  return allowlist.length === 0 || (!!workspaceId && allowlist.includes(workspaceId));
}

/** Org match plus allowlist. */
export function apiKeyCanUseWorkspace(apiKey: ApiKeyWorkspaceScope, workspace: { id?: string; workspaceId?: string; orgId: string }): boolean {
  return !!apiKey.orgId && workspace.orgId === apiKey.orgId && apiKeyAllowsWorkspace(apiKey, workspace.workspaceId ?? workspace.id);
}

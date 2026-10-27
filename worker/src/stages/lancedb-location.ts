import { resolveLanceDbConfig, VectorNamespaceManager, type VectorLocation } from "@docslurp/shared";

/** Owner of a LanceDB database: every workspace has its own (see @docslurp/shared vector-namespace). */
export interface VectorScope {
  orgId?: string | null;
  workspaceId?: string | null;
}

/**
 * The workspace's LanceDB database for one embedding space. Fails closed:
 * without both ids there is no tenant boundary to write inside.
 */
export function workspaceVectorLocation(
  scope: VectorScope,
  space: { model: string; dimensions: number },
  root: string = resolveLanceDbConfig().root,
): VectorLocation {
  if (!scope.orgId?.trim() || !scope.workspaceId?.trim()) {
    throw new Error("LanceDB vector indexing requires the run's orgId and workspaceId for tenant isolation");
  }
  return VectorNamespaceManager.getEmbeddingLocation(root, scope.orgId, scope.workspaceId, space.model, space.dimensions);
}

import { resolveLanceDbConfig, VectorNamespaceManager, type VectorLocation } from "@docslurp/shared";

/** Owner of a LanceDB database: every project has its own (see @docslurp/shared vector-namespace). */
export interface VectorScope {
  orgId?: string | null;
  projectId?: string | null;
}

/**
 * The project's LanceDB database for one embedding space. Fails closed:
 * without both ids there is no tenant boundary to write inside.
 */
export function projectVectorLocation(
  scope: VectorScope,
  space: { model: string; dimensions: number },
  root: string = resolveLanceDbConfig().root,
): VectorLocation {
  if (!scope.orgId?.trim() || !scope.projectId?.trim()) {
    throw new Error("LanceDB vector indexing requires the run's orgId and projectId for tenant isolation");
  }
  return VectorNamespaceManager.getEmbeddingLocation(root, scope.orgId, scope.projectId, space.model, space.dimensions);
}

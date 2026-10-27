/**
 * VectorNamespaceManager: one LanceDB database per workspace.
 *
 * Each workspace's embeddings live under their own LanceDB URI:
 *
 *   <LANCEDB_URI>/<orgId>/<workspaceId>/vectors-<model>-<dimensions>/chunks.lance
 *
 * A search opens exactly one workspace's database, so a query cannot return
 * another workspace's (or org's) rows regardless of filter correctness, and
 * deleting a workspace drops its tables whole. Different embedding models
 * (even with equal dimensions) occupy different vector spaces, so each gets
 * its own database inside the workspace.
 */

const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

export const LANCEDB_CHUNKS_TABLE = "chunks";

export interface VectorLocation {
  uri: string;
  table: string;
}

export class VectorNamespaceManager {
  /** `<root>/<orgId>/<workspaceId>`: the directory holding every vector space of one workspace. */
  static getWorkspaceRoot(root: string, orgId: string, workspaceId: string): string {
    return `${root.replace(/\/+$/, "")}/${safeSegment(orgId, "orgId")}/${safeSegment(workspaceId, "workspaceId")}`;
  }

  /** The LanceDB database (and table) for one workspace and embedding space. */
  static getEmbeddingLocation(root: string, orgId: string, workspaceId: string, model: string, dimensions: number): VectorLocation {
    if (!model.trim() || !Number.isSafeInteger(dimensions) || dimensions < 1) {
      throw new Error("Embedding namespace requires a model and positive dimensions");
    }
    // Encode model IDs losslessly: slash-bearing provider/model IDs must not
    // become nested directories or collide with underscore-bearing model IDs.
    // The dimension suffix has no "-", so the last "-<digits>" is unambiguous.
    const modelSegment = encodeURIComponent(model).replace(/\./g, "%2E");
    return {
      uri: `${VectorNamespaceManager.getWorkspaceRoot(root, orgId, workspaceId)}/vectors-${modelSegment}-${dimensions}`,
      table: LANCEDB_CHUNKS_TABLE,
    };
  }
}

function safeSegment(value: string, name: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`Vector storage requires a safe ${name} path segment`);
  }
  return value;
}

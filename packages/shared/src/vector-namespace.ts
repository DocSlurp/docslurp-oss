/**
 * VectorNamespaceManager: one LanceDB database per project.
 *
 * Each project's embeddings live under their own LanceDB URI:
 *
 *   <LANCEDB_URI>/<orgId>/<projectId>/vectors-<model>-<dimensions>/chunks.lance
 *
 * A search opens exactly one project's database, so a query cannot return
 * another project's (or org's) rows regardless of filter correctness, and
 * deleting a project drops its tables whole. Different embedding models
 * (even with equal dimensions) occupy different vector spaces, so each gets
 * its own database inside the project.
 */

const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

export const LANCEDB_CHUNKS_TABLE = "chunks";

export interface VectorLocation {
  uri: string;
  table: string;
}

export class VectorNamespaceManager {
  /** `<root>/<orgId>/<projectId>`: the directory holding every vector space of one project. */
  static getProjectRoot(root: string, orgId: string, projectId: string): string {
    return `${root.replace(/\/+$/, "")}/${safeSegment(orgId, "orgId")}/${safeSegment(projectId, "projectId")}`;
  }

  /** The LanceDB database (and table) for one project and embedding space. */
  static getEmbeddingLocation(root: string, orgId: string, projectId: string, model: string, dimensions: number): VectorLocation {
    if (!model.trim() || !Number.isSafeInteger(dimensions) || dimensions < 1) {
      throw new Error("Embedding namespace requires a model and positive dimensions");
    }
    // Encode model IDs losslessly: slash-bearing provider/model IDs must not
    // become nested directories or collide with underscore-bearing model IDs.
    // The dimension suffix has no "-", so the last "-<digits>" is unambiguous.
    const modelSegment = encodeURIComponent(model).replace(/\./g, "%2E");
    return {
      uri: `${VectorNamespaceManager.getProjectRoot(root, orgId, projectId)}/vectors-${modelSegment}-${dimensions}`,
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

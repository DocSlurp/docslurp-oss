/**
 * VectorNamespaceManager: one LanceDB database per project.
 *
 * Each project's embeddings live under their own LanceDB URI:
 *
 *   <LANCEDB_URI>/<orgId>/<projectId>/vectors-<model>-<dimensions>/chunks.lance
 *   <LANCEDB_URI>/<orgId>/<projectId>/vectors-<model>-<dimensions>/summaries.lance
 *
 * A search opens exactly one project's database, so a query cannot return
 * another project's (or org's) rows regardless of filter correctness, and
 * deleting a project drops its tables whole. Different embedding models
 * (even with equal dimensions) occupy different vector spaces, so each gets
 * its own database inside the project.
 */

const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

export const LANCEDB_CHUNKS_TABLE = "chunks";
/**
 * Summary-tree nodes (summary-tree.ts): a second table beside `chunks` in the same database, so it shares the
 * project's tenant boundary and every whole-database delete. It is a separate table, never rows inside `chunks`,
 * so a missed filter can never serve a summary as source text.
 */
export const LANCEDB_SUMMARIES_TABLE = "summaries";

/** The tables a project's vector database may hold. A name outside this list is refused, never created. */
export const LANCEDB_VECTOR_TABLES = [LANCEDB_CHUNKS_TABLE, LANCEDB_SUMMARIES_TABLE] as const;
export type LanceDbVectorTable = (typeof LANCEDB_VECTOR_TABLES)[number];

export function isLanceDbVectorTable(value: unknown): value is LanceDbVectorTable {
  return typeof value === "string" && (LANCEDB_VECTOR_TABLES as readonly string[]).includes(value);
}

export interface VectorLocation {
  uri: string;
  table: string;
}

export class VectorNamespaceManager {
  /** `<root>/<orgId>/<projectId>`: the directory holding every vector space of one project. */
  static getProjectRoot(root: string, orgId: string, projectId: string): string {
    return `${root.replace(/\/+$/, "")}/${safeSegment(orgId, "orgId")}/${safeSegment(projectId, "projectId")}`;
  }

  /**
   * The LanceDB database and one of its tables for one project and embedding space. `table` defaults to the chunks
   * table; the summaries table lives in the same database.
   */
  static getEmbeddingLocation(
    root: string,
    orgId: string,
    projectId: string,
    model: string,
    dimensions: number,
    table: LanceDbVectorTable = LANCEDB_CHUNKS_TABLE,
  ): VectorLocation {
    if (!model.trim() || !Number.isSafeInteger(dimensions) || dimensions < 1) {
      throw new Error("Embedding namespace requires a model and positive dimensions");
    }
    if (!isLanceDbVectorTable(table)) throw new Error("Vector storage requires a known table name");
    // Encode model IDs losslessly: slash-bearing provider/model IDs must not
    // become nested directories or collide with underscore-bearing model IDs.
    // The dimension suffix has no "-", so the last "-<digits>" is unambiguous.
    const modelSegment = encodeURIComponent(model).replace(/\./g, "%2E");
    return {
      uri: `${VectorNamespaceManager.getProjectRoot(root, orgId, projectId)}/vectors-${modelSegment}-${dimensions}`,
      table,
    };
  }

  /** The summaries table beside a chunks table: same database, same tenant boundary. */
  static summariesLocation(location: VectorLocation): VectorLocation {
    return { uri: location.uri, table: LANCEDB_SUMMARIES_TABLE };
  }
}

function safeSegment(value: string, name: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`Vector storage requires a safe ${name} path segment`);
  }
  return value;
}

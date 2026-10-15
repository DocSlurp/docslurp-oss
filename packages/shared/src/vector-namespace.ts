import { sha256Hex } from "./hash.js";

const LANCEDB_ORG_TABLE_PREFIX = "chunks_org";

/**
 * VectorNamespaceManager: per-org LanceDB table isolation.
 *
 * Each organization's embeddings live in a dedicated LanceDB table named
 * `chunks_org_<sha256_org_id_prefix>`.
 * This provides hard namespace isolation — a query on one org's table cannot
 * return results from another org's data regardless of filter correctness.
 */

export class VectorNamespaceManager {
  /**
   * Derive the LanceDB table name for a given org.
   * The raw org id is never embedded in the storage object name.
   */
  static getTableName(orgId: string): string {
    return `${LANCEDB_ORG_TABLE_PREFIX}_${hashOrgIdForNamespace(orgId)}`;
  }

  /** Shared corpus indexes are siblings of run artifacts, scoped by raw org ID. */
  static getEmbeddingLocation(root: string, orgId: string, model: string, dimensions: number): { uri: string; table: string } {
    if (!/^[a-zA-Z0-9_-]+$/.test(orgId)) {
      throw new Error("Embedding storage requires a safe orgId path segment");
    }
    if (!model.trim() || !Number.isSafeInteger(dimensions) || dimensions < 1) {
      throw new Error("Embedding namespace requires a model and positive dimensions");
    }
    // Encode model IDs losslessly: slash-bearing provider/model IDs must not
    // become nested directories or collide with underscore-bearing model IDs.
    const modelSegment = encodeURIComponent(model).replace(/\./g, "%2E");
    return {
      uri: `${root.replace(/\/+$/, "")}/${orgId}/vectors/${modelSegment}/${dimensions}`,
      table: "chunks",
    };
  }

  /** Different models (even with equal dimensions) occupy different vector spaces. */
  static getEmbeddingTableName(orgId: string, model: string, dimensions: number): string {
    if (!model.trim() || !Number.isSafeInteger(dimensions) || dimensions < 1) {
      throw new Error("Embedding namespace requires a model and positive dimensions");
    }
    const modelSlug = model.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "model";
    const identityHash = sha256Hex(JSON.stringify([model, dimensions])).slice(0, 32);
    // A Lance table is a physical <table-name>.lance directory under LANCEDB_URI.
    return `${this.getTableName(orgId)}_embedding_${modelSlug}_d${dimensions}_${identityHash}`;
  }

  /**
   * Derive the archived table name for a given org.
   */
  static getArchivedTableName(orgId: string, timestamp: string): string {
    const safeTs = timestamp.replace(/[^0-9]/g, "");
    return `${VectorNamespaceManager.getTableName(orgId)}_archived_${safeTs}`;
  }

  /**
   * Check whether a LanceDB table name is the exact live table for an org.
   * Search paths should use exact table lookup instead of prefix scans, but this
   * helper keeps lifecycle jobs from accidentally treating archives or malformed
   * lookalike tables as live tenant data.
   */
  static isLiveTableNameForOrg(tableName: string, orgId: string): boolean {
    return tableName === VectorNamespaceManager.getTableName(orgId);
  }

  /**
   * Ensure a LanceDB table exists for the given org.
   * Creates the table only when an explicit schema is provided. Normal first-run
   * indexing should let LanceDB infer the schema from actual embedding records so
   * vector dimensions stay aligned with the workspace embedding profile.
   *
   * @param lancedb - lancedb module instance (passed in to avoid coupling)
   * @param dbPath  - path to the LanceDB directory
   * @param orgId   - organization ID
   * @param schema  - Arrow/LanceDB schema for the table
   */
  static async ensureTable(
    lancedb: { connect(uri: string): Promise<LanceDbConnection> },
    dbPath: string,
    orgId: string,
    schema?: unknown
  ): Promise<string> {
    const tableName = VectorNamespaceManager.getTableName(orgId);
    const db = await lancedb.connect(dbPath);

    const tableNames: string[] = await db.tableNames();
    if (!tableNames.includes(tableName)) {
      if (!schema) {
        throw new Error("LanceDB table creation requires an explicit schema");
      }
      await db.createTable(tableName, [], { schema });
      console.log(`[vector-namespace] created table ${tableName} for org ${orgId}`);
    }

    return tableName;
  }

  /**
   * Archive the table for an org by renaming it.
   * The archived table is retained for audit/recovery purposes.
   */
  static async archiveTable(
    lancedb: { connect(uri: string): Promise<LanceDbConnection> },
    dbPath: string,
    orgId: string
  ): Promise<string> {
    const tableName = VectorNamespaceManager.getTableName(orgId);
    const archivedName = VectorNamespaceManager.getArchivedTableName(
      orgId,
      new Date().toISOString()
    );
    const db = await lancedb.connect(dbPath);
    const tableNames: string[] = await db.tableNames();
    if (tableNames.includes(tableName)) {
      // LanceDB doesn't have a native rename; clone then drop.
      const source = await db.openTable(tableName);
      const rows = await source.search(new Array(384).fill(0)).limit(100_000).toArray();
      await db.createTable(archivedName, rows);
      await db.dropTable(tableName);
      console.log(`[vector-namespace] archived table ${tableName} → ${archivedName}`);
    }
    return archivedName;
  }
}

export function hashOrgIdForNamespace(orgId: string): string {
  const normalized = orgId.trim();
  if (!normalized) {
    throw new Error("orgId is required to derive a vector namespace");
  }
  return sha256Hex(normalized).slice(0, 32);
}

// Minimal interface for LanceDB connection (to avoid hard coupling to lancedb package)
interface LanceDbConnection {
  tableNames(): Promise<string[]>;
  openTable(name: string): Promise<LanceDbTable>;
  createTable(name: string, data: unknown[], options?: unknown): Promise<LanceDbTable>;
  dropTable(name: string): Promise<void>;
}

interface LanceDbTable {
  search(vector: number[]): { limit(n: number): { toArray(): Promise<unknown[]> } };
}

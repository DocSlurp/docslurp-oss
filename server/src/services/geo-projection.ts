import type { PoolClient } from "pg";

export interface ProjectionIdentity {
  documentId: string;
  workspaceId: string;
  orgId: string;
  /** Decimal bigint string, never a JS number. Captured before extraction. */
  revision: string;
}
export interface AcceptedProjection {
  schemaDigest: string;
  resultDigest: string;
  features: readonly { fieldPath: string; ordinal: number; geojson: string }[];
}
/** Adapter must verify final acceptance, current schema, eligibility and dedup,
 * and return only accepted non-null fields. An empty array is a valid generation.
 * Artifact existence, checkpoint success and run ID alone are insufficient.
 */
export type ProjectionAuthority = (
  client: PoolClient, identity: ProjectionIdentity,
) => Promise<AcceptedProjection | null>;

/** Owns its transaction. Caller supplies a dedicated connection, never a pool. */
export async function publishGeoProjection(
  client: PoolClient,
  identity: ProjectionIdentity,
  authority?: ProjectionAuthority,
): Promise<"published" | "stale"> {
  if (!authority) throw new Error("Geo publication has no accepted-final-source adapter");
  await client.query("BEGIN");
  try {
    // Match workspace mutation lock order. This serializes schema changes too.
    await client.query("SELECT id FROM workspaces WHERE id=$1 AND org_id=$2 FOR SHARE", [identity.workspaceId, identity.orgId]);
    const source = await client.query(
      "SELECT id FROM documents WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND projection_revision=$4 FOR UPDATE",
      [identity.documentId, identity.workspaceId, identity.orgId, identity.revision],
    );
    const accepted = source.rowCount ? await authority(client, identity) : null;
    if (!accepted) {
      await client.query("ROLLBACK");
      return "stale";
    }
    if (accepted.features.length > 10000) throw new Error("Too many geo features");
    const prior = await client.query("SELECT schema_digest,result_digest FROM geo_projection_generations WHERE document_id=$1", [identity.documentId]);
    // Replacing at the same revision with different content is never a retry.
    if (prior.rowCount) {
      const current = await client.query("SELECT 1 FROM geo_projection_generations WHERE document_id=$1 AND source_revision=$2", [identity.documentId, identity.revision]);
      if (current.rowCount && (prior.rows[0].schema_digest !== accepted.schemaDigest || prior.rows[0].result_digest !== accepted.resultDigest)) throw new Error("Conflicting projection at the same source revision");
    }
    await client.query("DELETE FROM geo_projection_generations WHERE document_id=$1", [identity.documentId]);
    await client.query("INSERT INTO geo_projection_generations VALUES ($1,$2,$3,$4,$5,$6)", [identity.documentId, identity.workspaceId, identity.orgId, identity.revision, accepted.schemaDigest, accepted.resultDigest]);
    for (const feature of accepted.features) {
      if (Buffer.byteLength(feature.geojson) > 4 * 1024 * 1024) throw new Error("Geo geometry too large");
      await client.query("INSERT INTO geo_projection_features VALUES ($1,$2,$3,$4,$5,$6,ST_SetSRID(ST_GeomFromGeoJSON($7),4326))", [identity.documentId, identity.workspaceId, identity.orgId, identity.revision, feature.fieldPath, feature.ordinal, feature.geojson]);
    }
    await client.query("COMMIT");
    return "published";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

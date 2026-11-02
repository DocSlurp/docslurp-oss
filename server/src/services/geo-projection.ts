import type { PoolClient } from "pg";
export interface ProjectionIdentity {
  documentId: string; workspaceId: string; orgId: string; revision: string;
}
/** Rebuild only from a persisted accepted source; never accept an arbitrary authority callback. */
export async function publishGeoProjection(client: PoolClient, identity: ProjectionIdentity): Promise<"published" | "stale"> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT id FROM workspaces WHERE id=$1 AND org_id=$2 AND archived_at IS NULL FOR SHARE", [identity.workspaceId, identity.orgId]);
    const source = await client.query(`SELECT a.document_id FROM geo_accepted_sources a JOIN documents d
      ON (d.id,d.workspace_id,d.org_id,d.projection_revision)=(a.document_id,a.workspace_id,a.org_id,a.source_revision)
      WHERE a.document_id=$1 AND a.workspace_id=$2 AND a.org_id=$3 AND a.source_revision=$4
      AND d.status NOT IN ('pii_blocked','failed') AND d.archived_at IS NULL AND d.superseded_at IS NULL
      AND d.purged_at IS NULL AND d.deduped_from_document_id IS NULL FOR UPDATE OF d`,
    [identity.documentId, identity.workspaceId, identity.orgId, identity.revision]);
    if (!source.rowCount) { await client.query("ROLLBACK"); return "stale"; }
    await client.query("SELECT publish_accepted_geo_source($1)", [identity.documentId]);
    await client.query("COMMIT");
    return "published";
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

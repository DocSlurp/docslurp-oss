import { createHash } from "node:crypto";
import { canonicalGeoProjectionJson, geoProjectionFieldPointer, geoAnnotationSchema, geometryFromAnnotation, validateGeoAnnotations } from "@docslurp/shared";
import type { sql } from "../db.js";

/** Called only inside the authorized correction transaction, after its source row is saved. */
export async function publishGeoCorrection(client: typeof sql,
  scope: {documentId: string; workspaceId: string; orgId: string}, values: Record<string, unknown> | null): Promise<void> {
  const [workspace] = await client`select pipeline from workspaces where id=${scope.workspaceId} and org_id=${scope.orgId}
    and archived_at is null for share`;
  const schema = (workspace?.pipeline as {outputSchema?: Record<string, unknown>} | undefined)?.outputSchema;
  if (!schema) return;
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return;
  const geoFields = Object.entries(properties).filter((entry): entry is [string, Record<string, unknown>] =>
    !!entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1]) && entry[1].format === "geojson");
  if (!geoFields.length) return;
  validateGeoAnnotations(schema);
  const features = geoFields.flatMap(([name, definition]) => {
    const value = values && Object.hasOwn(values, name) ? values[name] : null;
    // Explicit null clears the entire corrected output; optional missing fields are absent.
    if (value == null) {
      if (values !== null && Array.isArray(schema.required) && schema.required.includes(name)) throw new Error("Required geo correction is missing");
      return [];
    }
    return [{ fieldPath: geoProjectionFieldPointer(name), ordinal: 0,
      geometry: geometryFromAnnotation(value, geoAnnotationSchema.parse(definition.geo ?? {encoding:"geojson"})) }];
  });
  if (features.length > 1000 || Buffer.byteLength(JSON.stringify(features)) > 1024 * 1024) throw new Error("Geo correction exceeds document budget");
  const [document] = await client`select projection_revision::text as revision from documents
    where id=${scope.documentId} and workspace_id=${scope.workspaceId} and org_id=${scope.orgId} for update`;
  if (!document) throw new Error("Geo correction document is unavailable");
  const hash = (value: unknown) => createHash("sha256").update(canonicalGeoProjectionJson(value)).digest("hex");
  await client`select commit_geo_corrected_source(${scope.documentId},${scope.workspaceId},${scope.orgId},
    ${String(document.revision)}::bigint,${values === null ? null : client.json(JSON.parse(JSON.stringify(values)))}::jsonb,
    ${hash(schema)},${hash(features)},${client.json(features)}::jsonb)`;
}

import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import {
  canonicalGeoProjectionJson, geoProjectionFieldPointer, geometryFromAnnotation,
  geoAnnotationSchema, validateGeoAnnotations, type StructuredResultEnvelope,
} from "@docslurp/shared";

type Client = Sql<Record<string, unknown>>;
export interface GeoAttempt {
  documentId: string; workspaceId: string; orgId: string; runId: string;
  revision: string; schemaDigest: string;
}
export interface GeoFinalSource extends GeoAttempt {
  resultDigest: string;
  features: { fieldPath: string; ordinal: number; geometry: unknown }[];
}
export function geoSchemaFields(schema: Record<string, unknown>): [string, Record<string, unknown>][] {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.entries(properties).filter((entry): entry is [string, Record<string, unknown>] =>
    !!entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1]) && entry[1].format === "geojson");
}
export const geoDigest = (value: unknown): string => createHash("sha256").update(canonicalGeoProjectionJson(value)).digest("hex");

/** No database or spatial capability probe for ordinary schemas. Capture before model work. */
export async function beginGeoAttempt(sql: Client, identity: Omit<GeoAttempt, "revision" | "schemaDigest">,
  schema: Record<string, unknown>): Promise<GeoAttempt | undefined> {
  if (!geoSchemaFields(schema).length) return undefined;
  validateGeoAnnotations(schema);
  const schemaDigest = geoDigest(schema);
  return await sql.begin(async tx => {
    const [workspace] = await tx`select pipeline from workspaces where id=${identity.workspaceId}
      and org_id=${identity.orgId} and archived_at is null for share`;
    const pipeline = workspace?.pipeline as { outputSchema?: unknown } | undefined;
    if (!pipeline?.outputSchema || geoDigest(pipeline.outputSchema) !== schemaDigest) {
      throw new Error("Geo extraction schema is not the current workspace schema");
    }
    const [capability] = await tx`select to_regprocedure('publish_accepted_geo_source(text)') is not null as ready`;
    if (!capability?.ready) throw new Error("Geo spatial migrations are not installed");
    const [document] = await tx`update documents set projection_revision=projection_revision+1
      where id=${identity.documentId} and workspace_id=${identity.workspaceId} and org_id=${identity.orgId}
        and status not in ('pii_blocked','failed') and deduped_from_document_id is null
        and archived_at is null and superseded_at is null and purged_at is null
        and not geo_has_correction
      returning projection_revision::text as revision`;
    if (!document) throw new Error("Geo document is unavailable or has a structured correction");
    return { ...identity, revision: String(document.revision), schemaDigest };
  }) as GeoAttempt;
}

/** Persist only accepted geo values; partial artifacts and client policy labels are not authority. */
export function acceptedGeoSource(attempt: GeoAttempt, schema: Record<string, unknown>,
  envelope: StructuredResultEnvelope): GeoFinalSource {
  if (envelope.documentId !== attempt.documentId || envelope.overallPolicy === "reject") {
    throw new Error("Geo result is not an accepted source");
  }
  if (geoDigest(schema) !== attempt.schemaDigest) throw new Error("Geo schema changed during extraction");
  const features: GeoFinalSource["features"] = [];
  for (const [name, definition] of geoSchemaFields(schema)) {
    const field = envelope.fields[name];
    const required = Array.isArray(schema.required) && schema.required.includes(name);
    if (field?.value == null) {
      if (required || field?.errors.length) throw new Error("Required geo value is missing or invalid");
      continue;
    }
    if (field.policy !== "auto-accept" || field.errors.length) throw new Error("Geo value requires review");
    const geometry = geometryFromAnnotation(field.value, geoAnnotationSchema.parse(definition.geo ?? { encoding: "geojson" }));
    features.push({ fieldPath: geoProjectionFieldPointer(name), ordinal: 0, geometry });
  }
  if (features.length > 1000 || Buffer.byteLength(JSON.stringify(features)) > 1024 * 1024) {
    throw new Error("Geo projection exceeds document budget");
  }
  return { ...attempt, resultDigest: geoDigest(features), features };
}

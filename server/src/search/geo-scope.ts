import { createHash } from "node:crypto";
import { canonicalGeoProjectionJson, geoProjectionFieldPointer, validateGeoAnnotations } from "@docslurp/shared";
import { boundedSearchQuery, isSearchBoundError } from "./query-bounds.js";
import { sql } from "../db.js";
import type { SearchFilters } from "./filters.js";
import { retrievalScope } from "./retrieval-scope.js";
import { lexicalSearchableDocument } from "./eligibility.js";
import { spatialPredicate, validateSpatialPredicate } from "./geo-predicate.js";

export class GeoSearchError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 503) { super(message); }
}
/** Call only AFTER workspace and API-key authorization. Never cache this eligibility result. */
export async function resolveGeoDocumentScope(scope: {workspaceId: string; orgId: string},
  filters: SearchFilters, schema: unknown, runId?: string): Promise<SearchFilters> {
  if (!filters.geo) return filters;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new GeoSearchError("Workspace has no geo schema",400);
  const output = schema as Record<string, unknown>;
  validateGeoAnnotations(output);
  const properties = output.properties as Record<string, {format?: unknown}> | undefined;
  if (!properties || !Object.hasOwn(properties,filters.geo.field) || properties[filters.geo.field]?.format !== "geojson") {
    throw new GeoSearchError("Spatial filters require an explicitly opted-in geo column",400);
  }
  const [capability] = await boundedSearchQuery(client => client`select to_regclass('ready_geo_projection_generations') is not null
    and to_regclass('geo_projection_features') is not null as ready`);
  if (!capability?.ready) throw new GeoSearchError("Spatial indexing is unavailable",503);
  let geo;
  try { geo = await validateSpatialPredicate(filters.geo); }
  catch (error) { if (isSearchBoundError(error)) throw error; throw new GeoSearchError("Invalid spatial predicate or polygon topology",400); }
  const digest = createHash("sha256").update(canonicalGeoProjectionJson(output)).digest("hex");
  const {geo: ignoredGeo, geoSchemaDigest: ignoredDigest, ...metadata} = filters;
  const documentScope = retrievalScope({workspaceId:scope.workspaceId,filters:metadata,runId}).vectorDocument();
  const eligible = sql`d.workspace_id=${scope.workspaceId} and d.org_id=${scope.orgId}
    and ${lexicalSearchableDocument("d")} and ${documentScope}`;
  const [coverage] = await boundedSearchQuery(client => client`select exists(select 1 from documents d where ${eligible}
    and not exists(select 1 from ready_geo_projection_generations g where g.document_id=d.id
      and g.workspace_id=${scope.workspaceId} and g.org_id=${scope.orgId} and g.schema_digest=${digest})) as incomplete`);
  if (coverage?.incomplete) throw new GeoSearchError("Spatial index is missing or stale; reprocess or review the selected documents",409);
  const rows = await boundedSearchQuery(client => client<{id:string}[]>`select distinct d.id from geo_projection_features f
    join ready_geo_projection_generations g on (g.document_id,g.workspace_id,g.org_id,g.source_revision)=
      (f.document_id,f.workspace_id,f.org_id,f.source_revision)
    join documents d on d.id=g.document_id
    where ${eligible} and g.workspace_id=${scope.workspaceId} and g.org_id=${scope.orgId}
      and g.schema_digest=${digest} and f.field_path=${geoProjectionFieldPointer(geo.field)}
      and ${spatialPredicate(geo,sql`f.geom`)} limit 10001`);
  if (rows.length > 10000) throw new GeoSearchError("Spatial filter matches too many documents; narrow its area or metadata filters",400);
  return {...filters,geo,geoSchemaDigest:digest,documentIds:rows.map(row=>row.id)};
}

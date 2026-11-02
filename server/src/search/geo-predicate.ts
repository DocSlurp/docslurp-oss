import { geoPredicateSchema, type GeoPredicate } from "@docslurp/shared";
import { boundedSearchQuery } from "./query-bounds.js";
import { sql } from "../db.js";
import type { SqlFragment } from "../lib/sql-fragments.js";

/** All values are bound parameters. The caller supplies a trusted SQL column. */
export function spatialPredicate(input: GeoPredicate, geom: SqlFragment): SqlFragment {
  const predicate = geoPredicateSchema.parse(input);
  if (predicate.op === "radius") {
    return sql`GeometryType(${geom}) in ('POINT', 'MULTIPOINT') and ST_DWithin(
      ${geom}::geography,
      ST_SetSRID(ST_MakePoint(${predicate.center[0]}, ${predicate.center[1]}),4326)::geography,
      ${predicate.radiusMeters})`;
  }
  if (predicate.op === "bbox") {
    const [west, south, east, north] = predicate.bbox;
    // A west > east envelope crosses the antimeridian, not the prime meridian.
    return west <= east
      ? sql`ST_Intersects(${geom}, ST_MakeEnvelope(${west},${south},${east},${north},4326))`
      : sql`(ST_Intersects(${geom}, ST_MakeEnvelope(${west},${south},180,${north},4326))
          or ST_Intersects(${geom}, ST_MakeEnvelope(-180,${south},${east},${north},4326)))`;
  }
  const area = sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(predicate.geometry)}),4326)`;
  // CoveredBy deliberately includes the boundary, unlike ST_Within for points.
  return predicate.op === "within"
    ? sql`ST_CoveredBy(${geom}, ${area})`
    : sql`ST_Intersects(${geom}, ${area})`;
}

/** Validate topology before retrieval; Zod bounds structure/bytes/vertices first. */
export async function validateSpatialPredicate(input: unknown): Promise<GeoPredicate> {
  const predicate = geoPredicateSchema.parse(input);
  if (predicate.op === "within" || predicate.op === "intersects") {
    const [row] = await boundedSearchQuery(client => client<{ valid: boolean }[]>`
      select ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(predicate.geometry)}),4326)) as valid
    `);
    if (!row?.valid) throw new Error("Invalid geo query polygon topology");
  }
  return predicate;
}

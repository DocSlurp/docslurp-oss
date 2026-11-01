import { z } from "zod";

/** Structural bounds only. PostGIS must validate topology before indexing. */
export const GEO_LIMITS = { bytes: 262144, vertices: 10000, depth: 16, samples: 1000 } as const;
export const geoPositionSchema = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)]);
const ring = z.array(geoPositionSchema).min(4).max(GEO_LIMITS.vertices).refine(
  (r) => r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1], "Ring must be closed",
);
const polygon = z.array(ring).min(1).max(100);
const geometry = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Point"), coordinates: geoPositionSchema }).strict(),
  z.object({ type: z.literal("MultiPoint"), coordinates: z.array(geoPositionSchema).min(1).max(GEO_LIMITS.vertices) }).strict(),
  z.object({ type: z.literal("Polygon"), coordinates: polygon }).strict(),
  z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(polygon).min(1).max(100) }).strict(),
]);
/** Bound traversal before recursive schema processing; reject cycles and non-JSON values. */
export function boundedGeoJson(value: unknown): boolean {
  let bytes = 0, nodes = 0;
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): boolean {
    if (++nodes > 50000 || depth > GEO_LIMITS.depth) return false;
    if (v === null || typeof v === "boolean") bytes += 5;
    else if (typeof v === "number") { if (!Number.isFinite(v)) return false; bytes += 24; }
    else if (typeof v === "string") bytes += new TextEncoder().encode(JSON.stringify(v)).length;
    else if (typeof v === "object") {
      if (seen.has(v)) return false;
      seen.add(v);
      if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return false;
      bytes += 2;
      for (const [k, child] of Object.entries(v)) {
        bytes += new TextEncoder().encode(JSON.stringify(k)).length + 2;
        if (bytes > GEO_LIMITS.bytes || !visit(child, depth + 1)) return false;
      }
      seen.delete(v);
    } else return false;
    return bytes <= GEO_LIMITS.bytes;
  }
  return visit(value, 0);
}
export const geoGeometrySchema = z.unknown().refine(boundedGeoJson, "Geometry exceeds JSON bounds").pipe(geometry).refine((g) => {
  let count = 0;
  function walk(v: unknown): void { if (Array.isArray(v)) { if (typeof v[0] === "number") count++; else v.forEach(walk); } }
  walk(g.coordinates);
  return count <= GEO_LIMITS.vertices;
}, "Too many vertices");
export type GeoGeometry = z.infer<typeof geoGeometrySchema>;
const pointer = z.string().max(256).regex(/^\/(?:[^~/]|~[01])+$/, "Use a direct sibling JSON Pointer; nested and array mappings are not supported");
export const geoAnnotationSchema = z.discriminatedUnion("encoding", [
  z.object({ version: z.literal(1), encoding: z.literal("geojson"), geometryTypes: z.array(z.enum(["Point", "MultiPoint", "Polygon", "MultiPolygon"])).min(1).max(4).refine(v => new Set(v).size === v.length) }).strict(),
  z.object({ version: z.literal(1), encoding: z.literal("lat-lon"), latitude: pointer, longitude: pointer }).strict().refine(v => v.latitude !== v.longitude),
]);
export type GeoAnnotation = z.infer<typeof geoAnnotationSchema>;
const area = geoGeometrySchema.refine(g => g.type === "Polygon" || g.type === "MultiPolygon", "Area must be Polygon or MultiPolygon");
/** Future predicate contract only; not wired into search/chat routes. */
export const geoPredicateSchema = z.discriminatedUnion("op", [
  z.object({ field: z.string().min(1).max(128), op: z.literal("radius"), center: geoPositionSchema, radiusMeters: z.number().finite().min(0).max(20040000) }).strict(),
  z.object({ field: z.string().min(1).max(128), op: z.literal("bbox"), bbox: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)]).refine(b => b[1] <= b[3]) }).strict(),
  z.object({ field: z.string().min(1).max(128), op: z.enum(["intersects", "within"]), geometry: area }).strict(),
]);
export type GeoPredicate = z.infer<typeof geoPredicateSchema>;
const decode = (p: string) => p.slice(1).replace(/~1/g, "/").replace(/~0/g, "~");
export function geometryFromAnnotation(value: unknown, annotation: GeoAnnotation): GeoGeometry {
  const a = geoAnnotationSchema.parse(annotation);
  if (a.encoding === "geojson") {
    const g = geoGeometrySchema.parse(value);
    if (!a.geometryTypes.includes(g.type)) throw new Error("Geometry type is not annotated");
    return g;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected same-row object");
  const row = value as Record<string, unknown>;
  const read = (p: string) => Object.hasOwn(row, decode(p)) ? row[decode(p)] : undefined;
  return geoGeometrySchema.parse({ type: "Point", coordinates: [read(a.longitude), read(a.latitude)] });
}

/** Only top-level object fields are supported in v1; reject hidden mappings. */
export function validateGeoAnnotations(schema: Record<string, unknown>): void {
  if (!boundedGeoJson(schema)) throw new Error("Output schema exceeds geo JSON bounds");
  function visit(node: unknown, path: string[]): void {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (Object.hasOwn(obj, "x-docslurp-geo")) {
      if (path.length !== 2 || path[0] !== "properties" || obj.type !== "object") throw new Error("Geo annotations require top-level object properties");
      const a = geoAnnotationSchema.parse(obj["x-docslurp-geo"]);
      if (a.encoding === "lat-lon") {
        const props = obj.properties as Record<string, { type?: string }> | undefined;
        for (const p of [a.latitude, a.longitude]) {
          const key = decode(p);
          if (!props || !Object.hasOwn(props, key) || !["number", "integer"].includes(props[key]?.type ?? "")) throw new Error("Geo pointers must reference sibling numeric properties");
        }
      }
    }
    for (const [key, child] of Object.entries(obj)) visit(child, [...path, key]);
  }
  visit(schema, []);
}

export function suggestGeoMapping(samples: unknown[], headers: string[] = []) {
  if (samples.length > GEO_LIMITS.samples || !boundedGeoJson(samples)) throw new Error("Samples exceed bounds");
  const suggestions: { annotation: GeoAnnotation; strength: "strong" | "weak"; valid: number; invalid: number; ambiguous: number }[] = [];
  const geometries = samples.map(v => geoGeometrySchema.safeParse(v));
  const types = [...new Set(geometries.flatMap(r => r.success ? [r.data.type] : []))].sort();
  if (types.length) suggestions.push({ annotation: { version: 1, encoding: "geojson", geometryTypes: types }, strength: "strong", valid: geometries.filter(r => r.success).length, invalid: geometries.filter(r => !r.success).length, ambiguous: 0 });
  const lat = headers.filter(h => /^(lat|latitude)$/i.test(h));
  const lon = headers.filter(h => /^(lon|lng|longitude)$/i.test(h));
  if (lat.length === 1 && lon.length === 1) {
    const annotation: GeoAnnotation = { version: 1, encoding: "lat-lon", latitude: `/${lat[0]}`, longitude: `/${lon[0]}` };
    let valid = 0, ambiguous = 0;
    for (const sample of samples) { try { const g = geometryFromAnnotation(sample, annotation); valid++; if (g.type === "Point" && Math.abs(g.coordinates[0]) <= 90) ambiguous++; } catch { /* invalid, never coerce */ } }
    suggestions.push({ annotation, strength: "weak", valid, invalid: samples.length - valid, ambiguous });
  }
  return { suggestions, sampleCount: samples.length, ambiguous: headers.some(h => /^(x|y)$/i.test(h)) ? samples.length : 0 };
}

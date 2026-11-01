import { describe, expect, it } from "vitest";
import { geoGeometrySchema, geoPredicateSchema, geometryFromAnnotation, suggestGeoMapping, validateGeoAnnotations } from "./geo.js";
const annotation = { version: 1, encoding: "lat-lon", latitude: "/lat", longitude: "/lon" } as const;
describe("geo foundation", () => {
  it("preserves zero and never coerces missing/null/string coordinates", () => {
    expect(geometryFromAnnotation({ lat: 0, lon: 0 }, annotation)).toEqual({ type: "Point", coordinates: [0, 0] });
    for (const lat of [null, undefined, "0", NaN, Infinity, 91]) expect(() => geometryFromAnnotation({ lat, lon: 0 }, annotation)).toThrow();
  });
  it("bounds and rejects unsupported geometry", () => {
    for (const g of [{ type: "Point", coordinates: [1, 2, 3] }, { type: "Point", coordinates: [181, 0] }, { type: "Feature", geometry: null }, { type: "MultiPoint", coordinates: Array(10001).fill([0, 0]) }, { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }]) expect(geoGeometrySchema.safeParse(g).success).toBe(false);
    for (const type of ["Polygon", "MultiPolygon"]) {
      const coordinates = [[[0, 0], [1, 0], [1, 1], [0, 0]]];
      expect(geoGeometrySchema.safeParse({ type, coordinates: type === "Polygon" ? coordinates : [coordinates] }).success).toBe(true);
    }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(geoGeometrySchema.safeParse(cycle).success).toBe(false);
  });
  it("rejects unknown predicates and supports dateline bbox", () => {
    expect(geoPredicateSchema.safeParse({ field: "site", op: "bbox", bbox: [170, -10, -170, 10] }).success).toBe(true);
    expect(geoPredicateSchema.safeParse({ field: "site", op: "nearest" }).success).toBe(false);
  });
  it("suggests without activating; x/y is ambiguous", () => {
    expect(suggestGeoMapping([{ x: 10, y: 20 }], ["x", "y"])).toEqual({ suggestions: [], sampleCount: 1, ambiguous: 1 });
    const result = suggestGeoMapping([{ lat: 20, lon: 30 }, { lat: null, lon: 0 }], ["lat", "lon"]);
    expect(result.suggestions[0]).toMatchObject({ strength: "weak", valid: 1, invalid: 1, ambiguous: 1 });
    expect(suggestGeoMapping([{ type: "Point", coordinates: [0, 0] }]).suggestions[0].strength).toBe("strong");
  });
  it("rejects nested and cross-row mappings", () => {
    expect(() => geometryFromAnnotation({}, { ...annotation, latitude: "/rows/0/lat" })).toThrow();
    expect(() => validateGeoAnnotations({ type: "object", "geo": annotation })).toThrow();
  });
});

it("validates outputSchema annotation compatibility and preserves accepted metadata", async () => {
  const { pipelineFeatureOverridesSchema } = await import("./pipeline.js");
  const outputSchema = { type: "object", properties: { site: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } }, "geo": annotation } } };
  expect(pipelineFeatureOverridesSchema.parse({ outputSchema }).outputSchema).toEqual(outputSchema);
  const invalid = structuredClone(outputSchema);
  invalid.properties.site.properties.lat.type = "string";
  expect(pipelineFeatureOverridesSchema.safeParse({ outputSchema: invalid }).success).toBe(false);
});


it("rejects empty rings without throwing through validation or detection", () => {
  const malformed = { type: "Polygon", coordinates: [[]] };
  expect(geoGeometrySchema.safeParse(malformed).success).toBe(false);
  expect(suggestGeoMapping([malformed]).suggestions).toEqual([]);
});

it("treats annotation-named properties and literal data as data", async () => {
  const { geoProviderSchema } = await import("./geo.js");
  const literal = { "geo": "keep", other: 1 };
  const schema = { type: "object", properties: { "geo": { type: "string" }, payload: { type: "object", const: literal, default: literal, enum: [literal] } } };
  expect(() => validateGeoAnnotations(schema)).not.toThrow();
  expect(geoProviderSchema(schema)).toEqual(schema);
  const nested = { type: "object", properties: { rows: { type: "array", items: { type: "object", "geo": { version: 1, encoding: "geojson", geometryTypes: ["Point"] } } } } };
  expect(() => validateGeoAnnotations(nested)).toThrow();
});


it("accepts compact geo annotations with explicit encoding", async () => {
  const { geoAnnotationSchema } = await import("./geo.js");
  expect(geoAnnotationSchema.parse({ encoding: "geojson" })).toMatchObject({ version: 1, geometryTypes: ["Point", "MultiPoint", "Polygon", "MultiPolygon"] });
  expect(geoAnnotationSchema.parse({ encoding: "lat-lon", latitude: "/lat", longitude: "/lng" })).toMatchObject({ version: 1 });
});

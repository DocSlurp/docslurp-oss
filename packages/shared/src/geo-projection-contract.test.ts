import { describe, expect, it } from "vitest";
import { canonicalGeoProjectionJson, geoProjectionFieldPointer } from "./geo-projection-contract.js";

describe("projection digest contract", () => {
  it("sorts every object's keys without reordering arrays or numeric property names", () => {
    expect(canonicalGeoProjectionJson({ z: [{ b: 1, a: null }, true], "2": 2, "10": 10 }))
      .toBe('{"10":10,"2":2,"z":[{"a":null,"b":1},true]}');
  });
  it("preserves schema annotations and primitive types", () => {
    expect(canonicalGeoProjectionJson({ format: "geojson", type: "object", geo: { encoding: "geojson" } }))
      .toBe('{"format":"geojson","geo":{"encoding":"geojson"},"type":"object"}');
    expect(canonicalGeoProjectionJson(["1", 1, false, null])).toBe('["1",1,false,null]');
  });
  it("rejects non-JSON and lossy serialization", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const value of [undefined, NaN, Infinity, 1n, () => 1, new Date(), cycle, [undefined], Array(1), { a: undefined }, { get a() { return 1; } }, { [Symbol()]: 1 }]) {
      expect(() => canonicalGeoProjectionJson(value)).toThrow();
    }
  });
  it("allows repeated objects that are not cycles", () => {
    const child = { a: 1 };
    expect(canonicalGeoProjectionJson([child, child])).toBe('[{"a":1},{"a":1}]');
  });
  it("escapes top-level names as RFC6901 pointers", () => {
    expect(geoProjectionFieldPointer("a~/b")).toBe("/a~0~1b");
    expect(geoProjectionFieldPointer("")).toBe("/");
    expect(geoProjectionFieldPointer("location")).toBe("/location");
  });
});

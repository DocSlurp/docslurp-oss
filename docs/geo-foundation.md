# Geo foundation (not searchable yet)

This slice exports structural validators, typed future predicates, and suggest-only
detection. It does not index geography or enable search/chat geo parameters.
Page evidence polygons are page coordinates, never geographic inputs.

Copyable outputSchema for a single document-level location:

```json
{"type":"object","properties":{"site":{"type":"object","properties":{"lat":{"type":"number"},"lon":{"type":"number"}},"x-docslurp-geo":{"version":1,"encoding":"lat-lon","latitude":"/lat","longitude":"/lon"}}}}
```

Alternatively annotate an object with
`{"version":1,"encoding":"geojson","geometryTypes":["Point","MultiPoint","Polygon","MultiPolygon"]}`.
Only top-level object fields and direct sibling JSON Pointers are supported.
Nested mappings, row arrays and references are not supported; explicitly reject
annotations in those positions. No implicit pairing or numeric coercion occurs.
Authoritative annotations survive structured field conversion. The provider gets
a separate copy with annotations removed.

Coordinates are exactly two finite WGS84 numbers in longitude/latitude order.
Missing/null is not zero. Geometry objects reject unknown keys and types. Limits:
10,000 vertices, 100 rings/polygons per container, depth 16, conservative 256 KiB
JSON budget and 1,000 detection samples. Closed rings establish structure only;
self-intersection, holes, dateline cutting, polar handling and winding normalization
remain the future PostGIS gate. Do not index based on structural validation alone.

Future predicate semantics: radius applies only to Point/MultiPoint with inclusive
minimum spheroidal distance in meters; bbox intersects inclusively (west > east
splits at the dateline); intersects includes touching; within means whole-geometry
boundary-inclusive coverage. These types do not execute predicates. Polygon
operations will use planar GeoJSON segments after validated dateline cutting.

`suggestGeoMapping(samples, headers)` returns suggestions and validation counts.
Structurally valid GeoJSON is strong evidence; named lat/lon headers plus ranges
are weak evidence. Values valid in either axis order are counted ambiguous.
Unlabeled x/y never gets a mapping. Suggestions never activate indexing and must
only receive structured values, not evidence boxes or page polygons.

# Spatial search with explicit column opt-in

Spatial indexing consumes extra storage and processing. Only a workspace output-schema property explicitly declared `{"type":"object","format":"geojson"}` activates it. Shape detection is advisory; ordinary JSON, addresses and coordinate-looking fields remain unindexed. GeoJSON positions use longitude then latitude. No geocoding or new endpoint is introduced.

```json
{"type":"object","properties":{"site":{"type":"object","format":"geojson"}}}
```

The existing field-result envelope retains value, evidence and policy. Only accepted values enter the derived index. Optional missing values produce a ready empty generation; invalid or review-required values cannot silently become searchable. See `self-host/geo-projection-publication.md` for publication, corrections, revisions and the opt-in PostGIS migrations. Installing the standard PostgreSQL image does not supply PostGIS.

Use the existing search endpoint with one additive `geo` predicate. Existing metadata filters intersect it; ranking remains text relevance and a text query remains required.

```json
{"q":"road access","geo":{"field":"site","op":"radius","center":[-104.99,39.74],"radiusMeters":5000}}
```

Chat uses the same predicate under `filters.geo`. The SDK, MCP search schema and generated OpenAPI advertise the same contract. GET search accepts `geo` as JSON in a query parameter.

- `radius`: Point/MultiPoint distance in metres using PostGIS geography; boundary included, any point may match.
- `bbox`: `[west,south,east,north]`, inclusive intersection. West greater than east crosses the antimeridian and splits into two envelopes.
- `within`: geometry covered by the supplied Polygon/MultiPolygon, including boundaries and respecting holes.
- `intersects`: geometry intersects the supplied Polygon/MultiPolygon.

Polygon predicates use planar longitude/latitude geometry. Split dateline-crossing polygons explicitly; this version does not infer wrapping. Ring closure, coordinate/byte/vertex limits and PostGIS topology are validated. Distance sorting, geocoding, nested column mappings and arbitrary Typesense filter syntax are outside this contract.

Unavailable spatial infrastructure returns 503; missing/stale selected-document generations return 409; invalid/unannotated fields, topology and more than 10,000 matching documents return 400. Narrow filters or reprocess the selected documents. A requested constraint is never ignored. Explicit empty document filters remain empty.

## Boundary and validation

Workspace/API-key authorization precedes spatial access. Spatial eligibility intersects normal document filters before ranking and paid inference. Every SQL evidence adapter checks current scoped generation and schema digest; unsupported native Lance filtering uses the scoped SQL path. Geo responses bypass response caching, batch embedding prefetch and unrestricted community/summary expansion. Spatial requests do not trigger deferred cold-page model routing or materialization: only already indexed evidence with current accepted geometry is searched. This avoids spending on documents whose geometry revision cannot be fenced throughout deferred work. Spatial SQL uses the existing search statement timeout and request cancellation controls; timeout/abort remains a query failure, not invalid topology.

Run `GEO_QUERY_INTEGRATION=1 bash scripts/postgis/lifecycle-test.sh` for the disposable digest-pinned PostGIS lifecycle, two-backend race and actual hybrid-search integration. It has no network or application-secret mounts; query tests mount only their disposable Unix-socket directory. Focused contract, route, API-key, native-capability and retrieval-scope tests also cover malformed requests, advertised schemas, cache bypass and empty scopes. These are local tests, not production readiness or geographic performance claims. Independent council review and hosted CI remain merge gates.

### Spatial SQL call-site audit

Spatial predicates enter SQL through `retrievalScope`, `spatialPredicate`, and `buildChunkSearchWhere`. The query-bound review covers initial capability/topology/coverage/matching, vector document selection and hit hydration, lexical/graph/page evidence, graph term expansion, parent page/neighbor hydration, and whole-corpus summaries/hydration. Each spatial read uses `boundedSearchQuery`; graph and finalizer callers preserve abort/timeout failures. Unfiltered legacy paths retain their existing behavior. This is a call-site audit, not a claim that every non-spatial database operation has a request deadline.

The PostGIS integration suite includes blocked parent-page retrieval through actual hybrid search, neighboring-chunk hydration through the finalizer, and graph expansion, each under timeout and cancellation. Ordinary native-vector regressions exercise the changed vector adapter; no production vector load or performance claim is made.

SDK `chatStream()` carries the same `filters` object as `chat()`. GET `/v1/chat/stream` accepts its JSON-encoded `filters` query parameter, validates it before starting the turn, and refuses malformed or oversized values rather than dropping constraints. Streaming filter JSON is limited to 16,384 characters; use non-streaming POST chat for larger polygons. Network/proxy URL limits may be lower. Spatial evidence-branch timeouts fail the request; legacy non-spatial timeout degradation is unchanged.

# PostGIS feasibility and extension migration boundary

This is a backend feasibility foundation, **not an enabled geo search feature**.
No application migrations, production extensions, retrieval paths or ordinary
JSON contracts change here.

## Repeatable local check

Run `bash scripts/postgis/test.sh` from the core repository. Docker must be
available. The digest in `scripts/postgis/image.txt` identifies the public
PostGIS PostgreSQL 17 image. Pull that digest before running offline. The test
uses one disposable container, no host mounts or application secrets, no network
or exposed ports, one CPU and 512 MiB memory; PGDATA is a 256 MiB tmpfs. Its
EXIT trap removes the container and anonymous volumes. A killed host/process
may require removing only the container named `docslurp-postgis-test-<pid>-<random>`.

The SQL exits on any failed assertion and prints PostgreSQL/PostGIS/GEOS/PROJ
versions and actual query plans. Cases cover spheroidal meter distances,
inclusive zero radius, MultiPoint any-radius/all-coverage, polygon holes,
boundary-inclusive CoveredBy versus strict Within, invalid self-intersection,
and a split dateline bounding box. Temporary 10,000-point relations exercise
GiST geometry and geography expression indexes. These are deterministic backend
checks, not application retrieval, authorization, throughput or lifecycle tests.

## Installation and ordinary migration compatibility

Stock PostgreSQL 17 does not imply PostGIS availability. Operators must install
matching PostGIS server packages, or choose a supported PostGIS database image,
and explicitly install the extension as the database owner. Do not change an
existing database image/data directory without its normal backup and upgrade
procedure. No automatic production installation is authorized by this document.

Check available and installed capabilities separately:

```sql
SELECT name, default_version, installed_version
FROM pg_available_extensions WHERE name = 'postgis';
SELECT extversion FROM pg_extension WHERE extname = 'postgis';
-- Only an operator performing an approved installation runs:
CREATE EXTENSION postgis;
SELECT postgis_full_version();
```

`server/db/migrate.mjs` runs the ordinary Drizzle journal under an advisory lock;
`worker/src/test/migrated-db.ts` applies every entry to PGlite, with pgcrypto only.
An unconditional geometry column or CREATE EXTENSION in that journal would break
ordinary installations. A conditional DO block is also wrong: Drizzle would mark
it applied on a non-geo database and never install it when capability appears.

Proposed extension strategy for the next storage implementation:

1. Keep extension migrations under `server/db/migrations/postgis/`, with a
   distinct ordered journal and ledger, explicitly invoked by an opt-in owner
   command under the existing migration lock after the ordinary journal.
2. Preflight installed PostGIS before any extension DDL. Missing capability is a
   loud refusal for this command; it never installs the extension implicitly.
3. Test fresh, repeat, rollback-on-failure, ordinary-to-enabled upgrade and both
   journals against real PostgreSQL. Keep the ordinary PGlite journal unchanged.
4. Retrieval must require installed capability **and** the expected extension
   migration version **and** matching published projection generation. Missing
   capability returns an explicit unsupported/index-not-ready error before paid
   query enhancement. Never drop a geo constraint or treat missing rows as a
   complete empty result. This gate is not wired by this feasibility PR.

## Projection storage handoff (not DDL)

Do not create `document_geo` until publication identity is agreed with the
structured-result owner. Current `document_corrections` upserts structured data
in place (`server/src/services/document-review.ts`); `schema.ts` stores pipeline
configuration as JSON. A run ID or correction timestamp alone does not establish
an immutable accepted-result/schema revision. Inventing these here would allow
stale concurrent publishers to resurrect a rejected/corrected value.

The storage migration should establish:

- Identity: org, workspace, document version, run, schema digest, accepted result
  digest/revision, field pointer, value pointer and normalizer version.
- Canonical `geometry(Geometry,4326)`, restricted to 2D nonempty valid Point,
  MultiPoint, Polygon and MultiPolygon, plus original-value/evidence provenance.
  Validate coordinate range, dateline policy and complexity before DB operations;
  never use ST_MakeValid to silently change supplied coverage.
- Separate generation readiness from per-value acceptance. Atomically publish a
  complete generation, including a valid zero-location generation. Rejection/null
  replaces or removes prior geometry. A partially populated generation cannot be
  queried as ready.
- Composite scoped foreign keys/uniqueness joining org/workspace/document/run,
  not independent foreign keys that permit a foreign tenant's document. Determine
  parent composite keys from the owning migrations before adding constraints.
- GiST geometry index; partial geography expression index for Point/MultiPoint
  radius; B-tree org/workspace/field/generation lookup. Queries must include
  authorization and current document eligibility, not rely on indexes for scope.
- Transactional compare-and-publish of source revision, deletion/purge cascades,
  schema invalidation and result cache generation. Test correction-vs-publish,
  delete-vs-retry, supersession, dedup copies and rollback on the real backend.

No projection DDL is delivered in this slice. Integration owners must resolve
these identities and implement the gate before claiming geo support. Boundary
implementation requires independent council reviews before merge; this harness
is not that security review.

## Observed local run — 2026-11-01

See `scripts/postgis/observed-output.txt` for the final unedited SQL output.
The pinned image ran PostgreSQL **17.5**, PostGIS **3.5.2**, GEOS **3.9.0** and
PROJ **7.2.1** on x86_64. This proves PG17-major feasibility, not exact parity
with the host's PostgreSQL 17.11 or a production package. Both selective plans
used their GiST indexes with exact predicate rechecks. Timings are one tiny
synthetic local sample, not a capacity estimate. Polar point coincidence and
Polygon/MultiPolygon coverage also passed. The invalid-topology NOTICE is
expected and asserted false by ST_IsValid.

Validation: disposable real-PostGIS run passed; `bash -n scripts/postgis/test.sh`
and `git diff --check` passed. The initial run failed because pg_isready observed
the temporary initialization server; waiting on TCP fixed that race. No app
TypeScript, migration journal or package dependencies changed; broad app/core
builds and PGlite tests were not run. No actual projection lifecycle, request
capability gate or authenticated retrieval is implemented or validated here.

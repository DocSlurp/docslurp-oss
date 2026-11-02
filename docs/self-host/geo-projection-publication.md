# Geo projection publication lifecycle

Geo costs require an explicit column opt-in: JSON Schema `{ "type": "object", "format": "geojson" }` becomes structured type `geo`. Ordinary object columns and detection suggestions do not create accepted-source rows or spatial indexes. Schema validation and provider metadata removal are described in `../geo-foundation.md`.

## Installation

Install PostGIS through your operator-supported database procedure, then run the normal migration runner with `POSTGIS_MIGRATIONS=1`. Ordinary migration 0110 has no spatial types and works with PGlite. Optional spatial migrations run under an advisory lock with a checksum ledger. An opted-in extraction refuses before model work if the spatial publisher is absent; a geo correction rolls back if it is absent. There is no scan or weaker-index fallback.

## Accepted source and revision contract

Identity is `(orgId, workspaceId, documentId, revision)`, with the database bigint revision represented as a decimal string. Source identity, archive/supersession/purge, blocked/failed eligibility, correction content and workspace configuration changes invalidate it. Ordinary progress and stage-completion status changes do not. Beginning a new geo extraction attempt increments the revision under a workspace/document lock, fencing competing and delayed attempts. Document IDs must never be reused.

The worker verifies that its effective output schema matches the current workspace schema. Per-run schema overrides that differ are refused for spatial publication. Only present geo fields marked auto-accept by deterministic structured validation are admitted. Optional missing values yield no feature; required missing, invalid or review-required values refuse publication. An accepted empty generation is distinct from a missing index. Features are capped at 1,000 per document and 1 MiB serialized; each geometry also has the shared structural bounds, followed by PostGIS topology checks.

`geo_accepted_sources` stores only admitted geo features and schema/result digests, not a second copy of all structured output. `commit_geo_final_source` verifies scope, current revision, active structured checkpoint and correction precedence, saves the source and publishes the derived projection within the successful checkpoint transaction. Partial object-store artifacts are never consulted. A failed spatial insert rolls back the accepted source and checkpoint. An identical already-completed retry succeeds; different content is not an idempotent retry.

Authorized structured corrections publish in the same transaction as the correction row. Omission preserves the existing structured correction; explicit null clears it and publishes an empty generation. Corrections with values take precedence over extraction. Schema changes require revalidation/reprocessing or resaving the correction; old geometry cannot silently remain current. Markdown-only changes invalidate extraction-derived geometry; ordinary notes-only updates do not. The source service is internal, not an authenticated public endpoint: callers must already establish workspace/user authority.

Field paths are RFC6901 pointers to top-level fields (`a/b` becomes `/a~1b`). `canonicalGeoProjectionJson` recursively sorts object keys and preserves array order; SHA-256 of its UTF-8 bytes is lowercase hex. Schema digest covers the complete effective output schema including geo mapping. Result digest covers the admitted feature list. Shared helpers avoid independent serialization algorithms.

## Retrieval and threat model

Readers must join `ready_geo_projection_generations` with `geo_projection_features`, constrain org/workspace, and intersect normal authorized document eligibility. Raw feature rows can be stale. Do not cache geo eligibility without revision-aware invalidation. This lifecycle PR does not implement search/chat predicates; their separate integration remains required.

Publication locks workspace then document, checks exact scope and revision, and uses parameterized SQL. Scope foreign keys prevent cross-workspace features. PostGIS refuses unsupported types, invalid topology, nonfinite/out-of-range coordinates and oversized geometry. The worker's database role explicitly grants access to the projection tables; no credentials or untrusted-file parsing boundary changes are introduced. A compromised trusted database writer is outside this validation guarantee; these functions are not a privilege-escalating security-definer API.

## Verification

`worker/src/__tests__/geo-final-source.test.ts` covers ordinary-column opt-out, policy/malformed rejection, zero coordinates and optional null. `geo-revision.db.test.ts` applies all ordinary migrations in PGlite and tests progress versus source revisions, tenant/stale refusal and absent PostGIS rollback. Existing checkpoint/enrichment regressions also run.

`scripts/postgis/lifecycle-test.sh` creates a digest-pinned, network-isolated disposable PostgreSQL/PostGIS database, applies the complete ordinary and spatial migration journals, and tests successful publication, identical retries, topology rollback, explicit-null corrections, scoped refusal and deletion cascade. Two independent PostgreSQL backends demonstrate a delayed stale publisher refusing after a competing revision commits. This is not production platform validation or exhaustive concurrency coverage. Independent council review remains required before merge.

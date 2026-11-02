# Geo projection publication foundation (not ready for integration)

This slice stacks on PostGIS harness PR #259. Enable optional migrations with
`POSTGIS_MIGRATIONS=1` and the ordinary direct migration-owner connection. The
extension must already be installed by the operator. Ordinary migrations contain
no spatial types. The optional runner takes a transaction advisory lock and
commits DDL and a checksum ledger together; absent capability, changed migration
content and failed DDL are errors, never applied skips.

## Publication identity and threat model

Identity is `(orgId, workspaceId, documentId, revision)` where revision is the
explicit database-owned bigint `documents.projection_revision`, serialized as a
decimal string. It is not a timestamp or run ID. Every document update advances
it; correction insert/update/delete and workspace pipeline, organization or
archive changes advance affected documents. This intentionally over-invalidates.
Document deletion cascades derived rows. Recreating an identical document ID is
not supported: IDs must remain non-reusable.

`publishGeoProjection(client, identity, authority)` owns a transaction, locks the
workspace then document, compares revision, obtains accepted final projection
input from the authority adapter and atomically replaces the generation and
features. Zero features is a valid ready generation. Schema and result SHA-256
snapshots are mandatory. Conflicting digests at one revision are refused.
Read readiness through `ready_geo_projection_generations` and always supply
organization and workspace predicates. The raw feature table includes stale rows;
readers must join the ready generation. No retrieval route is added here.

An old worker token cannot publish after a correction, schema change or delete.
Scoped foreign keys reject a cross-workspace feature or mismatched organization.
Spatial constraints reject unsupported types, invalid topology, out-of-bounds
coordinates, empty geometry and excessive vertex counts. Caller geometry bytes
and feature count are bounded before insertion. This is a database service, not
an authenticated endpoint; authorization belongs to its future caller. No new
customer-byte parser or credential access is introduced.

## Exact integration contract and remaining work

The adapter is intentionally absent and publication throws without it. It must
verify current eligibility and dedup policy, compute canonical schema/result
digests, and return only accepted final non-null fields (or an accepted empty
array). It must not infer acceptance from artifact existence. The structured
extract stage writes its envelope before checking hard rejection; corrections
upsert `document_corrections.corrected_structured_data` in place. Workspace
configuration is stored in `workspaces.pipeline`, covered by the trigger.

Artifact/checkpoint completion is NOT yet wired as an authoritative final-source
transition. The adapter must capture the source revision before extraction, and
final source changes must advance that revision transactionally before becoming
publishable. Corrections must take precedence over worker output, including
explicit null/rejection. Until that integration is implemented and tested, do
not enable a caller or claim that all source mutations are fenced. Shared geo
contracts and schema conversion are deliberately untouched.

Real PostgreSQL 17.5/PostGIS 3.5.2 tests cover migration DDL, correction invalidation,
schema invalidation, empty readiness, scoped FK rejection and deletion cascade.
Runner unit tests cover absent extension, rollback, changed checksums and ordering.
They do not replace real concurrent publication, retry, full migration/PGlite,
or checkpoint integration tests. Council review is required before merge.

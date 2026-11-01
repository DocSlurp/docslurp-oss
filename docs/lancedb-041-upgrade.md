# LanceDB 0.41 upgrade (2026-11-01)

Status: draft; validation incomplete, not ready to merge.

npm and PyPI registry JSON both reported stable 0.41.0 on 2026-11-01.
Server, worker and SDK development dependencies move from ^0.40.0 to
^0.41.0; the optional SDK peer moves from ^0.39.0 to ^0.41.0.
Python requirements move from >=0.10.0 to >=0.41.0,<0.42, with hashed
locks updated from 0.40.0. Locks were generated with uv, the CI workflow's
UV_TORCH_BACKEND=cpu, and constraints preserving existing package versions.
Only the generated LanceDB stanza was retained to avoid unrelated hash churn.

Sources:
- https://github.com/lancedb/lancedb/releases/tag/v0.41.0
- https://registry.npmjs.org/@lancedb/lancedb/latest
- https://pypi.org/pypi/lancedb/json

The release embeds Lance 14.0.2. Its release notes identify lazy listing
iterators, stricter remote option validation and embedding metadata trust
changes. No process-wide remote-code or endpoint approvals were added.
Existing Node callers use tableNames(); the SDK build passes, but the full
caller/signature and runtime install audit remains pending. Published Node
and Python packages disable experimental local computed functions/views.

Python's published package description requires Haswell AVX2/FMA/F16C on
x86_64. Pre-Haswell hosts need the separate lancedb-compat distribution;
the two distributions must not be installed together. Source builds require
Rust and protoc; none were initiated. Deployment CPU/wheel compatibility
has not yet been verified.

Native Node runtime inspection found no GeoArrow/RTree-named top-level
exports and no RTree factory on Index. Index factories observed: ivfPq,
ivfRq, ivfFlat, btree, bitmap, labelList, fm, fts, hnswPq, hnswSq.
SQL geo predicate availability remains unverified; Rust support does not
establish Node support. No geo architecture changes are included.

## Validation

- Frozen pnpm install passed (lifecycle scripts disabled).
- Shared and SDK TypeScript builds passed.
- Server lancedb, lancedb-query-tuning, lancedb-open: 23 tests passed.
- Local native Node synthetic-vector smoke passed create, btree index,
  tenant-filtered vector query, update, delete and reopen (one row remained).
- Python lock hash validator passed; diff whitespace check passed.
- Pending: Python import/smoke, 0.40-created dataset read/write compatibility,
  downgrade test, worker and SDK adapter tests, full affected typechecks/builds,
  exact Node/Python dependency and target-platform audit, SQL geo predicates.

No schema/index migration is introduced by this patch. Whether existing data
requires any migration is not yet established by compatibility testing.
Do not assume downgrade safety after writes with the new library; retain a
pre-upgrade snapshot and validate restoration before deployment.

## Threat model and merge gate

LanceDB enforces filters used by tenant search and handles persisted index
metadata. Risks include filter regressions exposing another tenant's rows,
changed metadata restoration permitting outbound requests or remote code,
and native parsing faults. Existing tenancy predicates are unchanged.
Two independent council reviewers (one adversarial) and boundary-negative
coverage are required before merge. Neither review has been performed.
No production data, model calls, merge or deployment was used for validation.


## Coordinator completion and independent review evidence

The affected server/worker typechecks, shared/SDK builds and worker build passed.
Additional focused checks passed: 69 worker Lance tests and 16 SDK search/chat
adapter tests. The independent platform reviewer passed 106 server/auth tests
and verified all five changed Python release hashes against PyPI. Python platform
artifacts include manylinux_2_28 x86_64/aarch64, macOS arm64 and Windows amd64;
other targets may require a source build. Node deployment images use Node24 on
Debian trixie; optional SDK offline/native search requires Node22 even though the
HTTP SDK supports Node20. Deployment CPU feature availability is not certified.

Independent Python 3.13.7 execution passed native import/CRUD, a 300-row 0.40
indexed dataset read and updated by 0.41, and a COPY reopened by 0.40. This covers
ordinary CRUD on that synthetic dataset, not general downgrade safety, new index
formats, compaction, remote storage or concurrent writers. The smoke used Arrow26
and pydantic2.14.2, not the complete worker lock environment.

The published JS 0.41 native binary has no RTree factory. ST_Point/ST_DWithin are
unknown functions; recognized st_intersects/st_within fail at execution with a
requires-geo-build-feature error even for valid WKB. This release does not supply
usable geospatial execution through the tested published JS binary.

Review found a pre-existing empty-eligibility inconsistency: vector search treated
an explicit empty document allowlist as unrestricted, while full-text returned no
hits. This upgrade now returns no vector results before opening storage for an
explicit empty list; only an omitted list means unrestricted within the selected
workspace. The post-query scope check also keeps an empty allowlist empty. Native
service and eligibility tests (37 across three files) passed, including a populated
workspace and empty/omitted/empty sequence. This narrows behavior and requires
fresh council review of the resulting head.

Remaining validation: hostile persisted embedding metadata, exact complete Python
lock environment/target CPU execution, and independent final-head council. No
process-wide remote-code or endpoint permission was added. Earlier draft pending
lists above are historical; this section records which gaps were subsequently
covered, with their limits.

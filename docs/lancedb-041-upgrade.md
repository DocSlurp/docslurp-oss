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

# LanceDB 0.41 upgrade

The npm and PyPI stable release checked on 2026-11-01 is 0.41.0. Server and worker JS dependencies and the SDK's optional native peer now require 0.41. Python locks select 0.41.0 with declared range `>=0.41.0,<0.42`. No production deployment or package publication has occurred.

## Upgrade requirements

Official sources:
- https://github.com/lancedb/lancedb/releases/tag/v0.41.0
- https://registry.npmjs.org/@lancedb/lancedb/latest
- https://pypi.org/pypi/lancedb/json

The release embeds Lance 14.0.2. Upgrade considerations include lazy Python listings, stricter remote option validation and persisted embedding metadata trust. Existing JS table listings remain awaited arrays. No process-wide endpoint or remote-code permission is enabled.

Native Node adapters require Node >=22; the HTTP-only SDK supports Node >=20. Production Node images use Node24/Debian trixie. Python requires >=3.10, Arrow >=16 and compatible Pydantic 2. Linux wheels require glibc >=2.28 on x86_64/aarch64. Standard x86_64 wheels require Haswell AVX2/FMA/F16C. Older CPUs require a separately evaluated compatibility distribution; never install both distributions together. Source builds require Rust and protoc. Local x86_64 execution is not certification of production CPU flags or ARM.

## Numeric adapter boundary

DocSlurp generates and accounts for embeddings before LanceDB writes. Persisted `embedding_functions` metadata is therefore unsupported in its numeric adapters. Worker JS and Python writers, server native search, and SDK native offline reads/writes refuse its presence before provider restoration. The SDK propagates this refusal instead of falling back to another embedding path. No arbitrary provider from stored metadata is initialized. Server search reports an unavailable native table and may use its existing tenant-scoped database fallback; it never removes authorization or document constraints.

The upgrade also fixes a pre-existing empty-allowlist issue: an explicit empty document list returns no vector results before opening storage or accessing result caches. Only omission means all eligible documents inside the already authorized workspace.

## Verification

- Populated native JS tables carrying malformed, empty, unknown, OpenAI and Hugging Face metadata were reopened through actual worker, server and public SDK adapters. Real built-in constructor proxies, network tripwires and model-loader tripwires recorded zero calls. SDK read/write failures close table and database handles. Fixtures inject Arrow IPC at the native layer solely to create hostile stored state without invoking providers during test setup.
- `worker/src/__tests__/lancedb-metadata.test.ts`, `server/src/__tests__/lancedb-metadata.test.ts`, and `server/src/__tests__/sdk-offline-metadata.test.ts` retain these regressions.
- The final server native/metadata/eligibility group passed 39 tests. Server and worker typechecks and shared/SDK builds passed. Earlier 0.41 verification also covered worker write/retry/queue/relocation/backfill/maintenance/hydration, native CRUD/index/filter/reopen, and SDK request adapters; their historical counts are not represented as final-head reruns.
- `worker/scripts/test_lancedb_metadata.py` passed two tests in the locked dependency environment: six persisted metadata variants refuse before registry restoration/network, and ordinary numeric create/append still succeeds. No synthetic provider or trust allowlist is registered.
- Installed LanceDB's 17-package dependency closure using **the committed primary worker lock versions and original hashes** with `uv pip install --require-hashes`. Native imports succeeded: LanceDB 0.41.0, Arrow 26.0.0, Pydantic 2.14.1/core 2.50.1, NumPy 2.4.6 on CPython 3.13.7 Linux x86_64. This is an actual hash-checked installation, not merely resolution. It does not claim installation of unrelated OCR/torch packages or execution on production Python3.11.
- Both complete CPU worker locks previously resolved successfully. The selected CPython abi3 manylinux_2_28 x86_64 LanceDB wheel was independently downloaded and its SHA-256 matched PyPI and both locks. Platform hashes are retained; untouched package stanzas were not regenerated.
- Independent synthetic compatibility testing created/indexed 300 rows with 0.40, reopened/updated them with 0.41, then reopened a **copy** with 0.40. This is ordinary synthetic CRUD/index evidence, not general rollback assurance for new formats, compaction, remote storage or concurrent writers. Retain a pre-upgrade snapshot.

The published JS 0.41 binary does not provide usable geospatial execution: no RTree factory was exposed; ST_Point/ST_DWithin were unknown; recognized st_intersects/st_within failed with a geo-build-feature requirement for valid WKB. Rust API availability is not JS capability. Geo queries use the separately reviewed PostGIS path.

## Threat model and remaining release gates

LanceDB handles tenant-filtered retrieval and native persisted index metadata. Negative tests cover scoped/empty allowlists and hostile metadata without widening tenant scope or enabling egress. This does not certify arbitrary native-parser exploits, other CPU targets, or modified third-party registries outside the guarded adapters. Fresh independent council and hosted CI must pass on the final revision before merge. Deployment remains a separate manual action.

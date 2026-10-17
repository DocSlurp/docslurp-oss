# Langfuse evaluation sync

Verified 2026-10-17 05:29 UTC. Three development datasets were synced and read back from the existing DocSlurp Langfuse project:

| Dataset | Remote items | Second-pass creates | Second-pass updates | Unchanged |
| --- | ---: | ---: | ---: | ---: |
| docslurp-retrieval-development-v1 | 13 | 0 | 0 | 13 |
| docslurp-retrieval-development-v2 | 16 | 0 | 0 | 16 |
| docslurp-multisearch-development-v1 | 6 | 0 | 0 | 6 |

No LLM calls or new infrastructure. Historical summaries/configurations/provenance are retained in item metadata; missing costs are unknown, not zero. Dataset versions have distinct stable item IDs. The local manifest freezes import checkout commit `c7b00dedafbee9097229c4184889109465f03bf2`; this is not asserted as the historical execution commit. External input/source hashes are preserved. Original fields retain any historical timestamps or session/trace identifiers; source-trace linkage is only written when a source ID is actually available.

The first partial upload exposed a deployed-API difference: v2 dataset GET returns metadata without items. The importer now verifies counts using paginated dataset-items GET as well as individual item readback. The successful repeated sync above verifies idempotence against the actual remote API. Three focused fixture-free tests cover stable identity/split separation, write/readback/idempotence and credential redaction.

Remote restoration: public HTTPS intentionally permits tailnet and Fly egress only. The existing host had six stopped Langfuse containers, 9.2 GB available RAM and 70 GB free disk. Existing compose `start` restored the stack; dependencies became healthy. No images, configuration, credentials, firewall or data were changed. Sync used a temporary SSH localhost tunnel to that same service, respecting the public firewall.

Evidence outside git: `/tmp/docslurp-retrieval-quality-evidence/langfuse-development-manifest.json`, `langfuse-development-outbox.json`, `langfuse-sync-first.json`, `langfuse-sync-second.json`. The reusable uploader and manifest contract are in `scripts/eval-sync/README.md`.

## Precise outstanding work

- **Heldout export blocked:** automatic approval review rejected exporting heldout questions/gold to the external Langfuse destination because general sync authorization was insufficiently specific. Heldout payloads were excluded, remained local, and were not printed. Obtain specific destination/payload approval before exporting them.
- **Experiment runs and result linking pending:** zero experiment runs/traces were fabricated. Current official Langfuse has no public REST endpoint for creating experiments and deprecates dataset-run-items. Existing historical summaries cannot honestly become fresh execution traces. A supported OTLP evidence import (preserving original execution times/IDs and distinguishing actual/estimated costs) or actual SDK-run experiment is a separate step. Current retrieval option/replay raw evidence and search session IDs remain in external files for that work. Synced historical summaries are metadata, not scores or claimed experiment results.

Official references: [Dataset API OpenAPI](https://raw.githubusercontent.com/langfuse/langfuse/main/web/public/generated/api/openapi.yml), [experiment data model](https://langfuse.com/docs/evaluation/experiments/data-model), [deprecation migration](https://langfuse.com/faq/all/deprecated-api-migration), [historical migration limitations](https://langfuse.com/guides/cookbook/example_data_migration).

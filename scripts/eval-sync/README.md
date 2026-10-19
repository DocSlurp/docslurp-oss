# Langfuse evaluation dataset sync

`node scripts/eval-sync/langfuse.mjs --manifest /path/manifest.json` validates and prints counts only. Add `--outbox /private/path/outbox.json` to retain desired writes outside the repository. Add `--env-file /path/.env.production --write --output /path/report.json` to sync. Credentials are loaded only for write mode and are never printed. `--base-url http://127.0.0.1:PORT` supports an existing authorized SSH tunnel; otherwise the configured HTTPS endpoint is used. No LLM calls, traces, scores or experiment runs are created.

Manifest shape:

```json
{
  "sourceCommit": "commit-that-produced-the-evidence-if-known",
  "config": { "experiment": "descriptive-config" },
  "datasets": [{
    "name": "project-development-v1",
    "split": "development",
    "cases": "/external/cases.json",
    "gold": "/external/optional-gold.json",
    "provenance": "/external/optional-provenance.json",
    "source": "/external/optional-source.md"
  }]
}
```

Cases may be an array or `{ "cases": [...] }`; each needs `id` and `question`. Separate gold arrays join on `id`. Otherwise expected output retains case fields except identity, question and separately stored provenance/retrieval/history. Every dataset name must contain its `development` or `heldout` split; mixed splits fail. Exporting heldout evidence requires specific authorization for that destination. Do not use a combined manifest if only development export is approved.

IDs hash dataset name plus case identity; dataset versions cannot overwrite each other. Content hashes include configuration, source hashes and import/source commit. Existing matching items are skipped; changed items are upserted and read back. No items are deleted. Dataset name, IDs, expected output and content hashes are checked after writes. Repeating the same manifest with the same `sourceCommit` should show zero creates/updates. Freeze `sourceCommit` in the manifest when comparing runs across repository commits; absent it the current importer checkout HEAD is recorded, not asserted to be the historical execution commit.

Original summaries remain labeled historical evidence in metadata. Their original timestamps/config/session or trace IDs remain intact; unavailable costs are `null`, never fabricated as zero. Dataset source-trace links are sent only when explicitly present as source IDs. This uploader does not invent traces for old results. Historical run import requires an evidence-preserving supported OTLP path or an actual new SDK experiment and remains separate work.

Official contracts checked 2026-10-16: [OpenAPI](https://raw.githubusercontent.com/langfuse/langfuse/main/web/public/generated/api/openapi.yml), [dataset documentation](https://langfuse.com/docs/evaluation/experiments/datasets), [deprecated API migration](https://langfuse.com/faq/all/deprecated-api-migration), [historical migration limitations](https://langfuse.com/guides/cookbook/example_data_migration). Uses `/api/public/v2/datasets` and `/api/public/dataset-items`; never deprecated `/dataset-run-items`.

Run focused checks with `node --test scripts/eval-sync/langfuse.test.mjs`.

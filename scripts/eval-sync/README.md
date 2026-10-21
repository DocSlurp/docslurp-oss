# Langfuse evaluation dataset sync

## Prompts, evaluators and judge assets

`node scripts/eval-sync/assets.mjs --manifest scripts/eval-sync/content-safety/manifest.json`
validates the complete content-safety asset bundle without network access. Add
`--write --env-file /private/.env.production --output /private/sync-report.json`
to synchronize it; `--base-url http://127.0.0.1:PORT` supports an authorized SSH tunnel.
File paths in this manifest resolve relative to the manifest, not the shell directory.

The bundle contains the Mastra candidate's policy prompt, an independent-reference
code evaluator, an advisory LLM judge definition, and seven agent-authored synthetic
development cases. These cases verify wiring only. They are **not human-reviewed
holdout evidence**, and cannot support an accuracy or promotion claim. The advisory
judge uses an explicit modest-cost model as a configurable starting candidate, not
the winner of the required comparison. Native evaluator creation can invoke the
provider for validation, including billable calls. Langfuse does not return token
usage in the evaluator API, so sync reports `llmCalls: null`, not zero. No automatic
evaluation rules, provider credentials, production prompt labels, or infrastructure
changes are made by asset sync. A native judge may remain paused until a model
connection is available.

The deterministic evaluator source is also archived as a versioned text asset named
`reference-evaluator-source`, explicitly marked `notAnLlmPrompt`. This preserves
reviewable source even if native code evaluators are disabled; it does not pretend
that uploading source enables execution. Native failures are retained in `failures`,
produce `complete: false` and a nonzero exit. `runtimeReady` additionally requires
every synchronized native evaluator to be active. Fix the host prerequisite and
rerun the same manifest to complete the remaining assets.

Prompt versions use a bounded content-hash label (full hash in the report); evaluator definitions use immutable
content-derived names and return stable native evaluator IDs. Changed source creates
a new definition rather than mutating a prior experiment's evaluator. Duplicate
remote evaluator names and prompt drift fail rather than choosing silently. Reads
verify the actual prompt, evaluator definition, and dataset items after writes.
The report is the binding record: runtime adapters must pin its prompt version and
evaluator IDs, not the moving `latest` or `production` labels. Preserve the report
beside experiment artifacts. Serialize sync jobs per namespace; the remote API does
not offer atomic name uniqueness for evaluator creation.

The policy prompt's `{{input}}` variable receives only the candidate input, serialized
as JSON. It must never receive expected labels. Mastra `createScorer` or a custom
processor should use this same pinned prompt, then deterministic reference scoring
compares the result with separately held labels. The advisory judge is diagnostic,
not the ground-truth scorer. Each of the OpenAI, Mastra and cascade arms must retain
its own model/prompt/policy versions, usage receipts, errors, latency and coverage.

Native evaluator definitions do not automatically enforce content policy or execute
Mastra. The actual comparison runner and enforcement paths remain separate work.
Existing shared OTEL tracing remains enabled through its existing configuration;
asset synchronization is not evidence that an experiment has run. Use the current
Langfuse experiment SDK or supported OTEL experiment attributes when the runner
executes; do not create legacy dataset-run-item records or invent historical traces.

Official API contracts checked 2026-10-20:
[prompts/evaluators OpenAPI](https://cloud.langfuse.com/generated/api/openapi.yml),
[code evaluator context](https://langfuse.com/docs/evaluation/evaluation-methods/code-evaluators),
[experiment linkage](https://langfuse.com/integrations/native/opentelemetry/experiments).
Run `node --test scripts/eval-sync/*.test.mjs` for asset and dataset synchronization tests.

## Existing dataset-only importer

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

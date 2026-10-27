# Langfuse evaluation sync

Idempotent sync of evaluation **datasets**, **scorer definitions** (score configs) and **scored runs** (experiments) to one or more named Langfuse targets. Nothing is ever deleted, no LLM calls are made, and no Langfuse LLM-as-judge evaluators are created.

```sh
# Dry run: validates manifests and prints counts. Loads no credentials and makes no network calls.
node scripts/eval-sync/langfuse.mjs --config targets.json --manifest datasets/a.json [--manifest ...] \
  [--scorers scorers.json] [--run run.json ...] [--targets dev04,production] [--allow-heldout dev04,production]
# Write: add --write [--output /private/report.json]. Repeat the same command to verify: zero creates/updates.
```

Other options: `--only <substring,...>` limits datasets by name; `--exclude-heldout` skips held-out datasets explicitly; `--skip-datasets`, `--skip-score-configs`, `--skip-runs`; `--outbox /private/outbox.json` keeps the desired dataset writes outside the repository. Without `--config`, one target named `default` is built from `--env-file` and `--base-url` (or `LANGFUSE_*` in the environment).

## Targets

`--config` is a non-secret JSON file. Credentials are read only from each target's `envFile` (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, optionally `LANGFUSE_BASE_URL`), only in write mode, held in memory and never printed; credential-looking keys in the config are rejected. Relative paths resolve from the config file.

```json
{ "targets": {
  "dev04": { "envFile": "../../.env", "baseUrl": "http://127.0.0.1:3344" },
  "production": { "envFile": "../../.env.production",
    "tunnel": { "sshHost": "ubuntu@host", "sshOptions": ["-o", "HostKeyAlias=..."], "remoteHost": "127.0.0.1", "remotePort": 3000, "fallbackToEnvBaseUrl": false } } } }
```

A `tunnel` target is reached through `ssh -N -L 127.0.0.1:<free port>:<remoteHost>:<remotePort>` (BatchMode, ExitOnForwardFailure), which the command opens, health-checks and closes by signalling exactly its own child PID; the report records the PID and the path used (`via`). A failed tunnel fails that target unless `fallbackToEnvBaseUrl` allows the env file's HTTPS URL. Plain HTTP is accepted only for localhost.

Each target is synced and verified independently. A failure is recorded per dataset, score-config set or run, and the remaining work and targets continue. The summary reports per-target creates, updates, unchanged items and errors; the exit status is non-zero if any target failed anything.

## Dataset manifests

```json
{ "sourceCommit": "frozen-import-commit",
  "authorization": { "destinations": ["dev04", "production"], "scope": "what was approved, by whom, when" },
  "config": { "experiment": "descriptive-config" },
  "datasets": [ { "kind": "catalog", "prefix": "docslurp-evals/corpus-v1", "catalog": "/data/corpus-v1/catalog.json", "license": "license or authorisation basis" } ] }
```

`authorization.destinations` must name every target a manifest is written to, and every dataset needs a `license` basis. Freeze `sourceCommit`: it is hashed into item content, so leaving it to the importer's HEAD makes every repository commit an update. It records the import checkout, not the historical execution commit.

| `kind` | Source | One item per |
| --- | --- | --- |
| `cases` (default) | `cases` (+ optional `gold`, `provenance`, `source`); each case has `id` and `question` | question; payload unchanged from the original importer |
| `catalog` | `extract-eval-catalog@v1` / `math-fidelity-catalog@v1` `{ entries: [{ id, split, asset, reference, expect }] }` | catalog entry; the reference file is hash-checked and inlined up to `inlineReferenceMaxBytes` (256 KiB), else kept as path + sha256 |
| `layout-jsonl` | `{ id, split, image_path, regions, metadata }` lines | page image (hashed) with its regions |
| `queries` | query JSON/JSONL plus optional `qrels`; `split` (with `splitBasis`) when rows carry none | query with relevance judgements |
| `case-list` | harness ID list + parent `catalog` + `parentPrefix` | listed case, pointing at the parent dataset item |
| `mirror` | `name`, `split`, `fromTarget` | item copied verbatim from a dataset that exists only on another target |

Item IDs hash the dataset name plus case identity, so dataset versions never overwrite each other. Existing items are compared against the full item list. Matching items are skipped; changed items are upserted and read back individually; the final list is checked for every expected ID. Dataset metadata records split, `heldout`, `tuningReadable`, source hashes, license and authorisation.

Langfuse drops C0/C1 control characters from stored JSON. Catalog, layout, query and run payloads therefore store any string containing them as `{ "$asciiJson": "<JSON string literal, ASCII only>" }`; `decodeUnsafe()` in `langfuse.mjs` restores the original value.

Langfuse also stores JSON numbers at about 16 significant digits (`318.76800537109375` reads back as `318.7680053710938`). Readback therefore treats numbers within a relative 1e-12 as equal; exact values remain in the source files referenced by path and sha256.

## Splits and held-out data

Every dataset is split-pure and its name carries the split: catalogs are partitioned into `<prefix>/<split>`. `test`, `holdout` and `heldout` are held out and become `<prefix>/<split>-heldout`. `development`, `calibration`, `train`, `dev`, `probe`, `standards-probe` and `pilot-review` are tuning-readable. Any other split fails until it is classified. Held-out datasets, and runs scored against them, are written only to targets named by `--allow-heldout <target,...>`; otherwise the target fails for those datasets, or skips them with `--exclude-heldout`.

**Rule: tuning tooling never reads held-out datasets from Langfuse.** Any tool that pulls a dataset for tuning, prompt or parameter search must pass it through `assertTuningReadable()` from `langfuse.mjs`. It refuses names containing `heldout`/`holdout` and anything not explicitly marked `heldout: false, tuningReadable: true`. Held-out results are reported once, never iterated on.

## Score configs

`--scorers` takes a registry (`docslurp-scorer-registry@v1`). Each scorer has `id`, `version`, `prefix`, `description`, `code { repo, path, commit, sourceSha256, checkout? }` and `components [{ name, dataType, min, max, direction, description }]`. Each component becomes the score config `<prefix>.<name>` (at most 35 characters) via `POST /api/public/score-configs`. Score configs have no metadata field, so the description carries scorer id, version, component, code reference (`repo:path@commit`) and source sha256. With `checkout`, the source is hashed from `git show <commit>:<path>` and must match `sourceSha256`.

Configs are versioned by name and never patched. An existing config with a different type, range or description is a conflict: give the scorer a new version and prefix. Scorers with `status: "pending"` (for example, uncommitted code) are skipped and reported. Learned judges must set `kind: "learned"` with `learned { model, promptVersion, settings }`, recorded in the description. The sync only registers them; it never configures Langfuse evaluators that would call a model.

## Scored runs (experiments)

`--run` takes a run manifest written by a harness (for example `score.py score --langfuse-run DIR`):

```json
{ "schema": "docslurp-eval-run@v1",
  "experiment": { "name": "unique per run", "description": "...", "metadata": {} },
  "dataset": { "name": "docslurp-evals/corpus-v1/development", "split": "development" },
  "startedAt": "ISO", "endedAt": "ISO", "scoredAt": "ISO", "timing": "what the timestamps measure",
  "costs": { "usd": null, "status": "not-recorded" },
  "items": [{ "caseId": "...", "input": {}, "output": {}, "metadata": {}, "scores": { "judge-v3.5.contentTokenF1": 0.97, "judge-v3.5.mathPartial": null } }] }
```

Timestamps must come from the actual run. The uploader refuses to invent them, uses run-level times for items without their own, and keeps unknown costs `null`. A run must be split-pure, every case must already exist in the synced dataset, and every score name must be a registered score config on that target. Null scores are not applicable; they are listed in item metadata instead of being sent.

Each item becomes one OTLP root span sent to `POST /api/public/otel/v1/traces` with header `x-langfuse-ingestion-version: 4`. The span carries `langfuse.experiment.{id,name,dataset.id,metadata.*}`, `langfuse.experiment.item.{id,root_observation_id,metadata.*}` and `langfuse.observation.{input,output}`, from which Langfuse synthesises an experiment linked to the dataset items. Scores go to `POST /api/public/scores` on the item's trace and root observation, with the config ID. Experiment, trace, span and score IDs derive from the run manifest's content, so a repeated upload is checked through `GET /api/public/experiment-items` and writes nothing. Readback polls until every item's output hash and every score is visible.

Historical summaries are not runs. They stay as labelled evidence in dataset item metadata, with unknown costs `null`; they are never turned into traces, timestamps or costs.

Contracts checked 2026-10-26 against the self-hosted v4.54 and v4.59 OpenAPI documents and the official docs: [experiments via OpenTelemetry](https://langfuse.com/integrations/native/opentelemetry/experiments), [deprecated API migration](https://langfuse.com/faq/all/deprecated-api-migration) (`POST /dataset-run-items` and trace events on `POST /ingestion` are deprecated and unused here), [OpenAPI](https://raw.githubusercontent.com/langfuse/langfuse/main/web/public/generated/api/openapi.yml) and [datasets](https://langfuse.com/docs/evaluation/experiments/datasets). Endpoints used: `/v2/datasets`, `/dataset-items`, `/score-configs`, `/otel/v1/traces`, `/scores`, `/experiment-items`.

Run focused checks with `node --test scripts/eval-sync/langfuse.test.mjs`.

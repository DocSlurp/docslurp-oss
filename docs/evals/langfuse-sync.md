# Evaluation sync to Langfuse

DocSlurp evaluation datasets, scorer definitions and scored runs sync to every configured self-hosted Langfuse instance with one command. The tool, manifest formats and API contracts are documented in [`scripts/eval-sync/README.md`](../../scripts/eval-sync/README.md).

- **Datasets.** One Langfuse dataset per corpus and split, for example `docslurp-evals/pdfust-dev-v1/wild-v2/development`. Items keep the reference labels (hash-checked), input hashes, license and provenance. Each manifest names the targets it is authorised for.
- **Held-out data.** `test`, `holdout` and `heldout` splits are written as separate `…-heldout` datasets marked `heldout: true, tuningReadable: false`, and only to targets named by `--allow-heldout`. Tuning tools never read held-out datasets from Langfuse: anything that pulls a dataset for tuning calls `assertTuningReadable()`, which refuses them.
- **Scorers.** Every scorer component is a Langfuse score config named `<scorer-prefix-with-version>.<component>`, such as `judge-v3.5.contentTokenF1`. Its description records the code reference (`repo:path@commit`) and source hash. A changed scorer gets a new version and new configs; existing configs are never edited.
- **Runs.** A harness that writes a `docslurp-eval-run@v1` manifest, such as the doppler `score.py score --langfuse-run DIR`, uploads it as a Langfuse experiment linked to the dataset items, with one score per component. Timestamps come from the actual run, and unknown costs stay `null`. Historical summaries remain labelled evidence in item metadata and are never converted into runs.

Every write is read back, and a repeated sync must report zero creates and updates on every target. The command exits non-zero if any target fails.

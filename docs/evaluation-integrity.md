# Evaluation integrity

DocSlurp uses evaluation datasets to measure general product behavior. They are not a source of hidden production rules.

## Hard boundary

Product code and worker-owned prompts must never encode:

- a benchmark or fixture name;
- field names or expected values copied from an evaluation schema;
- fixture IDs, filenames, hashes, image traits, or ordering used to recognize prior inputs;
- a branch, route, label, or model policy that exists only for one known evaluation set.

The same restriction applies to indirect leakage, such as a supposedly generic prompt whose enumerated fields reproduce the held-out answer schema.

## Allowed generalization

Changes may use signals available for any unseen customer document: MIME type, page geometry, OCR confidence, text density, handwriting or low-light classification, layout structure, and the workspace's runtime-provided output schema. Categories must name reusable document properties, not a benchmark domain.

A workspace may supply task-specific instructions or a schema at runtime. Worker-owned code may safely delimit and consume those inputs, but must not copy their contents into a built-in template.

## Promotion checklist

Before calling an eval-driven change a win:

1. State the general capability and the runtime signal that selects it.
2. Search the production diff for fixture names, benchmark field names, expected values, and input-recognition logic.
3. Run class-level regression checks, including cases outside the motivating failure when available.
4. Report quality, latency, and marginal cost on the same workload and scoring contract.
5. Preserve failed and eliminated hypotheses, but discard results produced after benchmark leakage.

When leakage is found, cancel the run, remove contaminated result artifacts, revert the specialized behavior, and restart from the last clean baseline.

## Dataset directory

Evaluation datasets live outside the repository in one directory named by `DOCSLURP_EVAL_DATA_DIR`. Pass a subdirectory as `--dataset` to the integrity judge.

## Independent integrity gate

Run the deterministic integrity judge independently of the quality scorer:

```sh
node scripts/evaluation-integrity-judge.mjs \
  --dataset /absolute/path/to/held-out-dataset \
  --output research/<evaluation>/integrity-report.json
```

The judge derives fixture identifiers, label names, distinctive expected values, and source-file hashes from the external dataset at runtime. It fails if source media has been copied into the repository or if production files recognize fixtures, embed labeled answers, or encode several benchmark labels together. It intentionally allows generic document capabilities and schemas supplied as runtime workspace configuration.

The current deterministic tool supports an external `integrity-manifest.json` with
schema `docslurp-authored-eval@v1`. Each case supplies a distinctive `id`, hashed
`source` and `labels` artifacts (`path`, `sha256`), and authored provenance
(`kind: "authored"`, `author`, `description`, `createdAt`). Label files contain
`{"labels":[{"name":"label_name","expected":"labeled value"}]}`; expected values may
also be arrays or objects. Missing labels, provenance or hash matches fail.

The tool scans production files and additions for fixture IDs, source hashes,
distinctive answers, and groups of benchmark labels. Ordinary single-word answers
alone are insufficient evidence: they require at least two benchmark labels in
the same file. Proper multiword values and structured identifiers can trigger an
individual finding. This deterministic screen does not detect every possible
obfuscation or replace independent review. Test gold and documentation are excluded
from textual product checks, but copied source bytes are checked across all tracked
and non-ignored untracked repository files. Reports bind the verdict to the dataset
manifest hash, Git head and scanned production content hash.

**Catalog limitation:** the restored tool currently rejects every `catalog.json`
with `unsupported-catalog-schema`. It does not yet implement or claim to validate
the catalog contract below. Do not convert a generated or licensed corpus into an
authored manifest to bypass these requirements. Catalog support must implement and
test the following rules before such a dataset can receive a passing verdict.

The required contract for an `extract-eval-catalog@v1` `catalog.json` checks each entry by `source.kind`:

- `synthetic` / `generated`: the generator must exist in the repository and the asset must match its catalog sha256
  (and the `manifest.json` artifact sha256 when listed). If the bytes changed, the asset passes only when the dataset
  manifest lists it under `nondeterministic` (a glob such as `inputs/unusual-encrypted-*.pdf`, e.g. time-salted
  encryption), its reference file still matches its hash, and a structural check passes (PDF header and `%%EOF`,
  an `/Encrypt` dictionary when the asset is encrypted, the declared page count when page objects are visible).
- `licensed-real` / `real-page-extract`: real documents that cannot be regenerated. The asset must match both the
  catalog sha256 and the manifest artifact sha256, carry a license record (`id`, `redistribution`, attribution, URL or
  evidence) and an upstream URL. They must stay outside the repository: a licensed-real corpus inside the repo, or any
  repository media file with the same bytes, fails.
- Any other kind fails `catalog-source-kinds`.

Quality and integrity are separate gates. A high labeled-data score cannot compensate for a failed integrity report, and envelope/schema validity must not substitute for labeled-value correctness.

Conversation and tool traces can be backtested separately with `scripts/trace-safety-judge.mjs`. Supply an explicit policy file containing the allowed hosts and command rules for that run. The report counts observed calls, violations, tool failures, model circumvention attempts, user prompt-injection attempts, hostile instructions returned by tools, and possible unsupported success claims. Raw messages and tool payloads are not copied into the report; findings use event indexes and evidence hashes.

Deterministic matches are not mind-reading. In particular, a tool failure is not dishonesty, a user jailbreak attempt is not a model violation, and a possible unsupported success claim requires review before it can be called dishonest.

Numeric prose consisting of a decimal or integer followed by a lowercase word
is retained as a hashed `comment-quantity-overlap` candidate when the complete
JS/TS file parses successfully and the occurrence lies entirely in a parser-proven
comment. These candidates alone do not fail the gate. There is no unit or phrase
allowlist. Any occurrence outside comments remains blocking, including strings,
prompts and answer-conditioned branches. Unsupported syntax and parse errors stay
blocking. Fixture identifiers, source hashes, proper names and label combinations
retain their existing checks even inside comments. Diff additions use the complete
current file's classification; source comments remain part of the production hash.

Candidates are review evidence, not proof of independent provenance. A copied
quantity in a comment may still be improper; independent review must assess that
possibility before promotion. This screen does not perform runtime dataflow analysis
or detect code that reads its own comments as prompt text.
